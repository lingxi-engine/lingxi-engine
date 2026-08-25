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
 *
 * v2.0.12 审批改造：审批 API（/approval*）放行给 jwtAuth 处理
 *  —— 审批弹窗要放到当前界面由操作者直接审批，普通登录用户也能通过/拒绝，
 *     不能再被 admin token 拦截；其余管理接口保持 adminAuth 保护不变。
 */

import { timingSafeEqual } from 'crypto';

export function adminAuth(req: any, res: any, next: any) {
  // 审批 API 放行：由 src/routes/admin.ts 内的 jwtAuth 处理（登录用户/本地放行）
  if (req.path.startsWith('/approval')) {
    return next();
  }

  const token = req.headers['x-admin-token'];
  const expected = process.env.ADMIN_TOKEN;

  if (!expected) {
    return res.status(503).json({
      ok: false,
      error: { code: 'admin_token_missing', message: 'ADMIN_TOKEN 未设置，管理接口不可用' },
    });
  }
  if (typeof token !== 'string' || token.length !== expected.length) {
    return res.status(403).json({
      ok: false,
      error: { code: 'forbidden', message: '无权限' },
    });
  }
  // 长度相等时做恒定时间比较
  try {
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (!timingSafeEqual(a, b)) {
      return res.status(403).json({
        ok: false,
        error: { code: 'forbidden', message: '无权限' },
      });
    }
  } catch {
    return res.status(403).json({
      ok: false,
      error: { code: 'forbidden', message: '无权限' },
    });
  }
  next();
}
