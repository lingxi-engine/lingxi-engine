/**
 * 市场路由 — AI 员工市场
 * 
 * 修复:
 * - Bug #11: 雇佣时检查/扣减买家积分
 * - Bug #12: 创建 hire 记录
 * - Bug #13: 创建买家-卖家聊天通道
 * - Bug #14: publish 校验 agent 所有权
 * - Bug #15: 添加下架/编辑/删除端点
 */
import { Router } from 'express';
import { getDB, getUserCredits, spendCredits, addCredits, createHire, createChat, addParticipant, getAgentByUserId } from '../storage/db.js';
import type { ServerContext } from '../server/context.js';

export function createMarketRoutes(_ctx: ServerContext): Router {
  const router = Router();

  router.get('/market/list', (_req, res) => {
    try {
      const stmt = getDB().prepare('SELECT * FROM agent_market WHERE status = ? ORDER BY rating DESC, hire_count DESC');
      stmt.bind(['active']);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json({ ok: true, listings: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/market/publish', (req, res) => {
    try {
      const { agentId, publisherId, title, description, category, price, tags } = req.body || {};
      if (!agentId || !publisherId || !title) return res.status(400).json({ error: 'agentId/publisherId/title 必填' });
      
      const d = getDB();
      
      // Bug #14: 校验 agent 所有权
      const agentStmt = d.prepare('SELECT user_id FROM agents WHERE id = ?');
      agentStmt.bind([agentId]);
      const agentRow = agentStmt.step() ? agentStmt.getAsObject() : null;
      agentStmt.free();
      if (!agentRow) return res.status(404).json({ error: 'Agent 不存在' });
      if (agentRow.user_id !== publisherId) return res.status(403).json({ error: '只能发布自己的 Agent' });

      const id = 'ml-' + Date.now().toString(36);
      d.run(
        'INSERT INTO agent_market (id,agent_id,publisher_id,title,description,category,price,tags,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [id, agentId, publisherId, title, description || '', category || '通用', price || 0, JSON.stringify(tags || []), Date.now()]
      );
      res.json({ ok: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bug #15: 下架商品
  router.post('/market/unpublish', (req, res) => {
    try {
      const { listingId, userId } = req.body || {};
      if (!listingId || !userId) return res.status(400).json({ error: 'listingId/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT publisher_id FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '商品不存在' });
      if (row.publisher_id !== userId) return res.status(403).json({ error: '只能下架自己的商品' });
      d.run("UPDATE agent_market SET status = 'paused' WHERE id = ?", [listingId]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bug #15: 编辑商品
  router.put('/market/:id', (req, res) => {
    try {
      const { userId, title, description, category, price, tags } = req.body || {};
      const listingId = req.params.id;
      if (!listingId || !userId) return res.status(400).json({ error: 'listingId/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT publisher_id FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '商品不存在' });
      if (row.publisher_id !== userId) return res.status(403).json({ error: '只能编辑自己的商品' });
      
      const sets: string[] = [];
      const vals: any[] = [];
      if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
      if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
      if (category !== undefined) { sets.push('category = ?'); vals.push(category); }
      if (price !== undefined) { sets.push('price = ?'); vals.push(price); }
      if (tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(tags)); }
      if (sets.length === 0) return res.json({ ok: true, message: '无需更新' });
      
      vals.push(listingId);
      d.run(`UPDATE agent_market SET ${sets.join(', ')} WHERE id = ?`, vals);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Bug #15: 删除商品
  router.delete('/market/:id', (req, res) => {
    try {
      const { userId } = req.body || {};
      const listingId = req.params.id;
      if (!listingId || !userId) return res.status(400).json({ error: 'listingId/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT publisher_id FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '商品不存在' });
      if (row.publisher_id !== userId) return res.status(403).json({ error: '只能删除自己的商品' });
      d.run("DELETE FROM agent_market WHERE id = ?", [listingId]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/market/hire', (req, res) => {
    try {
      const { listingId, buyerId } = req.body || {};
      if (!listingId || !buyerId) return res.status(400).json({ error: 'listingId/buyerId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT * FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const listing = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!listing) return res.status(404).json({ error: '商品不存在' });
      if (listing.status !== 'active') return res.status(400).json({ error: '商品已下架' });
      if (listing.publisher_id === buyerId) return res.status(400).json({ error: '不能雇佣自己的 Agent' });
      
      // Bug #11: 检查买家积分
      const buyerCredits = getUserCredits(buyerId);
      const price = Number(listing.price) || 0;
      if (buyerCredits < price) {
        return res.status(400).json({ error: `积分不足：需要 ${price}，当前 ${buyerCredits}` });
      }
      
      // 扣积分（加给卖家）
      if (price > 0) {
        spendCredits(buyerId, price);
        addCredits(listing.publisher_id, price);
      }
      
      // Bug #12: 创建 hire 记录
      const chatId = 'hire-chat-' + listingId + '-' + buyerId;
      // 创建雇佣聊天
      try {
        createChat(chatId, 'private');
        addParticipant('p-hire-' + listingId + '-buyer', chatId, buyerId, undefined, 'member');
        addParticipant('p-hire-' + listingId + '-seller', chatId, listing.publisher_id, undefined, 'member');
        // 添加被雇佣的AI
        addParticipant('p-hire-' + listingId + '-agent', chatId, undefined, listing.agent_id, 'agent');
      } catch (_e) { /* chat may already exist */ }
      
      // 插入 hire 记录
      createHire(listingId, buyerId, listing.publisher_id, listing.agent_id, listing.title, price, chatId);
      
      const orderId = 'mo-' + Date.now().toString(36);
      d.run('INSERT INTO market_orders (id,listing_id,buyer_id,status,created_at) VALUES (?,?,?,?,?)',
        [orderId, listingId, buyerId, 'completed', Date.now()]);
      d.run('UPDATE agent_market SET hire_count = hire_count + 1 WHERE id = ?', [listingId]);
      
      res.json({ ok: true, orderId, chatId, message: '雇佣成功' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 我的雇佣列表
  router.get('/market/my-hires', (req, res) => {
    try {
      const userId = req.query.userId as string;
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const d = getDB();
      const stmt = d.prepare("SELECT * FROM hires WHERE buyer_id = ? OR seller_id = ? ORDER BY hired_at DESC");
      stmt.bind([userId, userId]);
      const hires: any[] = [];
      while (stmt.step()) hires.push(stmt.getAsObject());
      stmt.free();
      res.json({ ok: true, hires });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 评价雇佣
  router.post('/market/rate', (req, res) => {
    try {
      const { orderId, rating, review, userId } = req.body || {};
      if (!orderId || !rating || !userId) return res.status(400).json({ error: 'orderId/rating/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT * FROM market_orders WHERE id = ?');
      stmt.bind([orderId]);
      const order = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!order) return res.status(404).json({ error: '订单不存在' });
      if (order.buyer_id !== userId) return res.status(403).json({ error: '只能评价自己的订单' });
      d.run('UPDATE market_orders SET rating = ?, review = ?, completed_at = ?, status = ? WHERE id = ?',
        [rating, review || '', Date.now(), 'completed', orderId]);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}