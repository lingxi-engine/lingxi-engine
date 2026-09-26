/**
 * 灵犀 MVP 闭环 — 端到端集成测试
 *
 * 用真实 sql.js 内存库 + 真实 Express app，跑通完整业务闭环：
 *   注册 → 登录 → 当前用户 → 创建任务 → 浏览任务 → 提交报价 → 撤回报价
 *   → 接受报价 → 创建合同 → 确认合同 → 提交交付物 → 要求修改 → 重新交付
 *   → 验收 → 评价 → 发起争议 → 管理员处理争议 → 模拟结算 → 通知 → 审计日志
 *   智能体：创建 → 配置技能 → 设置预算 → 花费 → 生成任务建议
 *
 * 同时覆盖越权、状态机非法跳转、重复报价等安全用例。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import initSqlJs from 'sql.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MvpMarketService, MvpMarketError, canTransitionTask, canTransitionContract } from '../core/mvp-market/service.js';
import { MVP_MARKET_MIGRATION } from '../storage/migrations/mvp-market-schema.js';
import { createMvpMarketRoutes } from '../routes/mvp-market.js';

// ────────────────────── 测试基建：真实 sql.js 内存库 ──────────────────────

let db: any;
let svc: MvpMarketService;
let tmpDir: string;

beforeAll(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  MVP_MARKET_MIGRATION.up(db);
  svc = new MvpMarketService({ raw: db } as any);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-test-'));
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ────────────────────── 资金辅助（任务市场现在真实扣款，测试需要充值） ──────────────────────

/** 幂等创建资金表，与 service 的兜底保持一致 */
function fundEnsure(d: any): void {
  d.run(`CREATE TABLE IF NOT EXISTS user_credits (
    user_id TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 1000,
    total_earned INTEGER NOT NULL DEFAULT 0, total_spent INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0)`);
  d.run(`CREATE TABLE IF NOT EXISTS credit_log (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '', balance_after INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL)`);
  d.run(`CREATE TABLE IF NOT EXISTS wallets (
    user_id TEXT PRIMARY KEY, balance_usd REAL NOT NULL DEFAULT 0,
    balance_cny REAL NOT NULL DEFAULT 0, frozen_usd REAL NOT NULL DEFAULT 0,
    frozen_cny REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);
  d.run(`CREATE TABLE IF NOT EXISTS wallet_tx (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, currency TEXT NOT NULL,
    amount REAL NOT NULL, type TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
    balance_after REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
}

/** 给用户充值积分 */
function fundCredits(userId: string, amount: number): number {
  fundEnsure(db);
  const row: any = db.exec(`SELECT credits FROM user_credits WHERE user_id = '${userId}'`);
  if (!row.length) {
    db.run(`INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, ?, 0, 0, ?)`,
      [userId, amount, Date.now()]);
    return amount;
  }
  const next = Number(row[0].values[0][0]) + amount;
  db.run(`UPDATE user_credits SET credits = ?, updated_at = ? WHERE user_id = ?`, [next, Date.now(), userId]);
  return next;
}

/** 给用户充钱包余额（usd / cny） */
function fundWallet(userId: string, currency: string, amount: number): number {
  fundEnsure(db);
  const col = currency === 'cny' ? 'cny' : 'usd';
  const exists: any = db.exec(`SELECT 1 FROM wallets WHERE user_id = '${userId}'`);
  if (!exists.length) {
    db.run(`INSERT INTO wallets (user_id, balance_usd, balance_cny, frozen_usd, frozen_cny, updated_at) VALUES (?, 0, 0, 0, 0, ?)`,
      [userId, Date.now()]);
  }
  db.run(`UPDATE wallets SET balance_${col} = balance_${col} + ?, updated_at = ? WHERE user_id = ?`, [amount, Date.now(), userId]);
  const r: any = db.exec(`SELECT balance_${col} FROM wallets WHERE user_id = '${userId}'`);
  return Number(r[0].values[0][0]);
}

/** 查用户积分余额 */
function creditsOf(userId: string): number {
  fundEnsure(db);
  const r: any = db.exec(`SELECT credits FROM user_credits WHERE user_id = '${userId}'`);
  return r.length ? Number(r[0].values[0][0]) : 0;
}

/** 查用户钱包余额 */
function walletOf(userId: string, currency: string): number {
  fundEnsure(db);
  const col = currency === 'cny' ? 'cny' : 'usd';
  const r: any = db.exec(`SELECT balance_${col} FROM wallets WHERE user_id = '${userId}'`);
  return r.length ? Number(r[0].values[0][0]) : 0;
}

// ────────────────────── 状态机单元测试 ──────────────────────

describe('状态机 — 合法/非法迁移', () => {
  it('任务状态机：open → quoted 合法，completed → open 非法', () => {
    expect(canTransitionTask('open', 'quoted')).toBe(true);
    expect(canTransitionTask('open', 'cancelled')).toBe(true);
    expect(canTransitionTask('completed', 'open')).toBe(false);
    expect(canTransitionTask('completed', 'cancelled')).toBe(false);
    expect(canTransitionTask('open', 'in_progress')).toBe(false);
  });

  it('合同状态机：pending_confirm → active 合法，accepted → active 非法', () => {
    expect(canTransitionContract('pending_confirm', 'active')).toBe(true);
    expect(canTransitionContract('active', 'delivered')).toBe(true);
    expect(canTransitionContract('delivered', 'accepted')).toBe(true);
    expect(canTransitionContract('accepted', 'active')).toBe(false);
    expect(canTransitionContract('completed', 'disputed')).toBe(false);
  });
});

// ────────────────────── 完整业务闭环 ──────────────────────

describe('MVP 闭环 — 全链路', () => {
  const employer = 'user-employer-001';
  const contractor = 'user-contractor-001';
  const admin = 'admin-001';
  const outsider = 'user-outsider-001';

  let taskId: string;
  let quoteA: string;   // 将被撤回
  let quoteB: string;   // 将被接受
  let contractId: string;
  let delivery1: string;
  let delivery2: string;
  let disputeId: string;

  it('1. 雇主创建任务', () => {
    const t = svc.createTask({ employerId: employer, title: '开发一个落地页', description: '需要响应式', budget: 500, category: '前端' });
    taskId = t.id;
    expect(t.status).toBe('open');
    expect(t.budget).toBe(500);
    expect(svc.listTasks({ status: 'open' }).some((x) => x.id === taskId)).toBe(true);
  });

  it('2. 任务标题为空应拒绝', () => {
    expect(() => svc.createTask({ employerId: employer, title: '   ', budget: 10 })).toThrow(MvpMarketError);
  });

  it('3. 负预算应拒绝', () => {
    expect(() => svc.createTask({ employerId: employer, title: 'x', budget: -5 })).toThrow(MvpMarketError);
  });

  it('4. 服务方 A 提交报价', () => {
    const q = svc.submitQuote({ taskId, bidderId: 'user-bidder-a', amount: 480, message: '3天交付', deliveryDays: 3 });
    quoteA = q.id;
    expect(q.status).toBe('pending');
    expect(svc.getTask(taskId).status).toBe('quoted');
  });

  it('5. 服务方 B 提交报价', () => {
    const q = svc.submitQuote({ taskId, bidderId: contractor, amount: 520, message: '5天交付', deliveryDays: 5 });
    quoteB = q.id;
    expect(q.status).toBe('pending');
  });

  it('6. 雇主不能给自己的任务报价', () => {
    expect(() => svc.submitQuote({ taskId, bidderId: employer, amount: 100 })).toThrow(MvpMarketError);
  });

  it('7. 服务方 A 撤回报价', () => {
    const q = svc.withdrawQuote('user-bidder-a', quoteA);
    expect(q.status).toBe('withdrawn');
  });

  it('8. 已撤回的报价不能再次撤回', () => {
    expect(() => svc.withdrawQuote('user-bidder-a', quoteA)).toThrow(MvpMarketError);
  });

  it('9. 非报价人不能撤回他人报价', () => {
    expect(() => svc.withdrawQuote(outsider, quoteB)).toThrow(MvpMarketError);
  });

  it('10. 雇主接受报价 B → 自动创建合同', () => {
    const c = svc.acceptQuote(employer, quoteB, '按里程碑付款');
    contractId = c.id;
    expect(c.status).toBe('pending_confirm');
    expect(c.amount).toBe(520);
    expect(c.contractor_id).toBe(contractor);
    expect(svc.getTask(taskId).status).toBe('contracted');
    expect(svc.getQuote(quoteB).status).toBe('accepted');
  });

  it('11. 非雇主不能接受报价', () => {
    // 重新造一个任务+报价来验证越权
    const t2 = svc.createTask({ employerId: employer, title: '另一个任务', budget: 100 });
    const q2 = svc.submitQuote({ taskId: t2.id, bidderId: contractor, amount: 90 });
    expect(() => svc.acceptQuote(outsider, q2.id)).toThrow(MvpMarketError);
  });

  it('12. 承包方确认合同', () => {
    const c = svc.confirmContract(contractor, contractId);
    expect(c.status).toBe('active');
    expect(c.confirmed_at).toBeGreaterThan(0);
    expect(svc.getTask(taskId).status).toBe('in_progress');
  });

  it('13. 非承包方不能确认合同', () => {
    expect(() => svc.confirmContract(outsider, contractId)).toThrow(MvpMarketError);
  });

  it('14. 承包方提交第 1 轮交付物', () => {
    const d = svc.submitDelivery({ contractId, submitterId: contractor, content: '第一版落地页，含 hero 区块' });
    delivery1 = d.id;
    expect(d.status).toBe('submitted');
    expect(d.round).toBe(1);
    expect(svc.getContract(contractId).status).toBe('delivered');
  });

  it('15. 非承包方不能提交交付物', () => {
    expect(() => svc.submitDelivery({ contractId, submitterId: employer, content: 'hack' })).toThrow(MvpMarketError);
  });

  it('16. 空交付内容应拒绝', () => {
    expect(() => svc.submitDelivery({ contractId, submitterId: contractor, content: '   ' })).toThrow(MvpMarketError);
  });

  it('17. 雇主要求修改（退回）', () => {
    const d = svc.requestRevision(employer, delivery1, 'hero 区块需要加 CTA 按钮');
    expect(d.status).toBe('revision_requested');
    expect(d.review_note).toContain('CTA');
    expect(svc.getContract(contractId).status).toBe('active');
  });

  it('18. 要求修改必须填意见', () => {
    expect(() => svc.requestRevision(employer, delivery1, '  ')).toThrow(MvpMarketError);
  });

  it('19. 承包方提交第 2 轮交付物', () => {
    const d = svc.submitDelivery({ contractId, submitterId: contractor, content: '第二版：已加 CTA 按钮' });
    delivery2 = d.id;
    expect(d.round).toBe(2);
    expect(svc.getContract(contractId).status).toBe('delivered');
  });

  it('20. 雇主验收第 2 轮交付物 → 生成模拟结算', () => {
    const r = svc.acceptDelivery(employer, delivery2);
    expect(r.delivery.status).toBe('accepted');
    expect(r.contract.status).toBe('accepted');
    expect(r.settlement.kind).toBe('release');
    expect(r.settlement.amount).toBe(520);
    expect(r.settlement.status).toBe('simulated');
    expect(svc.getTask(taskId).status).toBe('completed');
  });

  it('21. 同一交付物不能重复验收', () => {
    expect(() => svc.acceptDelivery(employer, delivery2)).toThrow(MvpMarketError);
  });

  it('22. 雇主评价合同', () => {
    const r = svc.rateContract(employer, contractId, 5, '很专业');
    expect(r.rating).toBe(5);
    expect(svc.listRatingsForUser(contractor).length).toBe(1);
  });

  it('23. 评分必须是 1-5 整数', () => {
    const t3 = svc.createTask({ employerId: employer, title: '评价边界任务', budget: 10 });
    const q3 = svc.submitQuote({ taskId: t3.id, bidderId: contractor, amount: 10 });
    const c3 = svc.acceptQuote(employer, q3.id);
    svc.confirmContract(contractor, c3.id);
    const d3 = svc.submitDelivery({ contractId: c3.id, submitterId: contractor, content: 'x' });
    svc.acceptDelivery(employer, d3.id);
    expect(() => svc.rateContract(employer, c3.id, 6)).toThrow(MvpMarketError);
    expect(() => svc.rateContract(employer, c3.id, 0)).toThrow(MvpMarketError);
  });

  it('24. 同一合同不能重复评价', () => {
    expect(() => svc.rateContract(employer, contractId, 4)).toThrow(MvpMarketError);
  });

  it('25. 非合同双方不能查看/操作（越权）', () => {
    expect(() => svc.confirmContract(outsider, contractId)).toThrow(MvpMarketError);
  });
});

// ────────────────────── 争议闭环（独立合同，避免与上面冲突） ──────────────────────

describe('MVP 闭环 — 争议与管理员处理', () => {
  const employer = 'user-emp-disp';
  const contractor = 'user-con-disp';
  const admin = 'admin-disp';
  let contractId: string;
  let deliveryId: string;

  // 争议块 · 雇主充值（任务市场现在真实扣预算，测试需有足够余额）
  beforeAll(() => {
    fundCredits(employer, 100000);
    fundCredits(contractor, 100000);
  });

  it('准备：走完合同+交付', () => {
    const t = svc.createTask({ employerId: employer, title: '争议测试任务', budget: 1000 });
    const q = svc.submitQuote({ taskId: t.id, bidderId: contractor, amount: 900 });
    const c = svc.acceptQuote(employer, q.id);
    contractId = c.id;
    svc.confirmContract(contractor, contractId);
    const d = svc.submitDelivery({ contractId, submitterId: contractor, content: '交付内容不合格' });
    deliveryId = d.id;
    expect(d.status).toBe('submitted');
  });

  it('发起争议', () => {
    const d = svc.openDispute({ contractId, initiatorId: employer, reason: '交付物与需求不符', evidence: '截图', deliveryId });
    expect(d.status).toBe('open');
    expect(svc.getContract(contractId).status).toBe('disputed');
  });

  it('争议原因不能为空', () => {
    expect(() => svc.openDispute({ contractId, initiatorId: employer, reason: '' })).toThrow(MvpMarketError);
  });

  it('非合同双方不能发起争议', () => {
    const t2 = svc.createTask({ employerId: employer, title: '另一个争议任务', budget: 100 });
    const q2 = svc.submitQuote({ taskId: t2.id, bidderId: contractor, amount: 90 });
    const c2 = svc.acceptQuote(employer, q2.id);
    svc.confirmContract(contractor, c2.id);
    svc.submitDelivery({ contractId: c2.id, submitterId: contractor, content: 'x' });
    expect(() => svc.openDispute({ contractId: c2.id, initiatorId: 'stranger', reason: 'x' })).toThrow(MvpMarketError);
  });

  it('管理员处理争议：release 全额给承包方', () => {
    const r = svc.resolveDispute({ adminId: admin, disputeId: svc.listDisputes({ contractId })[0].id, decision: 'release', resolution: '经审核承包方交付合格' });
    expect(r.dispute.status).toBe('resolved');
    expect(r.dispute.resolver_id).toBe(admin);
    expect(r.contract.status).toBe('completed');
    expect(r.settlement.kind).toBe('release');
    expect(r.settlement.amount).toBe(900);
  });

  it('已处理的争议不能重复处理', () => {
    const d = svc.listDisputes({ contractId })[0];
    expect(() => svc.resolveDispute({ adminId: admin, disputeId: d.id, decision: 'refund', resolution: 'x' })).toThrow(MvpMarketError);
  });

  it('部分退款金额必须落在 (0, 合同金额)', () => {
    const t = svc.createTask({ employerId: employer, title: '部分退款任务', budget: 500 });
    const q = svc.submitQuote({ taskId: t.id, bidderId: contractor, amount: 400 });
    const c = svc.acceptQuote(employer, q.id);
    svc.confirmContract(contractor, c.id);
    const d = svc.submitDelivery({ contractId: c.id, submitterId: contractor, content: 'x' });
    const disp = svc.openDispute({ contractId: c.id, initiatorId: employer, reason: '部分问题', deliveryId: d.id });
    expect(() => svc.resolveDispute({ adminId: admin, disputeId: disp.id, decision: 'partial', resolution: 'x', refundAmount: 0 })).toThrow(MvpMarketError);
    expect(() => svc.resolveDispute({ adminId: admin, disputeId: disp.id, decision: 'partial', resolution: 'x', refundAmount: 400 })).toThrow(MvpMarketError);
    const ok = svc.resolveDispute({ adminId: admin, disputeId: disp.id, decision: 'partial', resolution: '各让一步', refundAmount: 150 });
    expect(ok.settlement.kind).toBe('partial_refund');
    expect(ok.settlement.amount).toBe(250);
    expect(ok.dispute.refund_amount).toBe(150);
  });

  it('refund 全额退雇主，合同取消', () => {
    const t = svc.createTask({ employerId: employer, title: '全额退款任务', budget: 300 });
    const q = svc.submitQuote({ taskId: t.id, bidderId: contractor, amount: 280 });
    const c = svc.acceptQuote(employer, q.id);
    svc.confirmContract(contractor, c.id);
    svc.submitDelivery({ contractId: c.id, submitterId: contractor, content: 'x' });
    const disp = svc.openDispute({ contractId: c.id, initiatorId: employer, reason: '完全不符' });
    const r = svc.resolveDispute({ adminId: admin, disputeId: disp.id, decision: 'refund', resolution: '退款结案' });
    expect(r.contract.status).toBe('cancelled');
    expect(r.settlement.payee_id).toBe(employer);
    expect(r.settlement.amount).toBe(280);
    expect(svc.getTask(t.id).status).toBe('cancelled');
  });
});

// ────────────────────── 通知 / 审计 ──────────────────────

describe('通知与审计日志', () => {
  const employer = 'user-emp-notif';
  const contractor = 'user-con-notif';

  it('全链路会产生通知', () => {
    const t = svc.createTask({ employerId: employer, title: '通知测试任务', budget: 100 });
    const q = svc.submitQuote({ taskId: t.id, bidderId: contractor, amount: 90 });
    // 雇主应收到「收到新报价」
    const empNotifs = svc.listNotifications(employer);
    expect(empNotifs.some((n) => n.type === 'quote.new')).toBe(true);
    // 承包方应收到「报价被接受」
    const c = svc.acceptQuote(employer, q.id);
    expect(svc.listNotifications(contractor).some((n) => n.type === 'contract.created')).toBe(true);
    svc.confirmContract(contractor, c.id);
    const d = svc.submitDelivery({ contractId: c.id, submitterId: contractor, content: 'x' });
    expect(svc.listNotifications(employer).some((n) => n.type === 'delivery.new')).toBe(true);
    svc.acceptDelivery(employer, d.id);
    expect(svc.listNotifications(contractor).some((n) => n.type === 'delivery.accepted')).toBe(true);
  });

  it('未读数与已读标记', () => {
    const before = svc.unreadCount(employer);
    expect(before).toBeGreaterThan(0);
    const first = svc.listNotifications(employer)[0];
    svc.markNotificationRead(employer, first.id);
    expect(svc.unreadCount(employer)).toBe(before - 1);
    svc.markAllNotificationsRead(employer);
    expect(svc.unreadCount(employer)).toBe(0);
  });

  it('不能标记他人通知为已读', () => {
    const n = svc.listNotifications(contractor)[0];
    expect(() => svc.markNotificationRead(employer, n.id)).toThrow(MvpMarketError);
  });

  it('审计日志覆盖所有关键动作', () => {
    const logs = svc.listAuditLogs({ actorId: employer, limit: 500 });
    const actions = new Set(logs.map((l) => l.action));
    expect(actions.has('task.create')).toBe(true);
    expect(actions.has('quote.accept')).toBe(true);
    expect(actions.has('delivery.accept')).toBe(true);
    expect(actions.has('contract.confirm')).toBe(false); // confirm 的 actor 是承包方
  });

  it('审计日志覆盖评价动作（actor 为雇主）', () => {
    const logs = svc.listAuditLogs({ actorId: 'user-employer-001', limit: 500 });
    const actions = new Set(logs.map((l) => l.action));
    expect(actions.has('contract.rate')).toBe(true);
    expect(actions.has('delivery.request_revision')).toBe(true);
  });

  it('审计日志可按实体查询', () => {
    const t = svc.createTask({ employerId: employer, title: '审计实体查询', budget: 1 });
    const logs = svc.listAuditLogs({ entityType: 'task', entityId: t.id });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].entity_id).toBe(t.id);
  });
});

