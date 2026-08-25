/**
 * fix-task-interrupt.cjs — 任务中途停止问题修复补丁（TS 主引擎）
 * 依据：《灵犀任务中断问题-修复补丁参考-2026-08-25.docx》P0-1/P0-2/P0-4/P1-6
 * 覆盖：
 *  1. executor.ts  isCompletionSignal 判定顺序重构（反问优先 + 完成性证据兜底）
 *  2. executor.ts  追问机制修复：MAX_IDLE_ROUNDS 3→5、system 角色、删诱导措辞
 *  3. executor.ts  有工具调用时重置 idleRounds（防累计误杀）
 *  4. executor.ts  任务模式首轮 tool_choice=required（阻止"用嘴停轮"，次轮自动回退 auto）
 *  5. router.ts    generateReply 支持 options.requireCompletion 显式覆盖
 *  6. router.ts    generateOneShot 按模型裁剪 temperature（kimi/moonshot 系不支持）
 *  7. ws-handler.ts Orchestrator 步骤关闭 requireCompletion（单次指令不再空转追问）
 *  8. ws-handler.ts 步骤超时 120s → 300s
 * 幂等：每处替换先校验锚点存在，不存在则跳过并报告。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let applied = 0, skipped = 0;

function patchFile(relPath, patches) {
  const full = path.join(ROOT, relPath);
  if (!fs.existsSync(full)) { console.log(`[SKIP] 文件不存在: ${relPath}`); skipped++; return; }
  let src = fs.readFileSync(full, 'utf8');
  const hasBom = src.charCodeAt(0) === 0xFEFF;
  if (hasBom) src = src.slice(1); // 去掉 BOM 便于匹配，写完再加回
  for (const p of patches) {
    if (!p.anchor || !src.includes(p.anchor)) {
      console.log(`[SKIP] ${relPath} 锚点未找到: ${(p.name || '').slice(0, 40)}`);
      skipped++;
      continue;
    }
    const before = src;
    src = p.apply(src);
    if (src === before) {
      console.log(`[SKIP] ${relPath} 替换无变化: ${p.name}`);
      skipped++;
    } else {
      console.log(`[OK]   ${relPath} <- ${p.name}`);
      applied++;
    }
  }
  fs.writeFileSync(full, (hasBom ? '\uFEFF' : '') + src, 'utf8');
}

// ───────────────────────── 1. executor.ts ─────────────────────────
patchFile('src/tools/executor.ts', [
  {
    name: 'isCompletionSignal 判定顺序重构（反问优先）',
    anchor: '  for (const p of donePatterns) {\n    if (p.test(t)) return true;\n  }\n  // 反问/请示（这些不是完成，是停下来等用户）',
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
  },
  {
    name: 'MAX_IDLE_ROUNDS 3 → 5',
    anchor: '  const MAX_IDLE_ROUNDS = 3;',
    apply(src) { return src.replace('  const MAX_IDLE_ROUNDS = 3;', '  const MAX_IDLE_ROUNDS = 5;'); },
  },
  {
    name: '追问措辞改为 system 角色 + 删诱导句',
    anchor: '        const nudge = idleRounds === 1',
    apply(src) {
      return src.replace(
        /const nudge = idleRounds === 1\n          \? "系统提示：任务还没完成。请检查刚才的工作，看看还有哪些步骤没做完或遗漏了，继续调用工具完成它们。不要提前结束，直到全部做完。"\n          : `系统提示：任务仍未完成（已提醒 \$\{idleRounds\} 次）。如果你认为确实做完了，请明确输出"任务完成"并说明已满足的条件；否则请继续调用工具推进剩余工作，不要停。`;\n        result\.messages\.push\(\{ role: "user", content: nudge \} as ChatMessage\);/,
        `        // 修复：system 角色注入（模型更服从）；删除"如果你认为确实做完了请明确输出任务完成"的诱导措辞（防止提前收工）
        const nudge = \`系统提示：任务尚未完成，请继续检查工作、继续调用工具推进，不要停下，也不要询问用户。\`;
        result.messages.push({ role: "system", content: nudge } as ChatMessage);`
      );
    },
  },
  {
    name: '有工具调用时重置 idleRounds',
    anchor: '    // 记录 tool_calls（已验证过的条目）',
    apply(src) {
      return src.replace(
        '    // 记录 tool_calls（已验证过的条目）',
        '    // ⭐ 修复：本轮有工具调用 → 重置 idleRounds，避免"干完活继续累计追问次数"导致误停\n    idleRounds = 0;\n\n    // 记录 tool_calls（已验证过的条目）'
      );
    },
  },
  {
    name: '任务模式首轮 tool_choice=required',
    anchor: '      requestParams.tool_choice = "auto";',
    apply(src) {
      return src.replace(
        '      requestParams.tool_choice = "auto";',
        '      // 修复：任务模式（requireCompletion）首轮强制工具调用，阻止模型"用嘴停轮"；\n      // 后续轮次恢复 auto（若模型不支持 required，首轮失败后自动回退 auto，最多浪费一轮）\n      requestParams.tool_choice = (requireCompletion && i === 0) ? "required" : "auto";'
      );
    },
  },
]);

// ───────────────────────── 2. router.ts ─────────────────────────
patchFile('src/core/router.ts', [
  {
    name: 'generateReply options 增加 requireCompletion 覆盖',
    anchor: '    options?: { skipPersist?: boolean }',
    apply(src) { return src.replace('    options?: { skipPersist?: boolean }', '    options?: { skipPersist?: boolean; requireCompletion?: boolean }'); },
  },
  {
    name: 'runToolsLoop 使用 options.requireCompletion 覆盖',
    anchor: '        requireCompletion: isTaskMode,',
    apply(src) { return src.replace('        requireCompletion: isTaskMode,', '        // 修复：允许调用方显式覆盖（如 Orchestrator 单次步骤关闭持续执行，避免内部空转追问）\n        requireCompletion: options?.requireCompletion ?? isTaskMode,'); },
  },
  {
    name: 'generateOneShot 按模型裁剪 temperature',
    anchor: '      const resp = await client.chat.completions.create({\n        model: resolvedModel,\n        messages: [\n          { role: \'system\', content: opts?.systemPrompt',
    apply(src) {
      return src.replace(
        `      const resp = await client.chat.completions.create({
        model: resolvedModel,
        messages: [
          { role: 'system', content: opts?.systemPrompt || '你是灵犀引擎的任务规划器。严格按用户要求输出内容，不要输出任何工具调用标记（如 <｜DSML｜｜...>），不要多余解释。' },
          { role: 'user', content: prompt },
        ],
        temperature: opts?.temperature ?? 0.3,
        max_tokens: opts?.maxTokens ?? 4096,
      }, { signal: controller.signal });`,
        `      // 修复：kimi/moonshot 系模型不支持 temperature 参数（实测 kimi-k3 报 400 InvalidParameter），
      // 按模型名裁剪该参数，避免任务规划阶段直接失败
      const reqBody: Record<string, unknown> = {
        model: resolvedModel,
        messages: [
          { role: 'system', content: opts?.systemPrompt || '你是灵犀引擎的任务规划器。严格按用户要求输出内容，不要输出任何工具调用标记（如 <｜DSML｜｜...>），不要多余解释。' },
          { role: 'user', content: prompt },
        ],
        max_tokens: opts?.maxTokens ?? 4096,
      };
      if (!/kimi|moonshot|k3|k2\\.6|k2\\.7/i.test(resolvedModel)) {
        reqBody.temperature = opts?.temperature ?? 0.3;
      }
      const resp = await client.chat.completions.create(reqBody as any, { signal: controller.signal });`
      );
    },
  },
]);

// ───────────────────────── 3. ws-handler.ts ─────────────────────────
patchFile('src/core/ws-handler.ts', [
  {
    name: 'Orchestrator 步骤关闭 requireCompletion',
    anchor: '                { skipPersist: true }\n              );',
    apply(src) { return src.replace('                { skipPersist: true }\n              );', '                // 修复：步骤是单次执行指令（customPrompt 非空会被误判为任务模式触发持续执行追问空转），\n                // 显式关闭 requireCompletion，AI 输出即完成该步\n                { skipPersist: true, requireCompletion: false }\n              );'); },
  },
  {
    name: '步骤超时 120s → 300s',
    anchor: "ORCHESTRATOR_TIMEOUT_SECONDS || '120'",
    apply(src) { return src.replace("ORCHESTRATOR_TIMEOUT_SECONDS || '120'", "ORCHESTRATOR_TIMEOUT_SECONDS || '300'"); },
  },
]);

console.log(`\n==== 补丁完成: 应用 ${applied} 处, 跳过 ${skipped} 处 ====`);
