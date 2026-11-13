/**
 * Ed25519 签名验证工具
 * 用于 Mesh/LAN 消息的完整性和身份验证
 * 基于 Node.js crypto 模块 (Node 18+ 支持 Ed25519)
 */

import { generateKeyPairSync as cryptoGenerateKeyPairSync, createSign, createVerify } from 'crypto';

/** 生成密钥对（同步版本，Node.js 18+ 支持 Ed25519） */
export function generateKeyPairSync(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = cryptoGenerateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

/** 签名消息 */
export function sign(message: Uint8Array | string, privateKey: Buffer): Uint8Array {
  const msg = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  
  const sign = createSign('ed25519');
  sign.update(msg);
  return sign.sign(privateKey);
}

/** 验证签名 */
export function verify(message: Uint8Array | string, signature: Uint8Array, publicKey: Buffer): boolean {
  const msg = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  
  const verify = createVerify('ed25519');
  verify.update(msg);
  return verify.verify(publicKey, Buffer.from(signature));
}

/** 编码为 Base64URL */
export function toBase64URL(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

/** 从 Base64URL 解码 */
export function fromBase64URL(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/** Mesh 消息签名载荷构建 */
export function buildMeshMessagePayload(msg: any): Buffer {
  // 规范化消息：只包含业务字段，按键排序确保确定性
  const canonical = {
    type: msg.type,
    fromInstance: msg.fromInstance,
    toInstance: msg.toInstance,
    chatId: msg.chatId,
    content: msg.content,
    fromAgent: msg.fromAgent,
    goal: msg.goal,
    context: msg.context,
    replyTo: msg.replyTo,
    taskId: msg.taskId,
    publicKey: msg.publicKey,
    signal: msg.signal,
    timestamp: msg.timestamp,
  };
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

/** 对 Mesh 消息签名 */
export function signMeshMessage(msg: any, privateKey: Buffer): string {
  const payload = buildMeshMessagePayload(msg);
  const signature = sign(payload, privateKey);
  return toBase64URL(signature);
}

/** 验证 Mesh 消息签名 */
export function verifyMeshMessage(msg: any, signatureB64URL: string, publicKey: Buffer): boolean {
  const payload = buildMeshMessagePayload(msg);
  const signature = Buffer.from(signatureB64URL, 'base64url');
  return verify(payload, signature, publicKey);
}

/** 简易速率限制器（按 key 存储，支持滑动窗口） */
interface RateLimitBucket {
  count: number;
  windowStart: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

/** 清理过期桶 */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of Array.from(rateLimitBuckets.entries())) {
    if (now - bucket.windowStart > 60000) { // 1分钟窗口
      rateLimitBuckets.delete(key);
    }
  }
}, 30000);

/**
 * 检查速率限制
 * @param key 限流键 (如 "friend_request:user123" 或 "mesh_msg:instance1")
 * @param maxRequests 时间窗口内最大请求数
 * @param windowMs 时间窗口毫秒数
 * @returns { allowed: boolean, remaining: number, resetAt: number }
 */
export function checkRateLimit(key: string, maxRequests: number, windowMs: number = 60000): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(key);
  
  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { count: 0, windowStart: now };
    rateLimitBuckets.set(key, bucket);
  }
  
  bucket.count++;
  const remaining = Math.max(0, maxRequests - bucket.count);
  const resetAt = bucket.windowStart + windowMs;
  
  return {
    allowed: bucket.count <= maxRequests,
    remaining,
    resetAt,
  };
}

/** Express 中间件：好友请求限流 */
export function friendRequestRateLimit(maxPerMinute = 5) {
  return (req: any, res: any, next: any) => {
    const user = (req as any).user;
    const userId = user?.sub || user?.id || user?.numeric_id || req.ip;
    const key = `friend_request:${userId}`;
    
    const { allowed, remaining, resetAt } = checkRateLimit(key, maxPerMinute, 60000);
    
    res.setHeader('X-RateLimit-Limit', '5');
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    
    if (!allowed) {
      return res.status(429).json({ 
        error: '好友请求过于频繁，请稍后再试',
        retryAfter: Math.ceil((resetAt - Date.now()) / 1000)
      });
    }
    
    next();
  };
}

/** Express 中间件：Mesh 消息限流 */
export function meshMessageRateLimit(maxPerMinute = 30) {
  return (req: any, res: any, next: any) => {
    const instanceId = req.headers['x-instance-id'] || req.ip;
    const key = `mesh_msg:${instanceId}`;
    
    const { allowed, remaining, resetAt } = checkRateLimit(key, maxPerMinute, 60000);
    
    res.setHeader('X-RateLimit-Limit', '30');
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
    
    if (!allowed) {
      return res.status(429).json({ 
        error: 'Mesh 消息发送过于频繁',
        retryAfter: Math.ceil((resetAt - Date.now()) / 1000)
      });
    }
    
    next();
  };
}

/** Express 中间件：验证 Mesh 消息签名 */
export function verifyMeshSignature(getPublicKey: (instanceId: string) => Buffer | null) {
  return (req: any, res: any, next: any) => {
    const msg = req.body;
    const signature = req.headers['x-signature'] as string;
    const instanceId = req.headers['x-instance-id'] as string;
    
    if (!msg || !signature || !instanceId) {
      return res.status(400).json({ error: '缺少签名或实例 ID' });
    }
    
    const publicKey = getPublicKey(instanceId);
    if (!publicKey) {
      return res.status(403).json({ error: '未知实例或公钥不可用' });
    }
    
    // 移除签名字段后验证
    const { signature: _, ...msgWithoutSig } = msg;
    const valid = verifyMeshMessage(msgWithoutSig, signature, publicKey);
    
    if (!valid) {
      return res.status(403).json({ error: '签名验证失败' });
    }
    
    next();
  };
}