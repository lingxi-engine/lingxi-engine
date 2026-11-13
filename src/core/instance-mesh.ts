/**
 * 实例网格 (Instance Mesh) - 多灵犀实例互通
 *
 * 功能：
 *   - 生成唯一 instanceId
 *   - 向平台注册/发送心跳
 *   - 连接到平台 WebSocket mesh
 *   - 发送/接收 peer 消息
 *   - 与本地的 ws-handler 集成
 *   - WebRTC P2P 直连（src/net/p2p-link.ts）：信令走平台 relay，
 *     DataChannel 打通后 peer.message/peer.task/peer.response 直走 P2P，
 *     断开自动回退 relay。开关 MESH_P2P=0 关闭。
 */

import WebSocket from 'ws';
import { hostname, networkInterfaces } from 'os';
import { P2PManager, type P2PSignal } from '../net/p2p-link.js';

let wsSocket: WebSocket | null = null;
let instanceId: string = '';
let heartbeatTimer: NodeJS.Timeout | null = null;
let onPeerMessage: ((msg: PeerMessage) => void) | null = null;
let onPeerTask: ((msg: PeerMessage) => void) | null = null;
let onPeerKey: ((instanceId: string, publicKey: string) => void) | null = null;
let meshVersion: string = '0.0.0';
let meshPlatformUrl: string = '';
let meshToken: string = '';
let reconnectAttempt: number = 0;
const MAX_RECONNECT_DELAY = 60_000;

// ── P2P（WebRTC DataChannel）状态 ──
let p2p: P2PManager | null = null;
let p2pKeyProvider: (() => string) | null = null;
let p2pBootstrapped = false;

export interface PeerMessage {
  type: 'peer.message' | 'peer.task' | 'peer.response' | 'peer.broadcast' | 'peer.key' | 'peer.signal';
  fromInstance: string;
  toInstance?: string;
  chatId?: string;
  content?: string;
  fromAgent?: string;
  goal?: string;        // for task
  context?: string;     // for task
  replyTo?: string;     // for response
  taskId?: string;      // for task
  publicKey?: string;   // for peer.key (E2EE X25519 public key exchange)
  signal?: P2PSignal;   // for peer.signal (WebRTC offer/answer/candidate)
  timestamp: number;
}

function generateInstanceId(): string {
  // 格式: lingxi-{hostname前8字符}-{随机4位}
  const h = hostname().replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase();
  const r = Math.random().toString(36).slice(2, 6);
  return `lingxi-${h}-${r}`;
}

