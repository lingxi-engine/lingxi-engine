/**
 * 钱包/积分路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 4/N）
 *
 * 抽取范围: 原 index.ts 两段
 *   - 主块 L1149-1283: /api/credits/{balance,history,grant} + /api/wallet{,/recharge,/pay,/freeze,/unfreeze,/settle} 共 9 条
 *   - 孤岛 L3539-3579: /api/credits/{deduct,award} 共 2 条（requireAuth + 管理员校验）
 * 原则: 业务代码逐行保真，仅做依赖注入改造（optAuth/requireAuth 由宿主传入，db 函数直接 import）
 *
 * ⚠️ 顺手修复的潜伏 bug（原巨石 L1200-1283）:
 *   /api/wallet/pay 的 handler 在 res.json 之后缺少 `} catch ... });` 闭合，
 *   导致 freeze/unfreeze/settle 三条路由的注册代码被嵌进 pay 的 try 块内，
 *   只有第一次成功调用 pay 后这三条路由才会被注册（此前请求直接 404）。
 *   语法合法所以 tsc 无法发现，纯运行时地雷。本文件已按正确闭合重写。
 *
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查
 */
import type { Express, RequestHandler } from 'express';
import { adminAuth } from '../middleware/admin-auth.js';
import {
  getDB,
  getWallet,
  ensureWallet,
  _walletTx,
  addWalletBalance,
  spendWalletBalance,
  listWalletTx,
  getUserCredits,
  addCredits,
  getCreditHistory,
} from '../storage/db.js';

export interface WalletRouteDeps {
  optAuth: RequestHandler;
  requireAuth: RequestHandler;
}

