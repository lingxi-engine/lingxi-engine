/**
 * 局域网发现层 (LAN Discovery)
 *
 * 通过 UDP 广播在同一局域网内自动发现其他灵犀引擎实例。
 * 每个实例周期性广播一个"灯塔"包，携带本机用户/智能体信息；
 * 收到其他实例的灯塔后记入邻居表，超时未刷新则剔除。
 *
 * 设计要点：
 *   - 稳定实例身份：instanceId 持久化到 data/lan-identity.json，重启不变，
 *     这样好友/群组关系不会因重启而丢失。（区别于 instance-mesh 的临时 ID）
 *   - 社交层以 numericId（用户数字 ID）为稳定键，传输层以 instanceId 为路由键。
 *   - 与 db/manager 解耦：通过 config.getUsers() 注入本机用户列表。
 */

import dgram from 'dgram';
import { networkInterfaces } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// mDNS（Bonjour）可选增强：LAN_MDNS=1 开启后除 UDP 广播外再发布 _lingxi._tcp 服务，
// 跨子网/VLAN/访客网络场景下比纯广播更可靠。依赖 bonjour-service 包，缺失时自动降级到纯 UDP。
let mdnsService: any = null;
let mdnsAnnouncer: any = null;
async function startMdns(port: number, version: string): Promise<void> {
  if ((process.env.LAN_MDNS || '1') === '0') return;
  try {
    const mod: any = await import('bonjour-service');
    const Bonjour = mod.default || mod;
    const bonjour = new Bonjour();
    const ips = getLanIps();
    mdnsService = bonjour.publish({
      name: `lingxi-${selfInstanceId.slice(-6)}`,
      type: 'lingxi',
      port,
      txt: { instanceId: selfInstanceId, version, ips: ips.join(',') },
    });
    mdnsAnnouncer = bonjour;
    console.log(`[LAN] mDNS 已发布 _lingxi._tcp (port=${port}, ips=${ips.join(',') || '127.0.0.1'})`);
  } catch (e: any) {
    console.warn('[LAN] mDNS 不可用（缺少 bonjour-service 依赖），仅使用 UDP 广播:', e?.message || e);
  }
}
function stopMdns(): void {
  try { mdnsService?.stop?.(); } catch { /* ignore */ }
  try { mdnsAnnouncer?.destroy?.(); } catch { /* ignore */ }
  mdnsService = null;
  mdnsAnnouncer = null;
}


/** 灯塔广播端口（UDP）。可用环境变量 LAN_DISCOVERY_PORT 覆盖。 */
const DEFAULT_DISCOVERY_PORT = 3457;
/** 广播间隔（毫秒） */
const BEACON_INTERVAL_MS = 3000;
/** 邻居超时剔除时间（毫秒）：超过此时间未收到灯塔即视为离线 */
const PEER_STALE_MS = 10000;
/** 广播地址 */
const BROADCAST_ADDR = '255.255.255.255';

export interface LanUser {
  id: string;          // user-xxxx
  numericId: number;   // 数字 ID（社交层稳定键）
  displayName: string;
  agentId?: string;    // 该用户的灵犀引擎 agent id
}

export interface LanBeacon {
  type: 'lingxi-beacon';
  proto: number;            // 协议版本，便于将来升级
  instanceId: string;       // 稳定实例 ID
  lanIp: string;
  lanIps?: string[];        // FIX-ALL(2026-11-04): 多网卡全部地址
  port: number;             // 引擎 HTTP 端口（传输层用）
  version: string;          // 引擎版本
  users: LanUser[];         // 本机用户列表
  userCount: number;        // P1-5: user count summary
  ts: number;               // 发送时间戳
}

export interface LanPeer {
  instanceId: string;
  lanIp: string;
  port: number;
  version: string;
  users: LanUser[];
  lastSeen: number;
}

export interface LanDiscoveryConfig {
  /** 引擎 HTTP 端口（写入灯塔，供邻居回连） */
  port: number;
  /** 引擎版本号 */
  version: string;
  /** data 目录，用于持久化实例身份 */
  dataDir: string;
  /** 返回本机当前用户列表（含 numericId / agentId） */
  getUsers: () => LanUser[];
  /** 可选：自定义发现端口 */
  discoveryPort?: number;
  /** 鍙€夛細鍙戠幇鏂伴偦灞呮椂鍥炶皟锛堢敤浜?E2EE 鑷姩鍏挜浜ゆ崲锛?*/
  onPeerSeen?: (peer: LanPeer) => void;
}

