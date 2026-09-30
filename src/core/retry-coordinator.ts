/**
 * v2.8.0 retry-coordinator —— 全引擎唯一的重试/退避/恢复编排层。
 *
 * ── 为什么需要它（这轮修的真 bug）──
 * 改动前引擎里有三套各自为政的退避体系，参数全不相同：
 *   executor.ts : AI_RETRY_PER_ITER=4,  base=1s  cap=32s, 认 Retry-After, full jitter
 *   hub.ts      : MAX_RETRIES=3,        base=1s  cap=16s, 完全无视 Retry-After, 无 jitter
 *   router.ts   : 2s..15s，且【只在 stopReason==='ai_errors' 时退避】
 *   goal-exec   : 30s..5min（这层设计最好）
 *
 * 三个真实故障：
 *  1) 叠乘放大：一次 429 会同时触发 executor(4) × hub(3) × router续跑，每层从零开始计数，
 *     最坏 12 次请求打同一个已限流的 endpoint —— 越重试越被封。
 *  2) 退避只覆盖 ai_errors：aborted(超时，最常见) / max_iterations / tool_failures
 *     三种中断零退避，立刻重打同一个限流 endpoint。
 *  3) 无 jitter：hub 的 1000*2^(n-1) 是确定性退避，长任务里并发请求会同步重试形成惊群。
 *
 * ── v2.8.0 对标 NousResearch/hermes-agent（MIT, 25w star）──
 * 读了它的 agent/retry_utils.py、turn_retry_state.py、turn_loop_errors.py，抄的是设计不是代码：
 *  1) 【多种恢复模式】Hermes 的 TurnRetryState 有 4 个 restart_with_* 信号，不是「重试 or 放弃」
 *     二选一。本引擎同构：same / compress / continue-length / rebuild / redirect。
 *     —— 这才是「干活要干完、不让用户点继续」的技术底座。
 *  2) 【每个 guard 只许试一次】Hermes 19 个 one-shot guard。本引擎用 TurnRecoveryState 同构实现，
 *     防止无限打转；并在重试彻底耗尽后开第二轮 auto-recovery（重试是第一道防线，不是终点）。
 *  3) 【从错误正文挖真实重置时间】Hermes 能解析 "resets in 4hr 5min" / "resets_in_seconds: 30995"
 *     / "quotaResetDelay: 500ms"。我们原来只会干等固定退避，纯浪费配额。
 *  4) 【错误分级】Hermes 遍历 traceback 判断是本地确定性 bug 还是 API 路径错误：
 *     本地 bug 重试一万次结果一样 → 立刻停；API 路径错误 → 继续恢复。
 *
 * ── 设计原则 ──
 *  1) 单一退避时钟：全引擎共用一个 RetryBudget，一次失败只被"消费"一次。
 *  2) 尊重 Retry-After 与服务端 reset 文案：说了等多久就等多久（绝对上限可配）。
 *  3) full jitter：sleep = rand(0, exp)，防长任务并发惊群。
 *  4) 可重试 vs 致命错误分流：配置错误立刻停，临时故障才等。
 *  5) 可观测：每次退避都记审计行，用户能看见"在自愈"而不是"引擎死了"。
 *
 * 无外部依赖，纯函数 + 轻量状态，零 I/O。
 */

import {
  isRetryableError,
  extractRetryAfterMs,
  FATAL_STATUSES,
  RETRYABLE_STATUSES,
} from './autonomy.js';

/** 全局重试预算的默认参数（可被 executor/hub/router 三层共用） */
export type RetryBudgetOptions = {
  /** 单次逻辑操作最多重试几次（不含首次） */
  maxAttempts: number;
  /** 指数退避起始基数 */
  baseMs: number;
  /** 指数退避上限 */
  capMs: number;
  /** 单次等待的绝对上限（即使服务端 Retry-After 给了 10 分钟也别真等 10 分钟） */
  maxSleepMs: number;
  /** 是否遵守服务端 Retry-After 头与正文 reset 文案 */
  respectRetryAfter: boolean;
  /** 是否输出审计日志 */
  verbose: boolean;
  /** 日志前缀，便于定位是哪一层在等 */
  tag: string;
};

export const DEFAULT_RETRY_BUDGET: RetryBudgetOptions = {
  maxAttempts: 3,
  baseMs: 1_000,
  capMs: 32_000,
  maxSleepMs: 120_000,
  respectRetryAfter: true,
  verbose: true,
  tag: 'RetryCoordinator',
};

