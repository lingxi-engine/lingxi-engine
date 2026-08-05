/**
 * 聊天路由 — 会话管理、参与者、消息
 */
import { Router } from 'express';
import { getDB, getChatParticipants, listUsers, addMessage, getUser } from '../storage/db.js';
import type { ServerContext } from '../server/context.js';
import { sendPeerMessage, getInstanceId } from '../core/instance-mesh.js';

export function createChatRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { db, router: msgRouter } = ctx;

  // ── 创建聊天 ──
  router.post('/chats', (req, res) => {
    try {
      const { id, type } = req.body;
      if (!id) return res.status(400).json({ error: 'id 必填' });
      const chat = db.createChat(id, type || 'private');
      res.json({ ok: true, chat });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) return res.json({ ok: true, exists: true });
      res.status(500).json({ error: err.message });
    }
  });

  // ── 聊天列表 ──
  router.get('/chats', (req, res) => {
    try {
      // v2.0.7 安全修复：用 req.user.sub 代替客户端传的 userId，防止越权
      const userId = (req as any).user?.sub || req.query.userId as string;
      if (userId) {
        const allChats = db.listChats();
        const userChats = allChats.filter((c: any) => {
          const participants = getChatParticipants(c.id);
          return participants.some((p: any) => p.user_id === userId);
        });
        res.json({ ok: true, chats: userChats });
      } else {
        res.json({ ok: true, chats: db.listChats() });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 删除整个会话 ──
  router.delete('/chats/:id', (req, res) => {
    try {
      const chatId = req.params.id;
      // v2.0.7 安全修复：校验请求者是该聊天的参与者
      const userId = (req as any).user?.sub;
      if (userId) {
        const participants = getChatParticipants(chatId);
        const isOwner = participants.some((p: any) => p.user_id === userId);
        if (!isOwner) return res.status(403).json({ error: '无权删除此会话' });
      }
      const d = getDB();
      d.run('DELETE FROM messages WHERE chat_id = ?', [chatId]);
      d.run('DELETE FROM participants WHERE chat_id = ?', [chatId]);
      d.run('DELETE FROM chats WHERE id = ?', [chatId]);
      d.run('DELETE FROM chat_memories WHERE chat_id = ?', [chatId]);
      d.run('DELETE FROM entities WHERE chat_id = ?', [chatId]);
      res.json({ ok: true, deleted: chatId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 添加参与者 ──
  router.post('/participants', (req, res) => {
    try {
      const { id, chatId, agentId, role } = req.body;
      // v2.0.7 安全修复：userId 用鉴权用户，校验调用者已是该聊天参与者
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: '未登录' });
      if (!id || !chatId) return res.status(400).json({ error: 'id 和 chatId 必填' });
      const parts = getChatParticipants(chatId);
      const isMember = parts.some((p: any) => p.user_id === userId);
      if (!isMember) return res.status(403).json({ error: '无权操作此聊天' });
      db.addParticipant(id, chatId, userId, agentId, role || 'member');
      res.json({ ok: true });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) return res.json({ ok: true, exists: true });
      res.status(500).json({ error: err.message });
    }
  });

  // ── 获取参与者 ──
  router.get('/chats/:id/participants', (req, res) => {
    try {
      const participants = getChatParticipants(req.params.id);
      res.json({ ok: true, participants });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 移除参与者 ──
  router.delete('/participants', (req, res) => {
    try {
      const { id, chatId } = req.body || {};
      if (!id || !chatId) return res.status(400).json({ error: 'id 和 chatId 必填' });
      // v2.0.7 安全修复：校验调用者是该聊天参与者
      const userId = (req as any).user?.sub;
      if (!userId) return res.status(401).json({ error: '未登录' });
      const parts = getChatParticipants(chatId);
      const isMember = parts.some((p: any) => p.user_id === userId);
      if (!isMember) return res.status(403).json({ error: '无权操作此聊天' });
      db.removeParticipant(chatId, id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 消息列表 ──
  router.get('/chats/:id/messages', (req, res) => {
    try {
      // v2.0.7 安全修复：校验请求者是该聊天的参与者
      const userId = (req as any).user?.sub;
      if (userId) {
        const participants = getChatParticipants(req.params.id);
        const isOwner = participants.some((p: any) => p.user_id === userId || p.agent_id === userId);
        if (!isOwner) return res.status(403).json({ error: '无权查看此会话消息' });
      }
      res.json({ ok: true, messages: db.listMessages(req.params.id) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 可用成员 ──
  router.get('/chats/:id/available-members', (req, res) => {
    try {
      const userId = (req as any).user?.sub || (req.query.userId as string);
      const chatId = req.params.id;
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const friends = db.listFriends(userId);
      const friendAgents = friends
        .map((f: any) => {
          const agent = db.getAgentByUserId(f.friendId);
          return agent ? { id: agent.id, displayName: agent.display_name || agent.displayName, type: 'agent' } : null;
        })
        .filter(Boolean);
      const myAgent = db.getAgentByUserId(userId);
      const myAI = myAgent ? [{ id: myAgent.id, displayName: myAgent.display_name || myAgent.displayName, type: 'my-ai' }] : [];
      const all = [
        ...friends.map((f: any) => ({ id: f.friendId, displayName: f.friendName, type: 'friend' })),
        ...friendAgents,
        ...myAI,
      ];
      const existing = getChatParticipants(chatId);
      const existingIds = new Set(existing.map((p: any) => p.user_id || p.agent_id));
      const available = all.filter((m: any) => !existingIds.has(m.id));
      res.json({ ok: true, members: available });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 记忆搜索 ──
  router.get('/memory/search', (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const topK = parseInt(req.query.topK as string) || 5;
      if (!q) return res.status(400).json({ error: 'q 参数必填' });
      const hits = msgRouter.searchMemory(q, topK);
      res.json({ ok: true, query: q, hits });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // ── 跨平台好友聊天发送 ──
  router.post('/chats/:id/send-friend', async (req, res) => {
    try {
      const chatId = req.params.id as string;
      const content = req.body?.content;
      const fromUserId = (req as any).user?.sub || req.body?.fromUserId;
      if (!chatId.startsWith('chat-platform-')) return res.status(400).json({ error: '不是跨平台好友聊天' });
      if (!content) return res.status(400).json({ error: 'content 必填' });

      // 找到好友的 participant
      const parts = getChatParticipants(chatId);
      const friendParticipant = parts.find((p: any) => String(p.user_id) !== String(fromUserId));
      if (!friendParticipant) return res.status(400).json({ error: '无法确定好友' });

      // 判断好友是否为本实例本地用户（非数字 ID 如 "user-xxx" 即为本地用户）
      const friendUserId = String(friendParticipant.user_id);
      const friendNumericId = Number(friendUserId);

      // 本地用户（同一实例内好友）：直接落库，无需走 Mesh
      if (!friendNumericId || isNaN(friendNumericId)) {
        const localFriend = getUser(friendUserId);
        if (!localFriend) return res.status(404).json({ error: '好友用户不存在（ID: ' + friendUserId + '）' });
        addMessage({
          id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          chatId,
          senderType: 'user',
          senderId: String(fromUserId),
          content,
          type: 'text',
          timestamp: Date.now(),
        });
        return res.json({ ok: true, local: true });
      }

      // 跨实例好友：走 Mesh 中继
      const meshPlatformUrl = process.env.MESH_PLATFORM_URL || '';
      const meshToken = process.env.MESH_TOKEN || '';
      if (!meshPlatformUrl || !meshToken) return res.status(500).json({ error: 'Mesh 未配置' });

      // 查询好友所在实例
      const r = await fetch(meshPlatformUrl.replace(/\/$/, '') + '/api/users/find?numericId=' + friendNumericId, {
        headers: { 'Authorization': 'Bearer ' + meshToken },
      });
      const d = await r.json() as any;
      if (!d.found) return res.status(404).json({ error: '好友不在线或未注册到 Mesh' });

      // 通过 Mesh WebSocket 发送
      const ok = sendPeerMessage({
        type: 'peer.message',
        fromInstance: getInstanceId(),
        toInstance: d.instanceId,
        chatId,
        content,
        fromUserId: String(fromUserId),
        toUserId: friendNumericId,
        timestamp: Date.now(),
      } as any);

      if (!ok) return res.status(500).json({ error: 'Mesh 未连接' });

      // 本地存储消息
      addMessage({
        id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        chatId,
        senderType: 'user',
        senderId: String(fromUserId),
        content,
        type: 'text',
        timestamp: Date.now(),
      });

      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