// ────────────────────── 智能体：预算 + 任务建议 ──────────────────────

describe('智能体 — 预算与任务建议', () => {
  const owner = 'user-agent-owner';
  const agentId = 'agent-001';

  it('设置预算', () => {
    const b = svc.setAgentBudget({ agentId, ownerId: owner, totalBudget: 1000, period: 'monthly' });
    expect(b.total_budget).toBe(1000);
    expect(b.spent).toBe(0);
  });

  it('更新预算（同 owner）', () => {
    const b = svc.setAgentBudget({ agentId, ownerId: owner, totalBudget: 2000 });
    expect(b.total_budget).toBe(2000);
  });

  it('他人不能修改智能体预算', () => {
    expect(() => svc.setAgentBudget({ agentId, ownerId: 'other-user', totalBudget: 999 })).toThrow(MvpMarketError);
  });

  it('非法预算周期应拒绝', () => {
    expect(() => svc.setAgentBudget({ agentId, ownerId: owner, totalBudget: 100, period: 'yearly' })).toThrow(MvpMarketError);
  });

  it('花费记账 + 超预算拒绝', () => {
    const b1 = svc.spendAgentBudget({ agentId, ownerId: owner, amount: 500, reason: '调用模型' });
    expect(b1.spent).toBe(500);
    expect(() => svc.spendAgentBudget({ agentId, ownerId: owner, amount: 1600, reason: '超额' })).toThrow(MvpMarketError);
    const b2 = svc.spendAgentBudget({ agentId, ownerId: owner, amount: 1500, reason: '刚好到顶' });
    expect(b2.spent).toBe(2000);
  });

  it('未设置预算时花费应拒绝', () => {
    expect(() => svc.spendAgentBudget({ agentId: 'no-budget-agent', ownerId: owner, amount: 10, reason: 'x' })).toThrow(MvpMarketError);
  });

  it('生成任务建议：按技能匹配开放任务', () => {
    // 造两个开放任务，一个匹配技能一个不匹配
    svc.createTask({ employerId: 'emp-x', title: 'React 前端开发', description: '需要 react 经验', budget: 800, category: '前端' });
    svc.createTask({ employerId: 'emp-y', title: 'Python 数据爬虫', description: 'scrapy', budget: 600, category: '后端' });
    const sugg = svc.generateTaskSuggestions({ agentId, ownerId: owner, skills: ['react', '前端'] });
    expect(sugg.length).toBeGreaterThan(0);
    expect(sugg[0].title).toContain('React');
    const saved = svc.listTaskSuggestions(agentId, owner);
    expect(saved.length).toBe(sugg.length);
  });

  it('无技能时不产生建议', () => {
    const sugg = svc.generateTaskSuggestions({ agentId: 'agent-no-skill', ownerId: owner, skills: [] });
    expect(sugg.length).toBe(0);
  });
});

