/**
 * 灵犀引擎 V7 — 持久身份模块
 * 
 * 功能：邮箱+密码注册、数字ID登录、JWT签发、密码重置
 * 邮件发送暂用日志输出（mock），后续接 SMTP 适配器
 */

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import * as db from '../storage/db.js';

// ── 配置（从 .env 读取）──

function getJwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET 未设置，请在 .env 中配置');
  return s;
}

const JWT_EXPIRES_IN = '7d';
const VERIFY_TOKEN_EXPIRES = 24 * 60 * 60 * 1000;   // 24h
const RESET_TOKEN_EXPIRES = 60 * 60 * 1000;           // 1h
const BCRYPT_ROUNDS = 12;

// ── 类型 ──

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  inviteCode?: string;
  agentBinding?: 'auto_default' | 'auto_skip' | 'skip';
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    numericId: number;
    email: string;
    displayName: string;
    emailVerified: boolean;
  };
}

// ── JWT ──

export interface JwtPayload {
  sub: string;          // user-10003
  numeric_id: number;  // 10003
  sid: string;         // session id
  iat: number;
  exp: number;
  roles: string[];
}

export function signAccessToken(payload: { sub: string; numeric_id: number; sid: string; roles?: string[] }): string {
  return jwt.sign(
    {
      sub: payload.sub,
      numeric_id: payload.numeric_id,
      sid: payload.sid,
      roles: payload.roles || ['user'],
    },
    getJwtSecret(),
    { expiresIn: JWT_EXPIRES_IN }
  );
}

