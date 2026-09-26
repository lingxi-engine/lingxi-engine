/**
 * 灵犀 MVP 闭环 — 核心服务层
 *
 * 集中实现：
 *  - 状态机（任务/报价/合同/交付/争议）
 *  - 权限检查（资源归属）
 *  - 审计日志
 *  - 通知
 *  - 模拟结算
 *
 * 所有路由只做参数解析 + 调服务，不直接写 SQL，保证规则只有一份实现。
 */

import { randomUUID } from 'crypto';
import type { DB } from '../../storage/db.js';

// ────────────────────────── 状态机定义 ──────────────────────────

export const TASK_STATUS = ['open', 'quoted', 'contracted', 'in_progress', 'delivered', 'completed', 'cancelled'] as const;
export const QUOTE_STATUS = ['pending', 'accepted', 'rejected', 'withdrawn'] as const;
export const CONTRACT_STATUS = ['pending_confirm', 'active', 'delivered', 'accepted', 'disputed', 'completed', 'cancelled'] as const;
export const DELIVERY_STATUS = ['submitted', 'accepted', 'revision_requested', 'rejected'] as const;
export const DISPUTE_STATUS = ['open', 'reviewing', 'resolved', 'dismissed'] as const;
export const SETTLEMENT_KIND = ['release', 'refund', 'partial_refund'] as const;

/**
 * 平台抽成比例（默认 10%）。
 * 唯一权威来源：两套市场（/api/mvp 任务市场、/api/market 雇佣市场）都读这里，
 * 靠环境变量 PLATFORM_FEE_RATE 调整，无需改代码重新构建。
 * 取值范围锁定 [0, 0.5]——超过一半属于暴利，低于 0 无意义。
 */
export const PLATFORM_FEE_RATE = (() => {
  const raw = process.env.PLATFORM_FEE_RATE;
  if (raw === undefined || raw === '') return 0.1;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn('[mvp][fee] PLATFORM_FEE_RATE 不是数字，回退 0.1:', raw);
    return 0.1;
  }
  if (n < 0 || n > 0.5) {
    console.warn('[mvp][fee] PLATFORM_FEE_RATE 超出 [0, 0.5]，已夹紧:', raw);
    return Math.min(0.5, Math.max(0, n));
  }
  return n;
})();

/** 按币种精度取整：积分向下取整（不虚增），钱类保留两位小数（不丢分）。 */
export function roundFeeAmount(currency: string, value: number): number {
  return currency === 'credits' ? Math.floor(value) : Math.round(value * 100) / 100;
}

export type TaskStatus = (typeof TASK_STATUS)[number];
export type QuoteStatus = (typeof QUOTE_STATUS)[number];
export type ContractStatus = (typeof CONTRACT_STATUS)[number];
export type DeliveryStatus = (typeof DELIVERY_STATUS)[number];
export type DisputeStatus = (typeof DISPUTE_STATUS)[number];

/** 任务状态合法迁移 */
const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['quoted', 'cancelled'],
  quoted: ['contracted', 'open', 'cancelled'],
  contracted: ['in_progress', 'cancelled'],
  in_progress: ['delivered', 'cancelled'],
  delivered: ['completed', 'in_progress'],
  completed: [],
  cancelled: [],
};

/** 合同状态合法迁移 */
const CONTRACT_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  pending_confirm: ['active', 'cancelled'],
  active: ['delivered', 'disputed', 'cancelled'],
  delivered: ['accepted', 'disputed', 'active'],
  accepted: ['completed', 'disputed'],
  disputed: ['completed', 'cancelled', 'active'],
  completed: [],
  cancelled: [],
};

export function canTransitionTask(from: string, to: string): boolean {
  const allowed = TASK_TRANSITIONS[from as TaskStatus];
  return !!allowed && allowed.includes(to as TaskStatus);
}

export function canTransitionContract(from: string, to: string): boolean {
  const allowed = CONTRACT_TRANSITIONS[from as ContractStatus];
  return !!allowed && allowed.includes(to as ContractStatus);
}

// ────────────────────────── 行类型 ──────────────────────────

export interface TaskRow {
  id: string;
  employer_id: string;
  title: string;
  description: string;
  category: string;
  budget: number;
  currency: string;
  status: TaskStatus;
  accepted_quote_id: string | null;
  contract_id: string | null;
  deadline_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface QuoteRow {
  id: string;
  task_id: string;
  bidder_id: string;
  amount: number;
  currency: string;
  message: string;
  delivery_days: number;
  status: QuoteStatus;
  created_at: number;
  updated_at: number;
}

export interface ContractRow {
  id: string;
  task_id: string;
  quote_id: string;
  employer_id: string;
  contractor_id: string;
  amount: number;
  currency: string;
  status: ContractStatus;
  terms: string;
  created_at: number;
  updated_at: number;
  confirmed_at: number | null;
}

export interface DeliveryRow {
  id: string;
  contract_id: string;
  submitter_id: string;
  round: number;
  content: string;
  status: DeliveryStatus;
  review_note: string;
  created_at: number;
  reviewed_at: number | null;
}

export interface DisputeRow {
  id: string;
  contract_id: string;
  delivery_id: string | null;
  initiator_id: string;
  reason: string;
  evidence: string;
  status: DisputeStatus;
  resolution: string;
  resolver_id: string | null;
  refund_amount: number;
  created_at: number;
  resolved_at: number | null;
}

// ────────────────────────── 服务 ──────────────────────────

export class MvpMarketError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface AuditEntry {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  targetUserId?: string | null;
  detail?: Record<string, unknown>;
  ip?: string;
}

export class MvpMarketService {
  private db: any;

  /**
   * 兼容两种入参：
   *  - 生产：DB 实例（有 .raw getter 指向 sql.js Database）
   *  - 测试：裸 sql.js Database
   */
  constructor(db: DB | any) {
    this.db = db && typeof db.exec === 'function' ? db : (db as any)?.raw;
    if (!this.db || typeof this.db.exec !== 'function') {
      throw new Error('MvpMarketService 需要一个可用的 sql.js Database');
    }
  }

  private raw() {
    return this.db;
  }

  /** sql.js 不接受 undefined 入参，统一归一化为 null */
  private norm(params: any[] = []): any[] {
    return (params ?? []).map((v) => (v === undefined ? null : v));
  }

  /** 把 sql.js exec 的 {columns, values} 转成对象数组 */
  private toRows(res: any): any[] {
    if (!res || !res.length || !res[0]) return [];
    const { columns, values } = res[0];
    return values.map((row: any[]) => {
      const obj: any = {};
      columns.forEach((c: string, i: number) => { obj[c] = row[i]; });
      return obj;
    });
  }

  private all<T = any>(sql: string, params: any[] = []): T[] {
    return this.toRows(this.raw().exec(sql, this.norm(params))) as T[];
  }

  private one<T = any>(sql: string, params: any[] = []): T | null {
    const rows = this.all<T>(sql, params);
    return rows.length ? rows[0] : null;
  }

  private run(sql: string, params: any[] = []): void {
    this.raw().run(sql, this.norm(params));
  }

  private now(): number {
    return Date.now();
  }

  private id(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  }

  // ────────────────── 事务（P0-2：资金安全的地基）──────────────────

  /**
   * 事务包装。sql.js 不支持嵌套事务，内层直接执行即可。
   * 任何异常都 ROLLBACK，绝不允许「钱动了但账没转」的中间态落盘。
   */
  private txDepth = 0;

