// 端到端实测 v2：注册 -> 登录 -> 建会话 -> PATCH 改名 -> 读回验证
// 独立端口 3499 + 独立 data-dir，绝不碰 3456 旧服务及其数据
//
// 已确认的服务端契约（读源码得出，非猜测）：
//  POST /api/auth/register  body: { email, password, display_name }  -> { ok, user, accessToken }
//  POST /api/auth/login     body: { email, password }                -> { ok, accessToken, refreshToken, user }
//  auth.register() 的「用户名不能为空」实际校验的是 displayName
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

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, body: buf.slice(0, 500), json: j }); });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function killNewNodes() {
  const fresh = [...nodePids()].filter(p => !BASELINE.has(p));
  for (const pid of fresh) { try { spawnSync('taskkill', ['/F', '/T', '/PID', pid], { encoding: 'utf8' }); } catch {} }
  return fresh;
}
function pickToken(j) {
  if (!j) return null;
  return j.accessToken || j.token || (j.data && (j.data.accessToken || j.data.token)) || null;
}

(async () => {
  const child = spawn('npm.cmd', ['start', '--', '--port', String(PORT), '--data-dir', 'data-verify-tmp'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: false, shell: true,
  });
  let log = '';
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });

  let up = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1500);
    try { const h = await req('GET', '/api/health'); if (h.status === 200) { up = true; break; } } catch {}
    if (child.exitCode !== null) { console.log('SERVER DIED exit=' + child.exitCode); console.log(log.slice(-2000)); killNewNodes(); process.exit(1); }
  }
  if (!up) { console.log('SERVER NEVER UP'); console.log(log.slice(-2500)); killNewNodes(); process.exit(1); }
  console.log('server UP on ' + PORT);

  const stamp = Date.now();
  const email = 'e2e_' + stamp + '@example.com';
  const pass = 'Passw0rd!' + stamp;

  // 1) 注册
  const reg = await req('POST', '/api/auth/register', { email, password: pass, display_name: 'E2E测试' });
  console.log('\n[1] register  status=' + reg.status);
  let token = pickToken(reg.json);
  if (!token) {
    const lg = await req('POST', '/api/auth/login', { email, password: pass });
    console.log('[1b] login    status=' + lg.status);
    token = pickToken(lg.json);
  }
  if (!token) { console.log('NO TOKEN, abort. reg=' + reg.body); killNewNodes(); process.exit(1); }
  console.log('    token: ' + String(token).slice(0, 20) + '...');
  const AUTH = { Authorization: 'Bearer ' + token };

  // 2) 当前用户
  const me = await req('GET', '/api/auth/me', null, AUTH);
  console.log('[2] me        status=' + me.status + ' body=' + me.body);

  // 3) 建会话（模拟「点新建」，先用默认名）
  const chatId = 'chat-e2e-' + stamp;
  const mk = await req('POST', '/api/chats', { id: chatId, type: 'private', name: '新会话' }, AUTH);
  console.log('[3] create    status=' + mk.status + ' body=' + mk.body);
  const j = mk.json || {};
  const serverId = j.id || j.chatId || (j.data && (j.data.id || j.data.chatId)) || (j.chat && j.chat.id);
  console.log('    clientId=' + chatId + '  serverId=' + serverId + '  ok=' + (j.ok === true));

  // 3b) 把自己加为会话参与者（否则越权防护会正确返回 403）
  const myId = (me.json && me.json.user && (me.json.user.id || me.json.user.sub)) || '10001';
  const myNumeric = String((me.json && me.json.user && (me.json.user.numeric_id || me.json.user.numericId)) || '');
  const pj = await req('POST', '/api/participants', {
    id: 'part-' + stamp, chatId: chatId, userId: myId, role: 'owner',
  }, AUTH);
  console.log('[3b] participant status=' + pj.status + ' body=' + pj.body + '  (myId=' + myId + ' numeric=' + myNumeric + ')');
  // 4) 改名 —— 核心验证点
  const newName = '改名成功-' + stamp;
  const rn = await req('PATCH', '/api/chats/' + chatId + '/name', { name: newName }, AUTH);
  console.log('[4] RENAME    status=' + rn.status + ' body=' + rn.body);

  // 5) 读回验证
  const list = await req('GET', '/api/chats', null, AUTH);
  console.log('[5] list      status=' + list.status);
  const found = list.body.includes(newName);
  console.log('    new name in list: ' + (found ? 'YES ✅' : 'NO ❌'));
  console.log('    list: ' + list.body.slice(0, 600));

  // 6) 空名称应 400
  const bad = await req('PATCH', '/api/chats/' + chatId + '/name', { name: '   ' }, AUTH);
  console.log('[6] empty     status=' + bad.status + ' body=' + bad.body + '  (expect 400)');

  // 7) 不存在的会话应 404
  const nf = await req('PATCH', '/api/chats/no-such-chat-xyz/name', { name: 'x' }, AUTH);
  console.log('[7] notfound  status=' + nf.status + ' body=' + nf.body + '  (expect 404)');

  // 8) 未登录应 401
  const noauth = await req('PATCH', '/api/chats/' + chatId + '/name', { name: 'x' });
  console.log('[8] noauth    status=' + noauth.status + ' body=' + noauth.body + '  (expect 401)');

  console.log('\n=== E2E VERDICT ===');
  const r = {
    'rename -> 200': rn.status === 200,
    'readback name': found,
    'empty -> 400': bad.status === 400,
    'missing -> 404': nf.status === 404,
    'noauth -> 401': noauth.status === 401,
  };
  let allPass = true;
  for (const k of Object.keys(r)) { console.log('  ' + (r[k] ? 'PASS' : 'FAIL') + '  ' + k); if (!r[k]) allPass = false; }
  const killed = killNewNodes();
  console.log('\nstopped, killed: ' + (killed.join(', ') || '(none)'));
  process.exit(allPass ? 0 : 2);
})().catch(e => { console.error('FATAL', e); killNewNodes(); process.exit(1); });
