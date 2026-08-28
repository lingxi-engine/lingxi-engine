/**
 * AI 员工市场 + 雇佣系统路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 5/N）
 *
 * 抽取范围: 原 index.ts L1031-1339 单一连续段
 *   /api/market/{list,publish,hire,my-listings,unpublish,republish,rate,my-orders}
 *   /api/market/:id (PUT/DELETE) 共 10 条
 * 原则: 业务代码逐行保真，仅做依赖注入改造（optAuth/requireAuth 由宿主传入，db 函数直接 import）
 *
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查
 */
import type { Express, RequestHandler } from 'express';
import {
  getDB,
  spendWalletBalance,
  addWalletBalance,
  spendCredits,
  addCredits,
  createHire,
  fireHire,
  listHiresByBuyer,
  listHiresBySeller,
  getHire,
  createChat,
  getAgentByUserId,
  addParticipant,
  removeParticipant,
} from '../storage/db.js';

export function registerMarketRoutes(app: Express, deps: { optAuth: RequestHandler; requireAuth: RequestHandler }) {
  const { optAuth, requireAuth } = deps;
  app.get('/api/market/list', optAuth, (req, res) => {
    try {
      const type = (req.query.type as string) || '';
      const stmt = getDB().prepare("SELECT * FROM agent_market WHERE status = ? AND (? = '' OR item_type = ?) ORDER BY rating DESC, hire_count DESC");
      stmt.bind(['active', type, type]);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json({ ok: true, listings: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/market/publish', optAuth, (req, res) => {
    try {
      const { agentId, publisherId, title, description, category, price, currency, tags, duration, durationUnit, itemType, previewUrl, fileUrl, license, coverUrl } = req.body || {};
      const currencyOk = ['credits','usd','cny'].includes(currency) ? currency : 'credits';
      if (!agentId || !publisherId || !title) return res.status(400).json({ error: 'agentId/publisherId/title 必填' });
      // v2.0.12 B1/B2: 价格校验（最低10积分避免抽成取整后卖方到账0，上限100000）
      const rawPrice = Number(price) || 0;
      let priceNum = currencyOk === 'usd' ? Math.round(rawPrice * 100) / 100 : currencyOk === 'cny' ? Math.round(rawPrice * 100) / 100 : Math.floor(rawPrice);
      const minPrice = currencyOk === 'usd' ? 0.1 : currencyOk === 'cny' ? 1 : 10;
      const maxPrice = currencyOk === 'usd' ? 100000 : currencyOk === 'cny' ? 500000 : 100000;
      if (priceNum < minPrice) return res.status(400).json({ error: '发布价格最低 ' + minPrice + (currencyOk === 'credits' ? ' 积分' : '') });
      if (priceNum > maxPrice) return res.status(400).json({ error: '价格不能超过 ' + maxPrice + (currencyOk === 'credits' ? ' 积分' : '') });
      // v2.0.12: 自定义时长（0=永久买断）
      const durNum = Math.max(0, Math.floor(Number(duration) || 0));
      const unitOk = ['minute', 'hour', 'day'].includes(durationUnit) ? durationUnit : 'hour';
      const unit = durNum > 0 ? unitOk : 'permanent';
      const d = getDB();
      const id = 'ml-' + Date.now().toString(36);
            const typeOk = ['agent','music','video','bounty','asset','mcp','skill'].includes(itemType) ? itemType : 'agent';
      d.run('INSERT INTO agent_market (id,agent_id,publisher_id,title,description,category,price,currency,tags,created_at,duration,duration_unit,item_type,preview_url,file_url,license,cover_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [id, agentId, publisherId, title, description||'', category||'通用', priceNum, currencyOk, JSON.stringify(tags||[]), Date.now(), durNum, unit, typeOk, previewUrl||'', fileUrl||'', license||'', coverUrl||'']);
      res.json({ ok: true, id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 雇佣AI员工：扣积分 → 创建工作群 → 双方agent入群 → 记录雇佣关系 */
  app.post('/api/market/hire', optAuth, (req, res) => {
    try {
      const { listingId, buyerId } = req.body || {};
      if (!listingId || !buyerId) return res.status(400).json({ error: 'listingId/buyerId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT * FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const listing = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!listing) return res.status(404).json({ error: '商品不存在' });
      // v2.0.12 B3: 禁止自雇 + 检查上架状态
      if (listing.status !== 'active') return res.status(400).json({ error: '该商品已下架或不可雇佣' });
      if (String(listing.publisher_id) === String(buyerId)) return res.status(400).json({ error: '不能雇佣自己发布的员工' });
      // 1. 结算（按币种：credits 积分 / usd 美元 / cny 人民币），90% 给卖家，10% 平台税
      const price = Number(listing.price) || 0;
      const hireCurrency = listing.currency || 'credits';
      let spendResult: any = null;
      if (hireCurrency === 'usd' || hireCurrency === 'cny') {
        spendResult = spendWalletBalance(buyerId, hireCurrency, price, '购买/雇佣: ' + (listing.title || ''));
        if (typeof spendResult === 'object' && !spendResult.ok) return res.status(400).json({ error: spendResult.error, balance: spendResult.balance });
        const sellerPayout = Math.round(price * 0.9 * 100) / 100;
        addWalletBalance(listing.publisher_id, hireCurrency, sellerPayout, '出售分成(90%): ' + (listing.title || ''));
      } else {
        spendResult = !spendCredits ? {ok:false, error:'no fn'} : spendCredits(buyerId, price);
        if (typeof spendResult === 'object' && !spendResult.ok) return res.status(400).json({ error: spendResult.error, balance: (spendResult as { balance?: number }).balance });
        const sellerPayout = Math.floor(price * 0.9);
        if (typeof addCredits === 'function') addCredits(listing.publisher_id, sellerPayout);
      }
      
      // 3. 创建工作群组 chat
      const chatId = 'chat-hire-' + Date.now().toString(36);
      if (typeof createChat === 'function') createChat(chatId, 'group');
      
      // 4. 双方agent入群
      const buyerAgent = typeof getAgentByUserId === 'function' ? getAgentByUserId(buyerId) : null;
      const sellerAgent = typeof getAgentByUserId === 'function' ? getAgentByUserId(listing.publisher_id) : null;
      const boughtAgent = listing.agent_id ? d.getAgent(listing.agent_id) : null;
      
      const buyerAgentId = buyerAgent?.id || '';
      const usedAgentId = listing.agent_id || boughtAgent?.id || sellerAgent?.id || '';
      
      if (typeof addParticipant === 'function') {
        addParticipant('hp-' + Date.now().toString(36) + '-1', chatId, buyerId, undefined, 'member');
        addParticipant('hp-' + Date.now().toString(36) + '-2', chatId, undefined, buyerAgentId, 'agent');
        addParticipant('hp-' + Date.now().toString(36) + '-3', chatId, listing.publisher_id, undefined, 'member');
        addParticipant('hp-' + Date.now().toString(36) + '-4', chatId, undefined, usedAgentId, 'agent');
      }
      
      // 5. v2.0.12: 计算到期时间（发布者自定义时长，0=永久买断）
      const durMs: Record<string, number> = { minute: 60000, hour: 3600000, day: 86400000 };
      const dur = Number(listing.duration) || 0;
      const expiresAt = dur > 0 ? Date.now() + dur * (durMs[String(listing.duration_unit)] || 3600000) : 0;

      // 6. 记录雇佣关系
      const hireId = 'hire-' + Date.now().toString(36);
      if (typeof createHire === 'function') {
        createHire({
          id: hireId, listingId, buyerId,
          sellerId: listing.publisher_id,
          agentId: usedAgentId,
          title: listing.title || "AI雇佣",
          chatId, price, expiresAt,
        });
      }

      // 7. 记订单（关联hireId）+ 增hire计数
      const orderId = 'mo-' + Date.now().toString(36);
      d.run('INSERT INTO market_orders (id,listing_id,buyer_id,hire_id,created_at) VALUES (?,?,?,?,?)', [orderId, listingId, buyerId, hireId, Date.now()]);
      d.run('UPDATE agent_market SET hire_count = hire_count + 1 WHERE id = ?', [listingId]);
      
      // 8. 发欢迎消息
      const welcomeMsg = {
        id: 'msg-' + Date.now().toString(36),
        chatId, senderType: 'user',
        senderId: buyerId,
        content: '🎉 雇佣成功！欢迎AI员工加入团队。你可以在这个工作群中分配任务。',
        type: 'text', timestamp: Date.now(),
      };
      d.addMessage(welcomeMsg);
      
      res.json({ ok: true, orderId, hireId, chatId, expiresAt, balance: typeof spendResult === 'object' ? ((spendResult as { balance?: number }).balance || 0) : 0 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  // ── 钱包/积分路由（批次4: 迁移至 src/routes/wallet.ts，含 pay 嵌套闭合修复） ──

  /** v2.0.12: 雇佣到期惰性检查——超过 expires_at 则标记 expired 并把被雇 agent 移出工作群（保留聊天记录） */
  function checkHireExpired(hire: any): boolean {
    if (!hire || hire.status !== 'active') return false;
    const exp = Number(hire.expires_at) || 0;
    if (exp <= 0 || Date.now() < exp) return false;
    getDB().run("UPDATE hires SET status = 'expired', fired_at = ? WHERE id = ?", [Date.now(), hire.id]);
    if (hire.chat_id && hire.agent_id && typeof removeParticipant === 'function') {
      removeParticipant(hire.chat_id, '', hire.agent_id);
    }
    return true;
  }
  /** 查看员工的雇佣关系 */
  app.get('/api/employees', optAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const asBuyer = typeof listHiresByBuyer === 'function' ? listHiresByBuyer(userId) : [];
      const asSeller = typeof listHiresBySeller === 'function' ? listHiresBySeller(userId) : [];
      // 补充listing信息（并先做到期检查）+ 关联订单（供评价）
      const enrich = (hires: any[]) => hires.map((h0: any) => {
        const h = checkHireExpired(h0) && typeof getHire === 'function' ? (getHire(h0.id) || h0) : h0;
        const lst = getDB().prepare('SELECT * FROM agent_market WHERE id = ?');
        lst.bind([h.listing_id]);
        const listing = lst.step() ? lst.getAsObject() : null;
        lst.free();
        const ordStmt = getDB().prepare('SELECT id, rating FROM market_orders WHERE hire_id = ?');
        ordStmt.bind([h.id]);
        const order = ordStmt.step() ? ordStmt.getAsObject() : null;
        ordStmt.free();
        return { ...h, listing, orderId: order?.id || null, rated: !!(order && Number(order.rating) > 0) };
      });
      res.json({ ok: true, asBuyer: enrich(asBuyer), asSeller: enrich(asSeller) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 解雇员工 */
  app.post('/api/employees/fire', optAuth, (req, res) => {
    try {
      const { hireId } = req.body || {};
      if (!hireId) return res.status(400).json({ error: 'hireId 必填' });
      const ok = typeof fireHire === 'function' ? fireHire(hireId) : false;
      if (!ok) return res.status(404).json({ error: '未找到该雇佣关系或已解雇' });
      // 清理工作群参与者（保留聊天记录）—— v2.0.12: 移除被雇 agent（原 buyer_agent_id/seller_agent_id 字段不存在导致从未生效）
      const hire = typeof getHire === 'function' ? getHire(hireId) : null;
      if (hire && hire.chat_id && hire.agent_id && typeof removeParticipant === 'function') {
        removeParticipant(hire.chat_id, '', hire.agent_id);
      }
      res.json({ ok: true, message: '已解雇' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 我的市场发布 */
  app.get('/api/market/my-listings', optAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const rows = getDB().queryObjects('SELECT * FROM agent_market WHERE publisher_id = ? ORDER BY created_at DESC', [userId]);
      res.json({ ok: true, listings: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 下架商品 */
  app.post('/api/market/unpublish', optAuth, (req, res) => {
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
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 重新上架 */
  app.post('/api/market/republish', optAuth, (req, res) => {
    try {
      const { listingId, userId } = req.body || {};
      if (!listingId || !userId) return res.status(400).json({ error: 'listingId/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT publisher_id FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '商品不存在' });
      if (row.publisher_id !== userId) return res.status(403).json({ error: '只能上架自己的商品' });
      d.run("UPDATE agent_market SET status = 'active' WHERE id = ?", [listingId]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 编辑商品 */
  app.put('/api/market/:id', optAuth, (req, res) => {
    try {
      const { userId, title, description, category, price, tags, duration, durationUnit, itemType, previewUrl, fileUrl, license, coverUrl } = req.body || {};
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
      if (price !== undefined) {
        const p = Math.floor(Number(price) || 0);
        if (p < 10) return res.status(400).json({ error: '发布价格最低 10 积分' });
        if (p > 100000) return res.status(400).json({ error: '价格不能超过 100000 积分' });
        sets.push('price = ?'); vals.push(p);
      }
      if (tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(tags)); }
      if (itemType !== undefined) { sets.push('item_type = ?'); vals.push(itemType); }
      if (previewUrl !== undefined) { sets.push('preview_url = ?'); vals.push(previewUrl); }
      if (fileUrl !== undefined) { sets.push('file_url = ?'); vals.push(fileUrl); }
      if (license !== undefined) { sets.push('license = ?'); vals.push(license); }
      if (coverUrl !== undefined) { sets.push('cover_url = ?'); vals.push(coverUrl); }
      if (duration !== undefined) { sets.push('duration = ?'); vals.push(Math.max(0, Math.floor(Number(duration) || 0))); }
      if (durationUnit !== undefined && ['minute', 'hour', 'day', 'permanent'].includes(durationUnit)) { sets.push('duration_unit = ?'); vals.push(durationUnit); }
      if (sets.length === 0) return res.json({ ok: true, message: '无需更新' });
      vals.push(listingId);
      d.run(`UPDATE agent_market SET ${sets.join(', ')} WHERE id = ?`, vals);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 删除商品 */
  app.delete('/api/market/:id', optAuth, (req, res) => {
    try {
      const userId = req.body?.userId || req.query.userId;
      const listingId = req.params.id;
      if (!listingId || !userId) return res.status(400).json({ error: 'listingId/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT publisher_id FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '商品不存在' });
      if (row.publisher_id !== userId) return res.status(403).json({ error: '只能删除自己的商品' });
      d.run('DELETE FROM agent_market WHERE id = ?', [listingId]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 评价雇佣 + rating 回写 listing */
  app.post('/api/market/rate', optAuth, (req, res) => {
    try {
      const { orderId, rating, review, userId } = req.body || {};
      const r = Math.floor(Number(rating) || 0);
      if (!orderId || !userId || r < 1 || r > 5) return res.status(400).json({ error: 'orderId/userId/rating(1-5) 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT * FROM market_orders WHERE id = ?');
      stmt.bind([orderId]);
      const order = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!order) return res.status(404).json({ error: '订单不存在' });
      if (order.buyer_id !== userId) return res.status(403).json({ error: '只能评价自己的订单' });
      d.run('UPDATE market_orders SET rating = ?, review = ?, completed_at = ?, status = ? WHERE id = ?',
        [r, review || '', Date.now(), 'completed', orderId]);
      // rating 回写：listing 评分 = 该商品所有订单评分的平均值
      const avgStmt = d.prepare('SELECT AVG(rating) AS avg_r FROM market_orders WHERE listing_id = ? AND rating IS NOT NULL AND rating > 0');
      avgStmt.bind([order.listing_id]);
      if (avgStmt.step()) {
        const avgRow: any = avgStmt.getAsObject();
        d.run('UPDATE agent_market SET rating = ? WHERE id = ?', [Math.round((Number(avgRow.avg_r) || 0) * 10) / 10, order.listing_id]);
      }
      avgStmt.free();
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 我的订单 */
  app.get('/api/market/my-orders', optAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const rows: any[] = getDB().queryObjects('SELECT * FROM market_orders WHERE buyer_id = ? ORDER BY created_at DESC', [userId]);
      const orders = rows.map((o: any) => {
        const lst = getDB().prepare('SELECT title, category FROM agent_market WHERE id = ?');
        lst.bind([o.listing_id]);
        const listing = lst.step() ? lst.getAsObject() : null;
        lst.free();
        return { ...o, listing };
      });
      res.json({ ok: true, orders });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}