let socket: dgram.Socket | null = null;
let beaconTimer: NodeJS.Timeout | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let selfInstanceId = '';
let config: LanDiscoveryConfig | null = null;

/** 邻居表：instanceId -> LanPeer */
const peers = new Map<string, LanPeer>();

/** 获取本机局域网 IPv4 地址（取第一个非内部回环） */
export function getLanIp(): string {
  return getLanIps()[0] || '127.0.0.1';
}

/** FIX-ALL(2026-11-04): 返回本机所有非内部 IPv4 地址（多网卡/多 VLAN 场景） */
export function getLanIps(): string[] {
  const out: string[] = [];
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal && !out.includes(addr.address)) {
        out.push(addr.address);
      }
    }
  }
  return out;
}

/** FIX-ALL(2026-11-04): 计算每个网卡的定向广播地址（a.b.c.255），
 *  仅 255.255.255.255 在跨子网/VLAN/访客网络时会被路由丢弃，定向广播能穿透同网段内的不同子网掩码。 */
export function directedBroadcastAddrs(): string[] {
  const out: string[] = [BROADCAST_ADDR];
  for (const ip of getLanIps()) {
    const parts = ip.split('.').map(Number);
    if (parts.length === 4 && parts.every((n) => n >= 0 && n <= 255)) {
      out.push(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
    }
  }
  return [...new Set(out)];
}

/** 读取或生成持久化的实例 ID */
function loadOrCreateInstanceId(dataDir: string): string {
  const file = join(dataDir, 'lan-identity.json');
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (data && typeof data.instanceId === 'string' && data.instanceId) {
        return data.instanceId;
      }
    }
  } catch (_e) { /* 忽略损坏文件，重新生成 */ }
  const instanceId = 'lingxi-lan-' + randomUUID().slice(0, 12);
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ instanceId, createdAt: Date.now() }, null, 2));
  } catch (e: any) {
    console.error('[LAN] 无法持久化实例身份:', e.message);
  }
  return instanceId;
}

function buildBeacon(): LanBeacon {
  return {
    type: 'lingxi-beacon',
    proto: 1,
    instanceId: selfInstanceId,
    lanIp: getLanIp(),
    lanIps: getLanIps(), // FIX-ALL(2026-11-04): 多网卡时携带全部地址
    port: config!.port,
    version: config!.version,
    // P0-1 fix: 恢复 users 字段但只含 numericId + displayName（不含 agentId 等敏感信息）
    users: config!.getUsers().map((u: any) => ({ id: u.id, numericId: u.numericId, displayName: u.displayName })),
    userCount: config!.getUsers().length,
    ts: Date.now(),
  };
}

function sendBeacon() {
  if (!socket) return;
  const beacon = buildBeacon();
  const buf = Buffer.from(JSON.stringify(beacon));
  const port = config!.discoveryPort || DEFAULT_DISCOVERY_PORT;
  // FIX-ALL(2026-11-04): 同时发 255.255.255.255 + 各网卡定向广播地址，
  // 跨子网/VLAN 时至少有一条能到达对方。
  for (const addr of directedBroadcastAddrs()) {
    socket.send(buf, 0, buf.length, port, addr, (err) => {
      if (err && addr === BROADCAST_ADDR) console.error('[LAN] 广播失败:', err.message);
    });
  }
}

