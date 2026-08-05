/**
 * 好友路由 — 好友请求、好友列表、LAN peer 回调
 *
 * v2.0.6 整合：
 *  - 本地好友 CRUD（请求/响应/列表/撤销/删除）
 *  - LAN peer 回调路由（好友请求/接受/删除回调）
 *  - 统一 chatId 生成逻辑（按 userId 字典序）
 */
import { Router } from 'express';
import type { ServerContext } from '../server/context.js';
import { verifyLanRequest } from '../net/lan-transport.js';
import { deleteFriendRequest, deleteFriendshipByPair } from '../storage/db.js';

export function createFriendsRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { db } = ctx;

  // ════════════════════════════════════════════════
  // 本地好友 CRUD
  // ════════════════════════════════════════════════

  // ── 用户搜索（按 display_name 或 numeric_id）──
  router.get('/users', (req, res) => {
    try {
      const keyword = (req.query.q as string) || '';
      const users = db.listUsers();
      const filtered = keyword
        ? users.filter((u: any) => {
            const name = (u.display_name || '').toLowerCase();
            const idStr = String(u.numeric_id || u.id || '');
            return name.includes(keyword.toLowerCase()) || idStr.includes(keyword);
          })
        : users;
      res.json({
        ok: true,
        users: filtered.map((u: any) => ({ id: u.id, displayName: u.display_name, numericId: u.numeric_id })),
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 按 numeric_id 精确查找用户 ──
  router.get('/users/by-id', (req, res) => {
    try {
      const numericId = parseInt(req.query.numericId as string, 10);
      if (isNaN(numericId)) return res.status(400).json({ error: '无效的 numericId' });
      const user = db.getUserByNumericId(numericId);
      if (!user) return res.status(404).json({ error: '用户不存在' });
      res.json({ ok: true, user: { id: user.id, displayName: user.display_name, numericId: user.numeric_id } });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 发送好友请求（本地） ──
  router.post('/friends/request', (req, res) => {
    try {
      const { fromUserId, toUserId, message } = req.body;
      if (!fromUserId || !toUserId) return res.status(400).json({ error: 'fromUserId 和 toUserId 必填' });
      if (fromUserId === toUserId) return res.status(400).json({ error: '不能添加自己为好友' });
      const result = db.sendFriendRequest(fromUserId, toUserId, message || '');
      if (result.error) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 响应好友请求（accept / reject） ──
  router.post('/friends/respond', (req, res) => {
    try {
      const { requestId, action } = req.body;
      if (!requestId || !action) return res.status(400).json({ error: 'requestId 和 action 必填' });
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action 只能是 accept 或 reject' });
      const result = db.respondFriendRequest(requestId, action);
      if (result.error) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 好友请求列表 ──
  router.get('/friends/requests', (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      res.json({ ok: true, ...db.getFriendRequests(userId) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 撤销好友请求（v2.0.6 新增） ──
  router.delete('/friends/requests/:id', (req, res) => {
    try {
      deleteFriendRequest(req.params.id);
      res.json({ ok: true, message: '已撤销' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 好友列表 ──
  router.get('/friends/list', (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      res.json({ ok: true, friends: db.listFriends(userId) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 删除好友 ──
  router.delete('/friends/:id', (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      const friendId = req.params.id;
      if (!userId || !friendId) return res.status(400).json({ error: 'userId 和 friendId 必填' });
      deleteFriendshipByPair(userId, friendId);
      res.json({ ok: true, message: '好友已删除' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ════════════════════════════════════════════════
  // LAN peer 回调路由（邻居引擎间调用，用协议头验证而非 JWT）
  // ════════════════════════════════════════════════

  // ── 收到好友请求（邻居引擎调用） ──
  router.post('/lan/peer/friend-request', (req, res) => {
    const fromInstance = verifyLanRequest(req, res);
    if (!fromInstance) return;
    try {
      const result = (ctx as any).lanSocial?.handleIncomingFriendRequest(req.body) || { error: 'LAN 社交模块未初始化' };
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 对方接受好友后的回调 ──
  router.post('/lan/peer/friend-accept', (req, res) => {
    const fromInstance = verifyLanRequest(req, res);
    if (!fromInstance) return;
    try {
      const result = (ctx as any).lanSocial?.handleFriendAccept(req.body) || { error: 'LAN 社交模块未初始化' };
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 对方删除好友的回调 ──
  router.post('/lan/peer/friend-remove', (req, res) => {
    const fromInstance = verifyLanRequest(req, res);
    if (!fromInstance) return;
    try {
      const { userId, friendId } = req.body || {};
      deleteFriendshipByPair(userId, friendId);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}
