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

/** 协议标识头 */
const PROTO_HEADER = 'x-lingxi-lan-proto';
const PROTO_VERSION = '1';
const FROM_HEADER = 'x-lingxi-from';
const SECRET_HEADER = 'x-lingxi-secret';

/** 可选的局域网共享密钥（默认空 = 仅靠协议头识别） */
function getLanSecret(): string {
  return process.env.LAN_SECRET || '';
}

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
  const secret = getLanSecret();
  if (secret) {
    // P1-4: HMAC signature instead of plaintext secret
    const { createHmac } = await import('crypto');
    const timestamp = Date.now().toString();
    const payload = JSON.stringify(body);
    const sig = createHmac('sha256', secret).update(timestamp + ':' + path + ':' + payload).digest('hex');
    headers[SECRET_HEADER] = sig;
    headers['x-lingxi-ts'] = timestamp;
  }

  const retries = opts.retries ?? 2;
  let lastNetErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
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
  if (secret) headers[SECRET_HEADER] = secret;

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
    const provided = req.headers[SECRET_HEADER];
    if (provided !== secret) {
      res.status(403).json({ error: '局域网密钥错误' });
      return null;
    }
  }
  return (req.headers[FROM_HEADER] as string) || 'unknown';
}
