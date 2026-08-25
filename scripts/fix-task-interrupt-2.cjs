/**
 * fix-task-interrupt-2.cjs — 补打 3 处因 CRLF 行尾未匹配的补丁（幂等）
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

function patchFile(relPath, patches) {
  const full = path.join(ROOT, relPath);
  let src = fs.readFileSync(full, 'utf8');
  const hasBom = src.charCodeAt(0) === 0xFEFF;
  if (hasBom) src = src.slice(1);
  src = src.replace(/\r\n/g, '\n'); // 统一 LF 便于匹配
  for (const p of patches) {
    if (p.done && src.includes(p.done)) { console.log(`[SKIP] ${relPath} 已应用过: ${p.name}`); continue; }
    if (!src.includes(p.anchor)) { console.log(`[SKIP] ${relPath} 锚点未找到: ${p.name}`); continue; }
    const before = src;
    src = p.apply(src);
    if (src === before) { console.log(`[SKIP] ${relPath} 无变化: ${p.name}`); continue; }
    console.log(`[OK]   ${relPath} <- ${p.name}`);
  }
  src = src.replace(/\n/g, '\r\n'); // 还原 CRLF
  fs.writeFileSync(full, (hasBom ? '\uFEFF' : '') + src, 'utf8');
}

// 1) executor.ts isCompletionSignal 整体重构
patchFile('src/tools/executor.ts', [{
  name: 'isCompletionSignal 判定顺序重构（反问优先+证据兜底）',
  done: '// ① 先查反问/请示信号',
  anchor: 'function isCompletionSignal(content: string): boolean {',
  apply(src) {
    const oldFn = src.match(/function isCompletionSignal\(content: string\): boolean \{[\s\S]*?\n\}/);
    if (!oldFn) return src;
    const newFn = `function isCompletionSignal(content: string): boolean {
  if (!content) return false;
  const t = content.trim();
  // ① 先查反问/请示信号 —— 命中即未完成，绝不判为完成
  //    （修复：原实现先查完成信号，导致"任务已完成第一步，是否继续？"被误判整体完成、提前收工）
  const askingPatterns = [
    /(需要我|要我|是否需要|要不要|需不需要)(继续|接着|下一步)/,
    /(还需要|还需要做什么|还有什么需要|还有什么要做的)/,
    /是否(需要|要我|要)/,
    /(?:继续|接着|下一步)(?:吗|么|吧)?\\s*[?？]?\\s*$/,
    /\\?\\s*$/,
  ];
  for (const p of askingPatterns) {
    if (p.test(t)) return false;
  }
  // ② 再查明确完成信号
  const donePatterns = [
    /(任务|工作|全部|所有|目标)(已经|已|均已|都)(完成|做完|搞定|结束|处理完|执行完)/,
    /^任务完成/,
    /全部完成/,
    /已全部完成/,
    /均已完成/,
    /(?:所有|全部)验收(?:标准|条件)(?:已|均已)?(?:满足|达到|完成)/,
    /(?:done|completed|finished|all done)\\.?\\s*$/i,
  ];
  for (const p of donePatterns) {
    if (p.test(t)) return true;
  }
  // ③ 兜底：两条以上"完成性证据"才算完成（避免真做完但没写"任务完成"被白追问）
  const evidence = [/成功/, /已生成/, /已写入/, /已保存/, /已修复/, /已删除/, /测试通过/, /已更新/, /已完成/, /已解决/, /全部处理/];
  let evidenceHits = 0;
  for (const p of evidence) {
    if (p.test(t)) { evidenceHits++; if (evidenceHits >= 2) return true; }
  }
  return false;
}`;
    return src.replace(oldFn[0], newFn);
  },
}]);

// 2) executor.ts 追问措辞（system 角色 + 删诱导句）
patchFile('src/tools/executor.ts', [{
  name: '追问措辞改为 system 角色 + 删诱导句',
  done: '系统提示：任务尚未完成，请继续检查工作',
  anchor: 'const nudge = idleRounds === 1',
  apply(src) {
    return src.replace(
      /const nudge = idleRounds === 1\n          \? "系统提示：任务还没完成。请检查刚才的工作，看看还有哪些步骤没做完或遗漏了，继续调用工具完成它们。不要提前结束，直到全部做完。"\n          : `系统提示：任务仍未完成（已提醒 \$\{idleRounds\} 次）。如果你认为确实做完了，请明确输出"任务完成"并说明已满足的条件；否则请继续调用工具推进剩余工作，不要停。`;\n        result\.messages\.push\(\{ role: "user", content: nudge \} as ChatMessage\);/,
      `        // 修复：system 角色注入（模型更服从）；删除"如果你认为确实做完了请明确输出任务完成"的诱导措辞（防止提前收工）
        const nudge = \`系统提示：任务尚未完成，请继续检查工作、继续调用工具推进，不要停下，也不要询问用户。\`;
        result.messages.push({ role: "system", content: nudge } as ChatMessage);`
    );
  },
}]);

// 3) ws-handler.ts 步骤关闭 requireCompletion
patchFile('src/core/ws-handler.ts', [{
  name: 'Orchestrator 步骤关闭 requireCompletion',
  done: '{ skipPersist: true, requireCompletion: false }',
  anchor: '{ skipPersist: true }',
  apply(src) {
    return src.replace(
      '{ skipPersist: true }',
      `// 修复：步骤是单次执行指令（customPrompt 非空会被误判为任务模式触发持续执行追问空转），\n                // 显式关闭 requireCompletion，AI 输出即完成该步\n                { skipPersist: true, requireCompletion: false }`
    );
  },
}]);

console.log('==== 补丁2完成 ====');
