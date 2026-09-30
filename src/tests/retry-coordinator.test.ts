/**
 * v2.8.0：统一重试协调器回归测试
 *
 * 这些断言针对用户真实投诉「失败后为何不自动重试 / 一直让我点继续」，
 * 每一项都必须能独立复现一个曾经的线上故障。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classifyFailure,
  shouldWaitAndRetry,
  computeDelayMs,
  fullJitterDelayMs,
  extractResetDelayMs,
  runWithRetry,
  TurnRecoveryState,
  DEFAULT_RETRY_BUDGET,
} from '../core/retry-coordinator.js';

afterEach(() => {
  vi.useRealTimers();
});

/** 造一个带 HTTP 状态的错误 */
function httpErr(status: number, msg = 'boom') {
  const e: any = new Error(msg);
  e.statusCode = status;
  e.status = status;
  return e;
}

describe('1. 错误分类：限流必须可重试，凭据必须停', () => {
  it('429 限流 → 可恢复（用户不该被要求点继续）', () => {
    expect(shouldWaitAndRetry(httpErr(429))).toBe(true);
  });

  it('500/502/503 → 可恢复', () => {
    for (const s of [500, 502, 503, 504]) {
      expect(shouldWaitAndRetry(httpErr(s))).toBe(true);
    }
  });

  it('网络抖动（ECONNRESET / ETIMEDOUT）→ 可恢复', () => {
    const a: any = new Error('socket hang up');
    a.code = 'ECONNRESET';
    expect(shouldWaitAndRetry(a)).toBe(true);
    const b: any = new Error('connect ETIMEDOUT 1.2.3.4:443');
    b.code = 'ETIMEDOUT';
    expect(shouldWaitAndRetry(b)).toBe(true);
  });

  it('401 凭据错误 → 致命，重试一万次也没用', () => {
    expect(shouldWaitAndRetry(httpErr(401, 'Invalid API key'))).toBe(false);
  });

  it('404 模型不存在 → 致命', () => {
    expect(shouldWaitAndRetry(httpErr(404, 'model not found'))).toBe(false);
  });

  it('用户主动 AbortError → 致命（不能违背用户意愿继续跑）', () => {
    const e: any = new Error('aborted');
    e.name = 'AbortError';
    expect(shouldWaitAndRetry(e)).toBe(false);
  });

  it('AbortError 即使带 429 也仍然致命 —— 停止优先级高于重试', () => {
    const e: any = new Error('aborted');
    e.name = 'AbortError';
    e.statusCode = 429;
    expect(shouldWaitAndRetry(e)).toBe(false);
  });
});

