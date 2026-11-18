/**
 * 局域网直连传输层 (LAN Transport)
 *
 * 邻居之间通过 HTTP 直接互调（点对点，不经过中心平台）。
 * 复用 federation 的"直连 + 头部鉴权"模式，但面向局域网陌生人社交：
 *   - 默认使用一个众所周知的协议标识头 X-LingXi-LAN-Proto，用于识别合法灵犀流量；
 *   - 可选 LAN_SECRET 环境变量做额外密钥校验（同一局域网内想私有化的用户可设置）。
 *
 * 真正的信任关系由上层好友/群组握手建立，传输层只负责把请求可靠地送达邻居。
 */

import type { LanPeer } from './lan-discovery.js';
import { getLanInstanceId } from './lan-discovery.js';
import { createHmac } from 'crypto';

/** 协议标识头 */
const PROTO_HEADER = 'x-lingxi-lan-proto';
const PROTO_VERSION = '1';
const FROM_HEADER = 'x-lingxi-from';
const SECRET_HEADER = 'x-lingxi-secret';
const NONCE_HEADER = 'x-lingxi-nonce';

/** 可选的局域网共享密钥（默认空 = 仅靠协议头识别） */
function getLanSecret(): string {
  return process.env.LAN_SECRET || '';
}

/**
 * 修复（2026-11-18）：停用「自动生成的 per-instance LAN_SECRET」。
 * 背景：P1-B 曾为每台引擎自动生成随机 LAN_SECRET 写入 .env 用作局域网 HMAC 鉴权。
 * 但 per-instance 随机密钥彼此不同，跨引擎签名必然不匹配 → 对端 403「局域网签名校验失败」→「加好友加不上」。
 * HMAC 共享密钥只有在用户于所有引擎手动设置同一个 LAN_SECRET 时才有意义。
 * 本函数把 .env 中「带 P1-B 自动生成标记」的 LAN_SECRET 改名为 LAN_LOCAL_SECRET（保留值、退出鉴权）；
 * 用户手动设置（无标记）的 LAN_SECRET 原样保留。幂等：已迁移文本再跑一次不变。
 */
export function neutralizeAutoLanSecret(envText: string): { text: string; migrated: boolean } {
  const eol = envText.includes('\r\n') ? '\r\n' : '\n';
  const lines = envText.split(/\r?\n/);
  let migrated = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^LAN_SECRET\s*=\s*(.*)$/);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j--;
    const isAuto = j >= 0 && /Auto-generated on first boot \(P1-B/.test(lines[j]);
    if (!isAuto) continue; // 用户手动设置的共享密钥，保留
    lines[j] = '# [migrated 2026-11-18] 原 P1-B 自动生成的 per-instance 密钥已停用（跨引擎 HMAC 必失败）。';
    lines[i] = '# 如需私有局域网鉴权：在所有引擎手动设置相同的 LAN_SECRET=<共享密钥>。' + eol + 'LAN_LOCAL_SECRET=' + m[1];
    migrated = true;
  }
  return { text: migrated ? lines.join(eol) : envText, migrated };
}

/** P2-B: nonce 防重放缓存（nonce -> 首次使用时间戳），TTL 与时间戳容忍一致 */
const seenNonces = new Map<string, number>();
const NONCE_TTL = 300_000;
// P0-5 fix: 定期清理过期 nonce 防止内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of seenNonces) {
    if (now - ts > NONCE_TTL) seenNonces.delete(k);
  }
}, 60_000);

export interface LanSendOptions {
  timeoutMs?: number;
  /** 网络/超时类故障的额外重试次数（默认 2，即最多 3 次尝试）。逻辑错误（非 2xx）不重试。 */
  retries?: number;
}

/** 指数退避休眠 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 向指定邻居发起 HTTP POST。
 * @param peer   目标邻居（来自发现层）
 * @param path   目标路径，如 '/api/lan/peer/friend-request'
 * @param body   JSON 请求体
 * @returns 对端返回的 JSON
 *
 * 对网络/超时类故障（fetch 抛错）做指数退避重试；对端返回的非 2xx 逻辑错误不重试，直接抛错。
 */
