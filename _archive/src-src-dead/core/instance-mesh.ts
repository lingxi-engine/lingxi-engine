/**
 * 实例网格 (Instance Mesh) - 多灵犀实例互通
 *
 * 功能：
 *   - 生成唯一 instanceId
 *   - 向平台注册/发送心跳
 *   - 连接到平台 WebSocket mesh
 *   - 发送/接收 peer 消息
 *   - 与本地的 ws-handler 集成
 */

import WebSocket from 'ws';
import { hostname, networkInterfaces } from 'os';

let wsSocket: WebSocket | null = null;
let instanceId: string = '';
let heartbeatTimer: NodeJS.Timeout | null = null;
let onPeerMessage: ((msg: PeerMessage) => void) | null = null;
let onPeerTask: ((msg: PeerMessage) => void) | null = null;
let meshVersion: string = '0.0.0';
let meshPlatformUrl: string = '';
let reconnectAttempt: number = 0;
const MAX_RECONNECT_DELAY = 60_000;

export interface PeerMessage {
  type: 'peer.message' | 'peer.task' | 'peer.response' | 'peer.broadcast';
  fromInstance: string;
  toInstance?: string;
  chatId?: string;
  content?: string;
  fromAgent?: string;
  goal?: string;        // for task
  context?: string;     // for task
  replyTo?: string;     // for response
  taskId?: string;      // for task
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
 * 发送 peer 消息
 */
export function sendPeerMessage(msg: PeerMessage): boolean {
  if (!wsSocket || wsSocket.readyState !== WebSocket.OPEN) {
    console.error('[Mesh] 未连接，无法发送消息');
    return false;
  }
  wsSocket.send(JSON.stringify({
    ...msg,
    fromInstance: instanceId,
    timestamp: Date.now(),
  }));
  console.log(`[Mesh] 发送 ${msg.type}: ${msg.fromInstance} -> ${msg.toInstance || 'broadcast'}`);
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

/**
 * 获取本实例 ID
 */
export function getInstanceId(): string {
  return instanceId;
}

/**
 * 启动实例网格
 * @param platformUrl 平台 API URL (http://47.93.157.83:3001) 
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
  if (wsSocket) {
    wsSocket.close(1000, 'shutdown');
    wsSocket = null;
  }
  console.log('[Mesh] 已停止');
}
