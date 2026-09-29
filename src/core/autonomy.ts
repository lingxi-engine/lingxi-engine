/**
 * v2.2.0 autonomy policy.
 *
 * Fixes the deterministic loop where a long task would stop mid-way and force
 * the user to type "continue" every time.
 *
 * Root cause: the executor marks a run as 'idle_stop' whenever the model emits
 * text without a completion signal, but the router's auto-resume white-list only
 * contained 'aborted' and 'max_iterations'. 'idle_stop' therefore always fell
 * through to "hand control back to the user".
 */

const AUTO_RESUME_STOP_REASONS = new Set<string>([
  'idle_stop',
  'aborted',
  'max_iterations',
  'tool_failures',
  'repeat_tool',
]);

const STOP_REASON_TEXT: Record<string, string> = {
  idle_stop: '多轮未检测到明确完成信号（任务尚未完成）',
  aborted: '超出时限',
  max_iterations: '达到迭代上限',
  tool_failures: '工具连续失败',
  repeat_tool: '重复调用已收敛',
  ai_errors: 'AI 调用连续失败',
  completed: '已完成',
};

export function inferRemainingWork(lastText: string): string {
  const t = (lastText || '').trim();
  if (!t) return '';

  // 1) Checklist items anywhere in the text (markdown bullets or numbered),
  //    keeping only the ones that are NOT already checked off.
  const bulletRe = /^[ \t]*(?:[-*·]|[0-9]+[.、)])\s+(.+)$/gm;
  const pending: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = bulletRe.exec(t)) !== null) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    // skip items that are already ticked off
    if (/^\[[ xX✓√]\s*\]/.test(raw)) continue;
    const body = raw.replace(/^\[[ xX✓√]\s*\]\s*/, '').trim();
    if (body) pending.push(body);
  }

  if (pending.length > 0) {
    const list = pending.slice(-8);
    return (
      '\n\n【上一轮汇报中列出的未完成项】\n' +
      list.map((s, i) => (i + 1) + '. ' + s).join('\n') +
      '\n请直接逐条执行，不要再列清单。'
    );
  }

  // 2) Fallback: an explicit "next step" sentence.
  const todoMatch = t.match(/(?:下一步|接下来|待办|剩余|尚未|还没|未完成|需要做)[：:\s]*([^\n]+)/);
  if (todoMatch && todoMatch[1]) {
    return (
      '\n\n【上一轮列出的下一步】' + todoMatch[1].trim().slice(0, 300) +
      '\n请直接执行。'
    );
  }

  return '';
}

export type AutoResumeDecision = {
  shouldResume: boolean;
  reason: string;
  label: string;
  hint: string;
};

export function decideAutoResume(stopReason: string | undefined, lastText: string): AutoResumeDecision {
  const key = stopReason || 'completed';
  if (key === 'completed') {
    return { shouldResume: false, reason: 'completed', label: STOP_REASON_TEXT.completed, hint: '' };
  }
  if (!AUTO_RESUME_STOP_REASONS.has(key)) {
    return { shouldResume: false, reason: key, label: STOP_REASON_TEXT[key] || key, hint: '' };
  }
  return {
    shouldResume: true,
    reason: key,
    label: STOP_REASON_TEXT[key] || key,
    hint: '系统提示：任务尚未完成，不要停下来等用户回复。' + inferRemainingWork(lastText),
  };
}

export { AUTO_RESUME_STOP_REASONS, STOP_REASON_TEXT };
