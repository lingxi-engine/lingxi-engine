/**
 * 认证/用户路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 1/N）
 *
 * 抽取范围: 原 index.ts L595-913（v2.0.7~v2.4.1 认证相关 16 个端点）
 *   - /api/auth/* 12 条（register/verify-email/login/login-by-id/forgot/reset/refresh/logout/me/send-code/register-with-email）
 *   - /api/user/me 兼容别名
 *   - /api/admin/invite-codes POST+GET（含 adminAuth 挂载）
 *   - /api/users/register 旧版用户名注册
 * 原则: 业务代码逐行保真，仅做依赖注入改造（db/manager/defaultModel/requireAuth/broadcast 由宿主传入）
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查
 */
import type { Express, RequestHandler } from 'express';
import { randomInt } from 'crypto';
import * as auth from '../auth/index.js';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { adminAuth } from '../middleware/admin-auth.js';
import { authRateLimit } from '../middleware/rate-limit.js';
import { createInviteCode, listInviteCodes, listUsers, nextNumericId, syncAgentToPrivateChats, getDB, saveToDisk, type DB } from '../storage/db.js';
import { UsageTracker } from '../core/usage-tracker.js';
import type { AgentManager } from '../agents/manager.js';
import { getInstanceId } from '../core/instance-mesh.js';

interface User {
  id: string;
  email?: string;
  username?: string;
  displayName: string;
  agentId?: string;
  createdAt: number;
}

interface VerificationCode {
  email: string;
  code: string;
  username?: string;
  expiresAt: number;
}

const verificationCodes = new Map<string, VerificationCode>();
// P0-4 修复: 验证码尝试次数限制（防暴力枚举）
const verificationAttempts = new Map<string, { count: number; firstAttempt: number }>();
const MAX_CODE_ATTEMPTS = 10;  // 5分钟内最多尝试10次
const ATTEMPT_WINDOW = 5 * 60 * 1000;

export interface AuthRouteDeps {
  db: DB;
  manager: AgentManager;
  defaultModel: string;
  requireAuth: RequestHandler;
  broadcast: (event: any) => void;
}

