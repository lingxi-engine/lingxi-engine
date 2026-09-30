/**
 * v2.3.0 autonomy policy — 长任务自愈（不让用户点"继续"）。
 *
 * ── v2.2.0 解决的问题 ──
 * executor 会在模型只出文字、没有完成信号时把本轮标成 'idle_stop'，
 * 而 router 的自动续跑白名单里只有 'aborted' / 'max_iterations'，
 * 于是 'idle_stop' 永远落进"把控制权交还用户"分支 —— 用户被迫反复敲"继续"。
 *
 * ── v2.3.0 补的洞（本轮真凶）──
 * 1) 'ai_errors' 不在白名单里。
 *    429 限流 / 5xx / 网络抖动连续失败 5 次后，executor 置 stopReason='ai_errors'，
 *    decideAutoResume 立即返回 shouldResume=false ⇒ 任务当场停下等用户点"继续"。
 *    这正是"干活干一半卡住、一直让我点继续"的直接原因。
 *    现在 ai_errors 也纳入自动续跑：只要还有未完成信号就自己接着干。
 * 2) 429 属于"可恢复"的临时错误，不该和"配置错误"（400/401/403/404/410/422）
 *    一样立刻放弃。executor 侧新增独立的"临时错误退避重试"，
 *    连等 Retry-After，避免一次限流就打掉整个任务。
 * 3) 续跑轮数上限从硬编码行为改为"可配 + 到顶也不静默停"，
 *    到顶时在正文里明确写出已保留的进度与真实原因，而不是一句"请点继续"。
 */

/** 允许自动续跑的中断原因（= "还没干完，自己接着干"） */
const AUTO_RESUME_STOP_REASONS = new Set<string>([
  'idle_stop',
  'aborted',
  'max_iterations',
  'tool_failures',
  'repeat_tool',
  // ── v2.3.0 新增 ──
  // AI 连续调用失败（429 限流 / 5xx / 网络抖动）。这是"外部暂时不可用"，
  // 不是"任务做不下去"，所以必须自愈而不是甩给用户。
  'ai_errors',
]);

const STOP_REASON_TEXT: Record<string, string> = {
  idle_stop: '多轮未检测到明确完成信号（任务尚未完成）',
  aborted: '超出时限',
  max_iterations: '达到迭代上限',
  tool_failures: '工具连续失败',
  repeat_tool: '重复调用已收敛',
  ai_errors: 'AI 服务暂时不可用（限流或网络），已自动等待重试',
  completed: '已完成',
};

/** 可重试的 HTTP 状态码（临时性故障，重试有意义） */
export const RETRYABLE_STATUSES = new Set<number>([408, 409, 425, 429, 500, 502, 503, 504, 529]);

/** 不可重试的状态码（配置/权限/模型不存在，重试只会浪费时间） */
export const FATAL_STATUSES = new Set<number>([400, 401, 403, 404, 410, 422]);

export function isRetryableError(err: any): boolean {
  // 用户主动停止不是"临时故障"：必须立刻停。
  // 少了这一行，点过"停止"的任务仍会被退避重试复活。
  if (err?.name === 'AbortError') return false;
  if (err?.code === 'ABORT_ERR') return false;
  if (!err) return false;
  const status = typeof err.status === 'number' ? err.status : undefined;
  if (status !== undefined) {
    if (FATAL_STATUSES.has(status)) return false;      // 配置类错误：不重试
    if (RETRYABLE_STATUSES.has(status)) return true;    // 限流/过载/网关：重试
  }
  // 没有 status 的多半是网络层错误（ECONNRESET / ETIMEDOUT / fetch failed …）
  const msg = String(err.message || err).toLowerCase();
  const netHints = [
    'econnreset', 'etimedout', 'econnrefused', 'enotfound', 'epipe',
    'socket hang up', 'network', 'fetch failed', 'timeout', 'aborted',
    'rate limit', 'too many requests', 'overloaded', 'service unavailable',
    'bad gateway', 'gateway timeout', 'connection',
  ];
  return netHints.some(h => msg.includes(h));
}

/** 从错误对象里挖出服务端建议的等待秒数（Retry-After / retry-after / retry_after） */
export function extractRetryAfterMs(err: any, fallbackMs: number): number {
  const hdrs = err?.headers || err?.response?.headers || err?.raw?.headers;
  const raw = hdrs?.get?.('retry-after') ?? hdrs?.['retry-after'] ?? hdrs?.['Retry-After'];
  if (raw !== undefined && raw !== null && raw !== '') {
    const secs = Number(raw);
    if (Number.isFinite(secs) && secs >= 0) {
      // 不在这里硬截断：封顶交给调用方的 maxSleepMs，
      // 否则长窗口会被腰斩，调用方以为服务端只让等 2 分钟，白白早撞一次。
      return Math.max(0, secs * 1000);
    }
    // Retry-After 的第二种合法格式：HTTP-date（RFC 9110 §10.2.3）
    // 原来这里直接落空，于是"服务端让我们等 10 分钟"被当成没说，等 8 秒又撞一次。
    const at = Date.parse(String(raw));
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  const body = err?.error?.code || err?.code;
  if (body && /rate_limit|too_many/i.test(String(body))) {
    // 服务端只说"限流"没给秒数时，给一个保守起步值
    return Math.max(fallbackMs, 2_000);
  }
  return fallbackMs;
}

/**
 * 指数退避 + 抖动（full jitter）。
 * 抖动很重要：不加抖动的话，长任务里所有并发请求会同步重试，形成惊群。
 */
export function backoffDelayMs(attempt: number, baseMs = 1_000, capMs = 32_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

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
    // 已勾选的（[x] / [X] / [✓] / [√]）视为已完成，跳过。
    // 注意：\s* 会把空格的 "[ ]" 也匹配上 —— 那正是"未完成"的标记，
    // 一旦误判为已完成，整份 checklist 的待办会全部丢失，续跑时模型看不到任何剩余工作。
    const checked = /^\[[xX✓√]\]/.test(raw);
    if (checked) continue;
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
  // ── v2.3.0：不同中断原因给不同的续跑话术 ──
  // 限流类续跑要明确告诉模型"刚才只是被限流了，不是任务失败"，
  // 否则模型会以为任务真的做不下去了而直接放弃。
  const hints: Record<string, string> = {
    ai_errors: '系统提示：刚才 AI 接口调用失败（限流/网络抖动），不是任务本身做不下去。' +
      '已完成的进度都在上文。请直接接着干剩下的，不要因为报错就停下、不要询问用户、不要宣布失败。',
    tool_failures: '系统提示：工具连续失败过，已完成的进度保留在上文。' +
      '请换一种方式或换一个工具继续完成任务，不要放弃。',
    repeat_tool: '系统提示：上一轮因重复调用收敛而停下。' +
      '请基于已有信息换角度推进（如改用其他工具/直接给结论），不要重复同样的调用。',
    aborted: '系统提示：上一轮超出时限被中断，进度已保留。请从断点继续。',
    max_iterations: '系统提示：上一轮达到迭代上限，进度已保留。请继续执行剩余工作。',
    idle_stop: '系统提示：任务尚未完成，不要停下来等用户回复。',
  };
  return {
    shouldResume: true,
    reason: key,
    label: STOP_REASON_TEXT[key] || key,
    hint: (hints[key] || hints.idle_stop) + inferRemainingWork(lastText),
  };
}

export { AUTO_RESUME_STOP_REASONS, STOP_REASON_TEXT };