// ────────────────────── HTTP 层：鉴权与越权 ──────────────────────

describe('HTTP 层 — 鉴权强制与身份伪造防护', () => {
  let app: any;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // 模拟已登录用户：从 header 注入 user（等价于 jwtAuth 的行为）
    app.use((req: any, _res: any, next: any) => {
      const h = req.headers['x-test-user'];
      if (h) {
        req.user = { sub: String(h), roles: String(req.headers['x-test-roles'] ?? '').split(',').filter(Boolean) };
      }
      next();
    });
    const requireAuth = (req: any, res: any, next: any) => (req.user ? next() : res.status(401).json({ ok: false, error: { code: 'unauthorized' } }));
    const optAuth = (req: any, _res: any, next: any) => next();
    const adminAuth = (req: any, res: any, next: any) =>
      (req.user?.roles?.includes('admin') ? next() : res.status(403).json({ ok: false, error: { code: 'forbidden' } }));
    app.use('/api/mvp', createMvpMarketRoutes({ db, requireAuth, optAuth, adminAuth } as any));
  });

  it('未登录创建任务 → 401', async () => {
    const r = await request(app).post('/api/mvp/tasks').send({ title: 'x', budget: 1 });
    expect(r.status).toBe(401);
  });

  it('登录后可创建任务', async () => {
    const r = await request(app).post('/api/mvp/tasks')
      .set('x-test-user', 'http-employer')
      .send({ title: 'HTTP 测试任务', budget: 200 });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
  });

  it('身份伪造无效：body.userId 被忽略，身份取自 token', async () => {
    // 尝试用别人的身份创建任务 —— 应归属于 token 中的用户
    const r = await request(app).post('/api/mvp/tasks')
      .set('x-test-user', 'real-user')
      .send({ title: '伪造测试', budget: 10, userId: 'victim-user' });
    expect(r.status).toBe(201);
    expect(r.body.task.employer_id).toBe('real-user');
  });

  it('浏览任务无需登录', async () => {
    const r = await request(app).get('/api/mvp/tasks');
    expect(r.status).toBe(200);
  });

  it('非任务发布者看不到他人报价金额', async () => {
    const t = svc.createTask({ employerId: 'http-owner', title: '报价可见性', budget: 100 });
    svc.submitQuote({ taskId: t.id, bidderId: 'http-bidder', amount: 77 });
    const r = await request(app).get(`/api/mvp/tasks/${t.id}`).set('x-test-user', 'stranger');
    expect(r.status).toBe(200);
    expect(r.body.quotes[0].amount).toBeUndefined();
    const owner = await request(app).get(`/api/mvp/tasks/${t.id}`).set('x-test-user', 'http-owner');
    expect(owner.body.quotes[0].amount).toBe(77);
  });

  it('非管理员处理争议 → 403', async () => {
    const t = svc.createTask({ employerId: 'http-emp2', title: '越权争议', budget: 100 });
    const q = svc.submitQuote({ taskId: t.id, bidderId: 'http-con2', amount: 90 });
    const c = svc.acceptQuote('http-emp2', q.id);
    svc.confirmContract('http-con2', c.id);
    svc.submitDelivery({ contractId: c.id, submitterId: 'http-con2', content: 'x' });
    const disp = svc.openDispute({ contractId: c.id, initiatorId: 'http-emp2', reason: 'r' });
    const r = await request(app).post(`/api/mvp/disputes/${disp.id}/resolve`)
      .set('x-test-user', 'http-emp2')
      .send({ decision: 'release', resolution: 'x' });
    expect(r.status).toBe(403);
    const ok = await request(app).post(`/api/mvp/disputes/${disp.id}/resolve`)
      .set('x-test-user', 'http-admin')
      .set('x-test-roles', 'admin')
      .send({ decision: 'release', resolution: '审核通过' });
    expect(ok.status).toBe(200);
  });

  it('管理员可查看全部争议，普通用户只能看自己的', async () => {
    const asAdmin = await request(app).get('/api/mvp/disputes').set('x-test-user', 'a').set('x-test-roles', 'admin');
    expect(asAdmin.status).toBe(200);
    const asUser = await request(app).get('/api/mvp/disputes').set('x-test-user', 'nobody-related');
    expect(asUser.status).toBe(200);
    expect(asUser.body.disputes.length).toBe(0);
  });

  it('结算记录只能看自己的', async () => {
    const mine = await request(app).get('/api/mvp/settlements').set('x-test-user', 'http-emp2');
    expect(mine.status).toBe(200);
    expect(mine.body.settlements.every((s: any) => s.payer_id === 'http-emp2' || s.payee_id === 'http-emp2')).toBe(true);
  });

  it('审计日志只能看自己的', async () => {
    const mine = await request(app).get('/api/mvp/audit-logs').set('x-test-user', 'http-emp2');
    expect(mine.status).toBe(200);
    expect(mine.body.logs.every((l: any) => l.actor_id === 'http-emp2')).toBe(true);
  });

  it('智能体预算越权查看 → 403', async () => {
    svc.setAgentBudget({ agentId: 'http-agent', ownerId: 'http-owner-a', totalBudget: 100 });
    const r = await request(app).get('/api/mvp/agents/http-agent/budget').set('x-test-user', 'http-owner-b');
    expect(r.status).toBe(403);
  });
});

