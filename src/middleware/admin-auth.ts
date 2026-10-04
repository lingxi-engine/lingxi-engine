/**
 * V7 — Admin 权限守卫中间件
 *
 * 检查 X-Admin-Token header 与 .env ADMIN_TOKEN 是否一致
 * fail-secure：ADMIN_TOKEN 未设置时返回 503
 *
 * 修复 v2 报告：
 *  - 与 jwtAuth 同样的 ok/error 契约
 *  - fail-secure：ADMIN_TOKEN 未设置时 503（不允许降级）
 *  - 用恒定时间比较，避免 token timing 攻击
 */

import { timingSafeTokenEqual } from '../security/token-compare.js';

export function adminAuth(req: any, res: any, next: any) {
  const token = req.headers['x-admin-token'];
  const expected = process.env.ADMIN_TOKEN;

  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: { code: 'admin_token_missing', message: 'ADMIN_TOKEN 未设置，管理接口不可用' },
    });
  }
  if (typeof token !== 'string') {
    return res.status(403).json({
      ok: false,
      error: { code: 'forbidden', message: '无权限' },
    });
  }
  if (!timingSafeTokenEqual(token, expected)) {
    return res.status(403).json({
      ok: false,
      error: { code: 'forbidden', message: '无权限' },
    });
  }
  next();
}
