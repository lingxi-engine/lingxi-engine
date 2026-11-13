/**
 * Ed25519 签名验证工具
 * 用于 Mesh/LAN 消息的完整性和身份验证
 * 基于 Node.js crypto 模块 (Node 18+ 支持 Ed25519)
 *
 * 2026-11-14 修复（B4 根因/B7/B10）：
 * - sign/verify 原实现用 createSign('ed25519') 会抛 "Invalid digest"，
 *   且裸 DER Buffer 不被接受 → 改为一次性 crypto.sign(null, ...)/verify(null, ...)
 *   并用 createPrivateKey/createPublicKey 包装 DER 密钥。
 * - verifyMeshSignature 增加防重放：±5 分钟时间窗 + fromInstance 一致性 + 已用签名缓存。
 * - 限流桶记录真实 windowMs，清理按各自窗口判断；定时器 unref() 不阻塞进程退出。
 */

import {
  generateKeyPairSync as cryptoGenerateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPrivateKey,
  createPublicKey,
} from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/** 生成密钥对（同步版本，Node.js 18+ 支持 Ed25519） */
export function generateKeyPairSync(): { publicKey: Buffer; privateKey: Buffer } {
  const { publicKey, privateKey } = cryptoGenerateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

/** 签名消息（Ed25519 必须用 null 算法 + KeyObject，DER 私钥需显式包装） */
export function sign(message: Uint8Array | string, privateKey: Buffer): Uint8Array {
  const msg = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  const key = createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' });
  return cryptoSign(null, msg, key);
}

/** 验证签名（密钥/签名格式非法时返回 false，不抛异常） */
export function verify(message: Uint8Array | string, signature: Uint8Array, publicKey: Buffer): boolean {
  const msg = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  try {
    const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
    return cryptoVerify(null, msg, key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** 编码为 Base64URL */
export function toBase64URL(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url');
}

/** 从 Base64URL 解码 */
export function fromBase64URL(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/**
 * B4: 加载或创建联邦专用 Ed25519 签名密钥对（持久化到 dataDir）。
 * 注意：与 E2EE 身份密钥（X25519）严格分离，X25519 不能用于 Ed25519 签名。
 * 文件损坏时自动重新生成；写盘失败时降级为内存密钥（重启后对端需重新注册公钥）。
 */
export function loadOrCreateFederationKeyPair(dataDir: string): { publicKey: Buffer; privateKey: Buffer } {
  const file = join(dataDir, 'federation-ed25519.json');
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved && typeof saved.publicKey === 'string' && typeof saved.privateKey === 'string') {
        const publicKey = fromBase64URL(saved.publicKey);
        const privateKey = fromBase64URL(saved.privateKey);
        // 自检：确保加载的密钥可用，损坏则走重新生成
        const probe = Buffer.from('lingxi-federation-key-probe');
        if (verify(probe, sign(probe, privateKey), publicKey)) {
          return { publicKey, privateKey };
        }
      }
    }
  } catch { /* 文件损坏/不可读 → 重新生成 */ }
  const kp = generateKeyPairSync();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ publicKey: toBase64URL(kp.publicKey), privateKey: toBase64URL(kp.privateKey), createdAt: Date.now() }),
      { mode: 0o600 },
    );
  } catch (e: any) {
    console.warn('[Federation] 签名密钥对持久化失败（使用内存密钥，重启后需重新注册）:', e?.message || e);
  }
  return kp;
}

/** Mesh 消息签名载荷构建 */
export function buildMeshMessagePayload(msg: any): Buffer {
  // 规范化消息：只包含业务字段，按键排序确保确定性
  // B4: 补充 senderId/senderName（undefined 时 JSON.stringify 自动省略，旧消息签名字节不变，向后兼容）
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
    senderId: msg.senderId,
    senderName: msg.senderName,
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
  /** B10: 记录该桶的真实窗口，清理时按各自窗口判断，避免长窗口桶被提前删除 */
  windowMs: number;
}

const rateLimitBuckets = new Map<string, RateLimitBucket>();

/** 清理过期桶（B10: 按桶自身 windowMs 判断；unref 不阻塞进程退出） */
const bucketCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of Array.from(rateLimitBuckets.entries())) {
    if (now - bucket.windowStart > bucket.windowMs) {
      rateLimitBuckets.delete(key);
    }
  }
}, 30000);
bucketCleanupTimer.unref?.();

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
    bucket = { count: 0, windowStart: now, windowMs };
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

    res.setHeader('X-RateLimit-Limit', String(maxPerMinute));
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

    res.setHeader('X-RateLimit-Limit', String(maxPerMinute));
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

// ── B7: 防重放 ──────────────────────────────────────────────
/** 消息时间戳允许的最大偏移（±5 分钟） */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;
/** 已用签名缓存 TTL（2× 时间窗，确保窗口内的重放必被命中） */
const SIGNATURE_CACHE_TTL_MS = 2 * REPLAY_WINDOW_MS;
/** 已用签名缓存：`${instanceId}:${signature}` → 过期时间戳 */
const usedSignatures = new Map<string, number>();

const replayCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, expiresAt] of Array.from(usedSignatures.entries())) {
    if (expiresAt <= now) usedSignatures.delete(key);
  }
}, 60000);
replayCleanupTimer.unref?.();

/** Express 中间件：验证 Mesh 消息签名（含 B7 防重放） */
export function verifyMeshSignature(getPublicKey: (instanceId: string) => Buffer | null) {
  return (req: any, res: any, next: any) => {
    const msg = req.body;
    const signature = req.headers['x-signature'] as string;
    const instanceId = req.headers['x-instance-id'] as string;

    if (!msg || !signature || !instanceId) {
      return res.status(400).json({ error: '缺少签名或实例 ID' });
    }

    // B7: 时间戳时效检查（±5 分钟），缺失/非法/过期一律拒绝
    const ts = Number(msg.timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
      return res.status(403).json({ error: '消息时间戳缺失或过期（防重放）' });
    }

    // B7: 载荷内 fromInstance 必须与请求头声明的实例 ID 一致，防止冒名转发
    if (msg.fromInstance !== instanceId) {
      return res.status(403).json({ error: 'fromInstance 与实例 ID 不一致' });
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

    // B7: 验签通过后再查已用签名缓存，拒绝重放（先验签可避免垃圾请求污染缓存）
    const cacheKey = `${instanceId}:${signature}`;
    if (usedSignatures.has(cacheKey)) {
      return res.status(403).json({ error: '检测到重放消息（签名已使用）' });
    }
    usedSignatures.set(cacheKey, Date.now() + SIGNATURE_CACHE_TTL_MS);

    next();
  };
}
