/**
 * metrics.test.ts — 可观测性指标模块单测（v2.0.42 接线修复配套）
 *
 * 覆盖：计数器/直方图/gauge、Prometheus 文本格式、标签转义、
 *       路由归一化（防标签基数爆炸）、METRICS_ENABLED 开关、中间件行为。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  inc, observe, setGauge, resetMetrics, renderMetrics, normalizeRoute, metricsMiddleware,
} from '../middleware/metrics.js';

beforeEach(() => resetMetrics());

describe('metrics counters / histograms / gauges', () => {
  it('inc accumulates with and without labels', () => {
    inc('lingxi_ai_calls_total', { model: 'm1', type: 'chat' });
    inc('lingxi_ai_calls_total', { model: 'm1', type: 'chat' }, 4);
    inc('lingxi_test_plain');
    const out = renderMetrics();
    expect(out).toContain('lingxi_ai_calls_total{model="m1",type="chat"} 5');
    expect(out).toContain('lingxi_test_plain 1');
    expect(out).toContain('# TYPE lingxi_ai_calls_total counter');
  });

  it('observe records count and sum (summary style)', () => {
    observe('lingxi_http_request_duration_ms', 10, { route: '/api/health' });
    observe('lingxi_http_request_duration_ms', 30, { route: '/api/health' });
    const out = renderMetrics();
    expect(out).toContain('lingxi_http_request_duration_ms_count{route="/api/health"} 2');
    expect(out).toContain('lingxi_http_request_duration_ms_sum{route="/api/health"} 40');
    expect(out).toContain('# TYPE lingxi_http_request_duration_ms summary');
  });

  it('setGauge overwrites previous value', () => {
    setGauge('lingxi_agents', 3);
    setGauge('lingxi_agents', 7);
    expect(renderMetrics()).toContain('lingxi_agents 7');
  });

  it('always exposes lingxi_up and process_uptime_seconds', () => {
    const out = renderMetrics();
    expect(out).toContain('lingxi_up 1');
    expect(out).toMatch(/process_uptime_seconds \d+/);
  });

  it('escapes double quotes in label values', () => {
    inc('lingxi_test_escape', { model: 'a"b' });
    expect(renderMetrics()).toContain('model="a\\"b"');
  });

  it('resetMetrics clears everything', () => {
    inc('lingxi_tmp'); observe('lingxi_tmp_h', 1); setGauge('lingxi_tmp_g', 9);
    resetMetrics();
    const out = renderMetrics();
    expect(out).not.toContain('lingxi_tmp');
  });
});

describe('normalizeRoute (cardinality guard)', () => {
  it('replaces numeric segments with :id', () => {
    expect(normalizeRoute('/api/chats/12345/messages')).toBe('/api/chats/:id/messages');
    expect(normalizeRoute('/api/users/42')).toBe('/api/users/:id');
  });

  it('replaces UUID segments with :id', () => {
    expect(normalizeRoute('/api/sessions/123e4567-e89b-12d3-a456-426614174000/x'))
      .toBe('/api/sessions/:id/x');
  });

  it('replaces long hex segments (tokens / instance ids)', () => {
    expect(normalizeRoute('/api/peer/deadbeefdeadbeef0123/ping')).toBe('/api/peer/:id/ping');
  });

  it('keeps static routes untouched and strips query strings', () => {
    expect(normalizeRoute('/api/health')).toBe('/api/health');
    expect(normalizeRoute('/api/health?x=1')).toBe('/api/health');
  });

  it('caps pathological path length', () => {
    expect(normalizeRoute('/' + 'a'.repeat(500)).length).toBeLessThanOrEqual(201);
  });
});

describe('metricsMiddleware', () => {
  const fakeRes = () => {
    const handlers: Record<string, Function[]> = {};
    return {
      statusCode: 200,
      on(ev: string, fn: Function) { (handlers[ev] = handlers[ev] || []).push(fn); },
      emit(ev: string) { (handlers[ev] || []).forEach(f => f()); },
    };
  };

  it('records request count and duration on finish', () => {
    const mw = metricsMiddleware();
    const req: any = { method: 'GET', path: '/api/chats/99/messages', baseUrl: '' };
    const res: any = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    res.emit('finish');
    const out = renderMetrics();
    expect(out).toContain('lingxi_http_requests_total{method="GET",route="/api/chats/:id/messages",status="200"} 1');
    expect(out).toContain('lingxi_http_request_duration_ms_count{method="GET",route="/api/chats/:id/messages"} 1');
  });

  it('prefers matched express route over raw path', () => {
    const mw = metricsMiddleware();
    const req: any = { method: 'POST', path: '/api/chats/7/send', baseUrl: '', route: { path: '/api/chats/:id/send' } };
    const res: any = fakeRes();
    mw(req, res, () => {});
    res.emit('finish');
    expect(renderMetrics()).toContain('route="/api/chats/:id/send"');
  });

  describe('METRICS_ENABLED switch', () => {
    const OLD = process.env.METRICS_ENABLED;
    afterEach(() => {
      if (OLD === undefined) delete process.env.METRICS_ENABLED;
      else process.env.METRICS_ENABLED = OLD;
    });

    it('skips recording entirely when disabled', () => {
      process.env.METRICS_ENABLED = 'false';
      const mw = metricsMiddleware();
      const req: any = { method: 'GET', path: '/api/health' };
      const res: any = fakeRes();
      let nextCalled = false;
      mw(req, res, () => { nextCalled = true; });
      res.emit('finish');
      expect(nextCalled).toBe(true);
      expect(renderMetrics()).not.toContain('lingxi_http_requests_total');
    });
  });
});
