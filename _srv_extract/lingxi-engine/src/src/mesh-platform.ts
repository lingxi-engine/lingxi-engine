/**
 * 灵犀引擎 - 平台信令服务器 (Mesh Platform)
 * 部署在阿里云，作实例间的消息中继
 * 
 * 功能:
 *   - 接收实例心跳注册
 *   - WebSocket 连接池维护在线实例
 *   - 转发 peer 消息
 *   - 提供实例列表 API
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'crypto';

const PORT = parseInt(process.env.PORT || '3001', 10);
const MESH_TOKEN = process.env.MESH_TOKEN || randomBytes(16).toString('hex');

// 实例存储
interface Instance {
  id: string;
  ws: WebSocket;
  hostname: string;
  lanIp: string;
  port: number;
  agents: string[];
  version: string;
  lastHeartbeat: number;
  online: boolean;
}

const instances = new Map<string, Instance>();
const userRegistry = new Map<string, { instanceId: string; numericId: number; displayName: string; email?: string; userId: string }>();

const app = express();
app.use(express.json());

// ── 实例心跳 ──
app.post('/api/instances/heartbeat', (req, res) => {
  const { instanceId, hostname, lanIp, port, agents, version } = req.body;
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== MESH_TOKEN) return res.status(403).json({ error: '鉴权失败' });

  const existing = instances.get(instanceId);
  if (existing) {
    existing.hostname = hostname;
    existing.lanIp = lanIp;
    existing.port = port;
    existing.agents = agents || [];
    existing.version = version;
    existing.lastHeartbeat = Date.now();
  }
  res.json({ ok: true, timestamp: Date.now() });
});

// ── 获取在线实例列表 ──
app.get('/api/instances/list', (req, res) => {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== MESH_TOKEN) return res.status(403).json({ error: '鉴权失败' });

  const list = Array.from(instances.values())
    .filter(i => i.online)
    .map(i => ({
      instanceId: i.id,
      hostname: i.hostname,
      lanIp: i.lanIp,
      port: i.port,
      agents: i.agents,
      version: i.version,
      lastHeartbeat: i.lastHeartbeat,
    }));
  res.json({ ok: true, instances: list });
});

// ── 用户搜索 ──
app.get('/api/users/search', (req, res) => {
  const q = (req.query.q as string || '').trim();
  if (!q) return res.json({ ok: true, results: [] });

  const matched = Array.from(userRegistry.values())
    .filter(u => String(u.numericId) === q || (u.displayName || '').includes(q));

  res.json({
    ok: true,
    results: matched.map(u => ({
      numericId: u.numericId,
      displayName: u.displayName,
      email: u.email || '',
      userId: u.userId,
      source: 'platform',
    })),
  });
});

// ── 注册本机用户到平台 ──
app.post('/api/users/register', (req, res) => {
  const auth = req.headers.authorization?.replace('Bearer ', '');
  if (auth !== MESH_TOKEN) return res.status(403).json({ error: '鉴权失败' });

  const { instanceId, numericId, displayName, email, userId } = req.body;
  if (!instanceId || !numericId) return res.status(400).json({ error: '缺少必填字段' });

  userRegistry.set(`${instanceId}:${numericId}`, { instanceId, numericId, displayName: displayName || '', email: email || '', userId: userId || '' });
  res.json({ ok: true });
});

// ── WebSocket mesh ──
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/mesh' });

wss.on('connection', (ws: WebSocket, req) => {
  let instanceId: string | null = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      
      // 握手认证
      if (msg.type === 'auth') {
        if (msg.token !== MESH_TOKEN) {
          ws.send(JSON.stringify({ type: 'error', message: '鉴权失败' }));
          ws.close(4001, 'auth failed');
          return;
        }
        instanceId = msg.instanceId as string;
        if (!instanceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'instanceId 缺失' }));
          ws.close(4001, 'missing instanceId');
          return;
        }
        
        // 初始化实例记录
        instances.set(instanceId, {
          id: instanceId,
          ws,
          hostname: msg.hostname || '',
          lanIp: msg.lanIp || '',
          port: msg.port || 0,
          agents: msg.agents || [],
          version: msg.version || '0.0.0',
          lastHeartbeat: Date.now(),
          online: true,
        });
        
        ws.send(JSON.stringify({ type: 'auth_ok', instanceId }));
        console.log(`[Mesh] 实例上线: ${instanceId}`);
        return;
      }

      if (!instanceId) {
        ws.send(JSON.stringify({ type: 'error', message: '未认证' }));
        return;
      }

      // 更新心跳时间
      const inst = instances.get(instanceId);
      if (inst) inst.lastHeartbeat = Date.now();

      // 转发 peer 消息
      if (msg.toInstance) {
        const target = instances.get(msg.toInstance);
        if (target?.online && target.ws.readyState === WebSocket.OPEN) {
          target.ws.send(JSON.stringify(msg));
        } else {
          ws.send(JSON.stringify({ type: 'error', message: `目标实例 ${msg.toInstance} 不在线`, ref: msg.taskId || msg.type }));
        }
      }
      // 广播消息
      else {
        for (const [id, inst] of instances) {
          if (id !== instanceId && inst.online && inst.ws.readyState === WebSocket.OPEN) {
            inst.ws.send(JSON.stringify(msg));
          }
        }
      }
    } catch (e: any) {
      console.error('[Mesh] 消息处理错误:', e.message);
    }
  });

  ws.on('close', () => {
    if (instanceId) {
      const inst = instances.get(instanceId);
      if (inst) inst.online = false;
      console.log(`[Mesh] 实例下线: ${instanceId}`);
    }
  });

  ws.on('error', (err) => {
    console.error(`[Mesh] WebSocket 错误 (${instanceId}):`, err.message);
  });
});

// 清理超时实例（5 分钟没心跳）
setInterval(() => {
  const now = Date.now();
  for (const [id, inst] of instances) {
    if (inst.online && now - inst.lastHeartbeat > 300000) {
      inst.online = false;
      console.log(`[Mesh] 实例超时: ${id}`);
      try { inst.ws.close(4002, 'timeout'); } catch {}
    }
    // 彻底清理超过 1 小时的离线实例
    if (!inst.online && now - inst.lastHeartbeat > 3600000) {
      instances.delete(id);
      // 清理用户注册
      for (const [key, val] of userRegistry) {
        if (val.instanceId === id) userRegistry.delete(key);
      }
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`[Mesh Platform] 已启动, 端口 ${PORT}`);
  console.log(`[Mesh Platform] MESH_TOKEN=${MESH_TOKEN.slice(0, 8)}*** (请配置到各灵犀引擎 .env)`);
});