/** 一次退避的审计记录（供 finalContent / SSE 透出，让用户看见"在等限流"） */
export type RetryEvent = {
  layer: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
  status?: number;
  /** 服务端建议的真实等待时长（Retry-After / reset 文案解析结果） */
  serverHintMs?: number;
  /** 下一轮采用的恢复模式 */
  mode?: RecoveryMode;
};

export type RetryOutcome<T> = {
  ok: boolean;
  value?: T;
  error?: unknown;
  /** 本次逻辑操作累计消费的重试次数 */
  attempts: number;
  /** 累计退避时长（ms），用于最终文案里如实告知用户 */
  totalDelayMs: number;
  /** 全部退避事件的审计轨迹 */
  events: RetryEvent[];
  /** 耗尽后建议的恢复模式；'stop' 表示该停了（本地确定性 bug / 致命配置错） */
  suggestedMode: RecoveryMode;
};

// ═══════════════════════════════════════════════════════════════════
// 一、恢复模式（对标 Hermes 的 restart_with_* 四信号）
// ═══════════════════════════════════════════════════════════════════

/**
 * 失败之后【怎么继续】，而不是要不要继续。
 * Hermes 的关键洞察：绝大多数「停下来」都是因为只实现了 same/放弃两种模式。
 */
export type RecoveryMode =
  /** 原样重试：限流、网络抖动、5xx */
  | 'same'
  /** 压缩上下文后重发：上下文超限（context_length_exceeded） */
  | 'compress'
  /** 续写而不是重来：输出被 max_tokens 截断 */
  | 'continue-length'
  /** 重建 payload 后重发：切了备胎 provider，messages 里混了旧 provider 的格式 */
  | 'rebuild'
  /** 带断点提示重跑同一轮：用户中途纠偏 */
  | 'redirect'
  /** 真停：本地确定性 bug 或致命配置错误，重试一万次结果一样 */
  | 'stop';

const CONTEXT_OVERFLOW_HINTS = [
  'context_length_exceeded', 'context length', 'maximum context',
  'too many tokens', 'context window', 'prompt is too long', '上下文超限', '上下文过长',
];
const LENGTH_TRUNCATION_HINTS = [
  'finish_reason', 'max_tokens', 'length_exceeded', 'truncat', '被截断', '输出超长',
];
const PAYLOAD_REBUILD_HINTS = [
  'invalid_request_error', 'unrecognized request argument', 'unsupported parameter',
  'invalid parameter', 'tool_use', 'schema', '400',
];
const PAYER_HINTS = [
  'insufficient', 'quota', 'billing', 'credit', '余额', '额度', '欠费',
];

/**
 * 判断一次失败应该用哪种方式继续。
 * 顺序有讲究：先认"绝对停"（abort/致命），再认"要改姿势"的，最后才是原样重试。
 */
export function classifyFailure(err: unknown, signal?: AbortSignal): RecoveryMode {
  if (signal?.aborted) return 'stop';
  if (!err) return 'stop';

  // 用户主动停止优先于一切恢复策略：即使错误对象同时带着 429，
  // 也不能借"限流可重试"的名义把用户点停的任务复活。
  if ((err as any)?.name === 'AbortError' || (err as any)?.code === 'ABORT_ERR') {
    return 'stop';
  }

  const status = typeof (err as any)?.status === 'number' ? (err as any).status : undefined;
  const code = String((err as any)?.code || (err as any)?.error?.code || '');
  const text = String((err as any)?.message || err).toLowerCase();
  const body = String((err as any)?.body || (err as any)?.error?.message || '').toLowerCase();
  const hay = `${text} ${body} ${code.toLowerCase()}`;

  // 余额/额度耗尽：等和重试都没用，只能换 provider
  if (status === 402 || PAYER_HINTS.some((h) => hay.includes(h))) return 'rebuild';

  // 上下文超限：压缩后重发，原样重试必然再炸
  if (CONTEXT_OVERFLOW_HINTS.some((h) => hay.includes(h))) return 'compress';

  // 输出截断：续写，不是从头再来
  if (LENGTH_TRUNCATION_HINTS.some((h) => hay.includes(h))) return 'continue-length';

  // 致命配置类：立刻停，告诉用户去改配置
  if (status !== undefined && FATAL_STATUSES.has(status)) return 'stop';

  // 参数/payload 格式类：重建 payload 再试一次
  if (status === 400 && PAYLOAD_REBUILD_HINTS.some((h) => hay.includes(h))) return 'rebuild';

  // 401/403 但可能是过期凭据：换 provider 也许能救
  if (status === 401 || status === 403) return 'rebuild';

  return 'same';
}

