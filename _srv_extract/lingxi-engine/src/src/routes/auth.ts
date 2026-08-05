/**
 * 认证路由 — V7 持久身份系统
 * 
 * 修复 Bug #1: loginWithEmail 是 async，路由层必须 await
 */
import { Router } from 'express';
import * as auth from '../auth/index.js';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { adminAuth } from '../middleware/admin-auth.js';
import { createInviteCode, listInviteCodes, nextNumericId } from '../storage/db.js';

// v2.0.6 workaround: ESM 加载顺序 bug，改为运行时动态导入确保 db.ts 先被完整解析
let _createInviteCode: any, _listInviteCodes: any, _nextNumericId: any;
(async () => {
  try {
    const mod = await import('../storage/db.js');
    _createInviteCode = mod.createInviteCode;
    _listInviteCodes = mod.listInviteCodes;
    _nextNumericId = mod.nextNumericId;
  } catch (e: any) {
    console.error('[Auth] 动态导入 db.js 失败:', e?.message);
  }
})();
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
            } catch (_e: any) { console.warn('[Auth] 注册时设置默认模型失败:', _e?.message); }
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

  // ── V7: 登录（邮箱 + 密码） ── Bug #1 修复: 加 await
  router.post('/login', async (req, res) => {
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
      if (sid) auth.logout(sid);
      res.json({ ok: true, message: '已注销' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 当前用户信息（需 JWT） ──
  router.get('/me', jwtAuth({ required: true }), (req, res) => {
    const user = (req as any).user;
    res.json({ ok: true, user: { ...user, id: user.sub } });
  });

  // ── V7: Admin 管理接口 ──
  router.use('/admin/*', adminAuth);
  router.post('/admin/invite-codes', (req, res) => {
    try {
      const { code, max_uses, expires_at } = req.body;
      if (!code) return res.status(400).json({ error: '缺少 code' });
      _createInviteCode(code, 'admin', max_uses || 1, expires_at ? Number(expires_at) : undefined);
      res.json({ ok: true, code });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
  router.get('/admin/invite-codes', (_req, res) => {
    res.json({ ok: true, codes: _listInviteCodes() });
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
    console.log('[Auth] 验证码:', email, code);
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
      const numericId = _nextNumericId();
      const userId = String(numericId);
      const displayName = username || stored.username || email.split('@')[0];
      ctx.db.createUser(userId, displayName, email);
      // Bug #1 修复: 补 numeric_id
      ctx.db.run('UPDATE users SET numeric_id = ? WHERE id = ?', [numericId, userId]);
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
    const numericId = _nextNumericId();
    const userId = String(numericId);
    const user = ctx.db.createUser(userId, name);
    // Bug #1 修复: 补 numeric_id
    ctx.db.run('UPDATE users SET numeric_id = ? WHERE id = ?', [numericId, userId]);
    res.json({ ok: true, user: { id: userId, numericId, displayName: name } });
  });

  return router;
}
