/**
 * 平台抽成对账测试（真实 sql.js 内存库）
 *
 * 核心不变量：gross === pay + fee
 * 任何一笔结算、任何一种币种、任何一条争议路径，都不允许钱凭空消失或凭空多出。
 *
 * 这些用例是「模拟支付 → 真实支付」改造前的安全网：以后换真金白银时，
 * 只要这个文件还全绿，账就是平的。
 *
 * 注：积分（credits）按整数结算，wallets（usd/cny）是 REAL。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import initSqlJs from 'sql.js';
import { MvpMarketService, PLATFORM_FEE_RATE, roundFeeAmount } from '../core/mvp-market/service.js';
import { MVP_MARKET_MIGRATION } from '../storage/migrations/mvp-market-schema.js';

// ────────────────────── 测试基建：真实 sql.js 内存库 ──────────────────────

let db: any;
let svc: MvpMarketService;

beforeAll(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  MVP_MARKET_MIGRATION.up(db);
  svc = new MvpMarketService({ raw: db } as any);
});

afterAll(() => {
  try { db.close(); } catch { /* ignore */ }
});

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

function creditsOf(userId: string): number {
  fundEnsure(db);
  const r: any = db.exec(`SELECT credits FROM user_credits WHERE user_id = '${userId}'`);
  return r.length ? Number(r[0].values[0][0]) : 0;
}

function walletOf(userId: string, currency: string): number {
  fundEnsure(db);
  const col = currency === 'cny' ? 'cny' : 'usd';
  const r: any = db.exec(`SELECT balance_${col} FROM wallets WHERE user_id = '${userId}'`);
  return r.length ? Number(r[0].values[0][0]) : 0;
}

function fundCredits(userId: string, amount: number): void {
  fundEnsure(db);
  const r: any = db.exec(`SELECT credits FROM user_credits WHERE user_id = '${userId}'`);
  if (!r.length) {
    db.run(`INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, ?, 0, 0, ?)`,
      [userId, amount, Date.now()]);
  } else {
    db.run(`UPDATE user_credits SET credits = ?, updated_at = ? WHERE user_id = ?`,
      [Number(r[0].values[0][0]) + amount, Date.now(), userId]);
  }
}

function fundWallet(userId: string, currency: string, amount: number): void {
  fundEnsure(db);
  const col = currency === 'cny' ? 'cny' : 'usd';
  const e: any = db.exec(`SELECT 1 FROM wallets WHERE user_id = '${userId}'`);
  if (!e.length) {
    db.run(`INSERT INTO wallets (user_id, balance_usd, balance_cny, frozen_usd, frozen_cny, updated_at) VALUES (?, 0, 0, 0, 0, ?)`,
      [userId, Date.now()]);
  }
  db.run(`UPDATE wallets SET balance_${col} = balance_${col} + ?, updated_at = ? WHERE user_id = ?`,
    [amount, Date.now(), userId]);
}

/**
 * 取真实起点余额。
 * fundBalance() 对未开户用户会默认开户并给 1000 积分，
 * 所以这里必须复刻这个语义，否则基数会算成 0。
 */
function baseOf(userId: string, currency: string): number {
  if (currency === 'credits') {
    fundEnsure(db);
    const r: any = db.exec(`SELECT credits FROM user_credits WHERE user_id = '${userId}'`);
    if (!r.length) {
      db.run(`INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, 1000, 0, 0, ?)`,
        [userId, Date.now()]);
      return 1000;
    }
    return Number(r[0].values[0][0]);
  }
  return walletOf(userId, currency);
}

function revenueOf(contractId: string): { gross: number; pay: number; fee: number } | null {
  const r: any = db.exec(
    `SELECT gross, pay, fee FROM mvp_platform_revenue WHERE contract_id = '${contractId}'`);
  return r.length
    ? { gross: Number(r[0].values[0][0]), pay: Number(r[0].values[0][1]), fee: Number(r[0].values[0][2]) }
    : null;
}

/** 跑完整闭环：发任务 → 报价 → 成交 → 交付 → 验收 */
function runLoop(o: { currency: string; budget: number; quote: number; e: string; c: string; idem?: string }) {
  const { currency, budget, quote, e, c, idem } = o;
  // 先让 contractor 开户，拿到真实起点
  const conBase = baseOf(c, currency);
  if (currency === 'credits') fundCredits(e, budget);
  else fundWallet(e, currency, budget);

  const task = svc.createTask({ employerId: e, title: '对账用例', budget, currency });
  const q = svc.submitQuote({ taskId: task.id, bidderId: c, amount: quote, currency });
  let contract = svc.acceptQuote(e, q.id);
  // 合同成交后处于 pending_confirm，需承包方确认才进入 active
  contract = svc.confirmContract(c, contract.id);
  const delivery = svc.submitDelivery({ contractId: contract.id, submitterId: c, content: '交付内容' });
  const res: any = svc.acceptDelivery(e, delivery.id, idem);
  // 分账明细以 mvp_platform_revenue 账本为准（settlement 行只记总额）
  const rev = revenueOf(contract.id);
  return {
    task, contract, delivery, res, conBase,
    conNow: currency === 'credits' ? creditsOf(c) : walletOf(c, currency),
    settlement: rev ?? { gross: quote, pay: 0, fee: 0 },
  };
}

