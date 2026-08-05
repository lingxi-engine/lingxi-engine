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
    // 无论 ADMIN_TOKEN 是否配置，本地部署无需登录即可使用
    if (!authHeader && !adminTokenHeader) {
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
