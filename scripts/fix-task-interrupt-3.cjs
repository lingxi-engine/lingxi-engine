/**
 * fix-task-interrupt-3.cjs — 429 配额/限流快速失败（P1，报告1根因5）
 * 429 重试无用，连续 2 次即终止并给出可操作提示，不再傻等 5 次。
 */
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'src', 'tools', 'executor.ts');
let src = fs.readFileSync(file, 'utf8');
const hasBom = src.charCodeAt(0) === 0xFEFF;
if (hasBom) src = src.slice(1);
src = src.replace(/\r\n/g, '\n');

const anchor = '      result.consecutiveErrors = (result.consecutiveErrors || 0) + 1;\n      if (result.consecutiveErrors >= 5) {';
const done = 'isQuotaError';
if (src.includes(done)) {
  console.log('[SKIP] 已应用过 429 快速失败');
} else if (!src.includes(anchor)) {
  console.log('[SKIP] 锚点未找到');
} else {
  src = src.replace(anchor, `      result.consecutiveErrors = (result.consecutiveErrors || 0) + 1;
      // 修复：429 配额/限流识别 —— 这类错误重试无用，连续 2 次即终止并给出可操作提示（不再傻等 5 次）
      const isQuotaError = /429|usage limit|rate limit|quota|weekly limit|reached your/i.test(errMsg);
      if (isQuotaError && result.consecutiveErrors >= 2) {
        result.finalContent = \`任务中断：API 配额/限流耗尽（\${errMsg.substring(0, 200)}）。请稍后重试，或在设置中切换到其他模型。\`;
        break;
      }
      if (result.consecutiveErrors >= 5) {`);
  console.log('[OK] 429 快速失败已应用');
}
src = src.replace(/\n/g, '\r\n');
fs.writeFileSync(file, (hasBom ? '\uFEFF' : '') + src, 'utf8');