describe('2. 退避时长：必须有 jitter，且尊重服务端', () => {
  it('full jitter 随 attempt 增长但不超过 cap', () => {
    const d1 = fullJitterDelayMs(1, 1000, 32000);
    const d10 = fullJitterDelayMs(10, 1000, 32000);
    expect(d1).toBeLessThanOrEqual(1000);
    expect(d10).toBeLessThanOrEqual(32000);
  });

  it('jitter 确实产生不同值（防惊群，不是写死常数）', () => {
    const samples = new Set<number>();
    for (let i = 0; i < 40; i++) samples.add(fullJitterDelayMs(5, 1000, 32000));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('Retry-After: 30 秒 → 至少等 30 秒', () => {
    const e: any = new Error('slow down');
    e.headers = { 'retry-after': '30' };
    const { delayMs, serverHintMs } = computeDelayMs(e, 1, DEFAULT_RETRY_BUDGET);
    expect(serverHintMs).toBeGreaterThanOrEqual(30000);
    expect(delayMs).toBeGreaterThanOrEqual(30000);
  });

  it('服务端要求 4 小时重置 → 封顶在 maxSleepMs，绝不真睡 4 小时', () => {
    const e: any = new Error('rate limited, resets in 4hr 5min');
    const { delayMs, serverHintMs } = computeDelayMs(e, 1, DEFAULT_RETRY_BUDGET);
    expect(serverHintMs).toBeGreaterThan(4 * 3600 * 1000);
    expect(delayMs).toBeLessThanOrEqual(DEFAULT_RETRY_BUDGET.maxSleepMs);
  });

  it('尊重 Retry-After 头（秒数）', () => {
    expect(extractResetDelayMs(httpErr(429, 'quota exceeded, resets_in_seconds: 45'))).toBe(45_000);
  });

  it('尊重 Retry-After 头（HTTP 日期）', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const e: any = new Error('429');
    e.headers = { 'retry-after': future };
    const { serverHintMs } = computeDelayMs(e, 1, DEFAULT_RETRY_BUDGET);
    expect(serverHintMs).toBeGreaterThan(30_000);
  });

  it('Retry-After 秒数不被腰斩（封顶交给 maxSleepMs）', () => {
    const e: any = new Error('slow down');
    e.headers = { 'retry-after': '600' };
    const { serverHintMs } = computeDelayMs(e, 1, DEFAULT_RETRY_BUDGET);
    expect(serverHintMs).toBeGreaterThanOrEqual(600_000);   // 原来被砍成 120s
  });

  it('Retry-After 过去的日期不应产生负等待', () => {
    const past = new Date(Date.now() - 600_000).toUTCString();
    const e: any = new Error('429');
    e.headers = { 'retry-after': past };
    const { delayMs } = computeDelayMs(e, 1, DEFAULT_RETRY_BUDGET);
    expect(delayMs).toBeGreaterThanOrEqual(0);
  });

  it('没有服务端提示时退化为满抖动，不会是 0', () => {
    const { delayMs } = computeDelayMs(httpErr(500), 3, DEFAULT_RETRY_BUDGET);
    expect(delayMs).toBeGreaterThanOrEqual(0);
    expect(delayMs).toBeLessThanOrEqual(DEFAULT_RETRY_BUDGET.capMs);
  });
});

describe('3. runWithRetry：必须真的自己重试到成功', () => {
  it('前两次 429，第三次成功 → 不甩锅给用户，自动走完', async () => {
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls++;
        if (calls < 3) throw httpErr(429);
        return 'ok';
      },
      { baseMs: 1, capMs: 2, maxSleepMs: 4, verbose: false },
    );
    expect(out.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('重试耗尽 → ok=false 且带上原始错误，不会伪装成成功', async () => {
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls++;
        throw httpErr(429);
      },
      { maxAttempts: 2, baseMs: 1, capMs: 2, maxSleepMs: 4, verbose: false },
    );
    expect(out.ok).toBe(false);
    expect(calls).toBe(3); // 首次 + 2 次重试
  });

  it('致命错误一次都不重试（401 不浪费 30 秒）', async () => {
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls++;
        throw httpErr(401);
      },
      { baseMs: 1, capMs: 2, maxSleepMs: 4, verbose: false },
    );
    expect(out.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('中途被 abort → 立刻停止，不再重试', async () => {
    const ac = new AbortController();
    let calls = 0;
    const out = await runWithRetry(
      async () => {
        calls++;
        ac.abort();
        throw httpErr(429);
      },
      { baseMs: 1, capMs: 2, maxSleepMs: 4, verbose: false },
      ac.signal,
    );
    expect(calls).toBe(1);
    expect(out.ok).toBe(false);
  });
});

describe('4. TurnRecoveryState：恢复动作必须一次性，不能无限循环', () => {
  it('一次性 guard：compress 用掉后不能再用', () => {
    const st = new TurnRecoveryState();
    expect(st.canUse('compress')).toBe(true);
    expect(st.consume('compress')).toBe(true);       // 扣掉额度
    expect(st.canUse('compress')).toBe(false);      // 再来一次被拒
  });

  it('不同恢复模式互不干扰', () => {
    const st = new TurnRecoveryState();
    expect(st.consume('compress')).toBe(true);
    expect(st.canUse('redirect')).toBe(true);      // 换 provider 不受 compress 影响
  });

  it('canUse 是只读查询，不消耗额度', () => {
    const st = new TurnRecoveryState();
    st.canUse('compress');
    st.canUse('compress');
    expect(st.canUse('compress')).toBe(true);      // 查了两次依然可用
  });

  it('same / stop 不受一次性 guard 限制（预算交给外部）', () => {
    const st = new TurnRecoveryState();
    expect(st.consume('same')).toBe(true);
    expect(st.canUse('same')).toBe(true);
  });

  it('默认开启多轮自动恢复预算（Hermes 同款思路）', () => {
    const st = new TurnRecoveryState();
    expect(st.canAutoRecover()).toBe(true);
    expect(st.startAutoRecovery()).toBe(1);
    expect(st.canAutoRecover()).toBe(true);
    expect(st.startAutoRecovery()).toBe(2);
    expect(st.canAutoRecover()).toBe(false);        // 预算用尽，不再无限自救
  });

  it('恢复动作留审计痕迹，便于事后查账', () => {
    const st = new TurnRecoveryState();
    st.consume('compress');
    st.consume('redirect');
    expect(st.log).toEqual(['compress', 'redirect']);
  });
});

describe('5. recover 模式语义', () => {
  it('限流 → 原地重试', () => {
    expect(classifyFailure(httpErr(429))).toBe('same');
  });

  it('上下文超长 → 压缩后重发', () => {
    expect(classifyFailure(httpErr(413, 'context length exceeded'))).toBe('compress');
  });

  it('凭据错 → stop，绝不重试', () => {
    expect(classifyFailure(httpErr(401))).toBe('stop');
  });
});