  private transaction<T>(fn: () => T): T {
    // 已是事务中（内层调用）→ 不重复 BEGIN，交给最外层提交/回滚
    if (this.txDepth > 0) {
      this.txDepth++;
      try { return fn(); } finally { this.txDepth--; }
    }
    const d = this.raw();
    d.run('BEGIN');
    this.txDepth = 1;
    try {
      const out = fn();
      d.run('COMMIT');
      return out;
    } catch (e) {
      try { d.run('ROLLBACK'); }
      catch (re: any) { console.error('[mvp][tx] ROLLBACK 失败:', re?.message || re); }
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  // ────────────────── 幂等（P1-3：防重复扣款/重复结算）──────────────────

  /** 幂等表不存在则建。生产库由迁移建好，这里兜底保证测试库可用。 */
  private ensureIdempotencyTable(): void {
    try {
      this.raw().run(`CREATE TABLE IF NOT EXISTS mvp_idempotency (
        key TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        response TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL)`);
      // 复合唯一：同一个 key 在不同 scope 下互不干扰
      this.raw().run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mvp_idempotency_scope_key
        ON mvp_idempotency(scope, key)`);
    } catch { /* ignore */ }
  }

  /**
   * 幂等执行：同一个 key 第二次调用直接回放上次结果，绝不重复执行副作用。
   *
   * @param key   客户端提供的幂等键（没有就退化成「无幂等」，保持旧行为）
   * @param scope 命名空间，如 'delivery.accept'
   * @param fn    真正的业务逻辑
   */
  private idempotent<T>(key: string | null | undefined, scope: string, fn: () => T): T {
    if (!key) return fn();          // 未提供 key → 保持原行为，不阻断
    this.ensureIdempotencyTable();
    const k = String(key).slice(0, 128);

    const prev = this.one<{ response: string }>(`SELECT response FROM mvp_idempotency WHERE key = ? AND scope = ?`, [k, scope]);
    if (prev) {
      try { return JSON.parse(prev.response) as T; }
      catch { return fn(); }
    }

    const result = this.transaction(() => {
      const out = fn();
      // 业务成功才登记；失败时上面的 transaction 已 ROLLBACK
      this.run(
        `INSERT INTO mvp_idempotency (key, scope, response, created_at) VALUES (?, ?, ?, ?)`,
        [k, scope, JSON.stringify(out ?? null), this.now()],
      );
      return out;
    });

    return result;
  }

  // ────────────────── 资金层（自包含，走本实例的 sql.js 句柄）──────────────────

  /** 幂等创建资金表。生产库由 initDB 建好，测试库只跑 MVP 迁移，这里兜底。 */
  private ensureFundTables(): void {
    const d = this.raw();
    try {
      d.run(`CREATE TABLE IF NOT EXISTS user_credits (
        user_id TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 1000,
        total_earned INTEGER NOT NULL DEFAULT 0, total_spent INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0)`);
    } catch { /* ignore */ }
    try {
      d.run(`CREATE TABLE IF NOT EXISTS credit_log (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL,
        reason TEXT NOT NULL DEFAULT '', balance_after INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL)`);
    } catch { /* ignore */ }
    try {
      d.run(`CREATE TABLE IF NOT EXISTS wallets (
        user_id TEXT PRIMARY KEY, balance_usd REAL NOT NULL DEFAULT 0,
        balance_cny REAL NOT NULL DEFAULT 0, frozen_usd REAL NOT NULL DEFAULT 0,
        frozen_cny REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);
    } catch { /* ignore */ }
    try {
      d.run(`CREATE TABLE IF NOT EXISTS wallet_tx (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, currency TEXT NOT NULL,
        amount REAL NOT NULL, type TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
        balance_after REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    } catch { /* ignore */ }
    try {
      d.run(`CREATE TABLE IF NOT EXISTS mvp_platform_revenue (
        id TEXT PRIMARY KEY, market TEXT NOT NULL DEFAULT 'task',
        contract_id TEXT, settlement_id TEXT, payer_id TEXT, payee_id TEXT,
        gross REAL NOT NULL DEFAULT 0, pay REAL NOT NULL DEFAULT 0,
        fee REAL NOT NULL DEFAULT 0, fee_rate REAL NOT NULL DEFAULT 0.1,
        currency TEXT NOT NULL DEFAULT 'credits', kind TEXT NOT NULL DEFAULT 'release',
        note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`);
    } catch { /* ignore */ }
  }

  /** 查余额；未开户则按默认值开户后返回。 */
  private fundBalance(userId: string, currency: string): number {
    this.ensureFundTables();
    if (currency === 'credits') {
      const row = this.one<{ credits: number }>(`SELECT credits FROM user_credits WHERE user_id = ?`, [userId]);
      if (!row) {
        this.run(`INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, 1000, 0, 0, ?)`,
          [userId, this.now()]);
        return 1000;
      }
      return Number(row.credits) || 0;
    }
    const col = currency === 'cny' ? 'cny' : 'usd';
    const row = this.one<Record<string, number>>(`SELECT balance_${col} AS bal FROM wallets WHERE user_id = ?`, [userId]);
    if (!row) {
      this.run(`INSERT INTO wallets (user_id, balance_usd, balance_cny, frozen_usd, frozen_cny, updated_at) VALUES (?, 0, 0, 0, 0, ?)`,
        [userId, this.now()]);
      return 0;
    }
    return Number(row.bal) || 0;
  }

  /** 记账：正数入账 / 负数出账，自动写流水。 */
  private fundMove(userId: string, currency: string, delta: number, reason: string): number {
    this.ensureFundTables();
    const cur = this.fundBalance(userId, currency);
    if (currency === 'credits') {
      const next = cur + delta;
      this.run(`UPDATE user_credits SET credits = ?, total_earned = total_earned + ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ?`,
        [next, delta > 0 ? delta : 0, delta < 0 ? -delta : 0, this.now(), userId]);
      try {
        this.run(`INSERT INTO credit_log (id, user_id, amount, reason, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [this.id('clog'), userId, delta, reason, next, this.now()]);
      } catch { /* ignore */ }
      return next;
    }
    const col = currency === 'cny' ? 'cny' : 'usd';
    const next = cur + delta;
    this.run(`UPDATE wallets SET balance_${col} = ?, updated_at = ? WHERE user_id = ?`, [next, this.now(), userId]);
    try {
      this.run(`INSERT INTO wallet_tx (id, user_id, currency, amount, type, reason, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.id('wtx'), userId, col, delta, delta >= 0 ? 'income' : 'expense', reason, next, this.now()]);
    } catch { /* ignore */ }
    return next;
  }

  /** 扣款：余额不足返回 false，绝不扣成负数。 */
  private fundTrySpend(userId: string, currency: string, amount: number, reason: string): { ok: boolean; balance: number; error?: string } {
    const cur = this.fundBalance(userId, currency);
    if (cur < amount) {
      const label = currency === 'credits' ? '积分' : currency.toUpperCase() + ' 余额';
      return { ok: false, balance: cur, error: label + '不足：需要 ' + amount + '，当前 ' + cur };
    }
    return { ok: true, balance: this.fundMove(userId, currency, -amount, reason) };
  }

  /** 雇主下任务：扣留预算。 */
  private holdBudget(userId: string, currency: string, amount: number, note: string): void {
    if (amount <= 0) return;
    const r = this.fundTrySpend(userId, currency, amount, note);
    if (!r.ok) {
      throw new MvpMarketError(400, currency === 'credits' ? 'insufficient_credits' : 'insufficient_balance', r.error || '余额不足，无法冻结预算');
    }
  }

  /** 退预算（取消任务 / 全额退款）。 */
  private refundTo(userId: string, currency: string, amount: number, note: string): void {
    if (amount <= 0) return;
    this.fundMove(userId, currency, amount, note);
  }

  /**
   * 分档费率钩子。默认全站统一 PLATFORM_FEE_RATE。
   * 以后要搞「优质服务商 8% / 新人 12%」或「大额单阶梯抽成」，
   * 只需改这一个函数，不用碰结算逻辑。
   */
  feeRate(_contractorId: string, _gross: number, _currency: string): number {
    return PLATFORM_FEE_RATE;
  }

  /**
   * 平台抽成入账。fee 不再是空气——必须落成一条可对账的账本记录。
   * 恒等式由 roundFeeAmount + fee = gross - pay 保证：gross === pay + fee。
   */
  private recordRevenue(e: {
    market: string; contractId?: string | null; settlementId?: string | null;
    payerId?: string | null; payeeId?: string | null;
    gross: number; pay: number; fee: number; rate: number;
    currency: string; kind: string; note: string;
  }): void {
    if (e.fee <= 0) return;
    this.ensureFundTables();
    this.run(
      `INSERT INTO mvp_platform_revenue
       (id, market, contract_id, settlement_id, payer_id, payee_id,
        gross, pay, fee, fee_rate, currency, kind, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [this.id('rev'), e.market, e.contractId ?? null, e.settlementId ?? null,
       e.payerId ?? null, e.payeeId ?? null,
       roundFeeAmount(e.currency, e.gross), roundFeeAmount(e.currency, e.pay),
       roundFeeAmount(e.currency, e.fee), e.rate, e.currency, e.kind, e.note, this.now()],
    );
  }

  /** 平台抽成：服务方实收 = gross - fee。抽成自动入账，恒等式守恒。 */
  private payout(
    contractorId: string, currency: string, gross: number, note: string,
    ctx?: { contractId?: string | null; payerId?: string | null; kind?: string },
  ): { pay: number; fee: number; rate: number } {
    const rate = this.feeRate(contractorId, gross, currency);
    const fee = roundFeeAmount(currency, gross * rate);
    const pay = roundFeeAmount(currency, gross - fee);
    if (pay > 0) this.fundMove(contractorId, currency, pay, note);
    this.recordRevenue({
      market: 'task', contractId: ctx?.contractId ?? null, settlementId: null,
      payerId: ctx?.payerId ?? null, payeeId: contractorId,
      gross, pay, fee, rate, currency, kind: ctx?.kind ?? 'release', note,
    });
    return { pay, fee, rate };
  }

  // ────────────────── 平台抽成查询（对账 / 报表） ──────────────────

  /** 抽成汇总：按币种 + 市场维度，gross/pay/fee 三段式 */
  platformRevenueSummary(filter?: { market?: string; currency?: string; from?: number; to?: number }): {
    totalGross: number; totalPay: number; totalFee: number; count: number; feeRate: number;
  } {
    this.ensureFundTables();
    const where: string[] = [];
    const params: any[] = [];
    if (filter?.market) { where.push('market = ?'); params.push(filter.market); }
    if (filter?.currency) { where.push('currency = ?'); params.push(filter.currency); }
    if (filter?.from) { where.push('created_at >= ?'); params.push(filter.from); }
    if (filter?.to) { where.push('created_at <= ?'); params.push(filter.to); }
    const sql = `SELECT COUNT(*) AS c, COALESCE(SUM(gross),0) AS g,
                        COALESCE(SUM(pay),0) AS p, COALESCE(SUM(fee),0) AS f
                 FROM mvp_platform_revenue ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const row = this.one<{ c: number; g: number; p: number; f: number }>(sql, params);
    const totalGross = Number(row?.g) || 0;
    const totalFee = Number(row?.f) || 0;
    return {
      totalGross, totalPay: Number(row?.p) || 0, totalFee,
      count: Number(row?.c) || 0,
      feeRate: totalGross > 0 ? Math.round((totalFee / totalGross) * 10000) / 10000 : PLATFORM_FEE_RATE,
    };
  }

  /** 抽成流水（带分页，按时间倒序） */
  listPlatformRevenue(limit = 50, offset = 0, filter?: { market?: string; currency?: string }): any[] {
    this.ensureFundTables();
    const where: string[] = [];
    const params: any[] = [];
    if (filter?.market) { where.push('market = ?'); params.push(filter.market); }
    if (filter?.currency) { where.push('currency = ?'); params.push(filter.currency); }
    params.push(Math.max(1, Math.floor(limit)), Math.max(0, Math.floor(offset)));
    return this.all(
      `SELECT * FROM mvp_platform_revenue ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`, params);
  }

  // ────────────────── 审计日志 ──────────────────

  /** 写入审计日志。任何重要业务操作都必须调用。 */
  audit(entry: AuditEntry): void {
    try {
      this.run(
        `INSERT INTO mvp_audit_logs (id, actor_id, action, entity_type, entity_id, target_user_id, detail, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this.id('audit'),
          entry.actorId,
          entry.action,
          entry.entityType,
          entry.entityId,
          entry.targetUserId ?? null,
          JSON.stringify(entry.detail ?? {}),
          entry.ip ?? '',
          this.now(),
        ],
      );
    } catch (e: any) {
      // 审计写失败不能阻断主流程，但必须留下痕迹
      console.error('[mvp][audit] 写入失败:', e?.message || e);
    }
  }

  listAuditLogs(opts: { actorId?: string; entityType?: string; entityId?: string; limit?: number } = {}): any[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.actorId) { where.push('actor_id = ?'); params.push(opts.actorId); }
    if (opts.entityType) { where.push('entity_type = ?'); params.push(opts.entityType); }
    if (opts.entityId) { where.push('entity_id = ?'); params.push(opts.entityId); }
    const sql = `SELECT * FROM mvp_audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    params.push(Math.min(Math.max(1, opts.limit ?? 100), 500));
    return this.all(sql, params);
  }

  // ────────────────── 通知 ──────────────────

  notify(userId: string, type: string, title: string, content: string, refType?: string, refId?: string): void {
    try {
      this.run(
        `INSERT INTO mvp_notifications (id, user_id, type, title, content, ref_type, ref_id, read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [this.id('notif'), userId, type, title, content, refType ?? null, refId ?? null, this.now()],
      );
    } catch (e: any) {
      console.error('[mvp][notify] 写入失败:', e?.message || e);
    }
  }

