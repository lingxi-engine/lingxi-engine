// 批次12冒烟：验证 4 条 mesh REST 路由由模块版接管，且 requireAuth 真实生效
// 断言逻辑：
//   A. 本机无凭证请求 → 非 401 非 404（本地 admin-auto 放行 + 模块版已注册）
//   B. 垃圾 Bearer token → 401（旧内联版无鉴权不会 401，此为模块版独有特征）
import { spawn } from 'child_process';
import http from 'http';

const PORT = 3778;
const BASE = 'http://127.0.0.1:' + PORT;

const routes = [
  { m: 'GET', p: '/api/mesh/status' },
  { m: 'GET', p: '/api/mesh/peers' },
  { m: 'POST', p: '/api/mesh/send', body: JSON.stringify({ peer: 'x', message: 'smoke' }) },
  { m: 'POST', p: '/api/mesh/task', body: JSON.stringify({ peer: 'x', task: 'smoke' }) },
];

function req(method, path, headers = {}, body = null) {
  return new Promise((resolve) => {
    const r = http.request(BASE + path, { method, headers }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ code: res.statusCode, data }));
    });
    r.on('error', () => resolve({ code: 0, data: '' }));
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
  const { code } = await req('GET', '/api/time');
  if (code > 0) { ready = true; break; }
}
if (!ready) {
  console.log('❌ 服务未就绪，输出尾部：\n' + out.slice(-1500));
  child.kill();
  process.exit(1);
}
console.log('✅ 服务已就绪 (port ' + PORT + ')\n');

let fail = 0;

// ---- A. 本机无凭证：模块版接管 + 本地放行 ----
for (const r of routes) {
  const h = r.body ? { 'Content-Type': 'application/json' } : {};
  const { code, data } = await req(r.m, r.p, h, r.body);
  const ok = code !== 404 && code !== 0 && code !== 401;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' [local-noauth] ' + r.m.padEnd(4) + ' ' + r.p + '  -> HTTP ' + code + (ok && code === 200 ? '  ' + data.slice(0, 80) : ''));
}

// ---- B. 垃圾 token：requireAuth 必须拦下（模块版独有特征）----
for (const r of routes) {
  const h = { Authorization: 'Bearer smoke-invalid-token-0123456789', ...(r.body ? { 'Content-Type': 'application/json' } : {}) };
  const { code } = await req(r.m, r.p, h, r.body);
  const ok = code === 401;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' [bad-token-401] ' + r.m.padEnd(4) + ' ' + r.p + '  -> HTTP ' + code);
}

console.log('---');
console.log(fail === 0 ? '✅ 冒烟通过：4 条 mesh 路由模块版接管 + 鉴权生效' : '❌ ' + fail + ' 项断言失败');

child.kill();
process.exit(fail === 0 ? 0 : 1);