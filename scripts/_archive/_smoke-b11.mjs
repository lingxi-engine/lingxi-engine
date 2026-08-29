// 批次11冒烟：启动服务，验证被删内联路由均由模块版接管（非404即视为已注册）
import { spawn } from 'child_process';
import http from 'http';

const PORT = 3777;
const BASE = 'http://127.0.0.1:' + PORT;

const routes = [
  { m: 'GET', p: '/api/profile' },
  { m: 'GET', p: '/api/tags' },
  { m: 'GET', p: '/api/time' },
  { m: 'GET', p: '/api/workspace-mode' },
  { m: 'GET', p: '/api/federation/peers' },
  { m: 'POST', p: '/api/federation/register' },
  { m: 'POST', p: '/api/federation/message' },
  { m: 'POST', p: '/api/federation/send' },
  { m: 'POST', p: '/api/workspace-mode' },
];

function req(method, path) {
  return new Promise((resolve) => {
    const r = http.request(BASE + path, { method }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', () => resolve(0));
    r.end();
  });
}

const child = spawn('npx', ['tsx', 'index.ts', '--port', String(PORT)], {
  shell: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => { out += d; });

// 轮询等就绪（最多 30 秒）
let ready = false;
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 500));
  const code = await req('GET', '/api/time');
  if (code > 0) { ready = true; break; }
}
if (!ready) {
  console.log('❌ 服务未就绪，输出尾部：\n' + out.slice(-1500));
  child.kill();
  process.exit(1);
}
console.log('✅ 服务已就绪 (port ' + PORT + ')');

let fail = 0;
for (const r of routes) {
  const code = await req(r.m, r.p);
  const ok = code !== 404 && code !== 0;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' ' + r.m.padEnd(4) + ' ' + r.p + '  -> HTTP ' + code);
}
console.log('---');
console.log(fail === 0 ? '✅ 冒烟通过：9 条路由全部由模块版接管' : '❌ ' + fail + ' 条路由异常');

child.kill();
process.exit(fail === 0 ? 0 : 1);