  listNotifications(userId: string, unreadOnly = false): any[] {
    const sql = unreadOnly
      ? `SELECT * FROM mvp_notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT 200`
      : `SELECT * FROM mvp_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`;
    return this.all(sql, [userId]);
  }

  markNotificationRead(userId: string, notifId: string): boolean {
    const n = this.one(`SELECT * FROM mvp_notifications WHERE id = ?`, [notifId]);
    if (!n) throw new MvpMarketError(404, 'not_found', '通知不存在');
    if (n.user_id !== userId) throw new MvpMarketError(403, 'forbidden', '无权操作他人通知');
    this.run(`UPDATE mvp_notifications SET read = 1 WHERE id = ?`, [notifId]);
    return true;
  }

  markAllNotificationsRead(userId: string): number {
    this.run(`UPDATE mvp_notifications SET read = 1 WHERE user_id = ? AND read = 0`, [userId]);
    return Number(this.raw().getRowsModified() ?? 0);
  }

  unreadCount(userId: string): number {
    return this.one(`SELECT COUNT(*) AS c FROM mvp_notifications WHERE user_id = ? AND read = 0`, [userId])?.c ?? 0;
  }

  // ────────────────── 任务 ──────────────────

  createTask(input: {
    employerId: string;
    title: string;
    description?: string;
    category?: string;
    budget: number;
    currency?: string;
    deadlineAt?: number | null;
  }): TaskRow {
    const title = String(input.title ?? '').trim();
    if (!title) throw new MvpMarketError(400, 'invalid_title', '任务标题不能为空');
    if (title.length > 120) throw new MvpMarketError(400, 'invalid_title', '任务标题过长（≤120字符）');
    const budget = Number(input.budget);
    if (!Number.isFinite(budget) || budget < 0) throw new MvpMarketError(400, 'invalid_budget', '预算必须是非负数字');
    if (budget > 1e12) throw new MvpMarketError(400, 'invalid_budget', '预算超出允许范围');

    const now = this.now();
    const task: TaskRow = {
      id: this.id('task'),
      employer_id: input.employerId,
      title,
      description: String(input.description ?? '').slice(0, 5000),
      category: String(input.category ?? '通用').slice(0, 40),
      budget: Math.floor(budget),
      currency: String(input.currency ?? 'credits'),
      status: 'open',
      accepted_quote_id: null,
      contract_id: null,
      deadline_at: input.deadlineAt ?? null,
      created_at: now,
      updated_at: now,
    };
    // 真实资金：扣留雇主预算
    this.holdBudget(task.employer_id, task.currency, task.budget, `任务预算扣留: ${task.id}`);

    this.run(
      `INSERT INTO mvp_tasks (id, employer_id, title, description, category, budget, currency, status,
        accepted_quote_id, contract_id, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      [task.id, task.employer_id, task.title, task.description, task.category, task.budget, task.currency,
        task.status, task.deadline_at, task.created_at, task.updated_at],
    );
    this.audit({
      actorId: input.employerId,
      action: 'task.create',
      entityType: 'task',
      entityId: task.id,
      detail: { title: task.title, budget: task.budget, currency: task.currency },
    });
    return task;
  }

  getTask(taskId: string): TaskRow {
    const row = this.one<TaskRow>(`SELECT * FROM mvp_tasks WHERE id = ?`, [taskId]);
    if (!row) throw new MvpMarketError(404, 'not_found', '任务不存在');
    return row;
  }

  listTasks(opts: { status?: string; category?: string; employerId?: string; limit?: number } = {}): TaskRow[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.category) { where.push('category = ?'); params.push(opts.category); }
    if (opts.employerId) { where.push('employer_id = ?'); params.push(opts.employerId); }
    params.push(Math.min(Math.max(1, opts.limit ?? 100), 500));
    const sql = `SELECT * FROM mvp_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    return this.all<TaskRow>(sql, params);
  }

  /** 雇主取消任务：仅 open/quoted 状态可取消 */
  cancelTask(actorId: string, taskId: string): TaskRow {
    const task = this.getTask(taskId);
    if (task.employer_id !== actorId) throw new MvpMarketError(403, 'forbidden', '只有任务发布者可以取消任务');
    if (!canTransitionTask(task.status, 'cancelled')) {
      throw new MvpMarketError(409, 'invalid_state', `任务当前状态 ${task.status} 不可取消`);
    }
    return this.transaction(() => {
    // 取消任务时，连带撤回所有待处理报价
    this.run(`UPDATE mvp_quotes SET status = 'withdrawn', updated_at = ? WHERE task_id = ? AND status = 'pending'`, [this.now(), taskId]);
    this.run(`UPDATE mvp_tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`, [this.now(), taskId]);
    // 真实资金：取消任务 · 退回预算
    this.refundTo(task.employer_id, task.currency, task.budget, `取消任务 · 退回预算: ${task.id}`);
    this.audit({ actorId, action: 'task.cancel', entityType: 'task', entityId: taskId, detail: { from: task.status } });
    return this.getTask(taskId);
    });
  }

  // ────────────────── 报价 ──────────────────

  submitQuote(input: {
    taskId: string;
    bidderId: string;
    amount: number;
    message?: string;
    deliveryDays?: number;
  }): QuoteRow {
    const task = this.getTask(input.taskId);
    if (task.employer_id === input.bidderId) throw new MvpMarketError(400, 'self_quote', '不能给自己的任务报价');
    if (task.status !== 'open' && task.status !== 'quoted') {
      throw new MvpMarketError(409, 'invalid_state', `任务当前状态 ${task.status} 不可报价`);
    }
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new MvpMarketError(400, 'invalid_amount', '报价金额必须是正数');
    if (amount > 1e12) throw new MvpMarketError(400, 'invalid_amount', '报价金额超出允许范围');

    const now = this.now();
    const quote: QuoteRow = {
      id: this.id('quote'),
      task_id: task.id,
      bidder_id: input.bidderId,
      amount: Math.floor(amount),
      currency: task.currency,
      message: String(input.message ?? '').slice(0, 2000),
      delivery_days: Math.min(Math.max(1, Number(input.deliveryDays ?? 3) || 3), 365),
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    this.run(
      `INSERT INTO mvp_quotes (id, task_id, bidder_id, amount, currency, message, delivery_days, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [quote.id, quote.task_id, quote.bidder_id, quote.amount, quote.currency, quote.message,
        quote.delivery_days, quote.created_at, quote.updated_at],
    );
    if (task.status === 'open') {
      this.run(`UPDATE mvp_tasks SET status = 'quoted', updated_at = ? WHERE id = ?`, [now, task.id]);
    }
    this.notify(task.employer_id, 'quote.new', '收到新报价',
      `任务「${task.title}」收到一份报价：${quote.amount} ${quote.currency}`, 'task', task.id);
    this.audit({
      actorId: input.bidderId,
      action: 'quote.submit',
      entityType: 'quote',
      entityId: quote.id,
      targetUserId: task.employer_id,
      detail: { taskId: task.id, amount: quote.amount },
    });
    return quote;
  }

  getQuote(quoteId: string): QuoteRow {
    const row = this.one<QuoteRow>(`SELECT * FROM mvp_quotes WHERE id = ?`, [quoteId]);
    if (!row) throw new MvpMarketError(404, 'not_found', '报价不存在');
    return row;
  }

  listQuotesByTask(taskId: string): QuoteRow[] {
    return this.all<QuoteRow>(`SELECT * FROM mvp_quotes WHERE task_id = ? ORDER BY created_at DESC`, [taskId]);
  }

  listQuotesByBidder(bidderId: string): QuoteRow[] {
    return this.all<QuoteRow>(`SELECT * FROM mvp_quotes WHERE bidder_id = ? ORDER BY created_at DESC`, [bidderId]);
  }

  /** 撤回报价：仅 pending 状态可撤回 */
  withdrawQuote(actorId: string, quoteId: string): QuoteRow {
    const quote = this.getQuote(quoteId);
    if (quote.bidder_id !== actorId) throw new MvpMarketError(403, 'forbidden', '只有报价人可以撤回报价');
    if (quote.status !== 'pending') throw new MvpMarketError(409, 'invalid_state', `报价当前状态 ${quote.status} 不可撤回`);
    this.run(`UPDATE mvp_quotes SET status = 'withdrawn', updated_at = ? WHERE id = ?`, [this.now(), quoteId]);
    this.audit({ actorId, action: 'quote.withdraw', entityType: 'quote', entityId: quoteId, detail: { taskId: quote.task_id } });
    return this.getQuote(quoteId);
  }

  // ────────────────── 接受报价 → 合同 ──────────────────

  acceptQuote(actorId: string, quoteId: string, terms?: string, idempotencyKey?: string | null): ContractRow {
    const quote = this.getQuote(quoteId);
    const task = this.getTask(quote.task_id);
    if (task.employer_id !== actorId) throw new MvpMarketError(403, 'forbidden', '只有任务发布者可以接受报价');
    if (quote.status !== 'pending') throw new MvpMarketError(409, 'invalid_state', `报价当前状态 ${quote.status} 不可接受`);
    if (task.status !== 'open' && task.status !== 'quoted') {
      throw new MvpMarketError(409, 'invalid_state', `任务当前状态 ${task.status} 不可接受报价`);
    }

    const now = this.now();
    const contract: ContractRow = {
      id: this.id('contract'),
      task_id: task.id,
      quote_id: quote.id,
      employer_id: task.employer_id,
      contractor_id: quote.bidder_id,
      amount: quote.amount,
      currency: quote.currency,
      status: 'pending_confirm',
      terms: String(terms ?? '').slice(0, 5000),
      created_at: now,
      updated_at: now,
      confirmed_at: null,
    };
    return this.idempotent(idempotencyKey, 'quote.accept', () => this.transaction(() => {
    this.run(
      `INSERT INTO mvp_contracts (id, task_id, quote_id, employer_id, contractor_id, amount, currency, status, terms, created_at, updated_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_confirm', ?, ?, ?, NULL)`,
      [contract.id, contract.task_id, contract.quote_id, contract.employer_id, contract.contractor_id,
        contract.amount, contract.currency, contract.terms, contract.created_at, contract.updated_at],
    );
    this.run(`UPDATE mvp_quotes SET status = 'accepted', updated_at = ? WHERE id = ?`, [now, quote.id]);
    this.run(`UPDATE mvp_quotes SET status = 'rejected', updated_at = ? WHERE task_id = ? AND id != ? AND status = 'pending'`, [now, task.id, quote.id]);
    this.run(`UPDATE mvp_tasks SET status = 'contracted', accepted_quote_id = ?, contract_id = ?, updated_at = ? WHERE id = ?`,
      [quote.id, contract.id, now, task.id]);

    // 真实资金：退回未成交的预算差额（预算在 createTask 已全额扣留）
    // 合同金额可能低于预算，差额若不退会永久蒸发，破坏资金守恒
    if (task.currency === contract.currency) {
      const diff = Math.floor(Number(task.budget) || 0) - Math.floor(Number(contract.amount) || 0);
      if (diff > 0) {
        this.refundTo(task.employer_id, contract.currency, diff, `退回未成交预算差额: ${task.id}`);
      }
    }

    this.notify(quote.bidder_id, 'contract.created', '报价被接受，合同待确认',
      `任务「${task.title}」的报价已被接受，请确认合同 ${contract.id}`, 'contract', contract.id);
    this.audit({
      actorId,
      action: 'quote.accept',
      entityType: 'contract',
      entityId: contract.id,
      targetUserId: quote.bidder_id,
      detail: { quoteId: quote.id, taskId: task.id, amount: contract.amount },
    });
    return contract;
    }));
  }

