// patch-v26.cjs — executor 搜索/重复调用收敛（防死循环）
// 目标：src/tools/executor.ts + src/core/router.ts
// 修复：搜索命中缓存/工具无新信息时，AI 在 requireCompletion 模式下反复调用导致死循环超时
// 机制：双保险 —— (a) 相同工具+相同参数连续调用；(b) 搜索类工具累计调用次数。
//       达到阈值先注入"降级作答"提示，再超 +2 次则硬停止（stopReason='repeat_tool'），走兜底强制出答案。
// 幂等：重复运行 0 改动。备份：*.bak-20260919-v26

const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/Administrator/lingxi-engine';
const EXECUTOR = path.join(ROOT, 'src/tools/executor.ts');
const ROUTER = path.join(ROOT, 'src/core/router.ts');
const TAG = '20260919-v26';

function read(p) { return fs.readFileSync(p, 'utf8'); }
function eolOf(s) { return s.includes('\r\n') ? '\r\n' : '\n'; }

function backup(p) {
  const bak = p + '.bak-' + TAG;
  if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
  return bak;
}

// 确保锚点在内容中恰好出现一次（精确计数，避免误替换）
function countOccurrences(content, needle) {
  let n = 0, idx = 0;
  while ((idx = content.indexOf(needle, idx)) !== -1) { n++; idx += needle.length; }
  return n;
}

function mustReplace(content, from, to, label, file) {
  const c = countOccurrences(content, from);
  if (c !== 1) {
    throw new Error(`[${label}] 锚点出现 ${c} 次（应为 1）：${file}\n锚点: ${JSON.stringify(from.slice(0, 80))}`);
  }
  return content.replace(from, to);
}

// ─────────────────────────── 主流程 ───────────────────────────
function main() {
  const report = [];

  // ===== executor.ts =====
  {
    const EOL = eolOf(read(EXECUTOR));
    let c = read(EXECUTOR);

    if (c.includes('EXECUTOR_REPEAT_TOOL_LIMIT') && c.includes("| 'repeat_tool';")) {
      report.push('executor.ts: 已应用（跳过）');
    } else if (c.includes('EXECUTOR_REPEAT_TOOL_LIMIT') || c.includes('repeat_tool')) {
      throw new Error('executor.ts 处于部分应用状态，请人工检查');
    } else {
      backup(EXECUTOR);

      // A) stopReason 类型加 'repeat_tool'
      c = mustReplace(
        c,
        "'tool_failures' | 'ai_errors';",
        "'tool_failures' | 'ai_errors' | 'repeat_tool';",
        'A-stopReason', 'executor.ts'
      );

      // B) 计数器声明（在 consecutiveToolFailures 后追加）
      const blockB = [
        "  // v2.6 重复调用收敛：防\"搜索命中缓存 / 工具无新信息\"导致的死循环",
        "  let lastToolSignature = '';",
        "  let sameSignatureCount = 0;",
        "  let searchCallCount = 0;",
        "  const REPEAT_TOOL_LIMIT = Math.max(3, parseInt(process.env.EXECUTOR_REPEAT_TOOL_LIMIT || '4', 10));",
        "  const SEARCH_CALL_LIMIT = Math.max(5, parseInt(process.env.EXECUTOR_SEARCH_CALL_LIMIT || '8', 10));",
        "  const isSearchTool = (name: string) => name === 'web_search' || name === 'search' || name === 'scrape_url' || name === 'browser';",
      ].join(EOL);
      c = mustReplace(
        c,
        "  let consecutiveToolFailures = 0;",
        "  let consecutiveToolFailures = 0;" + EOL + blockB,
        'B-counters', 'executor.ts'
      );

      // C) 重复调用检测（在 toolRequest 构建前插入）
      const blockC = [
        "      // v2.6 重复调用检测：相同工具+相同参数连续调用 -> 原地打转；搜索工具累计计数 -> 反复搜索",
        "      const toolSignature = toolName + '::' + JSON.stringify(toolArgs);",
        "      if (toolSignature === lastToolSignature) {",
        "        sameSignatureCount += 1;",
        "      } else {",
        "        lastToolSignature = toolSignature;",
        "        sameSignatureCount = 1;",
        "      }",
        "      if (isSearchTool(toolName)) searchCallCount += 1;",
      ].join(EOL);
      c = mustReplace(
        c,
        "      const toolRequest: ToolCallRequest = {",
        blockC + EOL + "      const toolRequest: ToolCallRequest = {",
        'C-detect', 'executor.ts'
      );

      // D) 降级注入 + 硬停止（在 toolMessage push 后插入）
      const blockD = [
        "      // v2.6 重复调用收敛：达到阈值先注入\"降级作答\"提示，再超 +2 次则硬停止（走兜底强制出答案）",
        "      const degradeReason = sameSignatureCount === REPEAT_TOOL_LIMIT",
        "        ? `已连续 ${sameSignatureCount} 次用相同参数调用「${toolName}」`",
        "        : (isSearchTool(toolName) && searchCallCount === SEARCH_CALL_LIMIT)",
        "          ? `已累计调用 ${searchCallCount} 次搜索工具`",
        "          : '';",
        "      if (degradeReason) {",
        "        console.warn(`[Executor] 重复调用收敛：${degradeReason}，注入降级提示`);",
        "        result.messages.push({",
        "          role: 'user',",
        "          content: `系统提示：${degradeReason}，继续调用不会得到新信息（很可能是命中了搜索缓存或结果无更新）。请立即停止调用该工具，基于已有信息和你的知识直接给出最终答案；如信息不足，请明确说明不确定性并给出最佳估计，不要再搜索、不要再重复调用。`,",
        "        });",
        "      }",
        "      if (sameSignatureCount >= REPEAT_TOOL_LIMIT + 2 || (isSearchTool(toolName) && searchCallCount >= SEARCH_CALL_LIMIT + 2)) {",
        "        console.warn(`[Executor] 重复调用收敛：硬停止（sameSignature=${sameSignatureCount}, searchCalls=${searchCallCount}）`);",
        "        result.stopReason = 'repeat_tool';",
        "        i = maxIterations; // 强制退出外层循环",
        "        break; // 退出内层工具循环",
        "      }",
      ].join(EOL);
      c = mustReplace(
        c,
        "      result.messages.push(toolMessage);",
        "      result.messages.push(toolMessage);" + EOL + blockD,
        'D-degrade', 'executor.ts'
      );

      fs.writeFileSync(EXECUTOR, c, 'utf8');
      report.push('executor.ts: 4 处替换完成（A类型/B计数器/C检测/D降级硬停止）');
    }
  }

  // ===== router.ts =====
  {
    const EOL = eolOf(read(ROUTER));
    let c = read(ROUTER);

    if (c.includes("repeat_tool: '重复调用已收敛'")) {
      report.push('router.ts: 已应用（跳过）');
    } else {
      backup(ROUTER);
      c = mustReplace(
        c,
        "            tool_failures: '工具连续失败',",
        "            tool_failures: '工具连续失败'," + EOL + "            repeat_tool: '重复调用已收敛',",
        'E-reasonMap', 'router.ts'
      );
      fs.writeFileSync(ROUTER, c, 'utf8');
      report.push('router.ts: 1 处替换完成（reasonMap 加 repeat_tool）');
    }
  }

  console.log('=== patch-v26 结果 ===');
  report.forEach(r => console.log(' - ' + r));
  console.log('=== 完成 ===');
}

try {
  main();
} catch (e) {
  console.error('PATCH FAILED:', e.message);
  process.exit(1);
}