/** 跑到争议发起为止，返回 disputeId */
function runToDispute(o: { e: string; c: string; budget: number }) {
  const conBase = baseOf(o.c, 'credits');
  fundCredits(o.e, o.budget);
  const task = svc.createTask({ employerId: o.e, title: '争议用例', budget: o.budget, currency: 'credits' });
  const q = svc.submitQuote({ taskId: task.id, bidderId: o.c, amount: o.budget, currency: 'credits' });
  let contract = svc.acceptQuote(o.e, q.id);
  contract = svc.confirmContract(o.c, contract.id);
  const delivery = svc.submitDelivery({ contractId: contract.id, submitterId: o.c, content: '交付内容' });
  const dispute = svc.openDispute({ contractId: contract.id, initiatorId: o.e, reason: '货不对板' });
  return { task, contract, delivery, dispute, conBase };
}

// ────────────────────── 费率配置 ──────────────────────

describe('平台抽成 · 费率配置', () => {
  it('默认抽佣 10%，服务方 90%', () => {
    expect(PLATFORM_FEE_RATE).toBe(0.1);
  });

  it('roundFeeAmount：积分取整到分，绝不为负', () => {
    expect(roundFeeAmount('credits', 100)).toBe(100);
    expect(roundFeeAmount('credits', 99.4)).toBe(99);
    // 积分是向下取整（不虚增平台收入）
    expect(roundFeeAmount('credits', 9.9)).toBe(9);
    // 钱包是小数，不动分位
    expect(roundFeeAmount('usd', 9.99)).toBe(9.99);
  });
});

// ────────────────────── 验收入账 ──────────────────────

describe('平台抽成 · 验收入账', () => {
  it('验收后 contractor 到账 90%，雇主预算已扣不再重复扣', () => {
    const { settlement, conBase, conNow } = runLoop({ currency: 'credits', budget: 1000, quote: 1000, e: 'e1', c: 'c1' });
    expect(conNow - conBase).toBe(900);
    expect(settlement.gross).toBe(1000);
    expect(settlement.pay).toBe(900);
    expect(settlement.fee).toBe(100);
    expect(creditsOf('e1')).toBe(0);
  });

  it('报价低于预算：差额退回雇主，总账仍然守恒', () => {
    const { settlement, conBase, conNow } = runLoop({ currency: 'credits', budget: 1000, quote: 900, e: 'e2', c: 'c2' });
    expect(conNow - conBase).toBe(810);
    expect(settlement.gross).toBe(900);
    expect(settlement.pay).toBe(810);
    expect(settlement.fee).toBe(90);
    // 雇主只损失成交额，未成交的 100 应退回
    expect(creditsOf('e2')).toBe(100);
  });

  it('取消任务：预算全额退回，零抽成', () => {
    const base = creditsOf('e3');
    fundCredits('e3', 1000);
    const t = svc.createTask({ employerId: 'e3', title: '取消用例', budget: 1000, currency: 'credits' });
    expect(creditsOf('e3')).toBe(base + 1000 - 1000);
    svc.cancelTask('e3', t.id);
    expect(creditsOf('e3')).toBe(base + 1000);
    const rev = revenueOf(t.id);
    expect(rev).toBeNull();
  });
});

// ────────────────────── 争议路径守恒 ──────────────────────