  getContract(contractId: string): ContractRow {
    const row = this.one<ContractRow>(`SELECT * FROM mvp_contracts WHERE id = ?`, [contractId]);
    if (!row) throw new MvpMarketError(404, 'not_found', '合同不存在');
    return row;
  }

  listContractsByUser(userId: string): ContractRow[] {
    return this.all<ContractRow>(
      `SELECT * FROM mvp_contracts WHERE employer_id = ? OR contractor_id = ? ORDER BY created_at DESC`,
      [userId, userId],
    );
  }

  /** 合同确认：仅承包方可确认 */
  confirmContract(actorId: string, contractId: string): ContractRow {
    const contract = this.getContract(contractId);
    if (contract.contractor_id !== actorId) throw new MvpMarketError(403, 'forbidden', '只有承包方可以确认合同');
    if (contract.status !== 'pending_confirm') {
      throw new MvpMarketError(409, 'invalid_state', `合同当前状态 ${contract.status} 不可确认`);
    }
    const now = this.now();
    this.run(`UPDATE mvp_contracts SET status = 'active', confirmed_at = ?, updated_at = ? WHERE id = ?`, [now, now, contractId]);
    this.run(`UPDATE mvp_tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`, [now, contract.task_id]);
    this.notify(contract.employer_id, 'contract.confirmed', '合同已确认',
      `承包方已确认合同 ${contract.id}，任务进入执行中`, 'contract', contractId);
    this.audit({
      actorId,
      action: 'contract.confirm',
      entityType: 'contract',
      entityId: contractId,
      targetUserId: contract.employer_id,
      detail: { amount: contract.amount },
    });
    return this.getContract(contractId);
  }

