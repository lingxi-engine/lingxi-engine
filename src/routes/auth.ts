/**
 * 认证路由 — V7 持久身份系统
 * 
 * 修复 Bug #1: loginWithEmail 是 async，路由层必须 await
 * 修复 Bug #2: 登录支持用户名或邮箱（前端登录框只有一个输入框，用户可能输的是显示名）
 * 修复 Bug #3: /me 端点支持云平台账号（ouid-N）本地建档，返回完整用户信息
 */
import { Router } from 'express';
import * as auth from '../auth/index.js';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { adminAuth } from '../middleware/admin-auth.js';
import { createInviteCode, listInviteCodes, nextNumericId } from '../storage/db.js';
import type { ServerContext } from '../server/context.js';

// 旧版兼容验证码存储
interface VerificationCode {
  email: string;
  code: string;
  username?: string;
  expiresAt: number;
}
const verificationCodes = new Map<string, VerificationCode>();

export function createAuthRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { manager, defaultModel } = ctx;

  // ── V7: 注册（邮箱 + 密码 + 数字 ID） ──
  router.post('/register', (req, res) => {
    try {
      const { email, password, display_name, invite_code, agent_binding } = req.body;
      const result = auth.register({
        email,
        password,
        displayName: display_name,
        inviteCode: invite_code,
        agentBinding: agent_binding || 'skip',
      });
      if (agent_binding === 'auto_default' && result.user) {
        try {
          const agent = manager.register(
            result.user.id,
            display_name + '的灵犀引擎',
            display_name + ' 的 AI 助手',
            'semi'
          );
          if (defaultModel) {
            try {
              manager.update(agent.id, { model: defaultModel, modelSource: 'local' });
            } catch (_e) {}
          }
          res.json({ ok: true, user: result.user, agent, verificationToken: result.verificationToken });
        } catch (ae: any) {
          res.json({ ok: true, user: result.user, verificationToken: result.verificationToken, agentError: ae.message });
        }
      } else {
        res.json({ ok: true, user: result.user, verificationToken: result.verificationToken });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 邮箱验证 ──
  router.get('/verify-email', (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.status(400).json({ error: '缺少 token' });
      const result = auth.verifyEmail(token);
      res.json({ ok: true, message: '邮箱验证成功', userId: result.userId, email: result.email });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 登录（用户名或邮箱 + 密码） ── 修复: 支持用户名登录
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
      const result = await auth.loginWithUsernameOrEmail(email, password);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  });

  // ── V7: 登录（数字 ID + 密码） ──
  router.post('/login-by-id', (req, res) => {
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
  router.post('/forgot-password', (req, res) => {
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
  router.post('/reset-password', (req, res) => {
    try {
      const { token, new_password } = req.body;
      auth.resetPassword(token, new_password);
      res.json({ ok: true, message: '密码已重置，请重新登录' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 刷新 token ──
  router.post('/refresh', (req, res) => {
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
  router.post('/logout', jwtAuth({ required: true }), (req, res) => {
    try {
      const sid = (req as any).user?.sid;
      const uid = (req as any).user?.sub;
      if (sid) auth.logout(sid);
      // 登出时设置用户状态为 offline
      if (uid) {
        try { ctx.db.raw.run('UPDATE users SET status = ?, last_active_at = ? WHERE id = ?', ['offline', Date.now(), uid]); } catch {}
        try { ctx.broadcast({ type: 'user.offline', userId: uid }); } catch {}
      }
      res.json({ ok: true, message: '已注销' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 当前用户信息（需 JWT） ──
  // 修复: 云平台账号(ouid-N)本地建档，让个人中心/编辑资料/头像都能查到
  router.get('/me', jwtAuth({ required: true }), async (req, res) => {
    const payload = (req as any).user;
    const uid = payload?.sub;
    try {
      // [平台统一] 云平台账号(ouid-N)本地建档：让个人中心/编辑资料/头像都能查到
      if (uid && /^ouid-\d+$/.test(String(uid))) {
        const token = String(req.headers?.authorization || '').replace('Bearer ', '');
        const { ensurePlatformUser } = await import('./profile.js');
        await ensurePlatformUser(ctx.db, String(uid), token || undefined);
      }
      const user = uid ? ctx.db.getUser(String(uid)) : null;
      if (user) {
        return res.json({
          ok: true,
          user: {
            id: user.id,
            sub: user.id,
            numeric_id: user.numeric_id,
            numericId: user.numeric_id,
            email: user.email,
            display_name: user.display_name,
            displayName: user.display_name,
            username: user.display_name,
            avatar_url: user.avatar_url,
            avatarUrl: user.avatar_url,
            bio: user.bio,
            status: user.status,
            email_verified: user.email_verified,
            roles: payload?.roles || ['user'],
          },
        });
      }
    } catch (e: any) {
      console.warn('[Auth /me] 查库失败，降级返回 payload:', e.message);
    }
    // 本地无档案（如纯云平台 token 且平台不可达）→ 返回 payload 兜底
    res.json({ ok: true, user: { ...payload, id: payload?.sub } });
  });

  // ── V7: Admin 管理接口 ──
  router.use('/admin/*', adminAuth);
  router.post('/admin/invite-codes', (req, res) => {
    try {
      const { code, max_uses, expires_at } = req.body;
      if (!code) return res.status(400).json({ error: '缺少 code' });
      createInviteCode(code, 'admin', max_uses || 1, expires_at ? Number(expires_at) : undefined);
      res.json({ ok: true, code });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
  router.get('/admin/invite-codes', (_req, res) => {
    res.json({ ok: true, codes: listInviteCodes() });
  });

  // ── 旧版兼容：验证码发送（保留 demo 模式） ──
  router.post('/send-code', (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const username = req.body.username;
    verificationCodes.set(email, { email, code, username, expiresAt });
    console.log('[Auth] 验证码已生成:', email, '(code 已脱敏, 有效期5分钟)');
    res.json({ ok: true, message: '验证码已生成', expiresIn: 300 });
  });

  // ── 旧版兼容：验证码注册（已改为纯数字 ID） ──
  router.post('/register-with-email', (req, res) => {
    try {
      const { email, code, username } = req.body;
      if (!email || !code) return res.status(400).json({ error: '邮箱和验证码必填' });
      const stored = verificationCodes.get(email);
      if (!stored) return res.status(400).json({ error: '请先获取验证码' });
      if (Date.now() > stored.expiresAt) {
        verificationCodes.delete(email);
        return res.status(400).json({ error: '验证码已过期，请重新获取' });
      }
      if (stored.code !== code) return res.status(400).json({ error: '验证码错误' });
      verificationCodes.delete(email);
      const numericId = nextNumericId();
      const userId = String(numericId);
      const displayName = username || stored.username || email.split('@')[0];
      ctx.db.createUser(userId, displayName, email);
      // Bug #1 修复: 补 numeric_id
      (ctx.db as any).run('UPDATE users SET numeric_id = ? WHERE id = ?', [numericId, userId]);
      const agent = manager.register(userId, displayName + '的AI', displayName + ' 的 AI 助手', 'semi');
      if (defaultModel) {
        try { manager.update(agent.id, { model: defaultModel, modelSource: 'local' }); } catch (_e) {}
      }
      res.json({ ok: true, user: { id: userId, numericId, displayName }, agent });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── 旧版用户名注册（已改为纯数字 ID） ──
  router.post('/users/register', (req, res) => {
    const { displayName, username } = req.body;
    const name = username || displayName;
    if (!name) return res.status(400).json({ error: '用户名不能为空' });
    const numericId = nextNumericId();
    const userId = String(numericId);
    const user = ctx.db.createUser(userId, name);
    // Bug #1 修复: 补 numeric_id
    (ctx.db as any).run('UPDATE users SET numeric_id = ? WHERE id = ?', [numericId, userId]);
    res.json({ ok: true, user: { id: userId, numericId, displayName: name } });
  });

  return router;
}