// ────────────────────── 资金真实闭环（验证钱包/积分真的动） ──────────────────────

describe('资金真实闭环 — 积分/钱包实际增减', () => {
  const emp = 'user-emp-money';
  const con = 'user-con-money';

  beforeAll(() => {
    fundCredits(emp, 100000);
    fundCredits(con, 100000);
  });

  it('积分：下任务扣预算，验收后承包方收到 90%', () => {
    const empBefore = creditsOf(emp);
    const conBefore = creditsOf(con);

    const t = svc.createTask({ employerId: emp, title: '资金闭环任务', budget: 1000 });
    // 预算被扣留
    expect(creditsOf(emp)).toBe(empBefore - 1000);

    const q = svc.submitQuote({ taskId: t.id, bidderId: con, amount: 800 });
    const c = svc.acceptQuote(emp, q.id);
    svc.confirmContract(con, c.id);
    const d = svc.submitDelivery({ contractId: c.id, submitterId: con, content: 'ok' });
    svc.acceptDelivery(emp, d.id);

    // 承包方拿到 800 * 0.9 = 720
    expect(creditsOf(con)).toBe(conBefore + 720);
    // 雇主：扣预算 1000，成交时退回差额 200，净扣 800（无二次扣款）
    expect(creditsOf(emp)).toBe(empBefore - 800);
  });

  it('积分：取消任务全额退回预算', () => {
    const before = creditsOf(emp);
    const t = svc.createTask({ employerId: emp, title: '待取消任务', budget: 600 });
    expect(creditsOf(emp)).toBe(before - 600);
    svc.cancelTask(emp, t.id);
    expect(creditsOf(emp)).toBe(before);
  });

  it('积分：余额不足时拒绝创建任务，不产生负余额', () => {
    // 造一个只有 10 积分的账号
    db.run(`DELETE FROM user_credits WHERE user_id = 'user-broke'`);
    db.run(`INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at)
      VALUES ('user-broke', 10, 0, 0, 0)`);
    expect(() => svc.createTask({ employerId: 'user-broke', title: '没钱任务', budget: 5000 }))
      .toThrow(MvpMarketError);
    // 扣款失败不得留下负余额
    expect(creditsOf('user-broke')).toBe(10);
  });

  it('钱包 usd：扣预算 → 验收分账 90%', () => {
    const emp = 'user-emp-usd';
    const con = 'user-con-usd';
    fundWallet(emp, 'usd', 10000);
    const conBefore = walletOf(con, 'usd');

    const t = svc.createTask({ employerId: emp, title: 'USD 任务', budget: 200, currency: 'usd' });
    expect(walletOf(emp, 'usd')).toBe(9800);

    const q = svc.submitQuote({ taskId: t.id, bidderId: con, amount: 150 });
    const c = svc.acceptQuote(emp, q.id);
    svc.confirmContract(con, c.id);
    const d = svc.submitDelivery({ contractId: c.id, submitterId: con, content: 'ok' });
    svc.acceptDelivery(emp, d.id);

    // 150 * 0.9 = 135
    expect(walletOf(con, 'usd')).toBe(conBefore + 135);
    // 雇主：扣预算 200，成交退回差额 50，净扣 150（无二次扣款）
    expect(walletOf(emp, 'usd')).toBe(9850);
  });

  it('争议 release：全额付承包方 90%', () => {
    const emp = 'user-emp-rel';
    const con = 'user-con-rel';
    fundCredits(emp, 100000);
    fundCredits(con, 100000);
    const conBefore = creditsOf(con);

    const t = svc.createTask({ employerId: emp, title: '争议 release', budget: 1000 });
    const q = svc.submitQuote({ taskId: t.id, bidderId: con, amount: 900 });
    const c = svc.acceptQuote(emp, q.id);
    svc.confirmContract(con, c.id);
    const d = svc.submitDelivery({ contractId: c.id, submitterId: con, content: 'x' });
    const disp = svc.openDispute({ contractId: c.id, initiatorId: emp, reason: '有争议', deliveryId: d.id });
    svc.resolveDispute({ adminId: 'admin-x', disputeId: disp.id, decision: 'release', resolution: '承包方合格' });

    expect(creditsOf(con)).toBe(conBefore + 810);
  });

  it('争议 refund：全额退回雇主', () => {
    const emp = 'user-emp-ref';
    const con = 'user-con-ref';
    fundCredits(emp, 100000);
    fundCredits(con, 100000);
    const empBefore = creditsOf(emp);

    const t = svc.createTask({ employerId: emp, title: '争议 refund', budget: 1000 });
    const q = svc.submitQuote({ taskId: t.id, bidderId: con, amount: 900 });
    const c = svc.acceptQuote(emp, q.id);
    svc.confirmContract(con, c.id);
    const d = svc.submitDelivery({ contractId: c.id, submitterId: con, content: 'x' });
    const disp = svc.openDispute({ contractId: c.id, initiatorId: emp, reason: '完全不符' });
    svc.resolveDispute({ adminId: 'admin-x', disputeId: disp.id, decision: 'refund', resolution: '全退' });

    expect(creditsOf(emp)).toBe(empBefore);
  });

  it('争议 partial：部分退雇主，剩余 90% 付承包方', () => {
    const emp = 'user-emp-par';
    const con = 'user-con-par';
    fundCredits(emp, 100000);
    fundCredits(con, 100000);
    const empBefore = creditsOf(emp);
    const conBefore = creditsOf(con);

    const t = svc.createTask({ employerId: emp, title: '争议 partial', budget: 1000 });
    const q = svc.submitQuote({ taskId: t.id, bidderId: con, amount: 900 });
    const c = svc.acceptQuote(emp, q.id);
    svc.confirmContract(con, c.id);
    const d = svc.submitDelivery({ contractId: c.id, submitterId: con, content: 'x' });
    const disp = svc.openDispute({ contractId: c.id, initiatorId: emp, reason: '部分问题' });
    svc.resolveDispute({ adminId: 'admin-x', disputeId: disp.id, decision: 'partial', resolution: '各让一步', refundAmount: 150 });

    // 雇主：扣预算 1000，成交退差额 100，争议再退 150 → 净扣 750
    expect(creditsOf(emp)).toBe(empBefore - 750);
    // 承包方拿 (900-150)*0.9 = 675
    expect(creditsOf(con)).toBe(conBefore + 675);
  });
});

