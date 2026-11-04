/**
 * 好友/聊天路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 2/N）
 *
 * 抽取范围: 原 index.ts 三段，共 16 条路由
 *   - L622-933 主块: /api/users, /api/users/by-id, /api/friends/* 5条,
 *     /api/chats POST, /api/participants POST+DELETE, /api/chats/:id/send-friend,
 *     /api/chats/:id/participants, /api/chats/:id DELETE（13 条）
 *   - L1051-1070 孤岛: /api/chats/:id/available-members
 *   - L4074-4088 孤岛: /api/chats/:id/mode GET+POST
 * 原则: 业务代码逐行保真，仅做依赖注入改造（db/requireAuth/broadcast 由宿主传入）
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查
 */
import type { Express, RequestHandler } from 'express';
import { getDB, deleteFriendshipByPair, getChatMode, setChatMode, CHAT_MODES, type DB } from '../storage/db.js';
import { sendPeerMessage, getInstanceId } from '../core/instance-mesh.js';
import { canUseAgent, grantDeniedMessage } from './agent-grants.js';

export interface FriendsChatsRouteDeps {
  db: DB;
  requireAuth: RequestHandler;
  broadcast: (event: any) => void;
}

export function registerFriendsChatsRoutes(app: Express, deps: FriendsChatsRouteDeps): void {
  const { db, requireAuth, broadcast } = deps;

  // ── 好友系统 ──
  app.get('/api/users', requireAuth, (req, res) => {
    try {
      const keyword = (req.query.q as string) || '';
      // P1-1: require query param to prevent user enumeration
      if (!keyword || keyword.trim().length < 2) {
        return res.status(400).json({ error: '请提供至少2个字符的搜索关键词' });
      }
      const users = db.searchUsers(keyword, 50);
      res.json({ ok: true, users: users.map((u: any) => ({ id: u.id, numericId: u.numeric_id, displayName: u.display_name })) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 按 numeric_id 精确查找用户 ──
  app.get('/api/users/by-id', requireAuth, (req, res) => {
    try {
      const numericId = parseInt(req.query.numericId as string);
      if (isNaN(numericId)) return res.status(400).json({ error: '无效的 numericId' });
      const raw = getDB();
      const s = raw.prepare('SELECT id, numeric_id, display_name, email, status FROM users WHERE numeric_id = ?');
      s.bind([numericId]);
      let user = null;
      if (s.step()) { user = s.getAsObject(); }
      s.free();
      if (!user) return res.status(404).json({ error: '用户不存在' });
      res.json({ ok: true, user: { id: user.id, numericId: user.numeric_id, displayName: user.display_name, email: user.email, status: user.status } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/friends/request', requireAuth, (req, res) => {
    try {
      const { fromUserId, toUserId, message } = req.body;
      if (!fromUserId || !toUserId) return res.status(400).json({ error: 'fromUserId 和 toUserId 必填' });
      if (fromUserId === toUserId) return res.status(400).json({ error: '不能添加自己为好友' });
      // P0-4: verify sender is JWT holder
      const jwtUser = (req as any).user;
      const jwtUserId = jwtUser?.sub || jwtUser?.id || '';
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      if (jwtUserId && jwtUserId !== fromUserId && jwtNumericId !== fromUserId) {
        return res.status(403).json({ error: '无权替他人发送好友请求' });
      }
      const result = db.sendFriendRequest(fromUserId, toUserId, message || '');
      if (result.error) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/friends/respond', requireAuth, (req, res) => {
    try {
      const { requestId, action } = req.body;
      if (!requestId || !action) return res.status(400).json({ error: 'requestId 和 action 必填' });
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action 只能是 accept 或 reject' });
      // P0-5: verify current user is the receiver (v5-P1-A: fail-closed)
      const jwtUser5 = (req as any).user;
      const jwtUserId5 = jwtUser5?.sub || jwtUser5?.id || '';
      const jwtNumericId5 = String(jwtUser5?.numeric_id || '');
      const sid5 = String(jwtUser5?.sid || '');
      const isBootstrap5 = sid5 === 'admin-auto' || sid5 === 'platform-admin' || sid5 === 'admin-token' || jwtUserId5 === 'admin';
      if (jwtUserId5 && !isBootstrap5) {
        try {
          const raw5 = getDB();
          const stmt5 = raw5.prepare('SELECT to_user_id FROM friendships WHERE id = ?');
          stmt5.bind([requestId]);
          let toId5 = '';
          if (stmt5.step()) { const r5 = stmt5.getAsObject() as any; toId5 = r5.to_user_id; }
          stmt5.free();
          if (!toId5) return res.status(403).json({ error: '好友请求不存在或无权处理' });
          if (toId5 !== jwtUserId5 && toId5 !== jwtNumericId5) {
            return res.status(403).json({ error: '无权处理他人的好友请求' });
          }
        } catch(_e5) {
          return res.status(403).json({ error: '无法验证好友请求归属' });
        }
      }
      const result = db.respondFriendRequest(requestId, action);
      if (result.error) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/friends/requests', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(401).json({ error: '未登录或身份无效' });
      // P1-2: verify userId is JWT holder
      const jwtUser2 = (req as any).user;
      const jwtUserId2 = jwtUser2?.sub || jwtUser2?.id || '';
      const jwtNumericId2 = String(jwtUser2?.numeric_id || '');
      const sid2 = String(jwtUser2?.sid || '');
      // v2.1.3: admin-auto/admin-token 本地免登录模式下 sub='admin' 是虚拟身份，跳过一致性检查
      const isLocalAuto2 = (sid2 === 'admin-auto' || sid2 === 'admin-token');
      if (jwtUserId2 && !isLocalAuto2 && jwtUserId2 !== userId && jwtNumericId2 !== userId) {
        return res.status(403).json({ error: '无权查看他人的好友请求' });
      }
      res.json({ ok: true, ...db.getFriendRequests(userId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/friends/list', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      // FIX-ALL(2026-11-04): 缺参统一 401，前端据此判断登录态而非误判成参数错误
      if (!userId) return res.status(401).json({ error: '未登录或身份无效' });
      // P1-2: verify userId is JWT holder
      const jwtUser3 = (req as any).user;
      const jwtUserId3 = jwtUser3?.sub || jwtUser3?.id || '';
      const jwtNumericId3 = String(jwtUser3?.numeric_id || '');
      const sid3 = String(jwtUser3?.sid || '');
      // v2.1.3: admin-auto/admin-token 本地免登录模式下 sub='admin' 是虚拟身份，跳过一致性检查
      const isLocalAuto3 = (sid3 === 'admin-auto' || sid3 === 'admin-token');
      if (jwtUserId3 && !isLocalAuto3 && jwtUserId3 !== userId && jwtNumericId3 !== userId) {
        return res.status(403).json({ error: '无权查看他人的好友列表' });
      }
      res.json({ ok: true, friends: db.listFriends(userId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 删除好友 ──
  app.delete('/api/friends/:id', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      const friendId = String(req.params.id || '');
      if (!userId || !friendId) return res.status(400).json({ error: 'userId 和 friendId 必填' });
      // P0-1 修复: 越权防护 — 校验 userId 是否为 JWT 持有者
      const jwtUser = (req as any).user;
      const jwtUserId = jwtUser?.sub || jwtUser?.id || '';
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      if (jwtUserId && jwtUserId !== userId && jwtNumericId !== userId) {
        return res.status(403).json({ error: '无权操作他人好友关系' });
      }
      // 使用 DB 封装函数，自动处理 chatId 排序一致性
      deleteFriendshipByPair(userId, friendId);
      res.json({ ok: true, message: '好友已删除' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 聊天 & 参与者 API ──
  app.post('/api/chats', requireAuth, (req, res) => {
    try {
      const { id, type, name } = req.body;
      if (!id) return res.status(400).json({ error: 'id 必填' });
      const chat = db.createChat(id, type || 'private', undefined, name);
      res.json({ ok: true, chat });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) return res.json({ ok: true, exists: true });
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/participants', requireAuth, (req, res) => {
    try {
      const { id, chatId, userId, agentId, role } = req.body;
      if (!id || !chatId) return res.status(400).json({ error: 'id 和 chatId 必填' });
      // P1-4 修复: 身份伪造防护 — userId 必须为 JWT 持有者
      // ⭐ v2.1.2 修复 F5 会话消失：admin-auto（本地免登录）模式下 sub='admin' 是虚拟身份，
      //    与前端的 clientId（u-xxx）永远不匹配 → participant 写入被 403 拒绝 → 会话列表空白。
      //    本地免登录（sid='admin-auto'）时跳过一致性检查，允许写入。
      const jwtUser = (req as any).user;
      const jwtSid = String(jwtUser?.sid || '');
      const jwtSub = String(jwtUser?.sub || '');
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      const isLocalAuto = (jwtSid === 'admin-auto' || jwtSid === 'admin-token');
      if (userId && !isLocalAuto) {
        const reqUid = String(userId);
        const isSelf = !jwtSub || reqUid === jwtSub || reqUid === jwtNumericId;
        if (!isSelf) {
          // v2.0.37: 好友私聊建聊需要「我把好友拉进同一聊天」。之前一律 403，
          // 导致登录态下点好友💬时第二步加人必失败，私聊根本建不起来。
          // 收紧后的规则：请求者必须已在该聊天里，且目标必须是请求者的好友。
          let allowed = false;
          try {
            const meIds = [jwtSub, jwtNumericId].filter(Boolean).map(String);
            const parts = (db as any).getChatParticipants(String(chatId)) as any[];
            const meInChat = (parts || []).some((p: any) => meIds.includes(String(p.user_id)));
            const myKey = jwtNumericId || jwtSub;
            const friends = myKey ? ((db as any).listFriends(myKey) as any[]) : [];
            const isFriend = (friends || []).some((f: any) => String(f.friendId || f.friend_id || f.id || '') === reqUid);
            allowed = meInChat && isFriend;
          } catch (_e) { allowed = false; }
          if (!allowed) return res.status(403).json({ error: '无权以他人身份加入群聊' });
        }
      }
      // 角色白名单: 只允许 member/owner
      const allowedRoles = ['member', 'owner'];
      const finalRole = allowedRoles.includes(role) ? role : 'member';
      // AI usage grant check (friend != permission to use their AI; default deny)
      if (agentId) {
        const actorId = String(userId || jwtUser?.sub || jwtUser?.id || jwtUser?.numeric_id || '');
        const chk = canUseAgent(String(agentId), actorId, { chatId: String(chatId) });
        if (!chk.allowed) {
          return res.status(403).json({
            error: grantDeniedMessage(chk.reason),
            code: 'AGENT_NOT_GRANTED',
            reason: chk.reason,
          });
        }
      }
      db.addParticipant(id, chatId, userId, agentId, finalRole);
      res.json({ ok: true });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) return res.json({ ok: true, exists: true });
      res.status(500).json({ error: err.message });
    }
  });



  // ── 跨平台好友聊天：通过 Mesh 发送消息给好友实例 ──
  app.post('/api/chats/:id/send-friend', requireAuth, async (req, res) => {
    try {
      const chatId = req.params.id as string;
      const content = req.body?.content;
      const fromUserId = req.body?.fromUserId || req.user?.numeric_id || (req.user as any)?.id;
      // P0-2 修复: 身份伪造防护 — 校验 fromUserId 是否为 JWT 持有者
      if (req.body?.fromUserId) {
        const jwtUser = (req as any).user;
        const jwtUserId = String(jwtUser?.sub || jwtUser?.id || '');
        const jwtNumericId = String(jwtUser?.numeric_id || '');
        const reqFromId = String(req.body.fromUserId);
        if (jwtUserId && jwtUserId !== reqFromId && jwtNumericId !== reqFromId) {
          return res.status(403).json({ error: '无权以他人身份发送消息' });
        }
      }
      // Fix 3: 去掉 chat-platform- 前缀限制，支持所有好友私聊
      if (!content) return res.status(400).json({ error: 'content 必填' });

      // P1-3: verify current user is chat participant
      const jwtUser4 = (req as any).user;
      const jwtUserId4 = String(jwtUser4?.sub || jwtUser4?.id || '');
      const jwtNumericId4 = String(jwtUser4?.numeric_id || '');
      const parts = db.getChatParticipants(chatId);
      if (jwtUserId4 && parts.length > 0) {
        const isMember = parts.some((p: any) => String(p.user_id) === jwtUserId4 || String(p.user_id) === jwtNumericId4);
        if (!isMember) {
          return res.status(403).json({ error: '无权向此聊天发送消息' });
        }
      }
      const friendParticipant = parts.find((p: any) => String(p.user_id) !== String(fromUserId));
      if (!friendParticipant) return res.status(400).json({ error: '无法确定好友' });

      const friendUserId = String(friendParticipant.user_id);
      const friendNumericId = Number(friendUserId);

      // 本地用户（同一实例内好友）：直接落库 + 广播，无需走 Mesh
      // v2.0.37: 本地用户同样带 numeric_id，原先用「有没有数字 ID」判断会把本机好友
      // 误判成跨实例好友，未配置 Mesh 时直接 500「Mesh 未配置」。改为先查本地用户表。
      const localFriend = db.listUsers().find((u: any) =>
        String(u.id) === friendUserId || String(u.numeric_id) === friendUserId || String(u.numeric_id) === String(friendNumericId));
      if (localFriend) {
        const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        db.addMessage({ id: msgId, chatId, senderType: 'user', senderId: String(fromUserId), content, type: 'text', timestamp: Date.now() });
        broadcast({ type: 'message.new', chatId, from: String(fromUserId), senderId: String(fromUserId), senderType: 'user', content, timestamp: Date.now() });
        return res.json({ ok: true, local: true });
      }

      // 跨实例好友：走 Mesh 中继
      const _meshUrl = process.env.MESH_PLATFORM_URL || process.env.PLATFORM_URL || '';
      const _meshTok = process.env.MESH_TOKEN || process.env.PLATFORM_TOKEN || '';
      if (!_meshUrl || !_meshTok) return res.status(500).json({ error: 'Mesh 未配置' });

      const r = await fetch(_meshUrl.replace(/\/$/, '') + '/api/users/find?numericId=' + friendNumericId, {
        headers: { 'Authorization': 'Bearer ' + _meshTok },
      });
      const d = await r.json() as any;
      if (!d.found) return res.status(404).json({ error: '好友不在线或未注册到 Mesh' });

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

      if (!ok) return res.status(500).json({ error: 'Mesh 未连接或目标不在线' });

      // 本地也落库
      const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      db.addMessage({ id: msgId, chatId, senderType: 'user', senderId: String(fromUserId), content, type: 'text', timestamp: Date.now() });

      // 广播给前端（发送方也能实时看到消息）
      broadcast({ type: 'message.new', chatId, from: String(fromUserId), senderId: String(fromUserId), senderType: 'user', content, timestamp: Date.now() });

      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/chats/:id/participants', requireAuth, (req, res) => {
    try {
      const participants = db.getChatParticipants(req.params.id as string);
      res.json({ ok: true, participants });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/participants', requireAuth, (req, res) => {
    try {
      const { id, chatId, agentId } = req.body || {};
      if ((!id && !agentId) || !chatId) return res.status(400).json({ error: 'id 和 chatId 必填' });
      db.removeParticipant(chatId, id || '', agentId);
      // 如果群聊没参与者了，清理协作模式缓存
      const remaining = db.getChatParticipants(chatId);
      if (!remaining || remaining.length === 0) {
        (globalThis as any).__chatModes?.delete(chatId);
        (globalThis as any).__roundRobinIdx?.delete(chatId);
      }
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 删除整个会话（含消息+参与者） ──
  app.delete('/api/chats/:id', requireAuth, (req, res) => {
    try {
      const chatId = req.params.id;
      const d = getDB();
      d.run('DELETE FROM messages WHERE chat_id = ?', [chatId]);
      d.run('DELETE FROM participants WHERE chat_id = ?', [chatId]);
      d.run('DELETE FROM chats WHERE id = ?', [chatId]);
      d.run('DELETE FROM chat_memories WHERE chat_id = ?', [chatId]);
      d.run('DELETE FROM entities WHERE chat_id = ?', [chatId]);
      (globalThis as any).__chatModes?.delete(chatId);
      (globalThis as any).__roundRobinIdx?.delete(chatId);
      res.json({ ok: true, deleted: chatId });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 聊天成员管理 ──
  app.get('/api/chats/:id/available-members', requireAuth, (req, res) => {
    try {
      const userId = req.query.userId as string;
      const chatId = req.params.id as string;
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const friends = db.listFriends(userId);
      const friendAgents = friends.map((f: any) => {
        const agent = db.getAgentByUserId(f.friendId);
        if (!agent) return null;
        // Grant status decides whether this agent can be added at all (default deny)
        const chk = canUseAgent(String(agent.id), String(userId), { chatId });
        return {
          id: agent.id,
          displayName: agent.display_name || agent.displayName,
          type: 'agent',
          ownerId: f.friendId,
          ownerName: f.friendName,
          granted: chk.allowed,
          grantStatus: chk.allowed ? 'accepted' : (chk.reason === 'pending_approval' ? 'pending' : 'locked'),
          grantReason: chk.reason,
        };
      }).filter(Boolean);
      const myAgent = db.getAgentByUserId(userId);
      const myAI = myAgent ? [{ id: myAgent.id, displayName: myAgent.display_name || myAgent.displayName, type: 'my-ai' }] : [];
      const all = [...friends.map((f: any) => ({ id: f.friendId, displayName: f.friendName, type: 'friend' })), ...friendAgents, ...myAI];
      const existing = db.getChatParticipants(chatId);
      const existingIds = new Set(existing.map((p: any) => p.user_id || p.agent_id));
      const available = all.filter((m: any) => !existingIds.has(m.id));
      res.json({ ok: true, members: available });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 群聊协作模式（持久化于 chats.chat_mode，重启不丢）──
  app.get('/api/chats/:id/mode', requireAuth, (req, res) => {
    const mode = getChatMode(req.params.id as string);
    res.json({ ok: true, mode, modes: [...CHAT_MODES] });
  });

  app.post('/api/chats/:id/mode', requireAuth, (req, res) => {
    try {
      const { mode } = req.body || {};
      if (!setChatMode(req.params.id as string, mode)) {
        return res.status(400).json({ error: '无效模式，可选: ' + CHAT_MODES.join(', ') });
      }
      res.json({ ok: true, mode });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 会话/群聊重命名（v2.0.25：与新建群聊的命名体验对齐）──
  // 背景：此前 newChat() 硬编码「新会话」且无任何改名入口，用户抱怨「点新建总是新会话，不能改名」。
  // 私聊与群聊通用：仅参与者可改，名称落 chats.name，前端列表/标题即时同步。
  app.patch('/api/chats/:id/name', requireAuth, (req, res) => {
    try {
      const chatId = req.params.id as string;
      const rawName = req.body?.name;
      // 1) 会话必须存在
      const chat = db.getChatById(chatId);
      if (!chat) return res.status(404).json({ error: '会话不存在' });
      // 2) 名称校验：必填、去空白、限长 60
      if (typeof rawName !== 'string' || !rawName.trim()) {
        return res.status(400).json({ error: '会话名称不能为空' });
      }
      const name = rawName.trim();
      if (name.length > 60) {
        return res.status(400).json({ error: '会话名称不能超过 60 个字符' });
      }
      // 3) 越权防护：仅会话参与者可改名
      //    v2.1.3 同前：admin-auto/admin-token 本地免登录模式下 sub='admin' 是虚拟身份，跳过一致性检查
      const jwtUser = (req as any).user;
      const jwtSid = String(jwtUser?.sid || '');
      const jwtSub = String(jwtUser?.sub || jwtUser?.id || '');
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      const isLocalAuto = (jwtSid === 'admin-auto' || jwtSid === 'admin-token');
      if (jwtSub && !isLocalAuto) {
        const parts = db.getChatParticipants(chatId);
        const isMember = parts.some((p: any) => String(p.user_id) === jwtSub || String(p.user_id) === jwtNumericId);
        if (!isMember) {
          return res.status(403).json({ error: '无权修改此会话的名称' });
        }
      }
      // 4) 落库 + 广播（多端同步标题）
      const oldName = (chat as any).name ?? null;
      db.updateChatName(chatId, name);
      broadcast({ type: 'chat.renamed', chatId, name, oldName, by: jwtSub || 'admin', timestamp: Date.now() });
      res.json({ ok: true, chatId, name, oldName });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}
