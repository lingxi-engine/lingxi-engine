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
    // 取消任务时，连带撤回所有待处理报价
    this.run(`UPDATE mvp_quotes SET status = 'withdrawn', updated_at = ? WHERE task_id = ? AND status = 'pending'`, [this.now(), taskId]);
    this.run(`UPDATE mvp_tasks SET status = 'cancelled', updated_at = ? WHERE id = ?`, [this.now(), taskId]);
    this.audit({ actorId, action: 'task.cancel', entityType: 'task', entityId: taskId, detail: { from: task.status } });
    return this.getTask(taskId);
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

  acceptQuote(actorId: string, quoteId: string, terms?: string): ContractRow {
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
  acceptDelivery(actorId: string, deliveryId: string): { delivery: DeliveryRow; contract: ContractRow; settlement: any } {
    const delivery = this.getDelivery(deliveryId);
    const contract = this.getContract(delivery.contract_id);
    if (contract.employer_id !== actorId) throw new MvpMarketError(403, 'forbidden', '只有雇主可以验收交付物');
    if (delivery.status !== 'submitted') {
      throw new MvpMarketError(409, 'invalid_state', `交付物当前状态 ${delivery.status} 不可验收`);
    }
    if (contract.status !== 'delivered') {
      throw new MvpMarketError(409, 'invalid_state', `合同当前状态 ${contract.status} 不可验收`);
    }
    const now = this.now();
    this.run(`UPDATE mvp_deliveries SET status = 'accepted', reviewed_at = ? WHERE id = ?`, [now, deliveryId]);
    this.run(`UPDATE mvp_contracts SET status = 'accepted', updated_at = ? WHERE id = ?`, [now, contract.id]);
    this.run(`UPDATE mvp_tasks SET status = 'completed', updated_at = ? WHERE id = ?`, [now, contract.task_id]);

    const settlement = this.createSettlement({
      contractId: contract.id,
      payerId: contract.employer_id,
      payeeId: contract.contractor_id,
      amount: contract.amount,
      currency: contract.currency,
      kind: 'release',
      note: `验收通过，合同 ${contract.id} 结算`,
    });

    this.notify(contract.contractor_id, 'delivery.accepted', '交付物已验收',
      `合同 ${contract.id} 的交付物已通过验收，结算 ${contract.amount} ${contract.currency}`, 'contract', contract.id);
    this.audit({
      actorId,
      action: 'delivery.accept',
      entityType: 'delivery',
      entityId: deliveryId,
      targetUserId: contract.contractor_id,
      detail: { contractId: contract.id, settlementId: settlement.id, amount: contract.amount },
    });
    return { delivery: this.getDelivery(deliveryId), contract: this.getContract(contract.id), settlement };
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
  }): { dispute: DisputeRow; contract: ContractRow; settlement: any } {
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

    this.run(
      `UPDATE mvp_disputes SET status = 'resolved', resolution = ?, resolver_id = ?, refund_amount = ?, resolved_at = ? WHERE id = ?`,
      [resolution.slice(0, 5000), input.adminId, refund, now, dispute.id],
    );
    this.run(`UPDATE mvp_contracts SET status = ?, updated_at = ? WHERE id = ?`, [nextContractStatus, now, contract.id]);
    this.run(`UPDATE mvp_tasks SET status = ?, updated_at = ? WHERE id = ?`,
      [nextContractStatus === 'cancelled' ? 'cancelled' : 'completed', now, contract.task_id]);

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