describe('资金守恒 — 全场景总额不凭空增减', () => {
  const uids = ['emp-g', 'con-g'];

  function total(): number {
    fundEnsure(db);
    let sum = 0;
    for (const u of uids) sum += creditsOf(u);
    return sum;
  }

  // 守恒测试 · 重置两个账号并各充 10000 积分
  beforeAll(() => {
    fundEnsure(db);
    for (const u of uids) {
      db.run(`DELETE FROM user_credits WHERE user_id = '${u}'`);
      db.run(`INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at)
        VALUES ('${u}', 10000, 0, 0, 0)`);
    }
  });

  it('成交额 < 预算 时，只有平台抽成被扣除，雇主拿回差额', () => {
    const before = total();
    const t = svc.createTask({ employerId: 'emp-g', title: '守恒任务', budget: 1000 });
    svc.submitQuote({ taskId: t.id, bidderId: 'con-g', amount: 800 });
    expect(total()).toBe(before - 1000); // 下任务全扣

    const q = svc.listQuotesByTask(t.id)[0];
    const c = svc.acceptQuote('emp-g', q.id);
    // 退差额 200 → 总额 -800
    expect(total()).toBe(before - 800);
    svc.confirmContract('con-g', c.id);
    const d = svc.submitDelivery({ contractId: c.id, submitterId: 'con-g', content: 'ok' });
    svc.acceptDelivery('emp-g', d.id);
    // 结算 800：付 720 给承包方，平台抽 80
    expect(total()).toBe(before - 800 + 720);
  });

  it('取消任务：总额完全回到原样（零抽成）', () => {
    const before = total();
    const t = svc.createTask({ employerId: 'emp-g', title: '守恒取消', budget: 700 });
    expect(total()).toBe(before - 700);
    svc.cancelTask('emp-g', t.id);
    expect(total()).toBe(before);
  });
});
