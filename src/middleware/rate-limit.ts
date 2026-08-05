/**
 * 简单内存限流中间件
 * 按 IP + 路径分组，窗口内限制最大请求数
 */
// 安全修复 P1#17：TRUST_PROXY 开关控制是否信任 X-Forwarded-For，默认不信任
const TRUST_PROXY = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1';

const buckets = new Map<string, { count: number; resetAt: number }>();

// 确定性清理：每 60 秒清除过期桶
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.resetAt > 60000) buckets.delete(key);
  }
}, 60000);

export function rateLimit(opts: { windowMs: number; max: number; message?: string } = { windowMs: 60000, max: 30 }) {
  const msg = opts.message || '请求过于频繁，请稍后再试';
  return (req: any, res: any, next: any) => {
    // v2: 支持 X-Forwarded-For（仅在 TRUST_PROXY=true 时信任，防止伪造绕过限流）
    const ip = (TRUST_PROXY ? req.headers['x-forwarded-for']?.split(',')[0]?.trim()  : null) || req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, bucket);
    }
    // 概率清理过期条目（10% 概率每次请求）
    if (Math.random() < 0.1) {
      for (const [k, v] of buckets) {
        if (v.resetAt < now) buckets.delete(k);
      }
    }
    bucket.count++;
    if (bucket.count > opts.max) {
      return res.status(429).json({ error: msg, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) });
    }
    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, opts.max - bucket.count)));
    next();
  };
}

/** Auth 端点严格限流：5 次/分钟 */
export const authRateLimit = rateLimit({ windowMs: 60000, max: 5, message: '认证请求过于频繁，请 1 分钟后再试' });

/** 通用 API 限流：30 次/分钟 */
export const apiRateLimit = rateLimit({ windowMs: 60000, max: 30 });
