/**
 * V7 — JWT 鉴权中间件
 *
 * 从 Authorization: Bearer *** 取 JWT，验证后注入 req.user
 *
 * 安全策略（v2.0.6 修复 P0）：
 *  - DEV_MODE=true（默认本地开发）：无认证头时自动放行为 admin
 *  - DEV_MODE=false（生产/公网）：required=true 时拒绝未认证请求
 *  - ADMIN_TOKEN：始终可作为快速通道（Bearer 或 x-admin-token）
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

/** 是否为开发模式（允许免认证放行） */
function isDevMode(): boolean {
  // 未显式配置时默认视为开发模式（向后兼容本地单机部署）
  if (process.env.DEV_MODE === undefined) return true;
  return process.env.DEV_MODE !== 'false' && process.env.DEV_MODE !== '0';
}

export function jwtAuth(options: AuthOptions = {}) {
  return (req: Request, res: any, next: any) => {
    const authHeader = (req.headers['authorization']) as string | undefined;
    const adminTokenHeader = (req.headers['x-admin-token']) as string | undefined;
    const adminToken = process.env.ADMIN_TOKEN;
    const dev = isDevMode();

    // v1.9.9: ADMIN_TOKEN 快速通道——无需注册登录，适合个人/单机使用
    if (adminToken) {
      const providedToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : adminTokenHeader;
      if (providedToken === adminToken) {
        (req as any).user = { sub: 'admin', numeric_id: 0, sid: 'admin-token', iat: 0, exp: 0, roles: ['admin'] };
        return next();
      }
    }

    // 无任何认证头
    if (!authHeader && !adminTokenHeader) {
      // DEV 模式：自动放行为 admin（向后兼容个人本地部署）
      if (dev) {
        const platformAdmin = (globalThis as any).__platformAdminUser;
        if (platformAdmin) {
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
          (req as any).user = { sub: 'admin', numeric_id: 0, sid: 'admin-auto', iat: 0, exp: 0, roles: ['admin'] };
        }
        return next();
      }
      // 生产模式 + required：拒绝未认证请求
      if (options.required) {
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
