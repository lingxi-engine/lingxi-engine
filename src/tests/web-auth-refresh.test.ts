/**
 * 401 自动续期拦截器回归测试（2026-11-19）
 *
 * 背景 bug：
 *  - access token 7 天过期，后端 /api/auth/refresh 支持滚动续期，但旧前端从不续期 → 经常 401
 *  - jwt-auth 本地免登录兜底只在「无 Authorization 头」时生效 → 带坏 token 连 localhost 都 401
 *  - checkAuthStatus 的 catch 分支不清坏 token → 401 循环
 *
 * 用 vm 沙箱加载 web/js/auth-refresh.js，mock fetch/localStorage/window 验证真实行为。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'web/js/auth-refresh.js'), 'utf8');

function mockRes(status: number, data: any) {
  return { status, ok: status >= 200 && status < 300, json: async () => data };
}

interface SetupOpts {
  initial?: Record<string, string>;
  refreshStatus?: number;
  refreshResponse?: any;
  replayStatus?: number;
  firstStatus?: number;
  platformUrl?: string;
}

function setup(opts: SetupOpts = {}) {
  const store = new Map<string, string>(Object.entries(opts.initial || {}));
  const calls: { url: string; opts: any }[] = [];
  const events: any[] = [];
  const listeners: Record<string, any[]> = {};
  let refreshCalls = 0;

  const win: any = {
    location: { origin: 'http://localhost:3456' },
    PLATFORM_URL: opts.platformUrl ?? 'https://cloud.example.com',
    addEventListener: (t: string, f: any) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent: (e: any) => { events.push(e); (listeners[e.type] || []).forEach((f) => f(e)); return true; },
  };
  win.window = win;

  const fetchMock = async (url: any, o: any) => {
    calls.push({ url: String(url), opts: o });
    if (String(url).includes('/api/auth/refresh')) {
      refreshCalls++;
      return mockRes(opts.refreshStatus ?? 200, opts.refreshResponse ?? { ok: true, accessToken: 'AT2', refreshToken: 'RT2' });
    }
    if (o && o.__lxAuthRetried) return mockRes(opts.replayStatus ?? 200, { ok: true, replayed: true });
    return mockRes(opts.firstStatus ?? 401, { ok: false, error: { code: 'token_invalid' } });
  };
  win.fetch = fetchMock;

  const sandbox: any = {
    window: win,
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    },
    CustomEvent: class { type: string; detail: any; constructor(t: string, o?: any) { this.type = t; this.detail = o && o.detail; } },
    Event: class { type: string; constructor(t: string) { this.type = t; } },
    Promise, JSON, console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  win.LxAuthRefresh.install();

  return { win, store, calls, events, refreshCalls: () => refreshCalls };
}

const TOKENS = { authToken: 'AT1', authRefreshToken: 'RT1' };

describe('LxAuthRefresh — 401 自动续期', () => {
  it('install 幂等：重复调用不二次包裹 fetch', () => {
    const { win } = setup({ initial: TOKENS });
    const f1 = win.fetch;
    win.LxAuthRefresh.install();
    expect(win.fetch).toBe(f1);
    expect(typeof win.__lxOriginalFetch).toBe('function');
  });

  it('401 → 调 refresh → 存滚动新 token → 用新 Bearer 重放原请求', async () => {
    const { win, store, calls } = setup({ initial: TOKENS });
    const res = await win.fetch('/api/friends', { method: 'GET', headers: { Authorization: 'Bearer AT1' } });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.replayed).toBe(true);
    expect(store.get('authToken')).toBe('AT2');
    expect(store.get('authRefreshToken')).toBe('RT2'); // 滚动刷新必须存新 refresh
    const refreshCall = calls.find((c) => c.url.includes('/api/auth/refresh'));
    expect(refreshCall).toBeTruthy();
    expect(JSON.parse(refreshCall!.opts.body).refresh_token).toBe('RT1');
    const replay = calls[calls.length - 1];
    expect(replay.opts.headers.Authorization).toBe('Bearer AT2');
    expect(replay.opts.__lxAuthRetried).toBe(true);
    expect(replay.opts.method).toBe('GET');
  });

  it('并发 401 单飞：只发一次 refresh', async () => {
    const { win, refreshCalls } = setup({ initial: TOKENS });
    const rs = await Promise.all([win.fetch('/api/a'), win.fetch('/api/b'), win.fetch('/api/c')]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(refreshCalls()).toBe(1);
  });

  it('refresh 失败 → 清空双 token + 广播 lx-auth-expired + 返回原 401', async () => {
    const { win, store, events } = setup({ initial: TOKENS, refreshStatus: 401 });
    const res = await win.fetch('/api/friends');
    expect(res.status).toBe(401);
    expect(store.has('authToken')).toBe(false);
    expect(store.has('authRefreshToken')).toBe(false);
    expect(events.some((e) => e.type === 'lx-auth-expired')).toBe(true);
  });

  it('只有坏 access token、无 refresh token → 不空调 refresh，直接清 token', async () => {
    const { win, store, events, refreshCalls } = setup({ initial: { authToken: 'STALE' } });
    const res = await win.fetch('/api/friends');
    expect(res.status).toBe(401);
    expect(refreshCalls()).toBe(0);
    expect(store.has('authToken')).toBe(false);
    expect(events.some((e) => e.type === 'lx-auth-expired')).toBe(true);
  });

  it('续期成功但重放仍 401 → 清 token，不无限循环', async () => {
    const { win, store, calls, events, refreshCalls } = setup({ initial: TOKENS, replayStatus: 401 });
    const res = await win.fetch('/api/friends');
    expect(res.status).toBe(401);
    expect(refreshCalls()).toBe(1);
    expect(calls.length).toBe(3); // 原请求 + refresh + 重放，到此为止
    expect(store.has('authToken')).toBe(false);
    expect(events.some((e) => e.type === 'lx-auth-expired')).toBe(true);
  });

  it('游客（无任何 token）的 401 不触发续期/清理事件', async () => {
    const { win, events, refreshCalls } = setup({ initial: {} });
    const res = await win.fetch('/api/friends');
    expect(res.status).toBe(401);
    expect(refreshCalls()).toBe(0);
    expect(events.length).toBe(0);
  });

  it('认证端点本身（login/refresh/logout）不拦截', async () => {
    const { win, store, refreshCalls } = setup({ initial: TOKENS });
    const res = await win.fetch('/api/auth/login', { method: 'POST' });
    expect(res.status).toBe(401);
    expect(refreshCalls()).toBe(0);
    expect(store.get('authToken')).toBe('AT1'); // 登录失败不该清已有凭证
  });

  it('第三方外部 URL 的 401 不拦截', async () => {
    const { win, store, refreshCalls } = setup({ initial: TOKENS });
    const res = await win.fetch('https://api.openai.com/v1/models');
    expect(res.status).toBe(401);
    expect(refreshCalls()).toBe(0);
    expect(store.get('authToken')).toBe('AT1');
  });

  it('PLATFORM_URL 同源化请求也在拦截范围', async () => {
    const { win, refreshCalls } = setup({ initial: TOKENS });
    const res = await win.fetch('https://cloud.example.com/api/user/me');
    expect(res.status).toBe(200);
    expect(refreshCalls()).toBe(1);
  });

  it('非 401 响应原样透传', async () => {
    const { win, refreshCalls } = setup({ initial: TOKENS, firstStatus: 200 });
    const res = await win.fetch('/api/friends');
    expect(res.status).toBe(200);
    expect(refreshCalls()).toBe(0);
  });

  it('续期成功广播 lx-auth-refreshed 携带新 accessToken（供 app.js 同步 authToken 变量）', async () => {
    const { win, events } = setup({ initial: TOKENS });
    await win.fetch('/api/friends');
    const ev = events.find((e) => e.type === 'lx-auth-refreshed');
    expect(ev).toBeTruthy();
    expect(ev.detail.accessToken).toBe('AT2');
  });

  it('storeTokens/clear 辅助函数行为正确', () => {
    const { win, store, events } = setup({ initial: {} });
    win.LxAuthRefresh.storeTokens('A', 'R');
    expect(store.get('authToken')).toBe('A');
    expect(store.get('authRefreshToken')).toBe('R');
    expect(win.authToken).toBe('A');
    win.LxAuthRefresh.clear();
    expect(store.has('authToken')).toBe(false);
    expect(store.has('authRefreshToken')).toBe(false);
    expect(win.authToken).toBeNull();
    expect(events.some((e) => e.type === 'lx-auth-expired')).toBe(true);
  });

  it('Headers 实例入参重放时正确展开并替换 Authorization', async () => {
    const { win, calls } = setup({ initial: TOKENS });
    const headers = new Map<string, string>([['Content-Type', 'application/json'], ['Authorization', 'Bearer AT1']]);
    const headersLike = { forEach: (cb: any) => headers.forEach((v, k) => cb(v, k)), get: (k: string) => headers.get(k) || null };
    await win.fetch('/api/friends', { method: 'POST', headers: headersLike, body: '{"x":1}' });
    const replay = calls[calls.length - 1];
    expect(replay.opts.headers.Authorization).toBe('Bearer AT2');
    expect(replay.opts.headers['Content-Type']).toBe('application/json');
    expect(replay.opts.body).toBe('{"x":1}');
    expect(replay.opts.method).toBe('POST');
  });
});

describe('401 修复 — 前端接线静态守卫', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');

  it('app.js 登录成功时保存 refresh token', () => {
    expect(appJs).toContain("localStorage.setItem('authRefreshToken', _rt)");
  });

  it('app.js 注销时清除 refresh token', () => {
    expect(appJs).toContain("localStorage.removeItem('authRefreshToken')");
  });

  it('app.js 安装拦截器并监听续期/失效事件', () => {
    expect(appJs).toContain('LxAuthRefresh.install()');
    expect(appJs).toContain('lx-auth-refreshed');
    expect(appJs).toContain('lx-auth-expired');
  });

  it('index.html 在 app.js 之前引入 auth-refresh.js 且版本号已更新', () => {
    const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
    const i = html.indexOf('js/auth-refresh.js');
    const j = html.indexOf('js/app.js');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
    expect(html).not.toContain('app.js?v=20261118a');
  });

  it('chat/index.html 同样接线', () => {
    const html = fs.readFileSync(path.join(ROOT, 'web/chat/index.html'), 'utf8');
    const i = html.indexOf('/js/auth-refresh.js');
    const j = html.indexOf('/js/app.js');
    expect(i).toBeGreaterThan(-1);
    expect(j).toBeGreaterThan(i);
  });
});
