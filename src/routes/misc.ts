/**
 * 杂项路由 — 联邦通信、Mesh、标签、时间、工作区模式、群聊模式
 */
import { Router } from 'express';
import { getDB, getChatMode, setChatMode, CHAT_MODES, listUsers, addMessage, addCredits, getUserCredits } from '../storage/db.js';
import { startInstanceMesh, setPeerMessageHandler, setPeerTaskHandler, sendPeerMessage, getMeshInfo, getInstanceId, setUsersProvider, type PeerMessage } from '../core/instance-mesh.js';
import { processUserMessage } from '../core/ws-handler.js';
import { readFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { join } from 'path';
import type { ServerContext } from '../server/context.js';

export function createMiscRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { db, manager, router: msgRouter, broadcast, dataDir } = ctx;
  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;

  // ── 群聊协作模式 ──
  router.get('/chats/:id/mode', (req, res) => {
    const mode = getChatMode(req.params.id);
    res.json({ ok: true, mode, modes: [...CHAT_MODES] });
  });

  router.post('/chats/:id/mode', (req, res) => {
    try {
      const { mode } = req.body || {};
      if (!setChatMode(req.params.id, mode)) return res.status(400).json({ error: '无效模式，可选: ' + CHAT_MODES.join(', ') });
      res.json({ ok: true, mode });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 工作区模式 ──
  router.get('/workspace-mode', requireAuth, (req, res) => {
    const mode = (globalThis as any).__workspaceMode || 'personal';
    const root = (globalThis as any).__workspaceRoot || process.cwd();
    res.json({ mode, collabMode: mode === 'collab', workspaceRoot: root });
  });

  router.post('/workspace-mode', requireAuth, (req, res) => {
    const { mode, workspaceRoot } = req.body || {};
    const newMode = mode === 'collab' ? 'collab' : 'personal';
    const newRoot = workspaceRoot || process.cwd();
    (globalThis as any).__workspaceMode = newMode;
    (globalThis as any).__workspaceRoot = newRoot;
    res.json({ mode: newMode, collabMode: newMode === 'collab', workspaceRoot: newRoot });
  });

  // ── 标签 ──
  router.get('/tags', (req, res) => {
    res.json({ ok: true, tags: ['技术', '产品', '设计', '运营', 'SRE', 'AI', '工具', '游戏', '音乐', '写作', '翻译', '法律', '教育', '金融', '医疗', '其他'] });
  });

  // ── 时间 ──
  router.get('/time', (req, res) => {
    const now = new Date();
    res.json({ iso: now.toISOString(), local: now.toLocaleString('zh-CN'), unix: now.getTime(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  // ── 联邦通信 ──
  const FEDERATION_SECRET = process.env.FEDERATION_SECRET || '';
  function federationAuth(req: any, res: any, next: any) {
    if (!FEDERATION_SECRET) return res.status(403).json({ error: '联邦通信未启用（请配置 FEDERATION_SECRET）' });
    const secret = String(req.headers['x-federation-secret'] || req.body?.secret || '');
    const a = Buffer.from(secret); const b = Buffer.from(FEDERATION_SECRET);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(403).json({ error: '联邦通信密钥错误' });
    next();
  }

  router.post('/federation/register', federationAuth, (req, res) => {
    try {
      const { instanceId, baseUrl, name } = req.body || {};
      if (!instanceId || !baseUrl) return res.status(400).json({ error: 'instanceId/baseUrl 必填' });
      if (!(globalThis as any).__federationPeers) (globalThis as any).__federationPeers = new Map();
      (globalThis as any).__federationPeers.set(instanceId, { id: instanceId, baseUrl, name: name || instanceId, lastSeen: Date.now() });
      console.log(`[Federation] 实例已注册: ${name} (${baseUrl})`);
      res.json({ ok: true, ourId: process.env.INSTANCE_ID || 'local', ourUrl: 'http://' + req.headers.host });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/federation/peers', (_req, res) => {
    const peers = (globalThis as any).__federationPeers;
    if (!peers) return res.json({ ok: true, peers: [] });
    res.json({ ok: true, peers: Array.from(peers.values()) });
  });

  router.post('/federation/message', federationAuth, async (req, res) => {
    try {
      const { chatId, content, senderId, senderName, fromInstance } = req.body || {};
      if (!chatId || !content) return res.status(400).json({ error: 'chatId/content 必填' });
      const result = await msgRouter.handleIncoming({ chatId, senderType: 'user', senderId: senderId || 'remote', content: `[${senderName || '远程'}] ${content}` });
      broadcast({ type: 'message.new', chatId, from: senderId || 'remote', senderType: 'user', content: `[${senderName || '远程'}] ${content}`, timestamp: Date.now() });
      for (const resp of result.responses) {
        const replyContent = await msgRouter.generateReply(chatId, resp.agentId, resp.triggerMessage.id);
        if (replyContent) broadcast({ type: 'message.new', chatId, from: 'agent:' + resp.agentId, senderType: 'agent', content: replyContent, timestamp: Date.now() });
      }
      res.json({ ok: true, replies: result.responses.length });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/federation/send', federationAuth, async (req, res) => {
    try {
      const { targetInstance, chatId, content, senderId, senderName } = req.body || {};
      const peers = (globalThis as any).__federationPeers;
      if (!peers || !peers.has(targetInstance)) return res.status(404).json({ error: '目标实例未注册' });
      const peer = peers.get(targetInstance);
      const resp = await fetch(peer.baseUrl + '/api/federation/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId, content, senderId, senderName, fromInstance: process.env.INSTANCE_ID || 'local' }), signal: AbortSignal.timeout(15000) });
      const data = await resp.json();
      res.json(data);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 钱包：模拟充值（测试模式，未接真实支付）──
  const CREDIT_RATES: Record<string, number> = { USD: 100, CNY: 14 };
  router.post('/credits/add', requireAuth, (req, res) => {
    try {
      const { userId, amount, currency } = req.body || {};
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const amt = Number(amount);
      if (!amt || amt <= 0 || amt > 100000) return res.status(400).json({ error: '金额无效' });
      const cur = String(currency || 'USD').toUpperCase();
      const rate = CREDIT_RATES[cur] || CREDIT_RATES.USD;
      const credits = Math.round(amt * rate);
      const balance = addCredits(userId, credits, '模拟充值 ' + cur + ' ' + amt + '（测试模式）');
      res.json({ ok: true, added: credits, balance, currency: cur, amount: amt, testMode: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}

/**
 * 设置 Mesh — 实例网格通信
 */
export function setupMesh(ctx: ServerContext, port: number) {
  const { db, manager, router: msgRouter, broadcast } = ctx;
  const meshPlatformUrl = process.env.MESH_PLATFORM_URL || process.env.PLATFORM_URL || '';
  const meshToken = process.env.MESH_TOKEN || process.env.PLATFORM_TOKEN || '';
  let pkgVersion = '0.0.0';
  try { pkgVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version || '0.0.0'; } catch {}

  setPeerMessageHandler((msg: PeerMessage) => {
    try {
      if (!msg.content) return;

      // 跨平台好友聊天消息
      const anyMsg = msg as any;
      if (msg.chatId && String(msg.chatId).startsWith('chat-platform-') && anyMsg.fromUserId !== undefined) {
        const chatId = msg.chatId;
        const fromUserId = String(anyMsg.fromUserId);
        const toUserId = String(anyMsg.toUserId || '');

        // 自动创建聊天和参与者
        const existing = db.listChats().find((c: any) => c.id === chatId);
        if (!existing) {
          db.createChat(chatId, 'private');
          db.addParticipant('p-' + chatId + '-from', chatId, fromUserId, undefined, 'member');
          db.addParticipant('p-' + chatId + '-to', chatId, toUserId, undefined, 'member');
          console.log('[Mesh] 自动创建跨平台聊天 ' + chatId);
        }

        // 存储消息
        addMessage({
          id: 'msg-mesh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          chatId,
          senderType: 'user',
          senderId: fromUserId,
          content: msg.content,
          type: 'text',
          replyTo: undefined,
          metadata: { fromInstance: msg.fromInstance },
          timestamp: Date.now(),
        });

        // 广播给前端
        broadcast({ type: 'message.new', chatId, from: fromUserId, senderId: fromUserId, senderType: 'user', content: msg.content, timestamp: Date.now() });
        console.log('[Mesh] 好友消息注入聊天 ' + chatId + ': ' + msg.content.slice(0, 40));
        return;
      }

      // 普通 peer 消息（AI 对话）
      const chatId = resolveMeshChat(msg.chatId, db, manager);
      const senderId = 'peer:' + (msg.fromInstance || 'unknown');
      console.log('[Mesh] peer 消息注入聊天 ' + chatId + ': ' + msg.content.slice(0, 40));
      processUserMessage(chatId, senderId, msg.content, undefined, msgRouter, broadcast);
    } catch (err: any) { console.error('[Mesh] 处理 peer 消息失败:', err.message); }
  });

  setPeerTaskHandler((msg: PeerMessage) => {
    (async () => {
      try {
        const agents = manager.list();
        const agent = agents.find((a: any) => a.id === msg.fromAgent) || agents[0];
        if (!agent) { sendPeerMessage({ type: 'peer.response', fromInstance: getInstanceId(), toInstance: msg.fromInstance, content: '本实例没有可用的 AI Agent', taskId: msg.taskId, timestamp: Date.now() }); return; }
        const chatId = resolveMeshChat(msg.chatId, db, manager);
        const goal = msg.goal || msg.content || '';
        console.log(`[Mesh] 执行 peer 任务 (agent=${agent.id}): ${goal.slice(0, 40)}`);
        const reply = await msgRouter.generateReply(chatId, agent.id, 'mesh-task-' + Date.now(), undefined, undefined, goal);
        sendPeerMessage({ type: 'peer.response', fromInstance: getInstanceId(), toInstance: msg.fromInstance, content: reply, taskId: msg.taskId, timestamp: Date.now() });
      } catch (err: any) { console.error('[Mesh] peer 任务执行失败:', err.message); sendPeerMessage({ type: 'peer.response', fromInstance: getInstanceId(), toInstance: msg.fromInstance, content: '任务执行失败: ' + err.message, taskId: msg.taskId, timestamp: Date.now() }); }
    })();
  });

  if (meshPlatformUrl && meshToken) {
    const agentIds = manager.list().map((a: any) => a.id);
    // 注入用户列表提供器（心跳时带上用户列表）
    setUsersProvider(() => {
      try {
        return (listUsers() as any[])
          .filter((u: any) => u.numeric_id)
          .map((u: any) => ({ numericId: u.numeric_id, displayName: u.display_name || u.username || '', email: u.email || '', userId: u.id }));
      } catch { return []; }
    });
    startInstanceMesh(meshPlatformUrl, meshToken, port, agentIds, pkgVersion);
    console.log(`[Mesh] 已启用，平台: ${meshPlatformUrl}`);

    // 注册本地用户到 Mesh 平台
    try {
      const allUsers = listUsers() as any[];
      let registered = 0;
      for (const u of allUsers) {
        if (!u.numeric_id) continue;
        const regUrl = meshPlatformUrl.replace(/\/$/, '') + '/api/users/register';
        fetch(regUrl, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + meshToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ instanceId: getInstanceId(), numericId: u.numeric_id, displayName: u.display_name, email: u.email || '', userId: u.id }),
        }).then(() => { registered++; }).catch(() => {});
      }
      const count = allUsers.filter((u: any) => u.numeric_id).length;
      console.log('[Mesh] 正在注册 ' + count + ' 个本地用户到平台');
    } catch (e: any) { console.warn('[Mesh] 用户注册失败:', e.message); }
  } else {
    console.log('[Mesh] 未配置 MESH_PLATFORM_URL/MESH_TOKEN，实例组网未启用');
  }
}

function resolveMeshChat(preferred: string | undefined, db: any, manager: any): string {
  if (preferred) {
    const existing = db.listChats().find((c: any) => c.id === preferred);
    if (existing) return preferred;
  }
  const chats = db.listChats();
  if (chats.length > 0) return chats[0].id;
  const chatId = 'mesh-' + Date.now().toString(36);
  db.createChat(chatId, 'group');
  const firstAgent = manager.list()[0];
  if (firstAgent) db.addParticipant('p-mesh-' + firstAgent.id, chatId, undefined, firstAgent.id, 'agent');
  return chatId;
}

/**
 * Mesh REST API 路由
 */
export function createMeshRoutes(ctx: ServerContext): Router {
  const router = Router();
  const meshPlatformUrl = process.env.MESH_PLATFORM_URL || process.env.PLATFORM_URL || '';
  const meshToken = process.env.MESH_TOKEN || process.env.PLATFORM_TOKEN || '';

  router.get('/mesh/status', (_req, res) => { res.json({ ok: true, ...getMeshInfo() }); });

  router.get('/mesh/peers', async (_req, res) => {
    try {
      if (!meshPlatformUrl || !meshToken) return res.json({ ok: true, instances: [], count: 0, disabled: true });
      const r = await fetch(meshPlatformUrl.replace(/\/$/, '') + '/api/instances/list', { headers: { Authorization: 'Bearer ' + meshToken } });
      const d = await r.json() as any;
      const me = getInstanceId();
      const instances = (d.instances || []).filter((i: any) => i.instanceId !== me);
      res.json({ ok: true, instances, count: instances.length });
    } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });

  router.post('/mesh/send', (req, res) => {
    const { toInstance, content, chatId } = req.body || {};
    if (!toInstance || !content) return res.status(400).json({ error: '需要 toInstance 和 content' });
    const ok = sendPeerMessage({ type: 'peer.message', fromInstance: getInstanceId(), toInstance, content, chatId, timestamp: Date.now() });
    res.json({ ok });
  });

  router.post('/mesh/task', (req, res) => {
    const { toInstance, goal, agentId } = req.body || {};
    if (!toInstance || !goal) return res.status(400).json({ error: '需要 toInstance 和 goal' });
    const taskId = 'task-' + Date.now().toString(36);
    const ok = sendPeerMessage({ type: 'peer.task', fromInstance: getInstanceId(), toInstance, goal, fromAgent: agentId, taskId, timestamp: Date.now() });
    res.json({ ok, taskId });
  });

  return router;
}