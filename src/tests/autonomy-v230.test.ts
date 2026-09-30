/**
 * v2.3.0 autonomy 回归测试 — 长任务自愈（不让用户点"继续"）。
 *
 * ── 契约变更说明 ──
 * v2.2.0 测试断言 `ai_errors` **不**自动续跑（原意：AI 挂了要人来修）。
 * v2.3.0 推翻该契约：429 限流 / 5xx / 网络抖动属于"外部暂时不可用"，
 * 而非"任务做不下去"。让用户反复点"继续"是产品缺陷，不是安全设计。
 * 因此本文件按 v2.3.0 契约重写，并补充限流退避相关的单测。
 */
import { describe, it, expect } from 'vitest';
import {
  decideAutoResume,
  isRetryableError,
  extractRetryAfterMs,
  backoffDelayMs,
  inferRemainingWork,
  RETRYABLE_STATUSES,
  FATAL_STATUSES,
} from '../core/autonomy.js';

describe('v2.3.0 autonomy — 任务未完成就自己接着干', () => {
  it('completed 不续跑（唯一该交还控制权的情况）', () => {
    expect(decideAutoResume('completed', '').shouldResume).toBe(false);
  });

  it('undefined 视为 completed', () => {
    expect(decideAutoResume(undefined, '').shouldResume).toBe(false);
  });

  // ── v2.3.0 核心断言：这些"看起来像失败"的原因都要自愈 ──
  const selfHealReasons = ['idle_stop', 'aborted', 'max_iterations', 'tool_failures', 'repeat_tool', 'ai_errors'];
  for (const r of selfHealReasons) {
    it(`${r} 自动续跑`, () => {
      const d = decideAutoResume(r, '');
      expect(d.shouldResume).toBe(true);
      expect(d.hint).toContain('系统提示');
    });
  }

  it('未知原因不续跑（保守策略：不能瞎猜）', () => {
    expect(decideAutoResume('some_unknown_reason', '').shouldResume).toBe(false);
  });

  it('ai_errors 的续跑话术必须说明"不是任务失败"', () => {
    const d = decideAutoResume('ai_errors', '');
    expect(d.hint).toContain('限流');
    expect(d.hint).toContain('不是任务本身做不下去');
    expect(d.hint).toContain('不要因为报错就停下');
  });

  it('每种可续跑原因都有专属话术，不是一句万能的"请点继续"', () => {
    for (const r of selfHealReasons) {
      const d = decideAutoResume(r, '');
      expect(d.hint.length).toBeGreaterThan(20);
      expect(d.label).toBeTruthy();
    }
  });

  it('续跑话术注入上一轮未完成清单', () => {
    const text = '进度：\n- [x] 读完文件\n- [ ] 写报告\n- [ ] 发邮件';
    const d = decideAutoResume('idle_stop', text);
    expect(d.hint).toContain('写报告');
    expect(d.hint).toContain('发邮件');
    expect(d.hint).not.toContain('读完文件');
  });

  it('清单里没有待办项时不硬造提示', () => {
    expect(inferRemainingWork('全部搞定了，没有别的了。')).toBe('');
    expect(decideAutoResume('idle_stop', 'done').hint).not.toContain('未完成项');
  });

  it('能从散文里提"下一步"', () => {
    const d = decideAutoResume('aborted', '前面做完了，接下来：导出 PDF');
    expect(d.hint).toContain('导出 PDF');
  });
});

describe('v2.3.0 retryable error classification', () => {
  it('429/5xx 归类为可重试', () => {
    for (const s of [408, 409, 425, 429, 500, 502, 503, 504, 529]) {
      expect(RETRYABLE_STATUSES.has(s)).toBe(true);
      expect(isRetryableError({ status: s })).toBe(true);
    }
  });

  it('400/401/403/404/410/422 归类为不可重试（配置错误重试无意义）', () => {
    for (const s of [400, 401, 403, 404, 410, 422]) {
      expect(FATAL_STATUSES.has(s)).toBe(true);
      expect(isRetryableError({ status: s })).toBe(false);
    }
  });

  it('无 status 的网络层错误也可重试', () => {
    expect(isRetryableError({ message: 'socket hang up' })).toBe(true);
    expect(isRetryableError({ message: 'fetch failed' })).toBe(true);
    expect(isRetryableError({ message: 'ECONNRESET' })).toBe(true);
    expect(isRetryableError({ message: 'ETIMEDOUT' })).toBe(true);
  });

  it('未识别的错误不臆测为可重试', () => {
    expect(isRetryableError({ message: 'some domain specific failure' })).toBe(false);
    expect(isRetryableError(null)).toBe(false);
  });

  it('status 优先级高于 message 关键字', () => {
    // 403 + "rate limit" 字样：status 说是权限问题，就不该重试
    expect(isRetryableError({ status: 403, message: 'rate limit' })).toBe(false);
  });
});

describe('v2.3.0 backoff', () => {
  it('尊重 Retry-After 头', () => {
    const ms = extractRetryAfterMs({ headers: { get: (k: string) => (k === 'retry-after' ? '30' : null) } }, 1000);
    expect(ms).toBe(30_000);
  });

  it('Retry-After 超大值如实返回，不在解析层腰斩', () => {
    // 解析层只负责还原；封顶交给调用方 maxSleepMs（见 retry-coordinator.test.ts）
    const ms = extractRetryAfterMs({ headers: { get: () => '9999' } }, 1000);
    expect(ms).toBe(9_999_000);
  });

  it('Retry-After 的 HTTP-date 格式被正确解析', () => {
    const at = new Date(Date.now() + 90_000).toUTCString();
    const ms = extractRetryAfterMs({ headers: { get: () => at } }, 1000);
    expect(ms).toBeGreaterThan(60_000);
    expect(ms).toBeLessThanOrEqual(91_000);
  });

  it('Retry-After 日期已过期 → 返回 0 而非负数', () => {
    const past = new Date(Date.now() - 90_000).toUTCString();
    const ms = extractRetryAfterMs({ headers: { get: () => past } }, 1000);
    expect(ms).toBe(0);
  });

  it('AbortError 不可重试 —— 用户点停止后任务不能被复活', () => {
    expect(isRetryableError({ name: 'AbortError', message: 'aborted' })).toBe(false);
    expect(isRetryableError({ code: 'ABORT_ERR' })).toBe(false);
  });

  it('AbortError 优先级高于 429 —— 不得借限流名义复活已停止的任务', () => {
    const e: any = new Error('aborted');
    e.name = 'AbortError';
    e.status = 429;
    expect(isRetryableError(e)).toBe(false);
  });

  it('没有 Retry-After 时退回指数退避', () => {
    expect(extractRetryAfterMs({ status: 429 }, 5000)).toBe(5_000);
    expect(extractRetryAfterMs({}, 5000)).toBe(5_000);
  });

  it('backoff 带抖动且永不超过 cap', () => {
    for (let a = 1; a <= 8; a++) {
      const d = backoffDelayMs(a, 1000, 32_000);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(32_000);
    }
  });

  it('早期 attempt 平均等待小于后期', () => {
    const avg = (a: number) => (backoffDelayMs(a, 1000, 32_000) + backoffDelayMs(a, 1000, 32_000)) / 2;
    expect(avg(5)).toBeGreaterThan(avg(1));
  });

  it('limit code 在 body 里也能识别限流（OpenAI 风格）', () => {
    const ms = extractRetryAfterMs({ error: { code: 'rate_limit_error' } }, 1000);
    expect(ms).toBeGreaterThanOrEqual(2000);
  });
});