export function registerAuthRoutes(app: Express, deps: AuthRouteDeps): void {
  const { db, manager, defaultModel, requireAuth, broadcast } = deps;

  // ════════════════════════════════════════════════
  // ── V7 认证路由（持久身份：邮箱+密码+数字ID+JWT） ──
  // ════════════════════════════════════════════════

  // ── V7: 注册（邮箱 + 密码 + 数字 ID） ──
  app.post('/api/auth/register', authRateLimit, async (req, res) => {
    try {
      const { email, password, display_name, invite_code, agent_binding } = req.body;
      const result = auth.register({
        email, password, displayName: display_name, inviteCode: invite_code,
        agentBinding: agent_binding || 'skip',
      });
      // 注册成功后自动登录并签发 token，前端无需再次登录
      let tokens: any = {};
      try { tokens = await auth.loginWithEmail(email, password); } catch (_e) {}
      // 如果选了 auto_default，自动创建灵犀引擎
      if (agent_binding === 'auto_default' && result.user) {
        try {
          const agent = manager.register(result.user.id, display_name + '的灵犀引擎', display_name + ' 的 AI 助手', 'semi');
          if (defaultModel) {
            try { await manager.update(agent.id, { model: defaultModel, modelSource: 'local' }); } catch(_e) {}
          }
          res.json({ ok: true, user: result.user, agent, ...tokens });
        } catch (ae: any) {
          res.json({ ok: true, user: result.user, agentError: ae.message, ...tokens });
        }
      } else {
        res.json({ ok: true, user: result.user, ...tokens });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 邮箱验证 ──
  app.get('/api/auth/verify-email', (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.status(400).json({ error: '缺少 token' });
      const result = auth.verifyEmail(token);
      res.json({ ok: true, message: '邮箱验证成功', userId: result.userId, email: result.email });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 登录（邮箱 + 密码） ──
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
      const result = await auth.loginWithEmail(email, password);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  });

  // ── V7: 登录（数字 ID + 密码） ──
  app.post('/api/auth/login-by-id', (req, res) => {
    try {
      const { numeric_id, password } = req.body;
      if (!numeric_id || !password) return res.status(400).json({ error: '数字ID和密码必填' });
      const result = auth.loginWithNumericId(Number(numeric_id), password);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  });

  // ── V7: 忘记密码（防枚举，总是 200） ──
  app.post('/api/auth/forgot-password', (req, res) => {
    try {
      const { email } = req.body;
      if (!email || !email.includes('@')) return res.status(400).json({ error: '请输入有效的邮箱' });
      auth.forgotPassword(email);
      res.json({ ok: true, message: '如果该邮箱已注册，重置链接已发送' });
    } catch (err: any) {
      res.json({ ok: true, message: '如果该邮箱已注册，重置链接已发送' });
    }
  });

  // ── V7: 重置密码 ──
  app.post('/api/auth/reset-password', (req, res) => {
    try {
      const { token, new_password } = req.body;
      auth.resetPassword(token, new_password);
      res.json({ ok: true, message: '密码已重置，请重新登录' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 刷新 token ──
  app.post('/api/auth/refresh', (req, res) => {
    try {
      const { refresh_token } = req.body;
      if (!refresh_token) return res.status(400).json({ error: '缺少 refresh_token' });
      const result = auth.refreshAccessToken(refresh_token);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  });

  // ── V7: 注销 ──
  app.post('/api/auth/logout', jwtAuth({ required: true }), (req, res) => {
    try {
      const sid = (req as any).user?.sid;
      const uid = (req as any).user?.sub;
      if (sid) auth.logout(sid);
      // 登出时设置用户状态为 offline
      if (uid) {
        try { getDB().run('UPDATE users SET status = ?, last_active_at = ? WHERE id = ?', ['offline', Date.now(), uid]); } catch {}
        try { broadcast({ type: 'user.offline', userId: uid }); } catch {}
      }
      res.json({ ok: true, message: '已注销' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 当前用户信息（需 JWT） ──
  app.get('/api/auth/me', jwtAuth({ required: true }), (req, res) => {
    const user = { ...(req as any).user };
    const platformApiUrl = (globalThis as any).__platformApiUrl || '';
    const platformAdminToken = (globalThis as any).__platformAdminToken || '';

    // 情况 1: 平台 admin-auto 模式（未登录，使用平台 admin 身份）
    if (user.sid === 'platform-admin') {
      const pa = (globalThis as any).__platformAdminUser;
      if (pa) {
        user.id = String(pa.id);
        user.display_name = pa.username;
        user.username = pa.username;
        user.numeric_id = pa.id;
        user.email = pa.email || '';
        user.points = pa.points;
        user.status = pa.status || 'active';
        user.role = pa.role || 'admin';
      }
      return res.json({ ok: true, user });
    }

    // 情况 2: 平台 JWT（用户通过平台登录，payload 含 id/username/role）
    if (user.id && !user.sub) {
      // 这是平台签发的 JWT，补全字段
      user.sub = String(user.id);
      user.numeric_id = Number(user.id);
      user.sid = user.sid || 'platform';
      user.roles = user.roles || [user.role || 'user'];
      // 从平台 API 获取最新用户信息
      if (platformApiUrl) {
        (async () => {
          try {
            const resp = await fetch(`${platformApiUrl}/api/user/${user.id}`);
            const d = await resp.json() as any;
            if (d.ok && d.user) {
              user.username = d.user.username;
              user.display_name = d.user.username;
              user.email = d.user.email || '';
              // 补充积分等信息
              if (platformAdminToken) {
                try {
                  const ar = await fetch(`${platformApiUrl}/api/admin/users/${user.id}?token=${platformAdminToken}`);
                  const ad = await ar.json() as any;
                  if (ad.ok && ad.user) {
                    user.points = ad.user.points;
                    user.status = ad.user.status;
                  }
                } catch(_e) {}
              }
            }
          } catch(_e) {}
          // 确保 main.db 中有对应的本地记录（用于聊天引用）
          try {
            const localId = String(user.id);
            const existing = db.getUser(localId);
            if (!existing && user.username) {
              db.createUser(localId, user.username);
              const raw2 = getDB();
              raw2.run('UPDATE users SET numeric_id = ?, status = ? WHERE id = ?', [Number(user.id), 'online', localId]);
              saveToDisk();
            } else if (existing && user.username && existing.display_name !== user.username) {
              // 修复: 同步云平台最新 display_name 到本地数据库，避免刷新后回退为"用户+nid"
              const raw2 = getDB();
              raw2.run('UPDATE users SET display_name = ?, status = ? WHERE id = ?', [user.username, 'online', localId]);
              saveToDisk();
            }
          } catch(_e) {}
          // 注册到 Mesh 平台（让其他实例能找到此用户）
          try {
            const meshUrl = process.env.MESH_PLATFORM_URL || '';
            const meshTok = process.env.MESH_TOKEN || '';
            if (meshUrl && meshTok && user.numeric_id) {
              fetch(meshUrl.replace(/\/$/, '') + '/api/users/register', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + meshTok, 'Content-Type': 'application/json' },
                body: JSON.stringify({ instanceId: getInstanceId(), numericId: Number(user.numeric_id), displayName: user.username || user.display_name || '', email: user.email || '', userId: String(user.id) }),
              }).catch(() => {});
            }
          } catch(_e) {}
          res.json({ ok: true, user });
        })();
      } else {
        res.json({ ok: true, user });
      }
      return;
    }

    // 情况 3: 引擎本地 JWT（admin-auto 回退模式或本地注册用户）
    try {
      const dbUser = db.getUser(user.sub || user.id || '');
      if (dbUser) {
        user.id = dbUser.id;
        user.display_name = dbUser.display_name;
        user.numeric_id = dbUser.numeric_id;
        user.email = dbUser.email;
        user.username = dbUser.username;
        user.status = dbUser.status;
        user.avatar_url = dbUser.avatar_url || '';
        user.bio = dbUser.bio || '';
        user.email_verified = !!dbUser.email_verified;
      }
    } catch(_e) {}
    // 兜底: 从 sub 取 id
    if (!user.id && user.sub) user.id = String(user.sub);
    res.json({ ok: true, user });
  });

  // ── v2.4.1: /api/user/me 兼容别名（旧前端/客户端 checkAuthStatus 调用，避免 404 误清登录态）──
  app.get('/api/user/me', jwtAuth({ required: true }), (req, res) => {
    try {
      const user = { ...(req as any).user };
      if (!user.id && user.sub) user.id = String(user.sub);
      if (user.numeric_id === undefined && user.numericId !== undefined) user.numeric_id = user.numericId;
      res.json({ ok: true, user });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V7: Admin 管理接口 ──
  app.use('/api/admin/*', adminAuth);
  app.post('/api/admin/invite-codes', (req, res) => {
    try {
      const { code, max_uses, expires_at } = req.body;
      if (!code) return res.status(400).json({ error: '缺少 code' });
      createInviteCode(code, 'admin', max_uses || 1, expires_at ? Number(expires_at) : undefined);
      res.json({ ok: true, code });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
  app.get('/api/admin/invite-codes', (_req, res) => {
    res.json({ ok: true, codes: listInviteCodes() });
  });
  // ── v2.4.x: Admin 后台聚合面板（web/admin.html 登录+数据加载入口） ──
  app.get('/api/admin/dashboard', (_req, res) => {
    try {
      const users = listUsers().map((u: any) => {
        return u;
      });
      const raw: any = getDB();
      const count = (sql: string, params: any[] = []) => {
        try {
          const st = raw.prepare(sql);
          if (params.length) st.bind(params);
          const row: any = st.step() ? st.getAsObject() : {};
          st.free();
          return Number(Object.values(row)[0] ?? 0);
        } catch { return 0; }
      };
      const now = Date.now();
      res.json({
        ok: true,
        data: {
          users,
          agentCount: count('SELECT COUNT(*) AS c FROM agents'),
          chatCount: count('SELECT COUNT(*) AS c FROM chats'),
          msgCount: count('SELECT COUNT(*) AS c FROM messages'),
          sessionCount: count('SELECT COUNT(*) AS c FROM user_sessions WHERE revoked_at IS NULL AND expires_at > ?', [now]),
          usage: UsageTracker.getStats(),
          inviteCodes: listInviteCodes(),
        },
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── v2.4.x: Admin 最近调用记录（web/admin.html "最近调用"标签） ──
  app.get('/api/admin/usage', (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(String(req.query.limit)) || 50, 1), 500);
      res.json({ ok: true, recent: UsageTracker.getRecentRecords(limit) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── 旧版兼容：验证码发送（保留 demo 模式） ──
  app.post('/api/auth/send-code', (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }
    const code = String(randomInt(100000, 1000000));
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const username = req.body.username;
    verificationCodes.set(email, { email, code, username, expiresAt });
    console.log('[Auth] 验证码已生成:', email, '(已脱敏)');
    res.json({ ok: true, message: '验证码已生成', expiresIn: 300 });
  });

  // ── 旧版兼容：验证码注册（保留 demo 模式） ──
  app.post('/api/auth/register-with-email', async (req, res) => {
    try {
      const { email, code, username } = req.body;
      if (!email || !code) return res.status(400).json({ error: '邮箱和验证码必填' });
      const stored = verificationCodes.get(email);
      if (!stored) return res.status(400).json({ error: '请先获取验证码' });
      if (Date.now() > stored.expiresAt) {
        verificationCodes.delete(email);
        return res.status(400).json({ error: '验证码已过期，请重新获取' });
      }
      // P0-4 修复: 验证码尝试次数检查
      const attempts = verificationAttempts.get(email);
      if (attempts && Date.now() - attempts.firstAttempt < ATTEMPT_WINDOW) {
        if (attempts.count >= MAX_CODE_ATTEMPTS) {
          return res.status(429).json({ error: '验证码尝试次数过多，请稍后再试' });
        }
        attempts.count++;
      } else {
        verificationAttempts.set(email, { count: 1, firstAttempt: Date.now() });
      }
      if (stored.code !== code) return res.status(400).json({ error: '验证码错误' });
      // 验证成功，清除尝试计数
      verificationAttempts.delete(email);
      verificationCodes.delete(email);
      const localPart = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const numericId = nextNumericId(); const userId = String(numericId);
      const displayName = username || stored.username || localPart;
      const user: User = db.createUser(userId, displayName);
      const agent = manager.register(userId, displayName + '的AI', displayName + ' 的 AI 助手', 'semi');
      if (defaultModel) {
        try { await manager.update(agent.id, { model: defaultModel, modelSource: 'local' }); } catch(_e) {}
      }
      res.json({ ok: true, user, agent });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── 旧版用户名注册（兼容） ──
  // P0-3 修复: 添加 requireAuth，防止无鉴权无限创建用户
  app.post('/api/users/register', requireAuth, (req, res) => {
    const { displayName, username } = req.body;
    const name = username || displayName;
    if (!name) return res.status(400).json({ error: '用户名不能为空' });
    const numericId = nextNumericId(); const id = String(numericId);
    const user: User = db.createUser(id, name);
    res.json({ ok: true, user });
  });
}