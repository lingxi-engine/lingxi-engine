/**
 * V7 — JWT 鉴权中间件
 *
 * 从 Authorization: Bearer *** 取 JWT，验证后注入 req.user
 * 可选：无 token 时不拦截（用于兼容旧 demo 模式）
 *
 * 修复 v2 报告 P0：把 req.user 类型补上，给出明确 useAuth 取数辅助
 */

import type { Request } from 'express';
import { verifyAccessToken, JwtPayload } from '../auth/index.js';

export interface AuthOptions {
  required?: boolean; // true = 必须 token，false = 可选
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export interface AuthedRequest extends Request {
  user: JwtPayload;
}

/**
 * v2.0.7 安全加固：判断请求是否来自本地/内网（loopback 或 RFC1918 私有地址）。
 * admin-auto 无 token 放行仅限内网来源；公网来源必须携带有效凭证。
 */
let lastPublicWarn = 0; // 公网无凭证拒绝日志限频：每 60s 最多一条，防日志洪水
export function isTrustedLocalSource(req: Request): boolean {
  // 显式开启公网免登录（不推荐，仅向后兼容）
  if (process.env.ALLOW_PUBLIC_ADMIN_AUTO === '1' || process.env.ALLOW_PUBLIC_ADMIN_AUTO === 'true') return true;
  const raw = req.socket?.remoteAddress || '';
  const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  if (!ip) return false; // 无法确定来源时一律不可信（fail-closed）
  // v2.0.29 security hardening: TRUSTED_LOCAL_MODE = all (default) | loopback | none.
  // 'loopback' = only this machine skips login; LAN clients must present a token.
  // 'none'     = every caller must present a token (strictest, for shared hosts).
  const trustMode = (process.env.TRUSTED_LOCAL_MODE || 'all').trim().toLowerCase();
  if (trustMode === 'none') return false;
  const isLoopback = (addr: string): boolean =>
    addr === '::1' || addr === 'localhost' || addr.startsWith('127.');
  const isLocal = (addr: string): boolean =>
    addr === '::1' || addr === 'localhost' || addr.startsWith('127.') ||
    addr.startsWith('192.168.') || addr.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(addr);
  // v5-P0-C 修复: 反代场景（socket=本机/内网但带 XFF）时按真实客户端 IP 判断，防止公网攻击者经反代被“洗白”成本地免登录
  if (isLocal(ip)) {
    if (trustMode === 'loopback' && !isLoopback(ip)) return false;
    const xff = req.headers['x-forwarded-for'];
    const trustProxy = req.app?.get?.('trust proxy');
    if (xff && trustProxy) {
      const clientIp = String(xff).split(',')[0].trim().replace(/^::ffff:/, '');
      if (clientIp && !isLocal(clientIp)) return false; // 真实客户端来自公网 → 不视为可信本地来源
    }
    return true;
  }
  return false;
}

export function jwtAuth(options: AuthOptions = {}) {
  return (req: Request, res: any, next: any) => {
    const authHeader = (req.headers['authorization']) as string | undefined;
    const adminTokenHeader = (req.headers['x-admin-token']) as string | undefined;
    const adminToken = process.env.ADMIN_TOKEN;

    // v1.9.9: ADMIN_TOKEN 快速通道——无需注册登录，适合个人/单机使用
    if (adminToken) {
      // 显式携带 token（Bearer 或 x-admin-token）
      const providedToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : adminTokenHeader;
      if (providedToken === adminToken) {
        (req as any).user = { sub: 'admin', numeric_id: 0, sid: 'admin-token', iat: 0, exp: 0, roles: ['admin'] };
        return next();
      }
    }

    // v2.0.5: 个人本地引擎兜底——未携带任何认证头时自动放行
    // 本地部署无需登录即可使用；v2.0.7 收紧：仅限本地/内网来源，公网来源不放行
    if (!authHeader && !adminTokenHeader) {
      if (isTrustedLocalSource(req)) {
        const platformAdmin = (globalThis as any).__platformAdminUser;
        if (platformAdmin) {
          // 平台模式：使用平台 admin 用户信息
          (req as any).user = {
            sub: String(platformAdmin.id),
            numeric_id: platformAdmin.id,
            sid: 'platform-admin',
            iat: 0, exp: 0,
            roles: ['admin'],
            username: platformAdmin.username,
            email: platformAdmin.email || '',
            points: platformAdmin.points,
            status: platformAdmin.status || 'active',
          };
        } else {
          // 本地回退模式
          (req as any).user = { sub: 'admin', numeric_id: 0, sid: 'admin-auto', iat: 0, exp: 0, roles: ['admin'] };
        }
        return next();
      }
      // 公网来源且无任何凭证：按是否必需处理（不再静默以 admin 放行）
      if (options.required) {
        const now = Date.now();
        if (now - lastPublicWarn > 60000) {
          lastPublicWarn = now;
          console.warn(`[Auth] 公网来源无凭证请求已拒绝: ${req.method} ${req.path} 来源=${req.socket?.remoteAddress || '未知'}（内网免登录仅限本机/内网；如需公网免登录请设 ALLOW_PUBLIC_ADMIN_AUTO=1，不推荐）`);
        }
        return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: '未登录' } });
      }
      return next();
    }

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      if (options.required) return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: '未登录' } });
      return next();
    }

    const token = authHeader.slice(7);
    const payload = verifyAccessToken(token);
    if (!payload) {
      if (options.required) return res.status(401).json({ ok: false, error: { code: 'token_invalid', message: 'token 无效或已过期' } });
      return next();
    }

    (req as any).user = payload;
    next();
  };
}

/**
 * 在 handler 内断言 req.user 存在（由 jwtAuth({required:true}) 守门时才有）
 */
export function requireUser(req: Request): JwtPayload {
  if (!req.user) {
    const err: any = new Error('user_required');
    err.statusCode = 401;
    throw err;
  }
  return req.user;
}
