/**
 * patch-platform-admin.mjs
 * v2.0.15: 给 platform-server.ts 加平台管理后台
 *  - PLATFORM_ADMIN_TOKEN 配置（fail-secure）
 *  - 7 条 /api/admin/* 路由
 *  - express.static 托管 web/ 目录（platform-admin.html）
 * 用法: node patch-platform-admin.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const FILE = 'src/platform-server.ts';
let src = readFileSync(FILE, 'utf8');

if (src.includes('PLATFORM_ADMIN_TOKEN')) {
  console.log('[Skip] 管理后台代码已存在，无需重复打补丁');
  process.exit(0);
}

// ── 1. 配置区：PLATFORM_ADMIN_TOKEN（插在 HEARTBEAT_TIMEOUT 之后）──
const CFG_ANCHOR = "const HEARTBEAT_TIMEOUT = 90_000; // 90秒没心跳 → offline";
const CFG_INSERT = CFG_ANCHOR + `

// ============ v2.0.15 平台管理后台 ============
// fail-secure：未配置 PLATFORM_ADMIN_TOKEN 时所有管理接口返回 503（不存在后门）
const PLATFORM_ADMIN_TOKEN = process.env.PLATFORM_ADMIN_TOKEN || '';
if (!PLATFORM_ADMIN_TOKEN) {
  console.warn('[WARN] 未配置 PLATFORM_ADMIN_TOKEN，平台管理接口已锁定（503）。生成方法：openssl rand -hex 32');
} else {
  console.log('[Config] 平台管理后台已启用（PLATFORM_ADMIN_TOKEN 已配置）');
}`;
if (!src.includes(CFG_ANCHOR)) throw new Error('配置锚点未找到');
src = src.replace(CFG_ANCHOR, CFG_INSERT);

// ── 2. 静态托管 + 管理路由：插在 WS 之前（"// ============ WebSocket" 前）──
const WS_ANCHOR = '// ============ WebSocket (信令层) ============';
const ADMIN_BLOCK = `// ============ v2.0.15 平台管理后台路由 ============
// 鉴权中间件：fail-secure，token 未配置 → 503；token 不匹配 → 401
function platformAdminAuth(req, res, next) {
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
  const stmt = sqlDb.prepare(\`SELECT u.id, u.numeric_id, u.email, u.display_name, u.avatar_url, u.bio, u.status, u.created_at,
    COALESCE(c.balance, 0) as balance
    FROM users u LEFT JOIN credits c ON c.user_id = u.id ORDER BY u.numeric_id DESC LIMIT 500\`);
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
  if (after < 0) return res.status(400).json({ ok: false, error: \`扣减后余额为负（当前 \${before}）\` });
  sqlDb.run(\`INSERT INTO credits (user_id, balance) VALUES ($u, $after)
    ON CONFLICT(user_id) DO UPDATE SET balance = $after2\`, { $u: String(userId), $after: after, $after2: after });
  saveDB();
  console.log(\`[Admin] 积分操作: \${userId} \${amt > 0 ? '+' : ''}\${amt} (\${reason || '无备注'}) → \${after}\`);
  res.json({ ok: true, userId, before, after, changed: amt });
});

// ── 账单流水 ──
app.get('/api/admin/orders', platformAdminAuth, (req, res) => {
  const uid = String(req.query.userId || '').trim();
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  let sql = \`SELECT o.id, o.listing_id, o.buyer_id, o.goal, o.price, o.created_at,
    bu.display_name as buyer_name, hu.display_name as seller_name
    FROM hire_orders o
    LEFT JOIN users bu ON bu.id = o.buyer_id
    LEFT JOIN hires h ON h.id = o.listing_id
    LEFT JOIN users hu ON hu.id = h.owner_id\`;
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
  console.log(\`[Admin] 封禁用户: \${id}\`);
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
  console.log(\`[Admin] 解封用户: \${id}\`);
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
  console.log(\`[Admin] 删除用户及级联数据: \${id}\`);
  res.json({ ok: true, deleted: id });
});

// ── 实例列表（运维视角）──
app.get('/api/admin/instances', platformAdminAuth, (req, res) => {
  cleanExpiredInstances();
  const stmt = sqlDb.prepare(\`SELECT id, hostname, lan_ip, port, version, online, last_heartbeat
    FROM instances ORDER BY online DESC, last_heartbeat DESC LIMIT 500\`);
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

`;
if (!src.includes(WS_ANCHOR)) throw new Error('WS 锚点未找到');
src = src.replace(WS_ANCHOR, ADMIN_BLOCK + WS_ANCHOR);

writeFileSync(FILE, src, 'utf8');
console.log('[OK] 补丁已写入 src/platform-server.ts');
console.log('     - PLATFORM_ADMIN_TOKEN 配置区（fail-secure）');
console.log('     - platformAdminAuth 中间件 + 7 条 /api/admin/* 路由');
console.log('     - express.static 托管 web/ 目录');