export function registerWalletRoutes(app: Express, deps: WalletRouteDeps): void {
  const { optAuth, requireAuth } = deps;

  /** 查看积分余额 */
  app.get('/api/credits/balance', optAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const balance = typeof getUserCredits === 'function' ? getUserCredits(userId) : { credits: 1000, totalEarned: 0, totalSpent: 0 };
      res.json({ ok: true, ...balance });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 积分变动历史 */
  app.get('/api/credits/history', optAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const history = typeof getCreditHistory === 'function' ? getCreditHistory(userId, 50) : [];
      res.json({ ok: true, history });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 管理员加积分 */
  app.post('/api/credits/grant', adminAuth, (req, res) => {
    try {
      const { userId, amount } = req.body || {};
      if (!userId || !amount) return res.status(400).json({ error: 'userId/amount 必填' });
      const newBal = typeof addCredits === 'function' ? addCredits(userId, Math.abs(amount)) : 0;
      res.json({ ok: true, balance: newBal });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 钱包：查询余额 + 流水（USD / CNY） */
  app.get('/api/wallet', optAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const wallet = getWallet(userId);
      const tx = listWalletTx(userId, 50);
      res.json({ ok: true, ...wallet, tx });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 钱包：模拟充值（演示模式，未接真实支付） */
  app.post('/api/wallet/recharge', optAuth, (req, res) => {
    try {
      const { userId, currency, amount } = req.body || {};
      if (!userId || !currency || !amount) return res.status(400).json({ error: 'userId/currency/amount 必填' });
      const cur = String(currency).toLowerCase();
      if (!['usd', 'cny'].includes(cur)) return res.status(400).json({ error: 'currency 只支持 usd / cny' });
      const amt = Math.round(Number(amount) * 100) / 100;
      if (!(amt > 0)) return res.status(400).json({ error: '金额必须大于 0' });
      const bal = addWalletBalance(userId, cur as 'usd' | 'cny', amt, '模拟充值（未接真实支付）');
      res.json({ ok: true, currency: cur, balance: bal, message: '模拟充值成功（演示模式，未产生真实扣款）' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 钱包：转账给他人 */
  app.post('/api/wallet/pay', optAuth, (req, res) => {
    try {
      const { fromUserId, toUserId, currency, amount, reason } = req.body || {};
      if (!fromUserId || !toUserId || !currency || !amount) return res.status(400).json({ error: 'fromUserId/toUserId/currency/amount 必填' });
      const cur = String(currency).toLowerCase();
      if (!['usd', 'cny'].includes(cur)) return res.status(400).json({ error: 'currency 只支持 usd / cny' });
      const amt = Math.round(Number(amount) * 100) / 100;
      if (!(amt > 0)) return res.status(400).json({ error: '金额必须大于 0' });
      const spend = spendWalletBalance(fromUserId, cur as 'usd' | 'cny', amt, reason || '转账给 ' + toUserId);
      if (!spend.ok) return res.status(400).json({ error: spend.error, balance: spend.balance });
      addWalletBalance(toUserId, cur as 'usd' | 'cny', amt, reason || '来自 ' + fromUserId + ' 的转账');
      res.json({ ok: true, currency: cur, amount: amt, message: '转账成功' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // v2.4.0: 冻结（发布商品/下单时调用）
  app.post('/api/wallet/freeze', optAuth, (req, res) => {
    try {
      const { userId, currency, amount, refType, refId, note } = req.body || {};
      if (!userId || !currency || !amount) return res.status(400).json({ error: 'userId/currency/amount 必填' });
      const cur = String(currency).toLowerCase();
      if (!['usd', 'cny'].includes(cur)) return res.status(400).json({ error: 'currency 只支持 usd / cny' });
      const amt = Number(amount);
      if (!amt || amt <= 0) return res.status(400).json({ error: '金额必须大于 0' });
      ensureWallet(userId);
      const w = getWallet(userId);
      const bal = cur === 'usd' ? w.balanceUsd : w.balanceCny;
      if (bal < amt) return res.status(400).json({ error: '可用余额不足，无法冻结' });
      // 冻结：从可用扣减，frozen 增加（用 spend + 专门字段）
      getDB().run(`UPDATE wallets SET balance_${cur} = balance_${cur} - ?, frozen_${cur} = frozen_${cur} + ?, updated_at = ? WHERE user_id = ?`, [amt, amt, Date.now(), userId]);
      const nw = getWallet(userId);
      const nb = cur === 'usd' ? nw.balanceUsd : nw.balanceCny;
      _walletTx(userId, cur, -amt, 'freeze', note || '冻结: ' + (refType || '') + (refId || ''), nb);
      res.json({ ok: true, wallet: nw, frozen: cur === 'usd' ? nw.frozenUsd : nw.frozenCny });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // v2.4.0: 解冻（取消订单/下架时退回冻结额）
  app.post('/api/wallet/unfreeze', optAuth, (req, res) => {
    try {
      const { userId, currency, amount, refType, refId, note } = req.body || {};
      if (!userId || !currency || !amount) return res.status(400).json({ error: 'userId/currency/amount 必填' });
      const cur = String(currency).toLowerCase();
      if (!['usd', 'cny'].includes(cur)) return res.status(400).json({ error: 'currency 只支持 usd / cny' });
      const amt = Number(amount);
      if (!amt || amt <= 0) return res.status(400).json({ error: '金额必须大于 0' });
      ensureWallet(userId);
      const w = getWallet(userId);
      const frozen = cur === 'usd' ? w.frozenUsd : w.frozenCny;
      if (frozen < amt) return res.status(400).json({ error: '冻结金额不足，无法解冻' });
      getDB().run(`UPDATE wallets SET balance_${cur} = balance_${cur} + ?, frozen_${cur} = frozen_${cur} - ?, updated_at = ? WHERE user_id = ?`, [amt, amt, Date.now(), userId]);
      const nw = getWallet(userId);
      const nb = cur === 'usd' ? nw.balanceUsd : nw.balanceCny;
      _walletTx(userId, cur, amt, 'unfreeze', note || '解冻: ' + (refType || '') + (refId || ''), nb);
      res.json({ ok: true, wallet: nw });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // v2.4.0: 结算（交易完成：买家冻结额→卖家可用，占位模式直接转账）
  app.post('/api/wallet/settle', optAuth, (req, res) => {
    try {
      const { buyerId, sellerId, currency, amount, refId, note } = req.body || {};
      if (!buyerId || !sellerId || !currency || !amount) return res.status(400).json({ error: 'buyerId/sellerId/currency/amount 必填' });
      const cur = String(currency).toLowerCase();
      if (!['usd', 'cny'].includes(cur)) return res.status(400).json({ error: 'currency 只支持 usd / cny' });
      const amt = Number(amount);
      if (!amt || amt <= 0) return res.status(400).json({ error: '金额必须大于 0' });
      // 买家解冻（若不足则直接从可用扣）
      ensureWallet(buyerId); ensureWallet(sellerId);
      const bw = getWallet(buyerId);
      const bFrozen = cur === 'usd' ? bw.frozenUsd : bw.frozenCny;
      if (bFrozen >= amt) {
        getDB().run(`UPDATE wallets SET balance_${cur} = balance_${cur} + ?, frozen_${cur} = frozen_${cur} - ?, updated_at = ? WHERE user_id = ?`, [amt, amt, Date.now(), buyerId]);
        const nb = cur === 'usd' ? getWallet(buyerId).balanceUsd : getWallet(buyerId).balanceCny;
        _walletTx(buyerId, cur, amt, 'unfreeze', note || '交易完成解冻: ' + (refId || ''), nb);
      } else {
        const spend = spendWalletBalance(buyerId, cur as 'usd' | 'cny', amt, note || '交易结算扣款: ' + (refId || ''));
        if (!spend.ok) return res.status(400).json({ error: spend.error, balance: spend.balance });
      }
      // 卖家入账（占位模式：100% 到账；真实模式接支付通道后按抽成规则）
      addWalletBalance(sellerId, cur as 'usd' | 'cny', amt, note || '交易结算收入: ' + (refId || ''));
      res.json({ ok: true, buyer: getWallet(buyerId), seller: getWallet(sellerId), placeholder: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 积分孤岛路由（原 L3539-3579，requireAuth + 管理员校验） ──

  app.post('/api/credits/deduct', requireAuth, (req, res) => {
    try {
      const { userId, amount, reason } = req.body || {};
      const amt = Number(amount);
      if (!userId || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'userId/amount 必填且 amount 必须为正数' });
      const now = Date.now();
      const stmt = getDB().prepare('UPDATE user_credits SET credits = credits - ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ? AND credits >= ?');
      stmt.bind([amt, amt, now, userId, amt]);
      stmt.step();
      const changes = getDB().getRowsModified();
      stmt.free();
      if (changes === 0) {
        const checkStmt = getDB().prepare('SELECT credits FROM user_credits WHERE user_id = ?');
        checkStmt.bind([userId]);
        const row = checkStmt.step() ? checkStmt.getAsObject() : null;
        checkStmt.free();
        return res.status(400).json({ error: '积分不足', current: row?.credits || 0 });
      }
      const balStmt = getDB().prepare('SELECT credits FROM user_credits WHERE user_id = ?');
      balStmt.bind([userId]);
      const balRow = balStmt.step() ? balStmt.getAsObject() : null;
      balStmt.free();
      res.json({ ok: true, balance: balRow?.credits || 0 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/credits/award', requireAuth, (req, res) => {
    // P1-3 修复: 积分发放仅管理员可用
    const roles = (req as any).user?.roles || [];
    if (!roles.includes('admin')) return res.status(403).json({ error: '仅管理员可发放积分' });
    try {
      const { userId, amount, reason } = req.body || {};
      const amt = Number(amount);
      if (!userId || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'userId/amount 必填且 amount 必须为正数' });
      const now = Date.now();
      const stmt = getDB().prepare(`INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(user_id) DO UPDATE SET credits = credits + ?, total_earned = total_earned + ?, updated_at = ?`);
      stmt.bind([userId, 1000 + amt, amt, now, amt, amt, now]);
      stmt.step(); stmt.free();
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}