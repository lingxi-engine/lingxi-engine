/**
 * 好友路由 — 好友请求、好友列表
 */
import { Router } from 'express';
import { getDB, getUserByNumericId } from '../storage/db.js';
import type { ServerContext } from '../server/context.js';

export function createFriendsRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { db } = ctx;

  // ── 用户搜索（按 display_name 或 numeric_id）── SQL LIKE 查询，避免全表扫描
  router.get('/users', (req, res) => {
    try {
      const keyword = (req.query.q as string) || '';
      let users: any[];
      if (keyword) {
        // 使用 SQL LIKE 查询，限制最多 50 条结果
        const d = getDB();
        const likePattern = '%' + keyword.toLowerCase() + '%';
        const stmt = d.prepare('SELECT id, display_name, numeric_id FROM users WHERE LOWER(display_name) LIKE ? OR CAST(numeric_id AS TEXT) LIKE ? ORDER BY numeric_id DESC LIMIT 50');
        stmt.bind([likePattern, likePattern]);
        users = [];
        while (stmt.step()) {
          const row = stmt.getAsObject();
          users.push({ id: row.id, display_name: row.display_name, numeric_id: row.numeric_id });
        }
        stmt.free();
      } else {
        // 无关键词时返回最近活跃的 50 个用户
        users = db.listUsers().slice(0, 50);
      }
      res.json({
        ok: true,
        users: users.map((u: any) => ({
          id: u.id,
          displayName: u.display_name,
          numericId: u.numeric_id,
        })),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 按 numeric_id 精确查找用户 ──
  router.get('/users/by-id', (req, res) => {
    try {
      const numericId = parseInt(req.query.numericId as string, 10);
      if (isNaN(numericId)) return res.status(400).json({ error: '无效的 numericId' });
      // 2026-11-11 FIX：getUserByNumericId 是模块级导出，DB 类上没有这个方法（TS2339）
      const user = getUserByNumericId(numericId);
      if (!user) return res.status(404).json({ error: '用户不存在' });
      res.json({
        ok: true,
        user: {
          id: user.id,
          displayName: user.display_name,
          numericId: user.numeric_id,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 发送好友请求 ──
  router.post('/friends/request', (req, res) => {
    try {
      const { fromUserId, toUserId, message } = req.body;
      if (!fromUserId || !toUserId) return res.status(400).json({ error: 'fromUserId 和 toUserId 必填' });
      if (fromUserId === toUserId) return res.status(400).json({ error: '不能添加自己为好友' });
      const result = db.sendFriendRequest(fromUserId, toUserId, message || '');
      if (result.error) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 响应好友请求 ──
  router.post('/friends/respond', (req, res) => {
    try {
      const { requestId, action } = req.body;
      if (!requestId || !action) return res.status(400).json({ error: 'requestId 和 action 必填' });
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action 只能是 accept 或 reject' });
      const result = db.respondFriendRequest(requestId, action) as { ok: boolean; status: string; error?: string };
      if (result.error) return res.status(400).json(result);
      res.json({ ...result, ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 好友请求列表 ──
  router.get('/friends/requests', (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      res.json({ ok: true, ...db.getFriendRequests(userId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 好友列表 ──
  router.get('/friends/list', (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      res.json({ ok: true, friends: db.listFriends(userId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  // ── 删除好友 (Bug Fix) ──
  router.delete('/friends/:id', (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      const friendId = req.params.id;
      if (!userId || !friendId) return res.status(400).json({ error: 'userId 和 friendId 必填' });
      const d = getDB();
      // 删除双向好友关系
      d.run("DELETE FROM friendships WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)",
        [userId, friendId, friendId, userId]);
      d.run("DELETE FROM participants WHERE chat_id = ?", ["chat-" + userId + "-" + friendId]);
      d.run("DELETE FROM participants WHERE chat_id = ?", ["chat-" + friendId + "-" + userId]);
      res.json({ ok: true, message: '好友已删除' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}