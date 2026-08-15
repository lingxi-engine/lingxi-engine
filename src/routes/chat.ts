/**
 * 聊天路由 — 会话管理、参与者、消息
 */
import { Router } from 'express';
import { getDB, getChatParticipants } from '../storage/db.js';
import type { ServerContext } from '../server/context.js';

export function createChatRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { db, router: msgRouter, sessionManager } = ctx;

  // ── 创建聊天 ──
  router.post('/chats', (req, res) => {
    try {
      const { id, type } = req.body;
      if (!id) return res.status(400).json({ error: 'id 必填' });
      const chat = db.createChat(id, type || 'private');
      // 自动创建会话跟踪 (v2.0.7)
      if (sessionManager && req.body.userId) {
        sessionManager.ensureSessionForChat(id, req.body.userId, (chat as any).display_name || id);
      }
      res.json({ ok: true, chat });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) return res.json({ ok: true, exists: true });
      res.status(500).json({ error: err.message });
    }
  });

  // ── 聊天列表 ──
  router.get('/chats', (req, res) => {
    try {
      const userId = req.query.userId as string;
      if (userId) {
        // Bug Fix: 改为 SQL 级过滤，避免全表扫描
        const d = getDB();
        const stmt = d.prepare(`
          SELECT DISTINCT c.* FROM chats c
          INNER JOIN participants p ON p.chat_id = c.id
          WHERE p.user_id = ? OR p.agent_id = ?
          ORDER BY c.created_at DESC
        `);
        stmt.bind([userId, userId]);
        const userChats: any[] = [];
        while (stmt.step()) userChats.push(stmt.getAsObject());
        stmt.free();
        // 如果该用户没有参与任何会话，返回全部列表（个人单机使用兜底）
        if (!userChats.length) {
          res.json({ ok: true, chats: db.listChats() });
        } else {
          res.json({ ok: true, chats: userChats });
        }
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
      const { id, chatId, userId, agentId, role } = req.body;
      if (!id || !chatId) return res.status(400).json({ error: 'id 和 chatId 必填' });
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
      db.removeParticipant(chatId, id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 消息列表 ──
  router.get('/chats/:id/messages', (req, res) => {
    try {
      // 加载消息时自动跟踪活跃会话 (v2.0.7)
      if (sessionManager && req.query.userId) {
        sessionManager.ensureSessionForChat(req.params.id, String(req.query.userId));
        sessionManager.setActive('sess-' + req.params.id);
      }
      res.json({ ok: true, messages: db.listMessages(req.params.id) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 可用成员 ──
  router.get('/chats/:id/available-members', (req, res) => {
    try {
      const userId = req.query.userId as string;
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

  // ── 记忆搜索（P1-1: 强制 agentId/chatId 过滤，路由挂载处已有 requireAuth）──
  router.get('/memory/search', (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const topK = parseInt(req.query.topK as string) || 5;
      const agentId = (req.query.agentId as string) || '';
      const chatId = (req.query.chatId as string) || '';
      if (!q) return res.status(400).json({ error: 'q 参数必填' });
      if (!agentId && !chatId) return res.status(400).json({ error: 'agentId 或 chatId 至少提供一个' });
      const hits = msgRouter.searchMemory(q, topK, { agentId: agentId || undefined, chatId: chatId || undefined });
      res.json({ ok: true, query: q, hits });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}