  // ────────────────── 交付物 ──────────────────

  submitDelivery(input: { contractId: string; submitterId: string; content: string }): DeliveryRow {
    const contract = this.getContract(input.contractId);
    if (contract.contractor_id !== input.submitterId) throw new MvpMarketError(403, 'forbidden', '只有承包方可以提交交付物');
    if (contract.status !== 'active' && contract.status !== 'delivered') {
      throw new MvpMarketError(409, 'invalid_state', `合同当前状态 ${contract.status} 不可提交交付物`);
    }
    const content = String(input.content ?? '').trim();
    if (!content) throw new MvpMarketError(400, 'invalid_content', '交付内容不能为空');
    if (content.length > 50000) throw new MvpMarketError(400, 'invalid_content', '交付内容过长（≤50000字符）');

    // 轮次：被要求修改后重新提交则 +1
    const last = this.one<DeliveryRow>(
      `SELECT * FROM mvp_deliveries WHERE contract_id = ? ORDER BY round DESC LIMIT 1`, [contract.id]);
    const round = last && last.status === 'revision_requested' ? last.round + 1 : 1;

    const now = this.now();
    const delivery: DeliveryRow = {
      id: this.id('deliv'),
      contract_id: contract.id,
      submitter_id: input.submitterId,
      round,
      content,
      status: 'submitted',
      review_note: '',
      created_at: now,
      reviewed_at: null,
    };
    this.run(
      `INSERT INTO mvp_deliveries (id, contract_id, submitter_id, round, content, status, review_note, created_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, 'submitted', '', ?, NULL)`,
      [delivery.id, delivery.contract_id, delivery.submitter_id, delivery.round, delivery.content, delivery.created_at],
    );
    this.run(`UPDATE mvp_contracts SET status = 'delivered', updated_at = ? WHERE id = ?`, [now, contract.id]);
    this.run(`UPDATE mvp_tasks SET status = 'delivered', updated_at = ? WHERE id = ?`, [now, contract.task_id]);
    this.notify(contract.employer_id, 'delivery.new', '收到交付物',
      `合同 ${contract.id} 第 ${round} 轮交付物已提交，请验收`, 'contract', contract.id);
    this.audit({
      actorId: input.submitterId,
      action: 'delivery.submit',
      entityType: 'delivery',
      entityId: delivery.id,
      targetUserId: contract.employer_id,
      detail: { contractId: contract.id, round, length: content.length },
    });
    return delivery;
  }