let _fallbackWarned = false;
export function verifyAccessToken(token: string): JwtPayload | null {
  // 1. 优先用主密钥验证
  try {
    return jwt.verify(token, getJwtSecret()) as JwtPayload;
  } catch { /* 主密钥不匹配，再尝试回退密钥 */ }

  // 2. 回退密钥（JWT_SECRET_FALLBACKS 逗号分隔，用于接受云平台签发的 token）。仅在显式配置时启用。
  const fallbacks = (process.env.JWT_SECRET_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (fallbacks.length === 0) return null;
  if (!_fallbackWarned) {
    _fallbackWarned = true;
    console.warn('[auth] 警告：已配置 ' + fallbacks.length + ' 个 JWT 回退密钥，回退密钥签发的 token 将被接受。请确保来源可信，生产环境建议尽快轮换并清空 JWT_SECRET_FALLBACKS。');
  }
  // 可选：要求回退 token 携带指定 issuer，防止主密钥格式的 token 被回退密钥误放行（默认不强制，保持兼容）
  const expectedIssuer = process.env.JWT_FALLBACK_ISSUER || '';
  for (const secret of fallbacks) {
    try {
      const payload = jwt.verify(token, secret) as JwtPayload & { iss?: string };
      if (expectedIssuer && payload.iss !== expectedIssuer) continue; // issuer 不符 → 拒绝
      return payload;
    } catch { /* 尝试下一个密钥 */ }
  }
  return null;
}

// ── 注册 ──

export function register(input: RegisterInput): { user: any; agent?: any; verificationToken: string } {
  const { email, password, displayName, inviteCode, agentBinding } = input;

  // 1. 校验
  if (!email || !email.includes('@')) throw new Error('请输入有效的邮箱地址');
  if (!password || password.length < 6) throw new Error('密码至少6位');
  if (!displayName || displayName.trim().length === 0) throw new Error('用户名不能为空');

  // 2. 邮箱唯一性
  const existing = db.getUserByEmail(email);
  if (existing) throw new Error('该邮箱已注册');

  // 3. 邀请码（如果 .env 配了 INVITE_CODE_REQUIRED=1）
  if (process.env.INVITE_CODE_REQUIRED === '1') {
    if (!inviteCode) throw new Error('需要邀请码');
    const check = db.validateInviteCode(inviteCode);
    if (!check.valid) throw new Error(check.reason || '邀请码无效');
  } else if (inviteCode) {
    // 可选但有填就验证
    const check = db.validateInviteCode(inviteCode);
    if (!check.valid) throw new Error(check.reason || '邀请码无效');
  }

  // 4. 分配 ID
  const numericId = db.nextNumericId();
  const userId = String(numericId);
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  // 5. 创建用户
  const user = db.createFullUser({
    id: userId,
    numericId,
    email,
    passwordHash,
    displayName: displayName.trim(),
    inviteCode: inviteCode || undefined,
  });

  // 6. 邮箱验证 token
  const verifyToken = crypto.randomBytes(32).toString('hex');
  db.createVerificationToken({
    id: `ver-${crypto.randomUUID()}`,
    userId,
    token: verifyToken,
    type: 'email_verify',
    expiresAtMs: Date.now() + VERIFY_TOKEN_EXPIRES,
  });

  // 7. Mock 发邮件（日志，token 脱敏防止经 /api/logs 泄露）
  console.log(`[AUTH] 验证邮件 → ${email}，链接: /api/auth/verify-email?token=***（已脱敏）`);

  // 8. 灵犀引擎自动绑定（C 选项）
  let agent: any = undefined;
  if (agentBinding === 'auto_default') {
    // AgentManager 在 index.ts 路由层做绑定，这里只标记
  }

  return { user, verificationToken: verifyToken, agent };
}

// ── 邮箱验证 ──

export function verifyEmail(token: string): { userId: string; email: string } {
  const record = db.getVerificationToken(token);
  if (!record) throw new Error('验证链接无效或已使用');
  if (record.type !== 'email_verify') throw new Error('token 类型错误');
  if (record.expires_at < Date.now()) throw new Error('验证链接已过期');

  db.verifyUserEmail(record.user_id);
  db.consumeVerificationToken(record.id);

  const user = db.getUser(record.user_id);
  if (!user) throw new Error('用户不存在');

  return { userId: record.user_id, email: user.email };
}

// ── 登录（邮箱 + 密码）──

export async function loginWithEmail(email: string, password: string): Promise<LoginResult> {
  const user = db.getUserByEmail(email);
  if (!user) throw new Error('邮箱或密码错误');
  if (!user.password_hash) throw new Error('该账号未设置密码，请使用验证码登录');
  // 开发模式跳过邮箱验证
  if (process.env.DEV_AUTO_VERIFY === 'true' && !user.email_verified) {
    try {
      const { getDB } = await import('../storage/db.js');
      getDB().run("UPDATE users SET email_verified = 1 WHERE id = ?", [user.id]);
      user.email_verified = 1;
      console.log('[Auth] DEV_AUTO_VERIFY: 自动验证邮箱', user.email, '(status 保持 online)');
    } catch (e) { console.warn('[Auth] 自动验证失败:', (e as Error).message); }
  }
  if (!bcrypt.compareSync(password, user.password_hash)) throw new Error('邮箱或密码错误');
  if (!user.email_verified && (process.env.NODE_ENV === 'production' || process.env.DEV_MODE === 'false')) throw new Error('邮箱未验证，请先验证邮箱');

  return _createSession(user);
}

// ── 登录（用户名或邮箱 + 密码）──
// 修复：前端登录框只有一个用户名输入框，用户可能输入邮箱或显示名（username）
// 之前只按邮箱查，导致"用户名正确但邮箱框被隐藏"时永远登录失败

export async function loginWithUsernameOrEmail(identifier: string, password: string): Promise<LoginResult> {
  // 先尝试按邮箱查
  let user = db.getUserByEmail(identifier);
  // 邮箱查不到 → 按显示名/用户名查
  if (!user) {
    user = db.getUserByDisplayName(identifier);
  }
  if (!user) throw new Error('邮箱或密码错误');
  if (!user.password_hash) throw new Error('该账号未设置密码，请使用验证码登录');
  // DEV_AUTO_VERIFY 逻辑
  if (process.env.DEV_AUTO_VERIFY === 'true' && !user.email_verified) {
    try {
      const { getDB } = await import('../storage/db.js');
      getDB().run("UPDATE users SET email_verified = 1 WHERE id = ?", [user.id]);
      user.email_verified = 1;
    } catch (e) { console.warn('[Auth] 自动验证失败:', (e as Error).message); }
  }
  if (!bcrypt.compareSync(password, user.password_hash)) throw new Error('邮箱或密码错误');
  if (!user.email_verified && (process.env.NODE_ENV === 'production' || process.env.DEV_MODE === 'false')) throw new Error('邮箱未验证，请先验证邮箱');
  return _createSession(user);
}

// ── 登录（数字 ID + 密码）──

export function loginWithNumericId(numericId: number, password: string): LoginResult {
  const user = db.getUserByNumericId(numericId);
  if (!user) throw new Error('ID或密码错误');
  if (!user.password_hash) throw new Error('该账号未设置密码');
  if (!bcrypt.compareSync(password, user.password_hash)) throw new Error('ID或密码错误');
  // 修复：数字ID登录此前缺失 DEV_AUTO_VERIFY 自动验证，开发模式下可能误报“邮箱未验证”
  if (process.env.DEV_AUTO_VERIFY === 'true' && !user.email_verified) {
    try {
      db.getDB().run("UPDATE users SET email_verified = 1 WHERE id = ?", [user.id]);
      user.email_verified = 1;
    } catch (e) { console.warn('[Auth] 自动验证失败:', (e as Error).message); }
  }
  if (!user.email_verified && (process.env.NODE_ENV === 'production' || process.env.DEV_MODE === 'false')) throw new Error('邮箱未验证，请先验证邮箱');

  return _createSession(user);
}

// ── 忘记密码（总是 200，防枚举）──

export function forgotPassword(email: string): { sent: boolean } {
  const user = db.getUserByEmail(email);
  if (!user) {
    // 防枚举：返回 200 但不发 token，日志脱敏邮箱
    console.log(`[AUTH] forgot-password: ${email.slice(0, 3)}*** 未注册，静默忽略`);
    return { sent: false };
  }

  const resetToken = crypto.randomBytes(32).toString('hex');
  db.createVerificationToken({
    id: `ver-${crypto.randomUUID()}`,
    userId: user.id,
    token: resetToken,
    type: 'password_reset',
    expiresAtMs: Date.now() + RESET_TOKEN_EXPIRES,
  });

  // Mock 发邮件（token 脱敏防止经 /api/logs 泄露）
  console.log(`[AUTH] 密码重置邮件 → ${email}，链接: /api/auth/reset-password?token=***（已脱敏）`);

  return { sent: true };
}

// ── 重置密码 ──

export function resetPassword(token: string, newPassword: string): void {
  if (!newPassword || newPassword.length < 6) throw new Error('密码至少6位');

  const record = db.getVerificationToken(token);
  if (!record) throw new Error('重置链接无效或已使用');
  if (record.type !== 'password_reset') throw new Error('token 类型错误');
  if (record.expires_at < Date.now()) throw new Error('重置链接已过期');

  const newHash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
  db.updateUserPassword(record.user_id, newHash);
  // 改密时撤销该用户所有活跃会话，防止旧 refresh_token 继续使用
  db.revokeUserSessions(record.user_id);
  db.consumeVerificationToken(record.id);
}

// ── 刷新 token ──
// 修复 v2-P0-N2：用 refreshToken + bcrypt compare 找到 session
export function refreshAccessToken(refreshToken: string): { accessToken: string; refreshToken: string } {
  if (!refreshToken || typeof refreshToken !== 'string') {
    throw new Error('缺少 refresh_token');
  }
  const session = db.getActiveSessionByToken(refreshToken);
  if (!session) throw new Error('会话无效或已过期');

  const user = db.getUser(session.user_id);
  if (!user) throw new Error('用户不存在');

  // 滚动刷新：发一个新的 refresh token，撤销旧的（防止 token 泄漏后无限使用）
  const newRefreshToken = crypto.randomBytes(48).toString('base64url');
  const newRefreshHash = bcrypt.hashSync(newRefreshToken, 4); // 这个 sync 调用只发生在 30 天一次的 refresh，频率极低，可接受
  db.rotateUserSession(session.id, newRefreshHash);

  return {
    accessToken: signAccessToken({
      sub: user.id,
      numeric_id: user.numeric_id,
      sid: session.id,
    }),
    refreshToken: newRefreshToken,
  };
}

// ── 注销 ──

export function logout(sessionId: string): void {
  db.revokeSession(sessionId);
}

// ── 内部：创建会话 + 签 JWT ──

function _createSession(user: any): LoginResult {
  const sessionId = `session-${crypto.randomUUID()}`;
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const refreshTokenHash = bcrypt.hashSync(refreshToken, 4);
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 天

  db.createUserSession({
    id: sessionId,
    userId: user.id,
    refreshTokenHash,
    deviceInfo: '', // 前端传
    expiresAtMs: expiresAt,
  });

  db.updateUserStatus(user.id, 'online');

  const accessToken = signAccessToken({
    sub: user.id,
    numeric_id: user.numeric_id,
    sid: sessionId,
  });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      numericId: user.numeric_id,
      email: user.email,
      displayName: user.display_name,
      emailVerified: !!user.email_verified,
    },
  };
}
