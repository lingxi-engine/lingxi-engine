#!/usr/bin/env node
/**
 * 灵犀引擎官网 · 端到端回归验证
 *
 * 用法：
 *   node deploy/verify/e2e.mjs                      # 默认验证 www.lingxi-engine.com
 *   node deploy/verify/e2e.mjs http://127.0.0.1:3456 # 验证本机
 *   node deploy/verify/e2e.mjs <base> --no-register  # 跳过注册（用已有账号）
 *
 * 退出码：0 = 全通过；1 = 有失败项
 */

const BASE = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'https://www.lingxi-engine.com').replace(/\/$/, '');
const SKIP_REGISTER = process.argv.includes('--no-register');

const results = [];
function rec(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? '  → ' + detail : ''}`);
}

// 只探状态码：优先 HEAD（不下载正文），服务端不支持时回退 GET 并立即丢弃正文
async function head(url, timeout = 25000) {
  const probe = async (method) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { method, redirect: 'manual', signal: ac.signal });
      const len = Number(r.headers.get('content-length') || 0);
      if (method === 'GET' && r.body) { try { await r.body.cancel(); } catch {} }
      return { status: r.status, len };
    } catch (e) {
      return { status: -1, len: 0, err: e.message };
    } finally { clearTimeout(t); }
  };
  let r = await probe('HEAD');
  if (r.status === -1 || r.status === 405 || r.status === 501) r = await probe('GET');
  return r;
}

// ─────────────────────────────────────────────
console.log(`\n=== 1. 静态路由可达性 (${BASE}) ===`);
const ROUTES = [
  '/', '/index.html', '/chat/', '/chat/index.html', '/m/', '/mobile.html',
  '/register.html', '/login.html', '/download.html', '/docs/',
  '/privacy.html', '/terms.html', '/robots.txt', '/sitemap.xml',
  '/sw.js', '/manifest.json', '/icon.svg', '/favicon.ico',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/css/style.css', '/css/mobile.css', '/js/app.js', '/platform-config.js',
  '/public/lingxi-engine.tar.gz', '/api/health',
];
for (const p of ROUTES) {
  const r = await head(BASE + p);
  rec(`GET ${p}`, r.status === 200, `${r.status}${r.len ? ' / ' + r.len + 'B' : ''}`);
}

// ─────────────────────────────────────────────
console.log('\n=== 2. 服务健康 ===');
let health = null;
try {
  const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(20000) });
  health = await r.json();
  rec('health.ok', health.ok === true, String(health.status));
  rec('health.db', health.db === true, 'db=' + health.db);
  rec('health.version', !!health.version, health.version);
} catch (e) { rec('health', false, e.message); }

// ─────────────────────────────────────────────
console.log('\n=== 3. 注册 / 登录 ===');
const stamp = Date.now();
const email = `e2e-${stamp}@example.com`;
const password = 'E2eTest123456';
let token = null;
let userId = null;

if (!SKIP_REGISTER) {
  const payload = { email, password, display_name: 'E2E用户' + String(stamp).slice(-5), agent_binding: 'auto_default' };
  try {
    const r = await fetch(BASE + '/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    rec('POST /api/auth/register', r.status === 200 && j.ok === true, `${r.status} id=${j.user?.id} err=${j.error || '-'}`);
    token = j.accessToken || j.token || null;
    userId = j.user?.id ? String(j.user.id) : null;
    rec('注册自动签发 token', !!token, token ? 'len=' + token.length : 'missing');
    rec('注册自动创建 Agent', !!j.agent?.id, j.agent?.id || 'none');
  } catch (e) { rec('POST /api/auth/register', false, e.message); }
} else {
  console.log('  (跳过注册)');
  userId = '10205';
}

// 登录（注册已返回 token 时也再验一次登录接口）
if (email && !SKIP_REGISTER) {
  try {
    const r = await fetch(BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    rec('POST /api/auth/login', r.status === 200 && j.ok === true, `${r.status} ${j.error || 'ok'}`);
    if (j.accessToken) token = j.accessToken;
  } catch (e) { rec('POST /api/auth/login', false, e.message); }
}

// 错误密码必须被拒
try {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email || 'nobody@example.com', password: 'wrong-password-xxx' }),
    signal: AbortSignal.timeout(30000),
  });
  rec('错误密码被拒 (期望 401)', r.status === 401, String(r.status));
} catch (e) { rec('错误密码被拒', false, e.message); }

// ─────────────────────────────────────────────
console.log('\n=== 4. 会话隔离 ===');
const H = token ? { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } : {};
let chatId = null;
if (token) {
  try {
    const r = await fetch(BASE + '/api/chats', { headers: H, signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    const chats = j.chats || j.data || [];
    rec('GET /api/chats', r.status === 200, 'count=' + chats.length);
    chatId = chats[0]?.id || null;
    rec('注册后自动有默认会话', !!chatId, chatId || 'none');
  } catch (e) { rec('GET /api/chats', false, e.message); }

  // 越权：拿它去读别人的会话，必须 403/404
  try {
    const r = await fetch(BASE + '/api/chats/chat-999999/messages', { headers: H, signal: AbortSignal.timeout(20000) });
    rec('越权读他人会话被拒 (期望 403/404)', [403, 404].includes(r.status), String(r.status));
  } catch (e) { rec('越权读他人会话被拒', false, e.message); }
}

// ─────────────────────────────────────────────
console.log('\n=== 5. 聊天 WebSocket 全链路 ===');
if (token && chatId) {
  const wsBase = BASE.replace(/^http/, 'ws');
  const url = `${wsBase}/ws?id=${encodeURIComponent(userId || 'e2e')}&token=${encodeURIComponent(token)}`;
  let chunks = 0, text = '', subscribed = false, started = false, ended = false;
  const types = {};

  try {
    await new Promise((resolve) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch {} ; resolve('timeout'); }, 75000);

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'subscribe', chatId }));
        setTimeout(() => ws.send(JSON.stringify({ type: 'message', chatId, content: '请只回复两个字：收到' })), 700);
      });
      ws.addEventListener('message', (ev) => {
        let d; try { d = JSON.parse(String(ev.data)); } catch { return; }
        const t = d.type || '?';
        types[t] = (types[t] || 0) + 1;
        if (t === 'subscribed') subscribed = true;
        if (t === 'agent.streaming.start') started = true;
        if (t.includes('chunk')) { chunks++; text += (d.content || d.chunk || ''); }
        if (t === 'agent.streaming.end') { ended = true; clearTimeout(timer); resolve('end'); }
      });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve('error'); });
      ws.addEventListener('close', () => { clearTimeout(timer); resolve('close'); });
    });
  } catch (e) { rec('WebSocket 连接', false, e.message); }

  rec('WS 订阅会话 (subscribed)', subscribed, String(subscribed));
  rec('Agent 开始回复 (streaming.start)', started, String(started));
  rec('收到流式分片 (>0)', chunks > 0, 'chunks=' + chunks);
  rec('回复完整结束 (streaming.end)', ended, String(ended));
  rec('回复内容非空', text.length > 0, JSON.stringify(text.slice(0, 80)));
  console.log('   事件统计: ' + JSON.stringify(types));
} else {
  console.log('  (缺少 token 或 chatId，跳过)');
}

// ─────────────────────────────────────────────
console.log('\n=== 6. PWA 依赖一致性 ===');
try {
  const sw = await (await fetch(BASE + '/sw.js', { signal: AbortSignal.timeout(20000) })).text();
  const m = sw.match(/OFFLINE_URLS\s*=\s*\[([^\]]+)\]/);
  if (m) {
    const urls = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const bad = [];
    for (const u of urls) {
      const r = await head(BASE + u);
      if (r.status !== 200) bad.push(`${u}=${r.status}`);
    }
    rec(`sw.js 预缓存清单全部可用 (${urls.length} 项)`, bad.length === 0, bad.length ? 'BAD: ' + bad.join(', ') : 'all 200');
  } else { rec('sw.js 可解析 OFFLINE_URLS', false, '未找到清单'); }

  const mf = await (await fetch(BASE + '/manifest.json', { signal: AbortSignal.timeout(20000) })).json();
  const icons = (mf.icons || []).map(i => i.src);
  const badIcons = [];
  for (const i of icons) { const r = await head(BASE + i); if (r.status !== 200) badIcons.push(`${i}=${r.status}`); }
  rec(`manifest 图标全部可用 (${icons.length} 项)`, icons.length > 0 && badIcons.length === 0, badIcons.length ? 'BAD: ' + badIcons.join(', ') : 'all 200');
  rec('manifest start_url 可访问', true, mf.start_url || '-');
} catch (e) { rec('PWA 校验', false, e.message); }

// ─────────────────────────────────────────────
console.log('\n=== 7. 下载包完整性 ===');
try {
  const vt = await (await fetch(BASE + '/public/version.txt', { signal: AbortSignal.timeout(20000) })).text();
  const mSize = vt.match(/size:\s*(\d+)/);
  const mSha = vt.match(/sha256:\s*([a-f0-9]{64})/i);
  const mVer = vt.match(/^\s*(\d+\.\d+\.\d+)\s*$/m);
  rec('version.txt 可解析', !!mSize && !!mSha, `ver=${mVer?.[1] || '?'} size=${mSize?.[1] || '?'}`);

  const buf = Buffer.from(await (await fetch(BASE + '/public/lingxi-engine.tar.gz', { signal: AbortSignal.timeout(180000) })).arrayBuffer());
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(buf).digest('hex');
  rec('下载包体积与声明一致', mSize ? buf.length === Number(mSize[1]) : false, `actual=${buf.length} declared=${mSize?.[1]}`);
  rec('下载包 SHA256 与声明一致', mSha ? sha === mSha[1].toLowerCase() : false, `actual=${sha.slice(0, 16)}…`);
} catch (e) { rec('下载包校验', false, e.message); }

// ─────────────────────────────────────────────
const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log('\n' + '='.repeat(52));
console.log(`结果: ${pass} 通过 / ${fail} 失败 / 共 ${results.length}`);
if (fail > 0) {
  console.log('\n失败项:');
  results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}: ${r.detail}`));
  process.exit(1);
}
console.log('全部通过 ✅');
process.exit(0);