function handlePacket(msg: Buffer, rinfo: dgram.RemoteInfo) {
  let beacon: LanBeacon;
  try {
    beacon = JSON.parse(msg.toString());
  } catch {
    return; // 非 JSON，忽略
  }
  if (beacon.type !== 'lingxi-beacon') return;
  if (beacon.proto !== 1) return; // 协议版本不匹配，忽略
  if (!beacon.instanceId || beacon.instanceId === selfInstanceId) return; // 忽略自己

  // FIX-ALL(2026-11-04): 多网卡时优先选与本机同网段的地址；否则回退来源地址
  const myIps = new Set(getLanIps());
  const sameSubnet = (Array.isArray((beacon as any).lanIps) ? (beacon as any).lanIps as string[] : [])
    .find((ip: string) => {
      const a = String(ip).split('.').slice(0, 3).join('.');
      return [...myIps].some((m) => m.split('.').slice(0, 3).join('.') === a);
    });
  peers.set(beacon.instanceId, {
    instanceId: beacon.instanceId,
    // 优先用灯塔里声明的 IP；若为 0.0.0.0/127.0.0.1 则回退到来源地址
    lanIp: sameSubnet || ((beacon.lanIp && beacon.lanIp !== '0.0.0.0' && !beacon.lanIp.startsWith('127.'))
      ? beacon.lanIp
      : rinfo.address),
    port: beacon.port,
    version: beacon.version,
    users: Array.isArray(beacon.users) ? beacon.users : [],
    lastSeen: Date.now(),
  });
  try { config?.onPeerSeen?.(peers.get(beacon.instanceId)!); } catch (_e) {}
}

function pruneStalePeers() {
  const now = Date.now();
  for (const [id, peer] of peers) {
    if (now - peer.lastSeen > PEER_STALE_MS) {
      peers.delete(id);
      console.log(`[LAN] 邻居离线: ${id} (${peer.lanIp})`);
    }
  }
}

/**
 * 启动局域网发现。
 * 绑定 UDP 端口（SO_REUSEADDR + SO_BROADCAST），开始广播与监听。
 */
export function startLanDiscovery(cfg: LanDiscoveryConfig): void {
  if (socket) {
    console.log('[LAN] 发现服务已在运行');
    return;
  }
  config = cfg;
  startMdns(cfg.port, cfg.version).catch(() => {});
  selfInstanceId = loadOrCreateInstanceId(cfg.dataDir);
  const port = cfg.discoveryPort || DEFAULT_DISCOVERY_PORT;

  socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  socket.on('error', (err) => {
    console.error('[LAN] UDP 错误:', err.message);
  });

  socket.on('message', (msg, rinfo) => {
    handlePacket(msg, rinfo);
  });

  socket.bind(port, () => {
    try {
      socket!.setBroadcast(true);
    } catch (e: any) {
      console.error('[LAN] 设置广播失败:', e.message);
    }
    console.log(`[LAN] 发现服务已启动 端口=${port} 实例=${selfInstanceId} 本机IP=${getLanIp()}`);
    // 立即广播一次，随后周期性广播
    sendBeacon();
    beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS);
    pruneTimer = setInterval(pruneStalePeers, PEER_STALE_MS / 2);
  });
}

/** 停止局域网发现 */
export function stopLanDiscovery(): void {
  stopMdns();
  if (beaconTimer) { clearInterval(beaconTimer); beaconTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  if (socket) {
    try { socket.close(); } catch (_e) {}
    socket = null;
  }
  peers.clear();
  console.log('[LAN] 发现服务已停止');
}

/** 获取当前在线邻居列表（已剔除超时项） */
export function getLanPeers(): LanPeer[] {
  pruneStalePeers();
  return Array.from(peers.values()).sort((a, b) => b.lastSeen - a.lastSeen);
}

/** 按 instanceId 查找邻居 */
export function getLanPeer(instanceId: string): LanPeer | undefined {
  const p = peers.get(instanceId);
  if (p && Date.now() - p.lastSeen <= PEER_STALE_MS) return p;
  return undefined;
}

/** 按用户数字 ID 在所有邻居中查找其所在实例 */
export function findPeerByNumericId(numericId: number): { peer: LanPeer; user: LanUser } | undefined {
  for (const peer of getLanPeers()) {
    const user = peer.users.find((u) => u.numericId === numericId);
    if (user) return { peer, user };
  }
  return undefined;
}

/** 本实例信息（给状态接口用） */
export function getLanSelfInfo() {
  return {
    enabled: !!socket,
    instanceId: selfInstanceId,
    lanIp: getLanIp(),
    port: config?.port,
    version: config?.version,
    discoveryPort: config?.discoveryPort || DEFAULT_DISCOVERY_PORT,
    peerCount: peers.size,
  };
}

/** 获取本实例稳定 ID */
export function getLanInstanceId(): string {
  return selfInstanceId;
}
