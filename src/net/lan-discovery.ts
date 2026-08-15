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
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
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
    port: config!.port,
    version: config!.version,
    // P1-5: 不再广播完整用户列表，仅发送数量摘要
    // 用户信息在建立好友/群组关系后按需交换
    users: [],
    userCount: config!.getUsers().length,
    ts: Date.now(),
  };
}

function sendBeacon() {
  if (!socket) return;
  const beacon = buildBeacon();
  const buf = Buffer.from(JSON.stringify(beacon));
  const port = config!.discoveryPort || DEFAULT_DISCOVERY_PORT;
  socket.send(buf, 0, buf.length, port, BROADCAST_ADDR, (err) => {
    if (err) console.error('[LAN] 广播失败:', err.message);
  });
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

  peers.set(beacon.instanceId, {
    instanceId: beacon.instanceId,
    // 优先用灯塔里声明的 IP；若为 0.0.0.0/127.0.0.1 则回退到来源地址
    lanIp: (beacon.lanIp && beacon.lanIp !== '0.0.0.0' && !beacon.lanIp.startsWith('127.'))
      ? beacon.lanIp
      : rinfo.address,
    port: beacon.port,
    version: beacon.version,
    users: Array.isArray(beacon.users) ? beacon.users : [],
    lastSeen: Date.now(),
  });
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
