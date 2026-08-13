/**
 * 灵犀引擎 - 云平台服务器 (platform-server)
 * 闭源。负责：用户账号 / 积分 / 社交 / 雇佣 / (未来商城)
 * 
 * 定位:
 *  - 用户部署引擎(开源)后，本地单机可用
 *  - 注册平台账号 → 解锁联网: 加好友/聊天/接单/把自己引擎挂上平台供人雇佣
 * 
 * 数据:
 *  - SQLite (better-sqlite3 或 sql.js) 持久化用户/积分/好友/订单
 *  - 内存 Map 保存在线实例 + WS 连接
 * 
 * 部署: 47.93.157.83:3001 (测试服) → 未来独立正式服
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, createHash } from 'crypto';

// ============ 配置 ============
const PORT = parseInt(process.env.PORT || '3001', 10);
// MESH_TOKEN 仅用于"实例↔平台"机器级握手（引擎启动时自动注册拿 token，用户不感知）
// 用户级认证用 JWT 或简单 token（下面 generateToken）
const MESH_TOKEN = process.env.MESH_TOKEN || 'lingxi-mesh-v2-secret';
// 用户账号密码签名密钥
const SECRET = process.env.PLATFORM_SECRET || 'lingxi-platform-dev-secret';

// ============ 存储 ============
// 内存持久化(测试期用文件JSON，正式换DB)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data-platform');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = join(DATA_DIR, 'platform.json');

interface DBShape {
  users: Record<string, User>;      // key: userId (平台分配的 ouid-xxx)
  credits: Record<string, number>;  // key: userId -> 积分
  friends: Record<string, string[]>; // key: userId -> [friendUserId]
  friendReq: any[];                  // 好友请求
  hires: any[];                      // 雇佣订单
  nextId: number;                    // 全局 numericId 递增
}
interface User {
  id: string;          // ouid-xxxx
  numericId: number;   // 全局唯一数字ID
  email: string;
  passwordHash: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: number;
  registeredInstance?: string; // 注册时的实例id
}

function emptyDB(): DBShape {
  return { users: {}, credits: {}, friends: {}, friendReq: [], hires: [], nextId: 10000 };
}
let db: DBShape = loadDB();
function loadDB(): DBShape {
  if (existsSync(DB_FILE)) {
    try { return JSON.parse(readFileSync(DB_FILE, 'utf8')); } catch {}
  }
  return emptyDB();
}
function saveDB() {
  try { writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); } catch (e) { console.error('[DB] 保存失败', e); }
}

// ============ 工具 ============
function hashPw(pw: string): string {
  return createHash('sha256').update(pw + SECRET).digest('hex');
}
function genToken(userId: string): string {
  // 简单 token: ouid + 随机串，正式可用 JWT
  return randomBytes(24).toString('hex') + '.' + userId;
}
function parseToken(tok: string | undefined): string | null {
  if (!tok) return null;
  const parts = tok.split('.');
  if (parts.length !== 2) return null;
  const userId = parts[1];
  if (db.users[userId]) return userId;
  return null;
}

// ============ WebSocket 在线实例 (信令层，与之前一致) ============
interface Instance {
  id: string; ws: WebSocket; hostname: string; lanIp: string; port: number;
  agents: string[]; version: string; lastHeartbeat: number; online: boolean;
}
const instances = new Map<string, Instance>();
// 实例注册的用户索引 (instanceId -> registry)
const userRegistry = new Map<string, { instanceId: string; numericId: number; displayName: string; email?: string; userId: string }>();

const app = express();
app.use(express.json());

// ============ 用户账号 ============
// 注册 (公开, 无需 token) → 注册即送1000积分
app.post('/api/user/register', (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: '邮箱和密码(至少6位)必填' });
  }
  const em = String(email).trim().toLowerCase();
  const exists = Object.values(db.users).find(u => u.email === em);
  if (exists) return res.status(409).json({ error: '该邮箱已注册' });

  const numericId = db.nextId++;
  const userId = 'ouid-' + numericId;
  db.users[userId] = {
    id: userId, numericId, email: em,
    passwordHash: hashPw(String(password)),
    displayName: displayName || '用户' + numericId,
    createdAt: Date.now(),
  };
  // 注册送 1000 积分
  db.credits[userId] = 1000;
  saveDB();
  res.json({ ok: true, user: { id: userId, numericId, email: em, displayName: db.users[userId].displayName, credits: 1000 }, token: genToken(userId) });
});

// 登录
app.post('/api/user/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
  const em = String(email).trim().toLowerCase();
  const user = Object.values(db.users).find(u => u.email === em);
  if (!user || user.passwordHash !== hashPw(String(password))) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  res.json({ ok: true, user: { id: user.id, numericId: user.numericId, email: user.email, displayName: user.displayName, credits: db.credits[user.id] || 0 }, token: genToken(user.id) });
});

// 当前用户信息
app.get('/api/user/me', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const u = db.users[uid];
  res.json({ ok: true, user: { id: u.id, numericId: u.numericId, email: u.email, displayName: u.displayName, credits: db.credits[uid] || 0 } });
});

// ============ 积分 ============
app.get('/api/user/credits', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  res.json({ ok: true, credits: db.credits[uid] || 0 });
});

// ============ 用户搜索 (全局) ============
app.get('/api/user/search', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, results: [] });
  const matched = Object.values(db.users)
    .filter(u => String(u.numericId) === q || u.displayName.includes(q) || u.email.includes(q))
    .slice(0, 20)
    .map(u => ({ id: u.id, numericId: u.numericId, displayName: u.displayName, email: u.email }));
  res.json({ ok: true, results: matched });
});

// 按 numericId 精确查(跨机加好友)
app.get('/api/user/find', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const nid = Number(req.query.numericId);
  const u = Object.values(db.users).find(x => x.numericId === nid);
  if (!u) return res.json({ ok: true, found: false });
  res.json({ ok: true, found: true, user: { id: u.id, numericId: u.numericId, displayName: u.displayName, email: u.email } });
});

// ============ 好友 ============
// 发好友请求
app.post('/api/friend/request', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { toNumericId, message } = req.body || {};
  const toUser = Object.values(db.users).find(x => x.numericId === Number(toNumericId));
  if (!toUser) return res.status(404).json({ error: '用户不存在' });
  if (toUser.id === uid) return res.status(400).json({ error: '不能加自己' });
  // 已是好友?
  if ((db.friends[uid] || []).includes(toUser.id)) return res.json({ ok: true, already: true });
  db.friendReq.push({ id: 'fr-' + Date.now() + '-' + Math.random().toString(36).slice(2,6), from: uid, to: toUser.id, status: 'pending', message: message || '', createdAt: Date.now() });
  saveDB();
  res.json({ ok: true });
});

// 好友请求列表
app.get('/api/friend/requests', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const incoming = db.friendReq.filter(r => r.to === uid && r.status === 'pending').map(r => ({ id: r.id, from: r.from, fromName: db.users[r.from]?.displayName, fromId: db.users[r.from]?.numericId, message: r.message }));
  res.json({ ok: true, incoming });
});

// 处理好友请求(接受/拒绝)
app.post('/api/friend/respond', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { requestId, action } = req.body || {};
  const req2 = db.friendReq.find(r => r.id === requestId && r.to === uid);
  if (!req2) return res.status(404).json({ error: '请求不存在' });
  if (action === 'accept') {
    db.friends[uid] = db.friends[uid] || [];
    db.friends[req2.from] = db.friends[req2.from] || [];
    if (!db.friends[uid].includes(req2.from)) db.friends[uid].push(req2.from);
    if (!db.friends[req2.from].includes(uid)) db.friends[req2.from].push(uid);
  }
  req2.status = action === 'accept' ? 'accepted' : 'rejected';
  saveDB();
  res.json({ ok: true });
});

// 好友列表
app.get('/api/friend/list', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const friends = (db.friends[uid] || []).map(fid => {
    const u = db.users[fid];
    return u ? { id: u.id, numericId: u.numericId, displayName: u.displayName } : null;
  }).filter(Boolean);
  res.json({ ok: true, friends });
});

// 删除好友
app.post('/api/friend/remove', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { numericId } = req.body || {};
  const u = Object.values(db.users).find(x => x.numericId === Number(numericId));
  if (u) {
    db.friends[uid] = (db.friends[uid] || []).filter(x => x !== u.id);
  }
  saveDB();
  res.json({ ok: true });
});

// ============ 雇佣 ============
// 挂出自己的引擎/员工到平台（供人雇佣），消耗部分积分作为上架？
app.post('/api/hire/list', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { agentId, name, desc, pricePerTask, instanceId } = req.body || {};
  const entry = { id: 'hire-' + Date.now() + '-' + Math.random().toString(36).slice(2,6), ownerId: uid, agentId: agentId || '', name: name || '灵犀员工', desc: desc || '', pricePerTask: pricePerTask || 0, instanceId: instanceId || '', status: 'active', createdAt: Date.now() };
  db.hires.push(entry);
  saveDB();
  res.json({ ok: true, listing: entry });
});

// 市场列表(可雇佣的引擎/员工)
app.get('/api/hire/market', (req, res) => {
  const list = db.hires.filter(h => h.status === 'active').map(h => {
    const owner = db.users[h.ownerId];
    return { id: h.id, name: h.name, desc: h.desc, pricePerTask: h.pricePerTask, ownerName: owner?.displayName || '匿名', ownerId: h.ownerId, agentId: h.agentId, instanceId: h.instanceId };
  });
  res.json({ ok: true, list });
});

// 雇佣某员工(扣积分)
app.post('/api/hire/order', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { listingId, goal } = req.body || {};
  const listing = db.hires.find(h => h.id === listingId && h.status === 'active');
  if (!listing) return res.status(404).json({ error: '该员工不可用' });
  const price = listing.pricePerTask || 0;
  const bal = db.credits[uid] || 0;
  if (bal < price) return res.status(402).json({ error: '积分不足，需 ' + price + ' 积分' });
  db.credits[uid] = bal - price;
  // 给雇主(挂单者)计收入
  db.credits[listing.ownerId] = (db.credits[listing.ownerId] || 0) + price;
  db.hires.find(h => h.id === listingId)!.lastOrderAt = Date.now();
  saveDB();
  res.json({ ok: true, remaining: db.credits[uid], message: '已下单，等待对方引擎执行' });
});

// 我的订单
app.get('/api/hire/my-orders', (req, res) => {
  const uid = parseToken(req.headers.authorization?.replace('Bearer ', ''));
  if (!uid) return res.status(401).json({ error: '未登录' });
  res.json({ ok: true, hires: db.hires.filter(h => h.ownerId === uid) });
});

// ============ 实例(信令, 兼容原路径) ============
app.post('/api/instances/heartbeat', (req, res) => {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== MESH_TOKEN) return res.status(403).json({ error: '鉴权失败' });
  const { instanceId, hostname, lanIp, port, agents, version } = req.body;
  const existing = instances.get(instanceId);
  if (existing) {
    existing.hostname = hostname; existing.lanIp = lanIp; existing.port = port;
    existing.agents = agents || []; existing.version = version; existing.lastHeartbeat = Date.now();
  }
  res.json({ ok: true, timestamp: Date.now() });
});
app.get('/api/instances/list', (req, res) => {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== MESH_TOKEN) return res.status(403).json({ error: '鉴权失败' });
  const list = Array.from(instances.values()).filter(i => i.online).map(i => ({ instanceId: i.id, hostname: i.hostname, lanIp: i.lanIp, port: i.port, agents: i.agents, version: i.version, lastHeartbeat: i.lastHeartbeat }));
  res.json({ ok: true, instances: list });
});

// ============ WebSocket (信令层) ============
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/mesh' });
wss.on('connection', (ws: WebSocket) => {
  let instanceId: string | null = null;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth') {
        if (msg.token !== MESH_TOKEN) { ws.send(JSON.stringify({ type: 'error', message: '鉴权失败' })); ws.close(4001, 'auth failed'); return; }
        instanceId = msg.instanceId;
        if (!instanceId) { ws.send(JSON.stringify({ type: 'error', message: '缺 instanceId' })); ws.close(4001, 'auth failed'); return; }
        instances.set(instanceId, { id: instanceId, ws, hostname: msg.hostname || '', lanIp: msg.lanIp || '', port: msg.port || 0, agents: msg.agents || [], version: msg.version || '0.0.0', lastHeartbeat: Date.now(), online: true });
        ws.send(JSON.stringify({ type: 'auth_ok', instanceId }));
        console.log(`[Mesh] 实例上线: ${instanceId}`);
        return;
      }
      if (!instanceId) { ws.send(JSON.stringify({ type: 'error', message: '未认证' })); return; }
      const inst = instances.get(instanceId); if (inst) inst.lastHeartbeat = Date.now();
      if (msg.toInstance) {
        const target = instances.get(msg.toInstance);
        if (target?.online && target.ws.readyState === WebSocket.OPEN) target.ws.send(JSON.stringify(msg));
        else ws.send(JSON.stringify({ type: 'error', message: `目标实例 ${msg.toInstance} 不在线`, ref: msg.taskId || msg.type }));
      } else {
        for (const [id, i2] of instances) { if (id !== instanceId && i2.online && i2.ws.readyState === WebSocket.OPEN) i2.ws.send(JSON.stringify(msg)); }
      }
    } catch (e: any) { console.error('[Mesh] 消息错误:', e.message); }
  });
  ws.on('close', () => { if (instanceId) { const inst = instances.get(instanceId); if (inst) inst.online = false; console.log(`[Mesh] 实例下线: ${instanceId}`); } });
  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`[Platform] 已启动, 端口 ${PORT}`);
  console.log(`[Platform] MESH_TOKEN=${MESH_TOKEN.slice(0,8)}***`);
});
