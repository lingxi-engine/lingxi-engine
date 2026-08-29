// 批次13a冒烟：验证 8 条 skills 路由由模块版接管，且 requireAuth 真实生效
// 断言逻辑：
//   A. 本机无凭证请求 → 非 401 非 404（本地 admin-auto 放行 + 模块版已注册）
//   B. 垃圾 Bearer token → 401（旧内联版无鉴权不会 401，此为模块版独有特征）
// 特殊处理：GET /api/skills/market 会连外网，10s 超时记 SKIP 不记 FAIL
import { spawn } from 'child_process';
import http from 'http';

const PORT = 3779;
const BASE = 'http://127.0.0.1:' + PORT;

const routes = [
  { m: 'GET', p: '/api/skills' },
  { m: 'POST', p: '/api/skills/scan' },
  { m: 'POST', p: '/api/skills/smoke-fake-id/enable' },
  { m: 'POST', p: '/api/skills/smoke-fake-id/disable' },
  { m: 'DELETE', p: '/api/skills/smoke-fake-id' },
  { m: 'POST', p: '/api/skills/create', body: JSON.stringify({}) },                       // 缺参 → 400
  { m: 'GET', p: '/api/skills/market', net: true },
  { m: 'POST', p: '/api/skills/install', body: JSON.stringify({}) },                      // 缺参 → 400
];

function req(method, path, headers = {}, body = null, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const r = http.request(BASE + path, { method, headers }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ code: res.statusCode, data }));
    });
    r.on('error', () => resolve({ code: 0, data: '' }));
    r.setTimeout(timeoutMs, () => { r.destroy(); resolve({ code: -1, data: 'TIMEOUT' }); });
    if (body) r.write(body);
    r.end();
  });
}

const child = spawn('npx', ['tsx', 'index.ts', '--port', String(PORT)], {
  shell: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });

let ready = false;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 500));
  const { code } = await req('GET', '/api/time', {}, null, 2000);
  if (code > 0) { ready = true; break; }
}
if (!ready) {
  console.log('❌ 服务未就绪，输出尾部：\n' + out.slice(-1500));
  child.kill();
  process.exit(1);
}
console.log('✅ 服务已就绪 (port ' + PORT + ')\n');

let fail = 0, skip = 0;

// ---- A. 本机无凭证：模块版接管 + 本地放行 ----
for (const r of routes) {
  const h = r.body ? { 'Content-Type': 'application/json' } : {};
  const { code, data } = await req(r.m, r.p, h, r.body);
  if (r.net && code === -1) { skip++; console.log('SKIP [local-noauth] ' + r.m.padEnd(6) + ' ' + r.p + '  -> 外网超时(不判负)'); continue; }
  const ok = code !== 404 && code !== 0 && code !== 401 && code !== -1;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' [local-noauth] ' + r.m.padEnd(6) + ' ' + r.p + '  -> HTTP ' + code + (code === 200 ? '  ' + data.slice(0, 80) : ''));
}

// ---- B. 垃圾 token：requireAuth 必须拦下（模块版独有特征）----
for (const r of routes) {
  const h = { Authorization: 'Bearer smoke-invalid-token-0123456789', ...(r.body ? { 'Content-Type': 'application/json' } : {}) };
  const { code } = await req(r.m, r.p, h, r.body);
  if (r.net && code === -1) { skip++; console.log('SKIP [bad-token-401] ' + r.m.padEnd(6) + ' ' + r.p + '  -> 外网超时(不判负)'); continue; }
  const ok = code === 401;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' [bad-token-401] ' + r.m.padEnd(6) + ' ' + r.p + '  -> HTTP ' + code);
}

console.log('---');
console.log(fail === 0
  ? '✅ 冒烟通过：8 条 skills 路由模块版接管 + 鉴权生效' + (skip ? '（' + skip + ' 项外网超时跳过）' : '')
  : '❌ ' + fail + ' 项断言失败');

child.kill();
process.exit(fail === 0 ? 0 : 1);