function getLanIp(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name];
    if (!iface) continue;
    for (const addr of iface) {
      // 跳过内部回环和 IPv6
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

async function sendHeartbeat(
  platformUrl: string,
  token: string,
  port: number,
  agents: string[],
  users?: { numericId: number; displayName: string; email?: string; userId: string }[]
): Promise<boolean> {
  try {
    const res = await fetch(`${platformUrl}/api/instances/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        instanceId,
        hostname: hostname(),
        lanIp: getLanIp(),
        port,
        agents,
        version: meshVersion,
        // P2-2 修复：心跳只发送用户数量摘要，不发送完整用户列表
        userCount: (users || []).length,
        users: [],  // 完整用户信息在建立连接后按需交换
      }),
    });
    const data = await res.json() as any;
    if (data.ok) {
      console.log(`[Mesh] 心跳 OK (${data.online} 在线实例)`);
      return true;
    }
    console.error('[Mesh] 心跳失败:', JSON.stringify(data));
    return false;
  } catch (err: any) {
    console.error('[Mesh] 心跳网络错误:', err.message);
    return false;
  }
}

// ── P2P 管理 ──────────────────────────────────────────────

/**
 * 初始化 WebRTC P2P 层（node-datachannel 缺失时整体降级为纯 relay）
 * 必须在 startInstanceMesh 之后调用；getPublicKey 用于 peer.key 广播（E2EE 公钥交换）
 */
export async function initP2P(opts: {
  getPublicKey?: () => string;
  getPrivateKey?: () => Buffer | null;
  enabled?: boolean;
  stunServers?: string[];
}): Promise<boolean> {
  p2pKeyProvider = opts.getPublicKey || null;
  const enabled = opts.enabled !== false;
  p2p = new P2PManager({
    selfId: instanceId || 'pending',
    sendSignal: (to, signal) => sendPeerMessage({ type: 'peer.signal', fromInstance: instanceId, toInstance: to, signal, timestamp: Date.now() }),
    onMessage: (from, payload) => {
      // DataChannel 收到的 peer 消息，与 relay 收到的走同一入口
      if (payload && payload.type === 'peer.task' && onPeerTask) onPeerTask(payload as PeerMessage);
      else if (onPeerMessage) onPeerMessage(payload as PeerMessage);
    },
    stunServers: opts.stunServers,
    enabled,
  });
  // selfId 在 startInstanceMesh 里生成，这里可能已存在；保险再设一次
  if (instanceId) (p2p as any).selfId = instanceId;
  
  // 注入签名提供器（用于 P2P 消息签名）
  if (opts.getPrivateKey) {
    p2p.getSignData = (payload: any) => {
      const privateKey = opts.getPrivateKey!();
      if (!privateKey) return null;
      const { signMeshMessage } = require('../core/mesh-security.js');
      const signature = signMeshMessage(payload, privateKey);
      return { signature, publicKey: p2pKeyProvider ? p2pKeyProvider() : '' };
    };
  }
  
  const ok = await p2p.init();
  if (ok && instanceId) console.log('[Mesh] P2P 层已就绪（WebRTC DataChannel 直连）');
  return ok;
}

/** 向所有在线实例广播自己的 E2EE 公钥，并对每个在线 peer 发起 DataChannel 连接 */
export function bootstrapP2P(): void {
  if (!p2p || !p2p.isReady() || p2pBootstrapped) return;
  p2pBootstrapped = true;
  // 1) 广播公钥（peer.key 走 relay 广播，index.ts 收到后会回复并落库）
  try {
    const pub = p2pKeyProvider ? p2pKeyProvider() : '';
    if (pub) {
      sendPeerMessage({ type: 'peer.key', fromInstance: instanceId, publicKey: pub, timestamp: Date.now() });
    }
  } catch { /* ignore */ }
  // 2) 拉取在线实例列表，逐个尝试打通 DataChannel（glare 规则在 P2PManager 内处理）
  if (!meshPlatformUrl || !meshToken) return;
  fetch(`${meshPlatformUrl.replace(/\/$/, '')}/api/instances/list`, {
    headers: { 'Authorization': `Bearer ${meshToken}` },
  })
    .then((r) => r.json() as any)
    .then((d) => {
      for (const inst of d.instances || []) {
        if (inst.instanceId && inst.instanceId !== instanceId) {
          p2p!.connectTo(inst.instanceId).catch(() => {});
        }
      }
    })
    .catch(() => { /* 平台暂时不可达，等下次心跳/手动触发 */ });
}

/** 主动向某个 peer 建立 DataChannel */
export function connectP2PTo(toInstance: string): Promise<boolean> {
  if (!p2p || !p2p.isReady()) return Promise.resolve(false);
  return p2p.connectTo(toInstance);
}

/** P2P 状态摘要（给 /api/mesh/status） */
export function getP2PStats(): { ready: boolean; peers: Record<string, { state: string; initiator: boolean; lastActivity: number }> } {
  return { ready: !!p2p?.isReady(), peers: p2p?.stats() || {} };
}

/**
 * 连接到平台的 WebSocket mesh
 */
function connectMesh(platformWsUrl: string, token: string, port: number, agents: string[]) {
  if (wsSocket && wsSocket.readyState === WebSocket.OPEN) {
    console.log('[Mesh] 已经连接，跳过');
    return;
  }

  console.log(`[Mesh] 连接到平台: ${platformWsUrl}`);
  wsSocket = new WebSocket(platformWsUrl);

  wsSocket.on('open', () => {
    console.log('[Mesh] WebSocket 连接成功');
    // 发送握手
    wsSocket!.send(JSON.stringify({
      type: 'mesh.handshake',
      instanceId,
      token,
    }));
  });

  wsSocket.on('message', (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'mesh.handshake_ack') {
      reconnectAttempt = 0;
      console.log('[Mesh] 握手完成 ✅');
      // 握手成功后立即发一次心跳
      const platformUrl = platformWsUrl.replace('/mesh', '').replace('ws://', 'http://').replace('wss://', 'https://');
      sendHeartbeat(platformUrl, token, port, agents);
      // P2P：握手完成后尝试广播公钥 + 向在线 peers 建 DataChannel
      if (p2p?.isReady()) bootstrapP2P();
    }
    else if (msg.type === 'peer.signal') {
      // WebRTC 信令（offer/answer/candidate）→ 交给 P2PManager
      if (p2p?.isReady() && msg.fromInstance && msg.signal) {
        p2p.handleSignal(String(msg.fromInstance), msg.signal as P2PSignal);
      }
    }
    else if (msg.type === 'peer.key') {
      // 对端广播公钥（E2EE X25519 public key exchange）
      if (msg.fromInstance && msg.publicKey) {
        console.log(`[Mesh] 收到 peer.key: ${msg.fromInstance}`);
        // 存储对端公钥，用于 P2P 消息签名验证
        if (onPeerKey) onPeerKey(msg.fromInstance, msg.publicKey);
      }
    }
    else if (msg.type === 'peer.message') {
      console.log(`[Mesh] 收到 peer 消息: ${msg.fromInstance} -> ${msg.toInstance}`, msg.content?.slice(0, 50));
      if (onPeerMessage) onPeerMessage(msg as PeerMessage);
    }
    else if (msg.type === 'peer.task') {
      console.log(`[Mesh] 收到 peer 任务: ${msg.fromInstance} -> ${msg.toInstance}`, msg.goal);
      if (onPeerTask) onPeerTask(msg as PeerMessage);
    }
    else if (msg.type === 'peer.response') {
      console.log(`[Mesh] 收到 peer 响应: ${msg.fromInstance} -> ${msg.toInstance}`);
      if (onPeerMessage) onPeerMessage(msg as PeerMessage);
    }
    else if (msg.type === 'peer.message.error' || msg.type === 'peer.task.error') {
      console.warn(`[Mesh] 发送失败（${msg.type}）: ${msg.error || '未知'} -> ${msg.toInstance}`);
    }
  });

  wsSocket.on('close', (code, reason) => {
    reconnectAttempt++;
    const delay = Math.min(5000 * Math.pow(2, reconnectAttempt - 1), MAX_RECONNECT_DELAY);
    console.log(`[Mesh] WebSocket 断开 (${code}), ${delay / 1000}秒后重连 (第${reconnectAttempt}次)...`);
    wsSocket = null;
    setTimeout(() => connectMesh(platformWsUrl, token, port, agents), delay);
  });

  wsSocket.on('error', (err) => {
    console.error('[Mesh] WebSocket 错误:', err.message);
  });
}

/**
 * 发送 peer 消息。
 * peer.message / peer.task / peer.response 且与对端已有 DataChannel 时优先直走 P2P，
 * 否则回退到平台 relay（业务无感知）。
 */
export function sendPeerMessage(msg: PeerMessage): boolean {
  // P2P 直连优先（仅点对点业务消息；peer.key/peer.signal 必须走 relay）
  if (
    p2p?.isReady() &&
    msg.toInstance &&
    (msg.type === 'peer.message' || msg.type === 'peer.task' || msg.type === 'peer.response') &&
    p2p.isConnected(msg.toInstance)
  ) {
    if (p2p.send(msg.toInstance, msg)) {
      console.log(`[Mesh] P2P 直发 ${msg.type}: ${instanceId} -> ${msg.toInstance}`);
      return true;
    }
    // send 失败（如超大消息）→ 落回 relay
  }
  if (!wsSocket || wsSocket.readyState !== WebSocket.OPEN) {
    console.error('[Mesh] 未连接，无法发送消息');
    return false;
  }
  wsSocket.send(JSON.stringify({
    ...msg,
    fromInstance: instanceId,
    timestamp: Date.now(),
  }));
  console.log(`[Mesh] relay 发送 ${msg.type}: ${msg.fromInstance} -> ${msg.toInstance || 'broadcast'}`);
  return true;
}

/**
 * 设置 peer 消息处理器（通常在 ws-handler.ts 调用）
 */
export function setPeerMessageHandler(handler: (msg: PeerMessage) => void) {
  onPeerMessage = handler;
}

export function setPeerTaskHandler(handler: (msg: PeerMessage) => void) {
  onPeerTask = handler;
}

export function setPeerKeyHandler(handler: (instanceId: string, publicKey: string) => void) {
  onPeerKey = handler;
}

/**
 * 获取本实例 ID
 */
export function getInstanceId(): string {
  return instanceId;
}

/**
 * 启动实例网格
 * @param platformUrl 平台 API URL (http://your-platform-server:3001) 
 * @param token 平台认证 token
 * @param port 本实例端口
 * @param agents 本实例的 AI agent ID 列表
 */
// 用户列表获取回调（由 misc.ts 注入）
let _getUsersForHeartbeat: (() => { numericId: number; displayName: string; email?: string; userId: string }[]) | null = null;

export function setUsersProvider(fn: () => { numericId: number; displayName: string; email?: string; userId: string }[]) {
  _getUsersForHeartbeat = fn;
}

export function startInstanceMesh(
  platformUrl: string,
  token: string,
  port: number,
  agents: string[],
  version?: string
) {
  instanceId = generateInstanceId();
  meshVersion = version || '0.0.0';
  meshPlatformUrl = platformUrl;
  meshToken = token;
  console.log(`[Mesh] 实例 ID: ${instanceId}`);
  console.log(`[Mesh] 局域网 IP: ${getLanIp()}`);
  console.log(`[Mesh] AI agents: ${agents.join(', ') || '无'}`);

  // 平台 WebSocket mesh URL: http://... -> ws://... 的 /mesh 路径
  const platformWsUrl = platformUrl
    .replace('https://', 'ws://')
    .replace('http://', 'ws://')
    .replace(/\/$/, '') + '/mesh';

  connectMesh(platformWsUrl, token, port, agents);

  // 每30秒发送心跳（带用户列表，解决 Mesh 重启后 userRegistry 清空问题）
  heartbeatTimer = setInterval(() => {
    const users = _getUsersForHeartbeat ? _getUsersForHeartbeat() : [];
    sendHeartbeat(platformUrl, token, port, agents, users);
  }, 30000);
}

/** mesh 是否已连上平台 */
export function isMeshConnected(): boolean {
  return !!wsSocket && wsSocket.readyState === WebSocket.OPEN;
}

/** mesh 状态摘要（给 /api/mesh/status 用） */
export function getMeshInfo() {
  return {
    enabled: !!instanceId,
    connected: isMeshConnected(),
    instanceId,
    platformUrl: meshPlatformUrl,
    lanIp: getLanIp(),
    hostname: hostname(),
    version: meshVersion,
    p2p: getP2PStats(),
  };
}

/**
 * 停止实例网格
 */
export function stopInstanceMesh() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try { p2p?.shutdown(); } catch { /* ignore */ }
  p2p = null;
  p2pBootstrapped = false;
  if (wsSocket) {
    wsSocket.close(1000, 'shutdown');
    wsSocket = null;
  }
  console.log('[Mesh] 已停止');
}

// ── 别名（兼容 index.ts 旧接线名）──
export const p2pConnect = connectP2PTo;
export const isP2PConnected = (peerId: string): boolean => !!p2p && p2p.isConnected(peerId);
