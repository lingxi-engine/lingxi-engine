/**
 * 灵犀引擎 - 云平台服务器 (platform-server) v2
 * 闭源。负责：用户账号 / 积分 / 社交 / 雇佣 / (未来商城)
 *
 * v2 改进:
 *  - SQLite (sql.js) 替代 JSON 文件 → 并发安全 + 崩溃不丢数据
 *  - JWT 替代简单 token → 有过期时间 + 签名验证
 *  - 心跳超时自动标记 offline → 在线状态准确
 *  - userRegistry 持久化到 DB → 重启不丢索引
 *  - heartbeat 返回在线数量 → 客户端日志准确
 *  - WS 协议对齐 instance-mesh.ts → mesh.handshake / mesh.handshake_ack
 *  - bcrypt 密码哈希 → 安全
 *  - 参数化 SQL 查询 → 防注入
 *
 * 部署: your-platform-server:3001 (测试服) → 未来独立正式服
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes, createHash } from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import initSqlJs from 'sql.js';
import { isDevMode } from './security/token-compare.js';
import { config as dotenvConfig } from 'dotenv';
// 2026-09-09 v2.0.15: PM2 环境下加载 .env.platform（平台专属配置；不读主引擎 .env，避免误吞 PORT=3456）
dotenvConfig({ path: process.env.PLATFORM_ENV_FILE || '.env.platform' });

// ============ 配置 ============
const PORT = parseInt(process.env.PORT || '3001', 10);
const MESH_TOKEN = process.env.MESH_TOKEN || randomBytes(16).toString('hex');
// 2026-09-02 v4: MESH_TOKEN 弱值守卫（与主引擎 index.ts 保持一致）
const MESH_TOKEN_WEAK = ['change-me-to-a-strong-secret', 'changeme', 'change-me'];
if (MESH_TOKEN_WEAK.includes(MESH_TOKEN) || (process.env.MESH_PLATFORM_URL && !process.env.MESH_TOKEN)) {
  const msg = 'MESH_TOKEN 为默认弱值' + (process.env.MESH_PLATFORM_URL ? '（且已配置 MESH_PLATFORM_URL）' : '');
  if (!isDevMode()) {
    console.error('[FATAL] ' + msg + '，生产环境（NODE_ENV=production）拒绝启动，请设置强随机 MESH_TOKEN');
    process.exit(1);
  }
  console.warn('[WARN] ' + msg + '，仅限开发环境继续运行');
}

const SECRET = process.env.PLATFORM_SECRET || 'lingxi-platform-dev-secret';
// P0-3 修复: JWT_SECRET 固定，不再每次重启随机生成
const JWT_SECRET = process.env.PLATFORM_JWT_SECRET || SECRET;
const JWT_EXPIRES = '30d';
const HEARTBEAT_TIMEOUT = 90_000; // 90秒没心跳 → offline

// ============ v2.0.15 平台管理后台 ============
// fail-secure：未配置 PLATFORM_ADMIN_TOKEN 时所有管理接口返回 503（不存在后门）
const PLATFORM_ADMIN_TOKEN = process.env.PLATFORM_ADMIN_TOKEN || '';
if (!PLATFORM_ADMIN_TOKEN) {
  console.warn('[WARN] 未配置 PLATFORM_ADMIN_TOKEN，平台管理接口已锁定（503）。生成方法：openssl rand -hex 32');
} else {
  console.log('[Config] 平台管理后台已启用（PLATFORM_ADMIN_TOKEN 已配置）');
}

// ============ SQLite 初始化 ============
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data-platform');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = join(DATA_DIR, 'platform.sqlite');
const JSON_BACKUP = join(DATA_DIR, 'platform.json'); // 旧数据迁移

let sqlDb: any; // sql.js Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  numeric_id INTEGER UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  registered_instance TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS credits (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  balance INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(from_id, user_id)
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  message TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS hires (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_id TEXT DEFAULT '',
  name TEXT DEFAULT '',
  description TEXT DEFAULT '',
  price_per_task INTEGER DEFAULT 0,
  instance_id TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  created_at INTEGER NOT NULL,
  last_order_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hire_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  goal TEXT DEFAULT '',
  price INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  hostname TEXT DEFAULT '',
  lan_ip TEXT DEFAULT '',
  port INTEGER DEFAULT 0,
  version TEXT DEFAULT '',
  online INTEGER DEFAULT 0,
  last_heartbeat INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS instance_users (
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  numeric_id INTEGER NOT NULL,
  display_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  PRIMARY KEY(instance_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_from ON friends(from_id);
CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_fr_to ON friend_requests(to_id);
CREATE INDEX IF NOT EXISTS idx_fr_from ON friend_requests(from_id);
CREATE INDEX IF NOT EXISTS idx_iu_numeric ON instance_users(numeric_id);
`;

async function initDB() {
  const SQL = await initSqlJs();
  if (existsSync(DB_FILE)) {
    const buf = readFileSync(DB_FILE);
    sqlDb = new SQL.Database(buf);
  } else {
    sqlDb = new SQL.Database();
  }
  sqlDb.run(SCHEMA);
  migrateUsersTable();
  saveDB();
  migrateFromJson();
}

function saveDB() {
  try {
    const data = sqlDb.export();
    writeFileSync(DB_FILE, Buffer.from(data));
  } catch (e) {
    console.error('[DB] 保存失败', e);
  }
}

// 定时保存（每10秒 + 关键操作后立即保存）
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; saveDB(); }, 10_000);
}

// [平台统一] users 表补资料列（老库平滑迁移；新库 CREATE TABLE 已含）
function migrateUsersTable() {
  try {
    const cols = sqlDb.exec("PRAGMA table_info(users)")[0]?.values?.map((r: any) => r[1]) || [];
    const addIf = (col: string, def: string) => {
      if (!cols.includes(col)) sqlDb.run(`ALTER TABLE users ADD COLUMN ${col} ${def}`);
    };
    addIf('avatar_url', 'TEXT DEFAULT ""');
    addIf('bio', 'TEXT DEFAULT ""');
    addIf('email_verified', 'INTEGER DEFAULT 0');
    addIf('status', 'TEXT DEFAULT "active"');
  } catch (e: any) {
    console.error('[DB] migrateUsersTable 失败:', e.message);
  }
}

function migrateFromJson() {
  const cnt = sqlDb.exec("SELECT COUNT(*) as c FROM users");
  if (cnt.length > 0 && cnt[0].values[0][0] > 0) return; // 已有数据
  if (!existsSync(JSON_BACKUP)) return;
  try {
    const old = JSON.parse(readFileSync(JSON_BACKUP, 'utf8'));
    console.log('[DB] 从 JSON 迁移数据...');
    for (const u of Object.values(old.users || {}) as any[]) {
      sqlDb.run(
        `INSERT OR IGNORE INTO users (id, numeric_id, email, password_hash, display_name, created_at)
         VALUES ($id, $nid, $email, $ph, $dn, $ca)`,
        { $id: u.id, $nid: u.numericId, $email: u.email, $ph: u.passwordHash, $dn: u.displayName, $ca: u.createdAt }
      );
    }
    for (const [uid, bal] of Object.entries(old.credits || {})) {
      sqlDb.run(`INSERT OR IGNORE INTO credits (user_id, balance) VALUES ($u, $b)`, { $u: uid, $b: bal as number });
    }
    for (const r of (old.friendReq || [])) {
      sqlDb.run(
        `INSERT OR IGNORE INTO friend_requests (id, from_id, to_id, status, message, created_at) VALUES ($id,$f,$t,$s,$m,$c)`,
        { $id: r.id, $f: r.from, $t: r.to, $s: r.status, $m: r.message || '', $c: r.createdAt }
      );
    }
    for (const [uid, fids] of Object.entries(old.friends || {}) as [string, string[]][]) {
      for (const fid of fids) {
        sqlDb.run(`INSERT OR IGNORE INTO friends (from_id, user_id, created_at) VALUES ($f,$u,$c)`,
          { $f: uid, $u: fid, $c: Date.now() });
      }
    }
    for (const h of (old.hires || [])) {
      sqlDb.run(
        `INSERT OR IGNORE INTO hires (id, owner_id, agent_id, name, description, price_per_task, instance_id, status, created_at)
         VALUES ($id,$o,$a,$n,$d,$p,$i,$s,$c)`,
        { $id: h.id, $o: h.ownerId, $a: h.agentId || '', $n: h.name || '', $d: h.desc || '', $p: h.pricePerTask || 0, $i: h.instanceId || '', $s: h.status || 'active', $c: h.createdAt }
      );
    }
    saveDB();
    console.log('[DB] ✅ JSON 迁移完成');
  } catch (e) {
    console.error('[DB] JSON 迁移失败:', e);
  }
}

// ============ 工具函数 ============
// P0-2 修复: bcrypt 密码哈希，替代 sha256+SECRET
function hashPw(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}
function verifyPw(pw: string, hash: string): boolean {
  // 兼容旧 sha256 哈希（平滑迁移）
  if (hash.startsWith('$2a$') || hash.startsWith('$2b$')) {
    return bcrypt.compareSync(pw, hash);
  }
  // 旧哈希格式
  const oldHash = createHash('sha256').update(pw + SECRET).digest('hex');
  return hash === oldHash;
}
function genJwt(userId: string): string {
  return jwt.sign({ sub: userId, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}
function parseJwt(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const d = jwt.verify(token, JWT_SECRET) as any;
    return d.sub || null;
  } catch { return null; }
}
function authUser(req: express.Request): string | null {
  return parseJwt(req.headers.authorization?.replace('Bearer ', ''));
}

// ============ 内存实例 + WS 连接 ============
interface Instance {
  id: string; ws: WebSocket; hostname: string; lanIp: string; port: number;
  agents: string[]; version: string; lastHeartbeat: number; online: boolean;
}
const instances = new Map<string, Instance>();
const MAX_INSTANCES = 1000;  // P1-9: 防止恶意实例无限注册

// ============ Express ============
const app = express();
app.use(express.json());

// ============ 2026-09-12 Security hardening: global access gate ============
// Platform server no longer exposed to public internet. All requests except /api/health must carry MESH_TOKEN or PLATFORM_ADMIN_TOKEN. Local engine calls /api/admin/users with token - unaffected.
const PUBLIC_ACCESS_TOKEN = MESH_TOKEN;
app.use((req, res, next) => {
  const p = req.path;
  if (p === '/api/health' || p === '/health') return next();
  const h = req.headers['x-mesh-token'] || req.headers['x-admin-token'] || (req.headers.authorization || '').replace('Bearer ', '') || (req.query.token as string) || '';
  if (h === PUBLIC_ACCESS_TOKEN || h === PLATFORM_ADMIN_TOKEN) return next();
  return res.status(403).json({ ok: false, error: 'Platform closed to public access (403). MESH_TOKEN or PLATFORM_ADMIN_TOKEN required.' });
});

// ============ 用户账号 ============
app.post('/api/user/register', (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (!email || !password || password.length < 6)
    return res.status(400).json({ error: '邮箱和密码(至少6位)必填' });
  const em = String(email).trim().toLowerCase();
  // P0-1 修复: 参数化查询
  const existStmt = sqlDb.prepare("SELECT id FROM users WHERE email = $em");
  existStmt.bind({ $em: em });
  const exists = existStmt.step();
  existStmt.free();
  if (exists) return res.status(409).json({ error: '该邮箱已注册' });

  const maxR = sqlDb.exec("SELECT COALESCE(MAX(numeric_id), 9999) FROM users");
  const numericId = (maxR[0]?.values[0]?.[0] as number || 9999) + 1;
  const userId = 'ouid-' + numericId;
  const dn = displayName || '用户' + numericId;
  const now = Date.now();

  sqlDb.run(`INSERT INTO users (id, numeric_id, email, password_hash, display_name, created_at) VALUES ($id,$nid,$em,$ph,$dn,$now)`,
    { $id: userId, $nid: numericId, $em: em, $ph: hashPw(String(password)), $dn: dn, $now: now });
  sqlDb.run(`INSERT INTO credits (user_id, balance) VALUES ($u, 1000)`, { $u: userId });
  saveDB();  // P1-8: 关键操作立即保存，不依赖 scheduleSave 的 10 秒延迟

  res.json({ ok: true, user: {
    id: userId, numericId, email: em, displayName: dn, credits: 1000,
    avatarUrl: '', bio: '', status: 'active', emailVerified: false,
    avatar_url: '', email_verified: 0,
  }, token: genJwt(userId) });
});

app.post('/api/user/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
  const em = String(email).trim().toLowerCase();
  // P0-1 修复: 参数化查询
  const stmt = sqlDb.prepare("SELECT id, numeric_id, email, display_name, password_hash FROM users WHERE email = $em");
  stmt.bind({ $em: em });
  if (!stmt.step()) { stmt.free(); return res.status(401).json({ error: '邮箱或密码错误' }); }
  const row = stmt.getAsObject();
  stmt.free();
  const { id, numeric_id: nid, email: em2, display_name: dn, password_hash: ph } = row as any;
  if (!verifyPw(String(password), ph)) return res.status(401).json({ error: '邮箱或密码错误' });
  // P0-1 修复: 参数化查询
  const crStmt = sqlDb.prepare("SELECT balance FROM credits WHERE user_id = $u");
  crStmt.bind({ $u: id });
  const credits = crStmt.step() ? (crStmt.getAsObject().balance as number) : 0;
  crStmt.free();
  res.json({ ok: true, user: {
    id, numericId: nid, email: em2, displayName: dn, credits,
    avatarUrl: '', bio: '', status: 'active', emailVerified: false,
    avatar_url: '', email_verified: 0,
  }, token: genJwt(id as string) });
});

app.get('/api/user/me', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  // P0-1 修复: 参数化查询
  const stmt = sqlDb.prepare("SELECT id, numeric_id, email, display_name FROM users WHERE id = $u");
  stmt.bind({ $u: uid });
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: '用户不存在' }); }
  const row = stmt.getAsObject();
  stmt.free();
  const { id, numeric_id: nid, email: em, display_name: dn } = row as any;
  const crStmt = sqlDb.prepare("SELECT balance FROM credits WHERE user_id = $u");
  crStmt.bind({ $u: uid });
  const credits = crStmt.step() ? (crStmt.getAsObject().balance as number) : 0;
  crStmt.free();
  const avStmt = sqlDb.prepare("SELECT avatar_url, bio, status FROM users WHERE id = $u");
  avStmt.bind({ $u: uid });
  const avRow = avStmt.step() ? avStmt.getAsObject() : null;
  avStmt.free();
  const avatarUrl = (avRow?.avatar_url as string) || '';
  const bio = (avRow?.bio as string) || '';
  const status = (avRow?.status as string) || 'active';
  res.json({ ok: true, user: {
    id, numericId: nid, email: em, displayName: dn, credits,
    avatarUrl, bio, status,
    avatar_url: avatarUrl, email_verified: 0,
  } });
});

app.get('/api/user/credits', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const stmt = sqlDb.prepare("SELECT balance FROM credits WHERE user_id = $u");
  stmt.bind({ $u: uid });
  const balance = stmt.step() ? (stmt.getAsObject().balance as number) : 0;
  stmt.free();
  res.json({ ok: true, credits: balance });
});

// 模拟充值（测试模式，未接真实支付）
const CREDIT_RATES: Record<string, number> = { USD: 100, CNY: 14 };
app.post('/api/user/credits/add', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { amount, currency } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0 || amt > 100000) return res.status(400).json({ error: '金额无效' });
  const cur = String(currency || 'USD').toUpperCase();
  const rate = CREDIT_RATES[cur] || CREDIT_RATES.USD;
  const credits = Math.round(amt * rate);
  sqlDb.run(`INSERT INTO credits (user_id, balance) VALUES ($u, $c) ON CONFLICT(user_id) DO UPDATE SET balance = balance + $c`, { $u: uid, $c: credits });
  saveDB();
  const stmt = sqlDb.prepare("SELECT balance FROM credits WHERE user_id = $u");
  stmt.bind({ $u: uid });
  const balance = stmt.step() ? (stmt.getAsObject().balance as number) : credits;
  stmt.free();
  res.json({ ok: true, added: credits, balance, currency: cur, amount: amt, testMode: true });
});

// ============ 用户搜索 ============
app.get('/api/user/search', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ ok: true, results: [] });
  const like = `%${q}%`;
  const stmt = sqlDb.prepare(`SELECT id, numeric_id, display_name, email FROM users WHERE CAST(numeric_id AS TEXT) LIKE $q OR display_name LIKE $q2 OR email LIKE $q3 LIMIT 20`);
  stmt.bind({ $q: like, $q2: like, $q3: like });
  const results: any[] = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  res.json({ ok: true, results });
});

app.get('/api/user/find', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const nid = Number(req.query.numericId);
  const stmt = sqlDb.prepare(`SELECT id, numeric_id, display_name, email FROM users WHERE numeric_id = $n`);
  stmt.bind({ $n: nid });
  if (stmt.step()) {
    const u = stmt.getAsObject();
    stmt.free();
    res.json({ ok: true, found: true, user: u });
  } else {
    stmt.free();
    res.json({ ok: true, found: false });
  }
});

// ============ 好友 ============
app.post('/api/friend/request', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { toNumericId, message } = req.body || {};
  const stmt = sqlDb.prepare(`SELECT id FROM users WHERE numeric_id = $n`);
  stmt.bind({ $n: Number(toNumericId) });
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: '用户不存在' }); }
  const toId = stmt.getAsObject().id as string;
  stmt.free();
  if (toId === uid) return res.status(400).json({ error: '不能加自己' });

  // 已是好友？P0-1 修复: 参数化查询
  const f1Stmt = sqlDb.prepare("SELECT 1 FROM friends WHERE from_id = $a AND user_id = $b");
  f1Stmt.bind({ $a: uid, $b: toId });
  const f1 = f1Stmt.step();
  f1Stmt.free();
  const f2Stmt = sqlDb.prepare("SELECT 1 FROM friends WHERE from_id = $a AND user_id = $b");
  f2Stmt.bind({ $a: toId, $b: uid });
  const f2 = f2Stmt.step();
  f2Stmt.free();
  if (f1 || f2) return res.json({ ok: true, already: true });

  const frId = 'fr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  sqlDb.run(`INSERT INTO friend_requests (id, from_id, to_id, status, message, created_at) VALUES ($id,$f,$t,'pending',$m,$c)`,
    { $id: frId, $f: uid, $t: toId, $m: message || '', $c: Date.now() });
  saveDB();
  res.json({ ok: true });
});

app.get('/api/friend/requests', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const stmt = sqlDb.prepare(
    `SELECT fr.id, fr.from_id, fr.message, u.display_name as from_name, u.numeric_id as from_id_num
     FROM friend_requests fr LEFT JOIN users u ON fr.from_id = u.id
     WHERE fr.to_id = $u AND fr.status = 'pending' ORDER BY fr.created_at DESC`);
  stmt.bind({ $u: uid });
  const incoming: any[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    incoming.push({ id: r.id, from: r.from_id, fromName: r.from_name, fromId: r.from_id_num, fromUserId: r.from_id_num, message: r.message });
  }
  stmt.free();
  res.json({ ok: true, incoming });
});

app.post('/api/friend/respond', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { requestId, action } = req.body || {};
  const stmt = sqlDb.prepare(`SELECT id, from_id, status FROM friend_requests WHERE id = $id AND to_id = $u`);
  stmt.bind({ $id: requestId, $u: uid });
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: '请求不存在' }); }
  const fr = stmt.getAsObject();
  stmt.free();
  if (fr.status !== 'pending') return res.json({ ok: true, alreadyProcessed: true });

  const status = action === 'accept' ? 'accepted' : 'rejected';
  sqlDb.run(`UPDATE friend_requests SET status = $s WHERE id = $id`, { $s: status, $id: requestId });

  if (action === 'accept') {
    const now = Date.now();
    sqlDb.run(`INSERT OR IGNORE INTO friends (from_id, user_id, created_at) VALUES ($a,$b,$n)`, { $a: uid, $b: fr.from_id, $n: now });
    sqlDb.run(`INSERT OR IGNORE INTO friends (from_id, user_id, created_at) VALUES ($a,$b,$n)`, { $a: fr.from_id, $b: uid, $n: now });
  }
  saveDB();
  res.json({ ok: true });
});

app.get('/api/friend/list', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const stmt = sqlDb.prepare(
    `SELECT DISTINCT u.id, u.numeric_id, u.display_name FROM friends f
     JOIN users u ON u.id = CASE WHEN f.from_id = $u THEN f.user_id ELSE f.from_id END
     WHERE f.from_id = $u2 OR f.user_id = $u3`);
  stmt.bind({ $u: uid, $u2: uid, $u3: uid });
  const friends: any[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    friends.push({
      friendId: String(r.id), friendName: r.display_name, friendEmail: r.email || '',
      id: r.id, numeric_id: r.numeric_id, display_name: r.display_name,
      numericId: r.numeric_id, displayName: r.display_name,
    });
  }
  stmt.free();
  res.json({ ok: true, friends });
});

app.post('/api/friend/remove', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { numericId } = req.body || {};
  const stmt = sqlDb.prepare(`SELECT id FROM users WHERE numeric_id = $n`);
  stmt.bind({ $n: Number(numericId) });
  if (stmt.step()) {
    const fid = stmt.getAsObject().id as string;
    stmt.free();
    sqlDb.run(`DELETE FROM friends WHERE (from_id = $a AND user_id = $b) OR (from_id = $b2 AND user_id = $a2)`,
      { $a: uid, $b: fid, $a2: uid, $b2: fid });
    saveDB();
  } else { stmt.free(); }
  res.json({ ok: true });
});

// ============ 雇佣 ============
app.post('/api/hire/list', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { agentId, name, desc, pricePerTask, instanceId } = req.body || {};
  const id = 'hire-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  sqlDb.run(`INSERT INTO hires (id, owner_id, agent_id, name, description, price_per_task, instance_id, status, created_at) VALUES ($id,$o,$a,$n,$d,$p,$i,'active',$c)`,
    { $id: id, $o: uid, $a: agentId || '', $n: name || '灵犀员工', $d: desc || '', $p: pricePerTask || 0, $i: instanceId || '', $c: Date.now() });
  saveDB();
  res.json({ ok: true, listing: { id, name: name || '灵犀员工', desc: desc || '', description: desc || '', pricePerTask: pricePerTask || 0 } });
});

app.get('/api/hire/market', (req, res) => {
  const stmt = sqlDb.prepare(
    `SELECT h.id, h.name, h.description, h.price_per_task, h.owner_id, h.agent_id, h.instance_id, u.display_name as owner_name
     FROM hires h LEFT JOIN users u ON h.owner_id = u.id WHERE h.status = 'active'`);
  stmt.bind();
  const list: any[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    list.push({ id: r.id, name: r.name, desc: r.description, pricePerTask: r.price_per_task, ownerName: r.owner_name, ownerId: r.owner_id, agentId: r.agent_id, instanceId: r.instance_id });
  }
  stmt.free();
  res.json({ ok: true, list });
});

app.post('/api/hire/order', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const { listingId, goal } = req.body || {};
  const stmt = sqlDb.prepare(`SELECT id, owner_id, price_per_task, status FROM hires WHERE id = $id`);
  stmt.bind({ $id: listingId });
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: '该员工不可用' }); }
  const h = stmt.getAsObject();
  stmt.free();
  if (h.status !== 'active') return res.status(404).json({ error: '该员工不可用' });

  const price = h.price_per_task as number;
  // P0-1 修复: 参数化查询
  const crStmt = sqlDb.prepare("SELECT balance FROM credits WHERE user_id = $u");
  crStmt.bind({ $u: uid });
  const bal = crStmt.step() ? (crStmt.getAsObject().balance as number) : 0;
  crStmt.free();
  if (bal < price) return res.status(402).json({ error: '积分不足，需 ' + price + ' 积分' });

  sqlDb.run(`UPDATE credits SET balance = balance - $p WHERE user_id = $u`, { $p: price, $u: uid });
  sqlDb.run(`INSERT INTO credits (user_id, balance) VALUES ($u, $p) ON CONFLICT(user_id) DO UPDATE SET balance = balance + $p2`,
    { $u: h.owner_id, $p: price, $p2: price });
  sqlDb.run(`UPDATE hires SET last_order_at = $t WHERE id = $id`, { $t: Date.now(), $id: listingId });
  sqlDb.run(`INSERT INTO hire_orders (listing_id, buyer_id, goal, price, created_at) VALUES ($l,$b,$g,$p,$c)`,
    { $l: listingId, $b: uid, $g: goal || '', $p: price, $c: Date.now() });
  saveDB();

  // P0-1 修复: 参数化查询
  const cr2Stmt = sqlDb.prepare("SELECT balance FROM credits WHERE user_id = $u");
  cr2Stmt.bind({ $u: uid });
  const remaining = cr2Stmt.step() ? (cr2Stmt.getAsObject().balance as number) : 0;
  cr2Stmt.free();
  res.json({ ok: true, remaining, message: '已下单，等待对方引擎执行' });
});

app.get('/api/hire/my-orders', (req, res) => {
  const uid = authUser(req);
  if (!uid) return res.status(401).json({ error: '未登录' });
  const stmt = sqlDb.prepare(
    `SELECT ho.*, h.name, h.description FROM hire_orders ho LEFT JOIN hires h ON ho.listing_id = h.id WHERE ho.buyer_id = $u ORDER BY ho.created_at DESC`);
  stmt.bind({ $u: uid });
  const orders: any[] = [];
  while (stmt.step()) orders.push(stmt.getAsObject());
  stmt.free();
  res.json({ ok: true, orders });
});

// ============ 实例信令 ============
app.post('/api/instances/heartbeat', (req, res) => {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== MESH_TOKEN) return res.status(403).json({ error: '鉴权失败' });
  const { instanceId, hostname: hn, lanIp, port, agents, version, users } = req.body;
  if (!instanceId) return res.status(400).json({ error: '缺 instanceId' });

  const now = Date.now();
  sqlDb.run(`INSERT INTO instances (id, hostname, lan_ip, port, version, online, last_heartbeat) VALUES ($id,$h,$ip,$p,$v,1,$now)
    ON CONFLICT(id) DO UPDATE SET hostname=$h2, lan_ip=$ip2, port=$p2, version=$v2, online=1, last_heartbeat=$now2`,
    { $id: instanceId, $h: hn || '', $ip: lanIp || '', $p: port || 0, $v: version || '',
      $h2: hn || '', $ip2: lanIp || '', $p2: port || 0, $v2: version || '', $now: now, $now2: now });

  // 更新内存实例
  const inst = instances.get(instanceId);
  if (inst) {
    inst.hostname = hn || ''; inst.lanIp = lanIp || ''; inst.port = port || 0;
    inst.agents = agents || []; inst.version = version || ''; inst.lastHeartbeat = now; inst.online = true;
  }

  // 更新用户注册表
  if (Array.isArray(users)) {
    sqlDb.run(`DELETE FROM instance_users WHERE instance_id = $i`, { $i: instanceId });
    for (const u of users) {
      sqlDb.run(`INSERT OR REPLACE INTO instance_users (instance_id, user_id, numeric_id, display_name, email) VALUES ($i,$uid,$nid,$dn,$em)`,
        { $i: instanceId,
          $uid: u.userId ?? u.id ?? '',
          $nid: u.numericId ?? u.numeric_id ?? 0,
          $dn: u.displayName ?? u.display_name ?? '',
          $em: u.email ?? u.email ?? '' });
    }
  }

  // 统计在线
  const onlineR = sqlDb.exec("SELECT COUNT(*) FROM instances WHERE online = 1");
  const online = onlineR.length ? (onlineR[0].values[0][0] as number) : 0;

  saveDB();  // P1-9: heartbeat 立即保存，崩溃时不丢失最近心跳
  res.json({ ok: true, timestamp: now, online });
});

app.get('/api/instances/list', (req, res) => {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== MESH_TOKEN) return res.status(403).json({ error: '鉴权失败' });
  cleanExpiredInstances();
  const stmt = sqlDb.prepare(`SELECT id, hostname, lan_ip, port, version, last_heartbeat FROM instances WHERE online = 1`);
  stmt.bind();
  const list: any[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    list.push({ instanceId: r.id, hostname: r.hostname, lanIp: r.lan_ip, port: r.port, version: r.version, lastHeartbeat: r.last_heartbeat });
  }
  stmt.free();
  res.json({ ok: true, instances: list });
});

// 心跳超时清理
function cleanExpiredInstances() {
  const cutoff = Date.now() - HEARTBEAT_TIMEOUT;
  for (const [id, inst] of instances) {
    if (inst.online && inst.lastHeartbeat < cutoff) {
      inst.online = false;
      sqlDb.run(`UPDATE instances SET online = 0 WHERE id = $id`, { $id: id });
      console.log(`[Mesh] 实例超时下线: ${id}`);
    }
  }
  // 也检查 DB 中的
  sqlDb.run(`UPDATE instances SET online = 0 WHERE online = 1 AND last_heartbeat < $c`, { $c: cutoff });
}

// 定时清理（每30秒）
setInterval(cleanExpiredInstances, 30_000);

// ============ v2.0.15 平台管理后台路由 ============
// 鉴权中间件：fail-secure，token 未配置 → 503；token 不匹配 → 401
function platformAdminAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!PLATFORM_ADMIN_TOKEN) return res.status(503).json({ ok: false, error: '管理后台未配置 PLATFORM_ADMIN_TOKEN，接口已锁定' });
  const provided = (req.headers['x-admin-token'] as string) || (req.headers.authorization?.replace('Bearer ', '') || '') || (req.query.token as string) || '';
  if (provided !== PLATFORM_ADMIN_TOKEN) return res.status(401).json({ ok: false, error: '管理员令牌错误' });
  next();
}

// 静态托管：web/ 目录（platform-admin.html 等）
const WEB_DIR = join(process.cwd(), 'web');
app.use(express.static(WEB_DIR));

// ── 仪表盘：全局统计 + 用户列表 ──
// 兼容本地引擎启动拉取格式：GET /api/admin/users?token=xxx → { ok, users:[{id, role, username, points}] }
app.get('/api/admin/users', platformAdminAuth, (req, res) => {
  const stmt = sqlDb.prepare(`SELECT u.id, u.numeric_id, u.email, u.display_name, u.avatar_url, u.bio, u.status, u.created_at,
    COALESCE(c.balance, 0) as balance
    FROM users u LEFT JOIN credits c ON c.user_id = u.id ORDER BY u.numeric_id DESC LIMIT 500`);
  stmt.bind();
  const users: any[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    users.push({
      id: r.id, numericId: r.numeric_id, email: r.email, displayName: r.display_name,
      avatarUrl: r.avatar_url, bio: r.bio, status: r.status || 'active', createdAt: r.created_at,
      credits: r.balance,
      // 兼容本地引擎 index.ts 启动拉取的格式（role/username/points）
      role: 'admin', username: r.display_name, points: r.balance,
    });
  }
  stmt.free();
  const totalUsers = users.length;
  const totalCredits = users.reduce((s, u) => s + (u.credits || 0), 0);
  const ordersR = sqlDb.exec('SELECT COUNT(*) FROM hire_orders');
  const totalOrders = ordersR.length ? (ordersR[0].values[0][0] as number) : 0;
  const onlineR = sqlDb.exec('SELECT COUNT(*) FROM instances WHERE online = 1');
  const onlineInstances = onlineR.length ? (onlineR[0].values[0][0] as number) : 0;
  res.json({ ok: true, users, stats: { totalUsers, totalCredits, totalOrders, onlineInstances } });
});

// ── 发/扣积分 ──
app.post('/api/admin/credits/grant', platformAdminAuth, (req, res) => {
  const { userId, amount, reason } = req.body || {};
  const amt = Number(amount);
  if (!userId || !Number.isFinite(amt) || amt === 0)
    return res.status(400).json({ ok: false, error: 'userId 和非零 amount 必填' });
  const uStmt = sqlDb.prepare('SELECT id FROM users WHERE id = $u');
  uStmt.bind({ $u: String(userId) });
  if (!uStmt.step()) { uStmt.free(); return res.status(404).json({ ok: false, error: '用户不存在' }); }
  uStmt.free();
  const cStmt = sqlDb.prepare('SELECT balance FROM credits WHERE user_id = $u');
  cStmt.bind({ $u: String(userId) });
  const before = cStmt.step() ? (cStmt.getAsObject().balance as number) : 0;
  cStmt.free();
  const after = before + amt;
  if (after < 0) return res.status(400).json({ ok: false, error: `扣减后余额为负（当前 ${before}）` });
  sqlDb.run(`INSERT INTO credits (user_id, balance) VALUES ($u, $after)
    ON CONFLICT(user_id) DO UPDATE SET balance = $after2`, { $u: String(userId), $after: after, $after2: after });
  saveDB();
  console.log(`[Admin] 积分操作: ${userId} ${amt > 0 ? '+' : ''}${amt} (${reason || '无备注'}) → ${after}`);
  res.json({ ok: true, userId, before, after, changed: amt });
});

// ── 账单流水 ──
app.get('/api/admin/orders', platformAdminAuth, (req, res) => {
  const uid = String(req.query.userId || '').trim();
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  let sql = `SELECT o.id, o.listing_id, o.buyer_id, o.goal, o.price, o.created_at,
    bu.display_name as buyer_name, hu.display_name as seller_name
    FROM hire_orders o
    LEFT JOIN users bu ON bu.id = o.buyer_id
    LEFT JOIN hires h ON h.id = o.listing_id
    LEFT JOIN users hu ON hu.id = h.owner_id`;
  const params: any = {};
  if (uid) { sql += ' WHERE o.buyer_id = $uid'; params.$uid = uid; }
  sql += ' ORDER BY o.created_at DESC LIMIT $lim';
  params.$lim = limit;
  const stmt = sqlDb.prepare(sql);
  stmt.bind(params);
  const orders: any[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    orders.push({
      id: r.id, listingId: r.listing_id, buyerId: r.buyer_id, buyerName: r.buyer_name || r.buyer_id,
      sellerName: r.seller_name || '未知', goal: r.goal, price: r.price, createdAt: r.created_at,
    });
  }
  stmt.free();
  const totalR = sqlDb.exec('SELECT COALESCE(SUM(price), 0), COUNT(*) FROM hire_orders');
  const [sum, cnt] = totalR.length ? totalR[0].values[0] : [0, 0];
  res.json({ ok: true, orders, stats: { totalVolume: sum, totalCount: cnt } });
});

// ── 封禁 / 解封 ──
app.post('/api/admin/users/:id/ban', platformAdminAuth, (req, res) => {
  const id = req.params.id;
  const uStmt = sqlDb.prepare('SELECT id, status FROM users WHERE id = $u');
  uStmt.bind({ $u: id });
  if (!uStmt.step()) { uStmt.free(); return res.status(404).json({ ok: false, error: '用户不存在' }); }
  uStmt.free();
  sqlDb.run('UPDATE users SET status = $s WHERE id = $u', { $s: 'banned', $u: id });
  saveDB();
  console.log(`[Admin] 封禁用户: ${id}`);
  res.json({ ok: true, userId: id, status: 'banned' });
});

app.post('/api/admin/users/:id/unban', platformAdminAuth, (req, res) => {
  const id = req.params.id;
  const uStmt = sqlDb.prepare('SELECT id, status FROM users WHERE id = $u');
  uStmt.bind({ $u: id });
  if (!uStmt.step()) { uStmt.free(); return res.status(404).json({ ok: false, error: '用户不存在' }); }
  uStmt.free();
  sqlDb.run('UPDATE users SET status = $s WHERE id = $u', { $s: 'active', $u: id });
  saveDB();
  console.log(`[Admin] 解封用户: ${id}`);
  res.json({ ok: true, userId: id, status: 'active' });
});

// ── 删除用户（级联清理）──
app.delete('/api/admin/users/:id', platformAdminAuth, (req, res) => {
  const id = req.params.id;
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: '需要 confirm:true 才能删除' });
  const uStmt = sqlDb.prepare('SELECT id FROM users WHERE id = $u');
  uStmt.bind({ $u: id });
  if (!uStmt.step()) { uStmt.free(); return res.status(404).json({ ok: false, error: '用户不存在' }); }
  uStmt.free();
  // 级联清理：积分 → 好友双向 → 好友请求 → 挂单 → 订单 → 实例用户映射 → 本体
  sqlDb.run('DELETE FROM credits WHERE user_id = $u', { $u: id });
  sqlDb.run('DELETE FROM friends WHERE from_id = $u OR user_id = $u', { $u: id });
  sqlDb.run('DELETE FROM friend_requests WHERE from_id = $u OR to_id = $u', { $u: id });
  sqlDb.run('DELETE FROM hires WHERE owner_id = $u', { $u: id });
  sqlDb.run('DELETE FROM hire_orders WHERE buyer_id = $u', { $u: id });
  sqlDb.run('DELETE FROM instance_users WHERE user_id = $u', { $u: id });
  sqlDb.run('DELETE FROM users WHERE id = $u', { $u: id });
  saveDB();
  console.log(`[Admin] 删除用户及级联数据: ${id}`);
  res.json({ ok: true, deleted: id });
});

// ── 实例列表（运维视角）──
app.get('/api/admin/instances', platformAdminAuth, (req, res) => {
  cleanExpiredInstances();
  const stmt = sqlDb.prepare(`SELECT id, hostname, lan_ip, port, version, online, last_heartbeat
    FROM instances ORDER BY online DESC, last_heartbeat DESC LIMIT 500`);
  stmt.bind();
  const list: any[] = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    list.push({
      instanceId: r.id, hostname: r.hostname, lanIp: r.lan_ip, port: r.port,
      version: r.version, online: !!r.online, lastHeartbeat: r.last_heartbeat,
    });
  }
  stmt.free();
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

      // 握手: 兼容 mesh.handshake (instance-mesh.ts) 和 auth (旧版)
      if (msg.type === 'mesh.handshake' || msg.type === 'auth') {
        if (msg.token !== MESH_TOKEN) {
          ws.send(JSON.stringify({ type: 'error', message: '鉴权失败' }));
          ws.close(4001, 'auth failed');
          return;
        }
        instanceId = msg.instanceId;
        if (!instanceId) {
          ws.send(JSON.stringify({ type: 'error', message: '缺 instanceId' }));
          ws.close(4001, 'no instanceId');
          return;
        }

        // P1-9: 检查实例上限
        if (instances.size >= MAX_INSTANCES && !instances.has(instanceId)) {
          ws.send(JSON.stringify({ type: 'error', message: '实例数量已达上限' }));
          ws.close(4003, 'max instances reached');
          return;
        }

        // 如果旧连接还在，标记下线
        const old = instances.get(instanceId);
        if (old && old.ws !== ws && old.ws.readyState === WebSocket.OPEN) {
          try { old.ws.close(4002, 'replaced'); } catch {}
        }

        // P0-1 修复: 参数化查询
        const dbStmt = sqlDb.prepare("SELECT hostname, lan_ip, port, version FROM instances WHERE id = $id");
        dbStmt.bind({ $id: instanceId });
        let dbInst = null;
        if (dbStmt.step()) { dbInst = dbStmt.getAsObject(); }
        dbStmt.free();

        instances.set(instanceId, {
          id: instanceId, ws,
          hostname: msg.hostname || (dbInst ? dbInst.hostname as string : ''),
          lanIp: msg.lanIp || (dbInst ? dbInst.lan_ip as string : ''),
          port: msg.port || (dbInst ? dbInst.port as number : 0),
          agents: msg.agents || [],
          version: msg.version || (dbInst ? dbInst.version as string : ''),
          lastHeartbeat: Date.now(),
          online: true,
        });

        // 更新 DB
        sqlDb.run(`INSERT INTO instances (id, online, last_heartbeat) VALUES ($id, 1, $now)
          ON CONFLICT(id) DO UPDATE SET online = 1, last_heartbeat = $now2`,
          { $id: instanceId, $now: Date.now(), $now2: Date.now() });
        saveDB();  // P1-9: 实例上线立即保存

        // 响应: 兼容 mesh.handshake_ack 和 auth_ok
        ws.send(JSON.stringify({ type: 'mesh.handshake_ack', instanceId }));
        ws.send(JSON.stringify({ type: 'auth_ok', instanceId }));

        cleanExpiredInstances();
        console.log(`[Mesh] 实例上线: ${instanceId}`);
        return;
      }

      if (!instanceId) { ws.send(JSON.stringify({ type: 'error', message: '未认证' })); return; }

      // 更新心跳
      const inst = instances.get(instanceId);
      if (inst) {
        inst.lastHeartbeat = Date.now();
      }

      // 转发 peer 消息
      if (msg.toInstance) {
        const target = instances.get(msg.toInstance);
        if (target?.online && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(JSON.stringify(msg));
        } else {
          ws.send(JSON.stringify({ type: 'peer.message.error', error: `目标实例 ${msg.toInstance} 不在线`, toInstance: msg.toInstance, ref: msg.taskId || msg.type }));
        }
      } else if (msg.type?.startsWith('peer.')) {
        // 广播
        for (const [id, i2] of instances) {
          if (id !== instanceId && i2.online && i2.ws.readyState === WebSocket.OPEN) {
            i2.ws.send(JSON.stringify(msg));
          }
        }
      }
    } catch (e: any) {
      console.error('[Mesh] 消息错误:', e.message);
    }
  });

  ws.on('close', () => {
    if (instanceId) {
      const inst = instances.get(instanceId);
      if (inst && inst.ws === ws) {
        inst.online = false;
        sqlDb.run(`UPDATE instances SET online = 0 WHERE id = $id`, { $id: instanceId });
        saveDB();  // P1-9: 实例下线立即保存
        console.log(`[Mesh] 实例下线: ${instanceId}`);
      }
    }
  });

  ws.on('error', () => {});
});

// ============ 启动 ============
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`[Platform] v2 已启动, 端口 ${PORT}, SQLite 存储`);
    console.log(`[Platform] JWT 签名: ${JWT_SECRET.slice(0, 8)}***`);
    console.log(`[Platform] MESH_TOKEN: ${MESH_TOKEN.slice(0, 8)}***`);
  });
}).catch(err => {
  console.error('[Platform] 启动失败:', err);
  process.exit(1);
});
