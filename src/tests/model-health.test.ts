/**
 * v2.0.46 模型健康探针回归测试
 * 覆盖：TTL 缓存语义 / 超时类错误识别 / 探针成功/挂死/429/404 / AIHub 集成（候选过滤+快速失败）
 * 背景：NVIDIA NIM kimi-k3.1-pro「目录在列但推理零响应」幽灵模型实测案例。
 */
import { describe, it, expect, vi } from 'vitest';
import { ModelHealthCache, probeModelHealth, isTimeoutLikeError } from '../ai/model-health.js';
import { AIHub } from '../ai/hub.js';

function mockClient(impl: (body: any, opts?: any) => any): any {
  return { chat: { completions: { create: impl } } };
}

/** 模拟挂死端点：永不 resolve，但 honoring AbortSignal（与 OpenAI SDK 行为一致） */
function hangingClient(): any {
  return mockClient((_body: any, opts?: any) => new Promise((_res, rej) => {
    opts?.signal?.addEventListener('abort', () => {
      const e: any = new Error('Request was aborted.');
      e.name = 'AbortError';
      rej(e);
    });
  }));
}

describe('ModelHealthCache', () => {
  it('标记不健康并按 TTL 过期自动放行', () => {
    vi.useFakeTimers();
    try {
      const cache = new ModelHealthCache(1000);
      cache.markUnhealthy('m1', 'hang');
      expect(cache.isUnhealthy('m1')).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(cache.isUnhealthy('m1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('markHealthy 立即清除标记', () => {
    const cache = new ModelHealthCache();
    cache.markUnhealthy('m1', 'hang');
    cache.markHealthy('m1');
    expect(cache.isUnhealthy('m1')).toBe(false);
    expect(cache.getMark('m1')).toBeNull();
  });

  it('自定义 TTL 覆盖默认值', () => {
    vi.useFakeTimers();
    try {
      const cache = new ModelHealthCache(60_000);
      cache.markUnhealthy('m1', 'hang', 500);
      vi.advanceTimersByTime(501);
      expect(cache.isUnhealthy('m1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('listUnhealthy 只返回未过期标记', () => {
    vi.useFakeTimers();
    try {
      const cache = new ModelHealthCache(1000);
      cache.markUnhealthy('short', 'a', 300);
      cache.markUnhealthy('long', 'b', 5000);
      vi.advanceTimersByTime(400);
      const list = cache.listUnhealthy();
      expect(list.map(m => m.model)).toEqual(['long']);
      expect(list[0].reason).toBe('b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('空模型名忽略、clear 清空', () => {
    const cache = new ModelHealthCache();
    cache.markUnhealthy('', 'x');
    expect(cache.listUnhealthy()).toEqual([]);
    cache.markUnhealthy('m', 'x');
    cache.clear();
    expect(cache.isUnhealthy('m')).toBe(false);
  });
});

describe('isTimeoutLikeError', () => {
  it('识别 AbortError / APIConnectionTimeoutError / 连接错误码 / 超时消息', () => {
    expect(isTimeoutLikeError({ name: 'AbortError', message: 'aborted' })).toBe(true);
    expect(isTimeoutLikeError({ name: 'APIConnectionTimeoutError', message: '' })).toBe(true);
    expect(isTimeoutLikeError({ code: 'ECONNRESET', message: '' })).toBe(true);
    expect(isTimeoutLikeError({ code: 'ETIMEDOUT', message: '' })).toBe(true);
    expect(isTimeoutLikeError({ message: 'Request timed out.' })).toBe(true);
    expect(isTimeoutLikeError({ message: 'socket hang up' })).toBe(true);
  });

  it('不误判 4xx 配置类错误与空值', () => {
    expect(isTimeoutLikeError({ status: 404, message: 'model not found' })).toBe(false);
    expect(isTimeoutLikeError({ status: 401, message: 'Unauthorized' })).toBe(false);
    expect(isTimeoutLikeError(null)).toBe(false);
    expect(isTimeoutLikeError(undefined)).toBe(false);
  });
});

describe('probeModelHealth', () => {
  it('成功 → healthy 并清除旧的不健康标记', async () => {
    const cache = new ModelHealthCache();
    cache.markUnhealthy('m', 'old failure');
    const client = mockClient(async () => ({ choices: [{ message: { content: 'pong' } }] }));
    const r = await probeModelHealth(client, 'm', { cache });
    expect(r.healthy).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(cache.isUnhealthy('m')).toBe(false);
  });

  it('挂死端点 → 短超时判不健康并写入缓存', async () => {
    const cache = new ModelHealthCache();
    const r = await probeModelHealth(hangingClient(), 'ghost-model', { cache, timeoutMs: 50 });
    expect(r.healthy).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(cache.isUnhealthy('ghost-model')).toBe(true);
  });

  it('429 限流 → 不标记不健康（临时状态）', async () => {
    const cache = new ModelHealthCache();
    const client = mockClient(async () => {
      const e: any = new Error('rate limited');
      e.status = 429;
      throw e;
    });
    const r = await probeModelHealth(client, 'm', { cache, timeoutMs: 500 });
    expect(r.healthy).toBe(false);
    expect(r.status).toBe(429);
    expect(cache.isUnhealthy('m')).toBe(false);
  });

  it('404 模型不存在 → 标记不健康', async () => {
    const cache = new ModelHealthCache();
    const client = mockClient(async () => {
      const e: any = new Error('model not found');
      e.status = 404;
      throw e;
    });
    const r = await probeModelHealth(client, 'm', { cache, timeoutMs: 500 });
    expect(r.healthy).toBe(false);
    expect(cache.isUnhealthy('m')).toBe(true);
  });
});

describe('AIHub 健康缓存集成', () => {
  function hubWithModels(models: string[]): AIHub {
    const hub = new AIHub();
    hub.addProvider({
      id: 'test-provider',
      type: 'custom',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key-not-real',
      models,
    } as any);
    return hub;
  }

  it('getFailoverCandidates 排除健康缓存标记不健康的模型', () => {
    const hub = hubWithModels(['ghost-model', 'good-model']);
    hub.modelHealth.markUnhealthy('ghost-model', 'probe timeout');
    const cands = hub.getFailoverCandidates('ghost-model');
    expect(cands.find(c => c.resolvedModel === 'ghost-model')).toBeUndefined();
  });

  it('generate 对不健康模型快速失败（不干等客户端超时）', async () => {
    const hub = hubWithModels(['ghost-model']);
    hub.modelHealth.markUnhealthy('ghost-model', 'probe timeout');
    await expect(
      hub.generate({ model: 'ghost-model', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/模型不健康/);
  });

  it('未标记模型不受影响（候选正常返回）', () => {
    const hub = hubWithModels(['good-model']);
    const cands = hub.getFailoverCandidates('good-model');
    expect(cands.some(c => c.resolvedModel === 'good-model')).toBe(true);
  });

  it('probeModel 对无法解析的模型返回 null', async () => {
    const hub = new AIHub();
    const r = await hub.probeModel('definitely-not-existing-model-xyz', 100);
    expect(r).toBeNull();
  });
});