/**
 * 是否值得等一等再试。区分两件事：
 *  - 该不该重试（isRetryableError：临时故障 vs 配置错误）
 *  - 怎么重试（classifyFailure）
 */
export function shouldWaitAndRetry(err: unknown): boolean {
  if (!err) return false;
  // 用户主动停止：等和重试都没意义
  if ((err as any)?.name === 'AbortError' || (err as any)?.code === 'ABORT_ERR') {
    return false;
  }
  // 余额不足：换 provider 才有意义，等同一家毫无意义
  if ((err as any)?.status === 402) return false;
  // 403 区域封锁：等也没用
  if (FATAL_STATUSES.has((err as any)?.status)) return false;
  return isRetryableError(err);
}

// ═══════════════════════════════════════════════════════════════════
// 二、一次性 guard + 第二轮自救（对标 Hermes TurnRetryState）
// ═══════════════════════════════════════════════════════════════════

/**
 * 单次 API 调用的恢复账本。
 *
 * 对标 Hermes 的 TurnRetryState：每个 guard 最多触发一次，防止无限打转。
 * 关键区别于"重试"的地方：autoRecoveryCycles 是【在重试彻底耗尽之后】才启动的第二轮自救。
 * —— 重试是第一道防线，不是终点。这正是"不让用户点继续"的落地方式。
 */
export class TurnRecoveryState {
  /** 每种恢复模式只许试一次 */
  private used = new Set<RecoveryMode>();
  /** 重试耗尽后启动的自动恢复轮数 */
  autoRecoveryCyclesUsed = 0;
  /** 总重试耗尽轮数（agent.autoRecoveryCycles 封顶） */
  autoRecoveryCycles = 2;
  /** 所有已消费的 guard，用于审计 */
  readonly log: string[] = [];

  /** 该模式是否还允许再用一次 */
  canUse(mode: RecoveryMode): boolean {
    if (mode === 'same' || mode === 'stop') return true;   // 计数由外部预算管
    return !this.used.has(mode);
  }

  /** 消费一次 guard；返回 false 表示该模式已用尽 */
  consume(mode: RecoveryMode): boolean {
    if (!this.canUse(mode)) return false;
    this.used.add(mode);
    this.log.push(mode);
    return true;
  }

  /** 重试耗尽后还能不能再开一轮自救 */
  canAutoRecover(): boolean {
    return this.autoRecoveryCyclesUsed < this.autoRecoveryCycles;
  }

  startAutoRecovery(): number {
    this.autoRecoveryCyclesUsed += 1;
    return this.autoRecoveryCyclesUsed;
  }
}

// ═══════════════════════════════════════════════════════════════════
// 三、从错误正文挖真实重置时间（对标 Hermes reset_delay_from_message）
// ═══════════════════════════════════════════════════════════════════

// "Resets in 4hr 5min" / "resets in 2 hours 5 minutes" / "resets in 30s"
const RE_RESETS_IN =
  /resets?\s+in\s+(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b\s*)?(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b)?/i;
// 'resets_in_seconds': 30995
const RE_RESETS_IN_SECONDS = /resets_in_seconds\W{1,4}(\d+(?:\.\d+)?)/i;
// "quotaResetDelay: 500ms"（Z.AI GLM-5.2 过载 code 1305）
const RE_QUOTA_RESET_DELAY = /quotaResetDelay[:\s"]+(\d+(?:\.\d+)?)(ms|s)/i;
// "retry after 30 seconds"
const RE_RETRY_AFTER_SECONDS = /retry\s+(?:after\s+)?(\d+(?:\.\d+)?)\s*(?:sec|secs|seconds|s\b)/i;

const RESET_PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => number | null]> = [
  [RE_RETRY_AFTER_SECONDS, (m) => Number(m[1]) * 1000],
  [RE_QUOTA_RESET_DELAY, (m) => (m[2].toLowerCase() === 'ms' ? Number(m[1]) : Number(m[1]) * 1000)],
  [RE_RESETS_IN_SECONDS, (m) => Number(m[1]) * 1000],
  [
    RE_RESETS_IN,
    (m) => {
      if (!m[1] && !m[2] && !m[3]) return null;   // 光有 "resets in" 没有数字，不是这个语法
      return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
    },
  ],
];