export async function sendToPeer<T = any>(
  peer: LanPeer,
  path: string,
  body: any,
  opts: LanSendOptions = {}
): Promise<T> {
  const url = `http://${peer.lanIp}:${peer.port}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [PROTO_HEADER]: PROTO_VERSION,
    [FROM_HEADER]: getLanInstanceId(),
  };
  const retries = opts.retries ?? 2;
  let lastNetErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const secret = getLanSecret();
    if (secret) {
      // P1-4: HMAC signature instead of plaintext secret (P2-B: 每次尝试重新生成 nonce 防重放)
      const { createHmac, randomBytes } = await import('crypto');
      const timestamp = Date.now().toString();
      const nonce = randomBytes(16).toString('hex');
      const payload = JSON.stringify(body);
      const sig = createHmac('sha256', secret).update(timestamp + ':' + nonce + ':' + path + ':' + payload).digest('hex');
      headers[SECRET_HEADER] = sig;
      headers['x-lingxi-ts'] = timestamp;
      headers[NONCE_HEADER] = nonce;
    }
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
      });
    } catch (netErr) {
      // 网络/超时类故障：可重试
      lastNetErr = netErr;
      if (attempt < retries) {
        await sleep(Math.min(500 * Math.pow(2, attempt), 4000));
        continue;
      }
      throw new Error(`邻居 ${peer.lanIp} 不可达（已重试 ${retries} 次）: ${(netErr as any)?.message || netErr}`);
    }
    const text = await resp.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`邻居 ${peer.lanIp} 返回非 JSON (HTTP ${resp.status})`);
    }
    if (!resp.ok) {
      // 逻辑错误：不重试，直接抛
      throw new Error(data?.error || `邻居返回错误 HTTP ${resp.status}`);
    }
    return data as T;
  }
  // 理论上不会到这里（网络错误已在最后一次尝试抛出）
  throw new Error(`邻居 ${peer.lanIp} 发送失败: ${lastNetErr?.message || lastNetErr}`);
}

/**
 * 向指定邻居发起 HTTP GET。
 */
export async function getFromPeer<T = any>(
  peer: LanPeer,
  path: string,
  opts: LanSendOptions = {}
): Promise<T> {
  const url = `http://${peer.lanIp}:${peer.port}${path}`;
  const headers: Record<string, string> = {
    [PROTO_HEADER]: PROTO_VERSION,
    [FROM_HEADER]: getLanInstanceId(),
  };
  const secret = getLanSecret();
  if (secret) {
    // P1-4: HMAC signature for GET requests (no body, use empty string) (P2-B: nonce 防重放)
    const { createHmac, randomBytes } = await import('crypto');
    const timestamp = Date.now().toString();
    const nonce = randomBytes(16).toString('hex');
    const sig = createHmac('sha256', secret).update(timestamp + ':' + nonce + ':' + path + ':').digest('hex');
    headers[SECRET_HEADER] = sig;
    headers['x-lingxi-ts'] = timestamp;
    headers[NONCE_HEADER] = nonce;
  }

  const resp = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
  });
  const text = await resp.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`邻居 ${peer.lanIp} 返回非 JSON (HTTP ${resp.status})`);
  }
  if (!resp.ok) {
    throw new Error(data?.error || `邻居返回错误 HTTP ${resp.status}`);
  }
  return data as T;
}

/**
 * 校验入站请求是否来自合法灵犀邻居。
 * 在 index.ts 的 /api/lan/peer/* 路由前调用。
 * @returns 通过则返回来源实例 ID，否则返回 null（并已写 403 响应）
 */
export function verifyLanRequest(req: any, res: any): string | null {
  const proto = req.headers[PROTO_HEADER];
  if (proto !== PROTO_VERSION) {
    res.status(403).json({ error: '非灵犀局域网协议请求' });
    return null;
  }
  const secret = getLanSecret();
  if (secret) {
    // P1-4: HMAC signature verification instead of plaintext comparison
    const provided = req.headers[SECRET_HEADER];
    const timestamp = req.headers['x-lingxi-ts'];
    const nonce = req.headers[NONCE_HEADER];
    if (!provided || !timestamp || !nonce) {
      res.status(403).json({ error: '缺少签名、时间戳或 nonce' });
      return null;
    }
    // Replay protection: reject timestamps older than 5 minutes
    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 300_000) {
      res.status(403).json({ error: '时间戳过期' });
      return null;
    }
    // P2-B: nonce 一次性校验（重放攻击拦截，未验签的请求不登记，避免污染缓存）
    if (seenNonces.has(nonce as string)) {
      res.status(403).json({ error: 'nonce 已使用（疑似重放攻击）' });
      return null;
    }
    // Reconstruct the signed payload from the request
    // v5-P1-D 修复: GET 请求无 body，发送方签空串，接收方必须同样签空串（JSON.stringify({}) 会得到 '{}' 导致签名不匹配）
    const body = req.method === 'GET' ? '' : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const reqPath = req.path || req.url || '';
    // ESM 修复(2026-09-14): createHmac 改用文件顶部 import
    const expectedSig = createHmac('sha256', secret).update(timestamp + ':' + nonce + ':' + reqPath + ':' + body).digest('hex');
    if (provided !== expectedSig) {
      res.status(403).json({ error: '局域网签名校验失败' });
      return null;
    }
    // 签名通过后登记 nonce
    seenNonces.set(nonce as string, Date.now());
  }
  return (req.headers[FROM_HEADER] as string) || 'unknown';
}