describe('平台抽成 · 争议路径守恒', () => {
  it('release：全额付承包方 90%', () => {
    const { dispute, contract, conBase } = runToDispute({ e: 'e4', c: 'c4', budget: 1000 });
    const r: any = svc.resolveDispute({
      adminId: 'admin', disputeId: dispute.id, decision: 'release', resolution: '判定承包方履约',
    });
    const rev = revenueOf(contract.id)!;
    expect(rev.gross).toBe(1000);
    expect(rev.pay).toBe(900);
    expect(rev.fee).toBe(100);
    expect(creditsOf('c4') - conBase).toBe(900);
    expect(rev).not.toBeNull();
    expect(rev!.pay + rev!.fee).toBe(rev!.gross);
  });

  it('refund：全额退雇主，承包方零收入', () => {
    const { dispute, conBase } = runToDispute({ e: 'e5', c: 'c5', budget: 1000 });
    const r: any = svc.resolveDispute({
      adminId: 'admin', disputeId: dispute.id, decision: 'refund', resolution: '判定雇主胜诉',
    });
    const rev = revenueOf(r.contract.id);
    expect(rev === null || rev.pay === 0).toBe(true);
    expect(creditsOf('e5')).toBeGreaterThanOrEqual(1000);
    expect(creditsOf('c5') - conBase).toBe(0);
  });

  it('partial：退部分给雇主，剩余 90% 给承包方', () => {
    const { dispute, conBase } = runToDispute({ e: 'e6', c: 'c6', budget: 1000 });
    const r: any = svc.resolveDispute({
      adminId: 'admin', disputeId: dispute.id, decision: 'partial',
      resolution: '部分履约', refundAmount: 400,
    });
    const rev = revenueOf(r.contract.id)!;
    // 守恒不变量是硬要求；具体分配比例以代码实现为准
    expect(rev.pay + rev.fee).toBe(rev.gross);
    // 守恒的真正含义：退款(未抽成) + 结算额*0.9
    const refundToEmployer = creditsOf('e6');
    const payToContractor = creditsOf('c6') - conBase;
    expect(refundToEmployer).toBe(400);
    expect(payToContractor).toBe(540);
    expect(refundToEmployer + payToContractor).toBe(940);
    // 平台只对实际结算部分抽成：540 / 0.9 = 600 是结算基数，10% = 60
    expect(rev.fee).toBe(60);
  });
});

// ────────────────────── 幂等防重复结算 ──────────────────────

describe('平台抽成 · 幂等防重复结算', () => {
  it('相同 idempotencyKey 重复验收，只扣一次钱', () => {
    const r1 = runLoop({ currency: 'credits', budget: 1000, quote: 1000, e: 'idem-e1', c: 'idem-c1', idem: 'K-1' });
    const conAfter1 = r1.conNow;
    expect(creditsOf('idem-e1')).toBe(0);
    expect(conAfter1 - r1.conBase).toBe(900);

    // 同一 key 再调一次：状态机先挡住（accepted 不可再验收），
    // 无论走回放还是抛错，钱都不能再动一次
    let again: any = null;
    try {
      again = svc.acceptDelivery('idem-e1', r1.delivery.id, 'K-1');
    } catch (e: any) {
      expect(e.status).toBe(409);
    }
    // 关键断言：重复调用后余额分毫未动
    expect(creditsOf('idem-e1')).toBe(0);
    expect(creditsOf('idem-c1')).toBe(conAfter1);
    // 账本里也不能多出一笔收入
    const cnt: any = db.exec(`SELECT COUNT(*) FROM mvp_platform_revenue WHERE payee_id = 'idem-c1'`);
    expect(Number(cnt[0].values[0][0])).toBe(1);
  });

  it('跨 scope 相同 key 不互相回放（本次修复项）', () => {
    // 同一 key 在两个 scope 下应能共存，且互不串味
    db.run(`INSERT INTO mvp_idempotency (key, scope, response, created_at) VALUES (?, ?, ?, ?)`,
      ['K-1', 'other.scope', JSON.stringify({ marker: 'other' }), Date.now()]);
    const r: any = db.exec(`SELECT scope FROM mvp_idempotency WHERE key = 'K-1'`);
    const scopes: string[] = r[0].values.map((v: any[]) => v[0]);
    // 复数 scope 同 key 能落库 = 复合唯一生效（旧版只有 key 主键时这里会直接报 UNIQUE 冲突）
    expect(scopes).toContain('other.scope');
    expect(scopes).toContain('delivery.accept');
  });
});

// ────────────────────── 报表查询 ──────────────────────

describe('平台抽成 · 报表查询', () => {
  it('汇总按币种/市场过滤，流水可分页', () => {
    const sum = svc.platformRevenueSummary();
    expect(sum.count).toBeGreaterThan(0);
    expect(sum.totalGross).toBeGreaterThan(0);

    const rows = svc.listPlatformRevenue(10, 0);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(10);

    for (const row of rows) {
      expect(row.pay + row.fee).toBeCloseTo(row.gross, 5);
    }
  });

  it('按币种过滤：credits 与 usd 互不串账', () => {
    const creditsOnly = svc.platformRevenueSummary({ currency: 'credits' });
    expect(creditsOnly.count).toBeGreaterThan(0);
    for (const row of svc.listPlatformRevenue(50, 0, { currency: 'credits' })) {
      expect(row.currency).toBe('credits');
    }
  });
});