  getDelivery(deliveryId: string): DeliveryRow {
    const row = this.one<DeliveryRow>(`SELECT * FROM mvp_deliveries WHERE id = ?`, [deliveryId]);
    if (!row) throw new MvpMarketError(404, 'not_found', '交付物不存在');
    return row;
  }

  listDeliveries(contractId: string): DeliveryRow[] {
    return this.all<DeliveryRow>(`SELECT * FROM mvp_deliveries WHERE contract_id = ? ORDER BY round ASC`, [contractId]);
  }

  /** 验收：雇主接受交付物 → 合同 accepted → 生成模拟结算 */
  acceptDelivery(actorId: string, deliveryId: string, idempotencyKey?: string | null): { delivery: DeliveryRow; contract: ContractRow; settlement: any; replayed?: boolean } {
    const delivery = this.getDelivery(deliveryId);
    const contract = this.getContract(delivery.contract_id);
    if (contract.employer_id !== actorId) throw new MvpMarketError(403, 'forbidden', '只有雇主可以验收交付物');
    if (delivery.status !== 'submitted') {
      throw new MvpMarketError(409, 'invalid_state', `交付物当前状态 ${delivery.status} 不可验收`);
    }
    if (contract.status !== 'delivered') {
      throw new MvpMarketError(409, 'invalid_state', `合同当前状态 ${contract.status} 不可验收`);
    }
    return this.idempotent(idempotencyKey, 'delivery.accept', () => this.transaction(() => {
    const now = this.now();
    this.run(`UPDATE mvp_deliveries SET status = 'accepted', reviewed_at = ? WHERE id = ?`, [now, deliveryId]);
    this.run(`UPDATE mvp_contracts SET status = 'accepted', updated_at = ? WHERE id = ?`, [now, contract.id]);
    this.run(`UPDATE mvp_tasks SET status = 'completed', updated_at = ? WHERE id = ?`, [now, contract.task_id]);

    // 真实资金：预算已在 createTask 扣留，此处只做分账（不重复扣雇主）
    const rate = this.feeRate(contract.contractor_id, contract.amount, contract.currency);
    const { pay, fee } = this.payout(
      contract.contractor_id, contract.currency, contract.amount,
      `任务收入(${Math.round((1 - rate) * 100)}%): ${contract.id}`,
      { contractId: contract.id, payerId: contract.employer_id, kind: 'release' },
    );

    const settlement = this.createSettlement({
      contractId: contract.id,
      payerId: contract.employer_id,
      payeeId: contract.contractor_id,
      amount: contract.amount,
      currency: contract.currency,
      kind: 'release',
      note: `验收通过，合同 ${contract.id} 结算（实付 ${pay}，平台抽成 ${fee}）`,
    });

    this.notify(contract.contractor_id, 'delivery.accepted', '交付物已验收',
      `合同 ${contract.id} 的交付物已通过验收，结算 ${contract.amount} ${contract.currency}`, 'contract', contract.id);
    this.audit({
      actorId,
      action: 'delivery.accept',
      entityType: 'delivery',
      entityId: deliveryId,
      targetUserId: contract.contractor_id,
      detail: { contractId: contract.id, settlementId: settlement.id, amount: contract.amount, pay, fee, feeRate: rate },
    });
    return { delivery: this.getDelivery(deliveryId), contract: this.getContract(contract.id), settlement };
    }));
  }

  /** 要求修改：雇主退回交付物，合同回到 active 允许再次提交 */
  requestRevision(actorId: string, deliveryId: string, note: string): DeliveryRow {
    const delivery = this.getDelivery(deliveryId);
    const contract = this.getContract(delivery.contract_id);
    if (contract.employer_id !== actorId) throw new MvpMarketError(403, 'forbidden', '只有雇主可以要求修改');
    if (delivery.status !== 'submitted') {
      throw new MvpMarketError(409, 'invalid_state', `交付物当前状态 ${delivery.status} 不可要求修改`);
    }
    const reviewNote = String(note ?? '').trim();
    if (!reviewNote) throw new MvpMarketError(400, 'invalid_note', '要求修改必须填写修改意见');
    const now = this.now();
    this.run(`UPDATE mvp_deliveries SET status = 'revision_requested', review_note = ?, reviewed_at = ? WHERE id = ?`,
      [reviewNote.slice(0, 2000), now, deliveryId]);
    this.run(`UPDATE mvp_contracts SET status = 'active', updated_at = ? WHERE id = ?`, [now, contract.id]);
    this.run(`UPDATE mvp_tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`, [now, contract.task_id]);
    this.notify(contract.contractor_id, 'delivery.revision', '交付物被要求修改',
      `合同 ${contract.id} 第 ${delivery.round} 轮交付物需修改：${reviewNote.slice(0, 200)}`, 'contract', contract.id);
    this.audit({
      actorId,
      action: 'delivery.request_revision',
      entityType: 'delivery',
      entityId: deliveryId,
      targetUserId: contract.contractor_id,
      detail: { contractId: contract.id, round: delivery.round, note: reviewNote.slice(0, 500) },
    });
    return this.getDelivery(deliveryId);
  }

  // ────────────────── 评价 ──────────────────

  /** 雇主对承包方评价（1-5 星）。合同必须 accepted/completed。 */
  rateContract(actorId: string, contractId: string, rating: number, comment?: string): any {
    const contract = this.getContract(contractId);
    if (contract.employer_id !== actorId) throw new MvpMarketError(403, 'forbidden', '只有雇主可以评价');
    if (contract.status !== 'accepted' && contract.status !== 'completed') {
      throw new MvpMarketError(409, 'invalid_state', `合同当前状态 ${contract.status} 不可评价`);
    }
    const stars = Number(rating);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      throw new MvpMarketError(400, 'invalid_rating', '评分必须是 1-5 的整数');
    }
    const existing = this.one(`SELECT id FROM mvp_contract_ratings WHERE contract_id = ?`, [contractId]);
    if (existing) throw new MvpMarketError(409, 'already_rated', '该合同已评价过');