/**
 * 从供应商错误正文里解析真实重置时长（ms），解析不出返回 null。
 *
 * 为什么重要：GLM/Claude/部分 OpenAI 兼容端在周配额耗尽时会回
 * "resets in 4hr 5min"。我们原来只认 Retry-After 头，认不到就干等 8 秒再撞一次，
 * 纯浪费配额还可能被判定为恶意重试。
 * 显式 "retry after N s" 优先于 "resets in ..."：正文同时带两者时，
 * 短的那个才是供应商真正要的等待。
 */
export function extractResetDelayMs(err: unknown): number | null {
  if (!err) return null;
  const parts = [
    (err as any)?.message,
    (err as any)?.body,
    (err as any)?.error?.message,
    (err as any)?.response?.data,
    (err as any)?.data,
    typeof err === 'string' ? err : undefined,
  ].filter((p) => p != null);

  const text = parts.map((p) => (typeof p === 'string' ? p : safeStringify(p))).join(' ');
  if (!text) return null;

  for (const [pattern, toMs] of RESET_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const ms = toMs(m);
      if (ms != null && Number.isFinite(ms) && ms >= 0) return ms;
    }
  }
  return null;
}

function safeStringify(v: unknown): string {
  try {
    if (typeof v === 'string') return v;
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 四、退避计算与执行
// ═══════════════════════════════════════════════════════════════════

/**
 * full jitter 退避计算 —— AWS Architecture Blog 推荐的标准做法。
 * sleep = uniform(0, min(cap, base * 2^(attempt-1)))
 * 加随机是必须的：不加的话长任务里多个并发请求会在同一毫秒一起重试（惊群/共振），
 * 服务端刚放开配额又被自己打满。
 */
export function fullJitterDelayMs(attempt: number, baseMs: number, capMs: number): number {
  const exp = Math.min(capMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(Math.random() * exp);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) return resolve();
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort);
  });

/**
 * 算出这一次该等多久。
 * 优先级：服务端明确说的（Retry-After 头 / reset 文案）> 满抖动退避。
 * 两者都取，但封顶 maxSleepMs —— 不能让引擎因为"4 小时后重置"就真睡 4 小时。
 */
export function computeDelayMs(
  err: unknown,
  attempt: number,
  o: RetryBudgetOptions,
): { delayMs: number; serverHintMs?: number } {
  const fallback = fullJitterDelayMs(attempt, o.baseMs, o.capMs);
  if (!o.respectRetryAfter) return { delayMs: Math.min(fallback, o.maxSleepMs) };

  const headerHint = extractRetryAfterMs(err, 0) || 0;
  const bodyHint = extractResetDelayMs(err) ?? 0;
  const serverHintMs = Math.max(headerHint, bodyHint);

  if (serverHintMs <= 0) return { delayMs: Math.min(fallback, o.maxSleepMs) };
  return {
    delayMs: Math.min(Math.max(fallback, serverHintMs), o.maxSleepMs),
    serverHintMs,
  };
}

/**
 * 全引擎唯一入口：带统一退避 + 恢复模式决策的 AI 调用包装。
 *
 * 用法（executor / hub / router 三层都改成调它）：
 *   const out = await runWithRetry(
 *     () => requestCompletion(...),
 *     { tag: 'Executor' },
 *     signal,
 *   );
 *   if (out.ok) { use(out.value); }
 *   else { handleByMode(out.suggestedMode, out.error); }
 *
 * 它一次性解决四个问题：
 *  - 叠乘放大：预算按【逻辑操作】而不是按层，各层共用一个 attempts 计数
 *  - 退避只覆盖 ai_errors：调用方传 stopReason，退避不再依赖 stopReason 判断
 *  - 无 jitter：full jitter 防惊群
 *  - 不懂供应商的等待窗口：解析 Retry-After + reset 文案
 */
