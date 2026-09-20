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
import { getDB, getUserCredits, getAgentByUserId, queryOne, queryObjects } from '../storage/db.js';
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
    // ── P0-2 落地：雇佣链路原子化 + 幂等，杜绝"钱动了单没生成"的资损 ──
    // 兼容性说明：若上游已挂鉴权中间件（req.user 存在），买家身份以鉴权结果为准；
    // 否则回退到 req.body.buyerId（保持对现有前端调用方式的向后兼容）。
    try {
      const { listingId, expiresInDays } = req.body || {};
      if (!listingId) { res.status(400).json({ error: 'Missing listingId' }); return; }

      // 【D】买家身份：优先鉴权，其次 body（admin 可代为指定）
      const authUser = (req as any).user as { sub?: string; roles?: string[] } | undefined;
      const isAdmin = !!authUser?.roles?.includes('admin');
      const buyerId = authUser?.sub
        ? (isAdmin && req.body?.buyerId ? String(req.body.buyerId) : authUser.sub)
        : String(req.body?.buyerId || '');
      if (!buyerId) { res.status(400).json({ error: 'listingId/buyerId 必填' }); return; }

      const db = getDB();
      const listing = queryObjects('SELECT * FROM agent_market WHERE id = ?', [listingId])[0];
      if (!listing) { res.status(404).json({ error: '该服务不存在或已下架' }); return; }
      if (listing.status !== 'active') { res.status(409).json({ error: '该服务已下架' }); return; }
      if (String(listing.publisher_id) === String(buyerId)) {
        res.status(400).json({ error: '不能雇佣自己上架的服务' }); return;
      }

      const price = Number(listing.price || 0);

      // 【C】幂等：同一买家对同一 listing 已有 active 雇约 → 复用，不重复扣款
      const exist = queryObjects(
        "SELECT id, chat_id FROM hires WHERE buyer_id = ? AND listing_id = ? AND status = 'active' LIMIT 1",
        [buyerId, listingId]
      )[0];
      if (exist) {
        res.json({ ok: true, idempotent: true, hireId: exist.id, chatId: exist.chat_id, message: '已有生效中的雇约，未重复扣款' });
        return;
      }

      const now = Date.now();
      const expiresAt = expiresInDays ? now + Number(expiresInDays) * 86400000 : 0;
      const chatId = `hire-chat-${listingId}-${buyerId}`;
      const hireId = `hire-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;   // 【E】
      const orderId = `mo-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      let balanceAfter = 0;
      try {
        db.run('BEGIN');

        // 【A】条件扣款：把"检查余额"和"扣款"合成一条原子语句，杜绝竞态透支
        db.run(
          'UPDATE user_credits SET credits = credits - ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ? AND credits >= ?',
          [price, price, now, buyerId, price]
        );
        if (db.getRowsModified() !== 1) {
          db.run('ROLLBACK');
          const cur = getUserCredits(buyerId);
          res.status(402).json({ error: `积分不足，需要 ${price}，当前 ${cur.credits}`, balance: cur.credits });
          return;
        }
        const balRow = queryOne('SELECT credits FROM user_credits WHERE user_id = ?', [buyerId]);
        balanceAfter = balRow ? Number(balRow[0]) : 0;
        db.run(
          'INSERT INTO credit_log (user_id, amount, reason, balance_after, created_at) VALUES (?, ?, ?, ?, ?)',
          [buyerId, -Math.abs(price), `雇佣「${listing.title}」`, balanceAfter, now]
        );

        // 卖家入账
        db.run(
          'UPDATE user_credits SET credits = credits + ?, total_earned = total_earned + ?, updated_at = ? WHERE user_id = ?',
          [price, price, now, listing.publisher_id]
        );
        const sellerRow = queryOne('SELECT credits FROM user_credits WHERE user_id = ?', [listing.publisher_id]);
        db.run(
          'INSERT INTO credit_log (user_id, amount, reason, balance_after, created_at) VALUES (?, ?, ?, ?, ?)',
          [listing.publisher_id, Math.abs(price), `被雇佣「${listing.title}」收入`, sellerRow ? Number(sellerRow[0]) : 0, now]
        );

        // 会话与成员（幂等插入，避免重复雇约时撞主键）
        db.run('INSERT OR IGNORE INTO chats (id, type, created_at) VALUES (?, ?, ?)', [chatId, 'private', now]);
        const buyerAgent = getAgentByUserId(buyerId);
        db.run('INSERT OR IGNORE INTO participants (id, chat_id, user_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)',
          [`p-${chatId}-buyer`, chatId, buyerId, null, 'member', now]);
        db.run('INSERT OR IGNORE INTO participants (id, chat_id, user_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)',
          [`p-${chatId}-seller`, chatId, listing.publisher_id, null, 'member', now]);
        if (buyerAgent) {
          db.run('INSERT OR IGNORE INTO participants (id, chat_id, user_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)',
            [`p-${chatId}-agent`, chatId, null, buyerAgent.id, 'agent', now]);
        }

        // 雇约（与扣款同事务）
        db.run(
          `INSERT INTO hires (id, listing_id, buyer_id, seller_id, agent_id, title, price, status, chat_id, hired_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          [hireId, listingId, buyerId, listing.publisher_id, listing.agent_id, listing.title, price, chatId, now, expiresAt]
        );

        // 订单与计数（与扣款同事务）
        db.run('INSERT INTO market_orders (id, listing_id, buyer_id, status, created_at) VALUES (?, ?, ?, ?, ?)',
          [orderId, listingId, buyerId, 'completed', now]);
        db.run('UPDATE agent_market SET hire_count = COALESCE(hire_count, 0) + 1 WHERE id = ?', [listingId]);

        db.run('COMMIT');
      } catch (e: any) {
        try { db.run('ROLLBACK'); } catch { /* ignore */ }
        console.error('[market/hire] 事务失败已回滚:', e.message);
        res.status(500).json({
          error: '雇佣失败，已回滚（积分未发生变动）',
          detail: e.message,
          rolledBack: true,
        });
        return;
      }

      const sellerAgent = getAgentByUserId(listing.publisher_id);
      res.json({
        ok: true, hireId, orderId, chatId,
        buyerId, sellerId: listing.publisher_id,
        sellerAgentId: sellerAgent?.id || null,
        price, balance: balanceAfter,
        expiresAt,
      });
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