    const now = this.now();
    const ratingId = this.id('rate');
    this.run(
      `INSERT INTO mvp_contract_ratings (id, contract_id, rater_id, ratee_id, rating, comment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ratingId, contractId, actorId, contract.contractor_id, stars, String(comment ?? '').slice(0, 2000), now],
    );
    this.notify(contract.contractor_id, 'contract.rated', '收到评价',
      `合同 ${contractId} 获得 ${stars} 星评价`, 'contract', contractId);
    this.audit({
      actorId,
      action: 'contract.rate',
      entityType: 'contract',
      entityId: contractId,
      targetUserId: contract.contractor_id,
      detail: { rating: stars },
    });
    return this.one(`SELECT * FROM mvp_contract_ratings WHERE id = ?`, [ratingId]);
  }

  listRatingsForUser(userId: string): any[] {
    return this.all(`SELECT * FROM mvp_contract_ratings WHERE ratee_id = ? ORDER BY created_at DESC`, [userId]);
  }

  // ────────────────── 争议 ──────────────────

  /** 发起争议：雇主或承包方均可，合同需处于 active/delivered/accepted */
  openDispute(input: { contractId: string; initiatorId: string; reason: string; evidence?: string; deliveryId?: string | null }): DisputeRow {
    const contract = this.getContract(input.contractId);
    if (contract.employer_id !== input.initiatorId && contract.contractor_id !== input.initiatorId) {
      throw new MvpMarketError(403, 'forbidden', '只有合同双方可以发起争议');
    }
    if (!['active', 'delivered', 'accepted'].includes(contract.status)) {
      throw new MvpMarketError(409, 'invalid_state', `合同当前状态 ${contract.status} 不可发起争议`);
    }
    const reason = String(input.reason ?? '').trim();
    if (!reason) throw new MvpMarketError(400, 'invalid_reason', '争议原因不能为空');
    if (reason.length > 2000) throw new MvpMarketError(400, 'invalid_reason', '争议原因过长（≤2000字符）');

    const now = this.now();
    const dispute: DisputeRow = {
      id: this.id('disp'),
      contract_id: contract.id,
      delivery_id: input.deliveryId ?? null,
      initiator_id: input.initiatorId,
      reason,
      evidence: String(input.evidence ?? '').slice(0, 5000),
      status: 'open',
      resolution: '',
      resolver_id: null,
      refund_amount: 0,
      created_at: now,
      resolved_at: null,
    };
    this.run(
      `INSERT INTO mvp_disputes (id, contract_id, delivery_id, initiator_id, reason, evidence, status, resolution, resolver_id, refund_amount, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', '', NULL, 0, ?, NULL)`,
      [dispute.id, dispute.contract_id, dispute.delivery_id, dispute.initiator_id, dispute.reason,
        dispute.evidence, dispute.created_at],
    );
    this.run(`UPDATE mvp_contracts SET status = 'disputed', updated_at = ? WHERE id = ?`, [now, contract.id]);
    this.run(`UPDATE mvp_tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`, [now, contract.task_id]);

    const counterpart = contract.employer_id === input.initiatorId ? contract.contractor_id : contract.employer_id;
    this.notify(counterpart, 'dispute.open', '收到争议',
      `合同 ${contract.id} 被发起争议：${reason.slice(0, 100)}`, 'dispute', dispute.id);
    this.audit({
      actorId: input.initiatorId,
      action: 'dispute.open',
      entityType: 'dispute',
      entityId: dispute.id,
      targetUserId: counterpart,
      detail: { contractId: contract.id, reason: reason.slice(0, 500) },
    });
    return dispute;
  }

  getDispute(disputeId: string): DisputeRow {
    const row = this.one<DisputeRow>(`SELECT * FROM mvp_disputes WHERE id = ?`, [disputeId]);
    if (!row) throw new MvpMarketError(404, 'not_found', '争议不存在');
    return row;
  }