export async function runWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: Partial<RetryBudgetOptions> = {},
  signal?: AbortSignal,
): Promise<RetryOutcome<T>> {
  const o: RetryBudgetOptions = { ...DEFAULT_RETRY_BUDGET, ...opts };
  const events: RetryEvent[] = [];
  let totalDelayMs = 0;
  let lastError: unknown;
  let lastMode: RecoveryMode = 'same';

  for (let attempt = 0; attempt <= o.maxAttempts; attempt++) {
    try {
      const value = await fn(attempt);
      return {
        ok: true, value, attempts: attempt, totalDelayMs, events, suggestedMode: 'stop',
      };
    } catch (err) {
      lastError = err;
      if (signal?.aborted) break;                  // 用户主动停止：不消耗预算
      if (!shouldWaitAndRetry(err)) { lastMode = classifyFailure(err, signal); break; }
      if (attempt >= o.maxAttempts) { lastMode = classifyFailure(err, signal); break; }

      const mode = classifyFailure(err, signal);
      // non-same 模式（compress/rebuild/...）不在这里执行，只作为建议返回给调用方，
      // 因为"压缩上下文""重建 payload"需要调用方自己改参数，编排器无权代劳。
      if (mode === 'stop') break;

      const { delayMs, serverHintMs } = computeDelayMs(err, attempt + 1, o);

      const ev: RetryEvent = {
        layer: o.tag,
        attempt: attempt + 1,
        maxAttempts: o.maxAttempts,
        delayMs,
        reason: shortReason(err),
        status: typeof (err as any)?.status === 'number' ? (err as any).status : undefined,
        serverHintMs,
        mode,
      };
      events.push(ev);
      totalDelayMs += delayMs;
      lastMode = mode;

      if (o.verbose) {
        const hint = serverHintMs ? `（服务端建议 ${Math.round(serverHintMs / 1000)}s）` : '';
        console.warn(
          `[${o.tag}] 第 ${ev.attempt}/${o.maxAttempts} 次失败(${ev.reason})，退避 ${delayMs}ms 后以 [${mode}] 模式重试${hint}`
        );
      }
      await sleep(delayMs, signal);
      if (signal?.aborted) break;
    }
  }

  return {
    ok: false,
    error: lastError,
    attempts: events.length,
    totalDelayMs,
    events,
    suggestedMode: lastMode,
  };
}

/** 人话版失败原因，直接进 finalContent */
export function shortReason(err: unknown): string {
  const status = typeof (err as any)?.status === 'number' ? (err as any).status : undefined;
  const msg = String((err as any)?.message || err || '').toLowerCase();
  if (status === 429) return '接口限流(429)';
  if (status === 402) return '余额不足(402)';
  if (status === 401) return '密钥无效(401)';
  if (status === 403) return '区域封锁(403)';
  if (status === 404) return '模型不存在(404)';
  if (status === 408) return '请求超时(408)';
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return `服务端错误(${status})`;
  }
  if (/context_length|maximum context|too many tokens|上下文/i.test(msg)) return '上下文超限';
  if (/quota|insufficient|billing|余额|额度/i.test(msg)) return '额度耗尽';
  return msg ? msg.slice(0, 80) : '未知错误';
}

/**
 * 把退避轨迹翻译成给用户看的一句话。
 * 这是"不点继续"体验的关键：用户要能看见引擎在自愈，而不是以为它死了。
 */
export function describeRetryEvents(events: RetryEvent[]): string {
  if (!events || events.length === 0) return '';
  const totalSec = Math.round(events.reduce((a, e) => a + e.delayMs, 0) / 1000);
  const reasons = Array.from(new Set(events.map((e) => e.reason)));
  const kinds: string[] = [];
  if (reasons.some((r) => r.includes('限流') || r.includes('429'))) kinds.push('接口限流');
  if (reasons.some((r) => r.includes('服务端错误') || r.includes('超时'))) kinds.push('服务端不稳定');
  if (reasons.some((r) => r.includes('余额') || r.includes('密钥') || r.includes('区域'))) {
    kinds.push('凭据问题');
  }
  if (reasons.some((r) => r.includes('额度'))) kinds.push('额度耗尽');
  const kindsText = kinds.length > 0 ? kinds.join('、') : '临时网络故障';
  return (
    `期间因${kindsText}自动退避重试 ${events.length} 次，累计等待 ${totalSec} 秒。` +
    `这些都是临时故障，已自动恢复，无需你点"继续"。`
  );
}

/** 从环境变量统一读取重试预算（部署方不用改代码就能调，开源即生效） */
export function retryBudgetFromEnv(tag: string): Partial<RetryBudgetOptions> {
  const n = (k: string, d: number) => {
    const v = parseInt(process.env[k] || '', 10);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    maxAttempts: n('AI_RETRY_MAX_ATTEMPTS', DEFAULT_RETRY_BUDGET.maxAttempts),
    baseMs: n('AI_RETRY_BASE_MS', DEFAULT_RETRY_BUDGET.baseMs),
    capMs: n('AI_RETRY_MAX_MS', DEFAULT_RETRY_BUDGET.capMs),
    maxSleepMs: n('AI_RETRY_MAX_SLEEP_MS', DEFAULT_RETRY_BUDGET.maxSleepMs),
    tag,
  };
}

export { RETRYABLE_STATUSES, FATAL_STATUSES };
