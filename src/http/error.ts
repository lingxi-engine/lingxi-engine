/**
 * 统一应用错误 + 统一响应壳
 *
 * 设计原则：
 *  - 所有路由用 throw new AppError(...) 代替手动 res.status(4xx)
 *  - handler 失败统一由 asyncHandler / res.fail 包揽格式
 *  - 不直接暴露内部错误 message（生产模式），脱敏后输出
 *  - 错误有 code，客户端可据此分支
 */

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = 'AppError';
  }

  static badRequest(code: string, message: string, details?: unknown): AppError {
    return new AppError(400, code, message, details);
  }
  static unauthorized(code = 'unauthorized', message = '未登录'): AppError {
    return new AppError(401, code, message);
  }
  static forbidden(code = 'forbidden', message = '无权限'): AppError {
    return new AppError(403, code, message);
  }
  static notFound(code = 'not_found', message = '不存在'): AppError {
    return new AppError(404, code, message);
  }
  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }
  static tooManyRequests(code = 'rate_limited', message = '请求过于频繁'): AppError {
    return new AppError(429, code, message);
  }
  static internal(message = '服务异常', details?: unknown): AppError {
    return new AppError(500, 'internal_error', message, details);
  }
}

export interface JsonErrorBody {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

/**
 * Express handler 包装 — async 异常自动捕获
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
export const asyncHandler =
  <T extends RequestHandler>(fn: T): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req as any, res as any, next as any)).catch(next);
  };

/**
 * 404 fallback
 */
export const notFoundHandler = (_req: any, res: any, _next: any) => {
  res.status(404).json({ ok: false, error: { code: 'not_found', message: '路由不存在' } });
};

/**
 * 全局错误 handler — 必须挂到 app 最后
 */
export const errorHandler =
  (opts: { logger?: (e: unknown, ctx?: unknown) => void } = {}) =>
  (err: unknown, req: any, res: any, _next: any) => {
    if (err instanceof AppError) {
      // AppError 直接 echo
      res.status(err.status).json({
        ok: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
      return;
    }
    const e: any = err;
    // v2.0.13: body-parser 畸形 JSON → 400（在通用 500 之前拦截）
    if (e && (e.type === 'entity.parse.failed' || (e instanceof SyntaxError && (e as any).status === 400))) {
      res.status(400).json({
        ok: false,
        error: { code: 'invalid_json', message: '请求体格式错误（JSON 无效）' },
      });
      return;
    }
    // SQLite UNIQUE 重复键 → 409
    if (typeof e?.message === 'string' && /UNIQUE constraint/i.test(e.message)) {
      res.status(409).json({
        ok: false,
        error: { code: 'duplicate', message: '资源已存在' },
      });
      return;
    }
    opts.logger?.(err, { path: req.path, method: req.method });
    // 生产模式不暴露堆栈/原始 message
    res.status(500).json({
      ok: false,
      error: { code: 'internal_error', message: '服务异常' },
    });
  };