  listDisputes(opts: { status?: string; contractId?: string; limit?: number } = {}): DisputeRow[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts.contractId) { where.push('contract_id = ?'); params.push(opts.contractId); }
    params.push(Math.min(Math.max(1, opts.limit ?? 100), 500));
    const sql = `SELECT * FROM mvp_disputes ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    return this.all<DisputeRow>(sql, params);
  }

  /**
   * 管理员处理争议。
   * decision: 'release'（全额给承包方）| 'refund'（全额退雇主）| 'partial'（按 refundAmount 部分退）
   */
  resolveDispute(input: {
    adminId: string;
    disputeId: string;
    decision: 'release' | 'refund' | 'partial';
    resolution: string;
    refundAmount?: number;
    idempotencyKey?: string | null;
  }): { dispute: DisputeRow; contract: ContractRow; settlement: any; replayed?: boolean } {
    const dispute = this.getDispute(input.disputeId);
    if (dispute.status !== 'open' && dispute.status !== 'reviewing') {
      throw new MvpMarketError(409, 'invalid_state', `争议当前状态 ${dispute.status} 不可处理`);
    }
    const resolution = String(input.resolution ?? '').trim();
    if (!resolution) throw new MvpMarketError(400, 'invalid_resolution', '处理结论不能为空');

    const contract = this.getContract(dispute.contract_id);
    const now = this.now();
    let refund = 0;
    let nextContractStatus: ContractStatus;
    let kind: 'release' | 'refund' | 'partial_refund';

    if (input.decision === 'release') {
      refund = 0;
      nextContractStatus = 'completed';
      kind = 'release';
    } else if (input.decision === 'refund') {
      refund = contract.amount;
      nextContractStatus = 'cancelled';
      kind = 'refund';
    } else {
      refund = Math.floor(Number(input.refundAmount ?? 0));
      if (!Number.isFinite(refund) || refund <= 0 || refund >= contract.amount) {
        throw new MvpMarketError(400, 'invalid_refund', '部分退款金额必须在 (0, 合同金额) 之间');
      }
      nextContractStatus = 'completed';
      kind = 'partial_refund';
    }

    return this.idempotent(input.idempotencyKey, 'dispute.resolve', () => this.transaction(() => {
    this.run(
      `UPDATE mvp_disputes SET status = 'resolved', resolution = ?, resolver_id = ?, refund_amount = ?, resolved_at = ? WHERE id = ?`,
      [resolution.slice(0, 5000), input.adminId, refund, now, dispute.id],
    );
    this.run(`UPDATE mvp_contracts SET status = ?, updated_at = ? WHERE id = ?`, [nextContractStatus, now, contract.id]);
    this.run(`UPDATE mvp_tasks SET status = ?, updated_at = ? WHERE id = ?`,
      [nextContractStatus === 'cancelled' ? 'cancelled' : 'completed', now, contract.task_id]);

    // 争议仲裁 · 真实资金处理（金额已在 createTask 扣留）
    if (kind === 'refund') {
      // 全额退给雇主
      this.refundTo(contract.employer_id, contract.currency, contract.amount, `争议全额退款: ${contract.id}`);
    } else if (kind === 'partial_refund') {
      // 部分退雇主，剩余部分 90% 付承包方
      this.refundTo(contract.employer_id, contract.currency, refund, `争议部分退款: ${contract.id}`);
      this.payout(contract.contractor_id, contract.currency, contract.amount - refund,
        `争议后收入: ${contract.id}`, { contractId: contract.id, payerId: contract.employer_id, kind: 'partial_refund' });
    } else {
      // release：全额付承包方 90%
      this.payout(contract.contractor_id, contract.currency, contract.amount,
        `争议后收入: ${contract.id}`, { contractId: contract.id, payerId: contract.employer_id, kind: 'release' });
    }

    const settlement = this.createSettlement({
      contractId: contract.id,
      disputeId: dispute.id,
      payerId: contract.employer_id,
      payeeId: kind === 'refund' ? contract.employer_id : contract.contractor_id,
      amount: kind === 'refund' ? contract.amount : contract.amount - refund,
      currency: contract.currency,
      kind,
      note: `争议 ${dispute.id} 处理：${resolution.slice(0, 200)}`,
    });

    for (const uid of [contract.employer_id, contract.contractor_id]) {
      this.notify(uid, 'dispute.resolved', '争议已处理',
        `争议 ${dispute.id} 已由管理员处理：${resolution.slice(0, 150)}`, 'dispute', dispute.id);
    }
    this.audit({
      actorId: input.adminId,
      action: 'dispute.resolve',
      entityType: 'dispute',
      entityId: dispute.id,
      targetUserId: contract.contractor_id,
      detail: { contractId: contract.id, decision: input.decision, refund, settlementId: settlement.id },
    });
    return { dispute: this.getDispute(dispute.id), contract: this.getContract(contract.id), settlement };
    }));
  }

  // ────────────────── 模拟结算 ──────────────────

  /**
   * 生成模拟结算记录。
   * ⚠️ 这是「模拟」结算：只写流水记录，不调用任何真实支付通道、不触碰真实资金。
   */
  createSettlement(input: {
    contractId: string;
    disputeId?: string | null;
    payerId: string;
    payeeId: string;
    amount: number;
    currency?: string;
    kind: 'release' | 'refund' | 'partial_refund';
    note?: string;
  }): any {
    const amount = Math.floor(Number(input.amount));
    if (!Number.isFinite(amount) || amount < 0) throw new MvpMarketError(400, 'invalid_amount', '结算金额必须是非负数字');
    const id = this.id('settle');
    this.run(
      `INSERT INTO mvp_settlements (id, contract_id, dispute_id, payer_id, payee_id, amount, currency, kind, status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'simulated', ?, ?)`,
      [id, input.contractId, input.disputeId ?? null, input.payerId, input.payeeId, amount,
        input.currency ?? 'credits', input.kind, String(input.note ?? '').slice(0, 1000), this.now()],
    );
    return this.one(`SELECT * FROM mvp_settlements WHERE id = ?`, [id]);
  }

  listSettlements(opts: { userId?: string; contractId?: string; limit?: number } = {}): any[] {
    const where: string[] = [];
    const params: any[] = [];
    if (opts.userId) { where.push('(payer_id = ? OR payee_id = ?)'); params.push(opts.userId, opts.userId); }
    if (opts.contractId) { where.push('contract_id = ?'); params.push(opts.contractId); }
    params.push(Math.min(Math.max(1, opts.limit ?? 100), 500));
    const sql = `SELECT * FROM mvp_settlements ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC LIMIT ?`;
    return this.all(sql, params);
  }

  // ────────────────── 智能体预算 ──────────────────

  setAgentBudget(input: { agentId: string; ownerId: string; totalBudget: number; currency?: string; period?: string }): any {
    const total = Math.floor(Number(input.totalBudget));
    if (!Number.isFinite(total) || total < 0) throw new MvpMarketError(400, 'invalid_budget', '预算必须是非负数字');
    if (total > 1e12) throw new MvpMarketError(400, 'invalid_budget', '预算超出允许范围');
    const period = String(input.period ?? 'monthly');
    if (!['daily', 'weekly', 'monthly', 'total'].includes(period)) {
      throw new MvpMarketError(400, 'invalid_period', '预算周期必须是 daily/weekly/monthly/total');
    }
    const now = this.now();
    const existing = this.one(`SELECT * FROM mvp_agent_budgets WHERE agent_id = ?`, [input.agentId]);
    if (existing) {
      if (existing.owner_id !== input.ownerId) throw new MvpMarketError(403, 'forbidden', '无权修改他人智能体预算');
      this.run(`UPDATE mvp_agent_budgets SET total_budget = ?, currency = ?, period = ?, updated_at = ? WHERE agent_id = ?`,
        [total, input.currency ?? existing.currency, period, now, input.agentId]);
    } else {
      this.run(
        `INSERT INTO mvp_agent_budgets (agent_id, owner_id, total_budget, spent, currency, period, status, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, 'active', ?, ?)`,
        [input.agentId, input.ownerId, total, input.currency ?? 'credits', period, now, now],
      );
    }
    this.audit({
      actorId: input.ownerId,
      action: 'agent_budget.set',
      entityType: 'agent_budget',
      entityId: input.agentId,
      detail: { totalBudget: total, period },
    });
    return this.one(`SELECT * FROM mvp_agent_budgets WHERE agent_id = ?`, [input.agentId]);
  }

  getAgentBudget(agentId: string): any {
    return this.one(`SELECT * FROM mvp_agent_budgets WHERE agent_id = ?`, [agentId]);
  }

  /** 智能体花费记账。超预算时拒绝。 */
  spendAgentBudget(input: { agentId: string; ownerId: string; amount: number; reason: string }): any {
    const budget = this.getAgentBudget(input.agentId);
    if (!budget) throw new MvpMarketError(404, 'not_found', '智能体预算未设置');
    if (budget.owner_id !== input.ownerId) throw new MvpMarketError(403, 'forbidden', '无权操作他人智能体预算');
    const amount = Math.floor(Number(input.amount));
    if (!Number.isFinite(amount) || amount <= 0) throw new MvpMarketError(400, 'invalid_amount', '花费金额必须是正数');
    if (budget.spent + amount > budget.total_budget) {
      throw new MvpMarketError(409, 'budget_exceeded',
        `超出预算：已用 ${budget.spent}，本次 ${amount}，上限 ${budget.total_budget}`);
    }
    this.run(`UPDATE mvp_agent_budgets SET spent = spent + ?, updated_at = ? WHERE agent_id = ?`,
      [amount, this.now(), input.agentId]);
    this.audit({
      actorId: input.ownerId,
      action: 'agent_budget.spend',
      entityType: 'agent_budget',
      entityId: input.agentId,
      detail: { amount, reason: String(input.reason).slice(0, 200), spentAfter: budget.spent + amount },
    });
    return this.getAgentBudget(input.agentId);
  }

  // ────────────────── 智能体任务建议 ──────────────────

  /**
   * 基于智能体已配置技能 + 当前开放任务，生成任务建议。
   * 纯本地规则匹配，不调用外部模型（可测、无副作用）。
   */
  generateTaskSuggestions(input: { agentId: string; ownerId: string; skills: string[]; limit?: number }): any[] {
    const agentId = String(input.agentId ?? '').trim();
    if (!agentId) throw new MvpMarketError(400, 'invalid_agent', 'agentId 不能为空');
    const skills = (Array.isArray(input.skills) ? input.skills : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 20);

    const openTasks = this.all<any>(
      `SELECT * FROM mvp_tasks WHERE status IN ('open','quoted') ORDER BY created_at DESC LIMIT 200`, []);

    const scored = openTasks.map((t) => {
      const haystack = `${t.title} ${t.description} ${t.category}`.toLowerCase();
      const matched = skills.filter((s) => s && haystack.includes(s));
      const score = matched.length;
      return { task: t, matched, score };
    }).filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.task.budget - b.task.budget)
      .slice(0, Math.min(Math.max(1, input.limit ?? 5), 20));

    const out = scored.map((r) => {
      const id = this.id('sugg');
      this.run(
        `INSERT INTO mvp_agent_task_suggestions (id, agent_id, owner_id, title, rationale, skill_match, est_budget, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
        [id, agentId, input.ownerId, r.task.title,
          `匹配技能 ${r.matched.join('、')}；任务预算 ${r.task.budget} ${r.task.currency}`,
          JSON.stringify(r.matched), r.task.budget, this.now()],
      );
      return this.one(`SELECT * FROM mvp_agent_task_suggestions WHERE id = ?`, [id]);
    });

    this.audit({
      actorId: input.ownerId,
      action: 'agent_suggestion.generate',
      entityType: 'agent',
      entityId: agentId,
      detail: { skills, generated: out.length },
    });
    return out;
  }

  listTaskSuggestions(agentId: string, ownerId: string): any[] {
    return this.all(
      `SELECT * FROM mvp_agent_task_suggestions WHERE agent_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 100`,
      [agentId, ownerId]);
  }
}
