// 运行时验证 v3：起真实服务（独立端口 + 独立 data-dir），实测 PATCH /api/chats/:id/name 端点。
//
// 安全设计：
//  - 端口 3499 + data-dir data-verify-tmp，绝不碰 3456 上正在跑的旧服务及其数据
//  - 记录 spawn 前 node 进程基线，结束时只杀本次新增的，绝不误杀引擎本体/旧服务
//  - taskkill /T /F 杀整棵进程树，避免 npm.cmd 外壳被杀后 node 变孤儿残留
//
// 判定要点（v2 在这里误判过）：
//  框架层 404 => body 含 "路由不存在"  => 端点真的没注册
//  业务层 404 => body 如 {"error":"会话不存在"} => handler 已执行，端点已注册 ✅
const { spawn, spawnSync } = require('child_process');
const http = require('http');

const PORT = 3499;
const BASE = `http://127.0.0.1:${PORT}`;

function nodePids() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object -ExpandProperty ProcessId"], { encoding: 'utf8' });
  return new Set(String(r.stdout || '').split(/\s+/).filter(Boolean));
}
const BASELINE = nodePids();
console.log('baseline node PIDs: ' + [...BASELINE].join(', '));

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      timeout: 8000,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf.slice(0, 300) }));
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function killNewNodes() {
  const now = nodePids();
  const fresh = [...now].filter(p => !BASELINE.has(p));
  for (const pid of fresh) {
    try { spawnSync('taskkill', ['/F', '/T', '/PID', pid], { encoding: 'utf8' }); } catch {}
  }
  return fresh;
}

(async () => {
  console.log(' spawning server on port ' + PORT + ' ...');
  const child = spawn('npm.cmd', ['start', '--', '--port', String(PORT), '--data-dir', 'data-verify-tmp'], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    shell: true,
  });
  let log = '';
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });

  let up = false;
  let healthBody = '';
  for (let i = 0; i < 45; i++) {
    await sleep(1500);
    try {
      const h = await req('GET', '/api/health');
      if (h.status === 200) { up = true; healthBody = h.body; console.log(' server UP: ' + h.body.slice(0, 220)); break; }
    } catch (e) { /* not yet */ }
    if (child.exitCode !== null) {
      console.log(' SERVER DIED early, exit=' + child.exitCode); console.log(log.slice(-2500));
      killNewNodes(); process.exit(1);
    }
  }
  if (!up) {
    console.log(' SERVER NEVER CAME UP'); console.log(log.slice(-3000));
    killNewNodes(); process.exit(1);
  }

  const ver = (healthBody.match(/"version":"([^"]+)"/) || [])[1] || '?';
  const com = (healthBody.match(/"commit":"([^"]+)"/) || [])[1] || '?';
  console.log(' running version=' + ver + ' commit=' + com);

  // PROBE 1: 目标端点。未登录 + 会话不存在 => 业务层 404「会话不存在」即为「已注册」
  console.log('\n--- PROBE 1: PATCH /api/chats/probe-chat/name ---');
  const p1 = await req('PATCH', '/api/chats/probe-chat/name', { name: 'probe' });
  console.log(' status=' + p1.status + ' body=' + p1.body);
  const framework404 = p1.status === 404 && p1.body.includes('路由不存在');
  const routeExists = !framework404;
  console.log(' => route registered: ' + (routeExists ? 'YES ✅ (handler executed)' : 'NO ❌ (framework 404)'));

  // PROBE 2: 基线对照，确认框架层 404 长什么样
  console.log('\n--- PROBE 2: PATCH /api/chats/x/definitely-not-a-route ---');
  const p2 = await req('PATCH', '/api/chats/x/definitely-not-a-route', { name: 'probe' });
  console.log(' status=' + p2.status + ' body=' + p2.body);

  // PROBE 3: GET 同路径，确认方法+路径组合命中
  console.log('\n--- PROBE 3: GET /api/chats/probe-chat/name ---');
  const p3 = await req('GET', '/api/chats/probe-chat/name');
  console.log(' status=' + p3.status + ' body=' + p3.body);

  console.log('\n=== VERDICT ===');
  console.log('rename route registered : ' + (routeExists ? 'YES' : 'NO'));
  console.log('probe1 (target)         : ' + p1.status + ' ' + p1.body);
  console.log('probe2 (baseline 404)   : ' + p2.status + ' ' + p2.body);

  const killed = killNewNodes();
  console.log('\n temp server stopped, killed fresh PIDs: ' + (killed.join(', ') || '(none)'));
  process.exit(routeExists ? 0 : 2);
})().catch(e => { console.error('FATAL', e); killNewNodes(); process.exit(1); });
