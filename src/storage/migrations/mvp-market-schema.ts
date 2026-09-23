/**
 * 灵犀 MVP 闭环 — 数据库迁移（任务市场 / 报价 / 合同 / 交付 / 争议 / 结算 / 通知 / 审计）
 *
 * 设计约束（来自仓库现状）：
 *  - 不修改 db.ts 主体（CI ratchet 上限 2300 行，当前 2270）
 *  - 不修改 index.ts 主体（CI ratchet 上限 4900 行，当前 4853）
 *  - 只在本文件内完成建表，并通过 db.ts 的 MIGRATIONS 数组注册
 *
 * 安全约束：
 *  - 所有表均为 CREATE TABLE IF NOT EXISTS，幂等可重入
 *  - 所有状态字段使用受限字符串集合，由路由层状态机校验
 *  - 不含任何真实密钥、Token、支付凭据
 *  - 结算为「模拟结算」：仅记录流水，不接任何真实支付通道
 */

export interface Migration {
  id: string;
  description: string;
  up: (db: any) => void;
}

/** MVP 市场闭环全部数据表（幂等建表） */
export const MVP_MARKET_MIGRATION: Migration = {
  id: '20260923_001_mvp_market_loop',
  description:
    'MVP 闭环：tasks/quotes/contracts/deliveries/ratings/disputes/settlements/notifications/audit_logs/agent_budgets/suggestions',
  up: (db) => {
    // ── 任务（雇主发布的需求） ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_tasks (
        id            TEXT PRIMARY KEY,
        employer_id   TEXT NOT NULL,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        category      TEXT NOT NULL DEFAULT '通用',
        budget        INTEGER NOT NULL DEFAULT 0,
        currency      TEXT NOT NULL DEFAULT 'credits',
        status        TEXT NOT NULL DEFAULT 'open',
        accepted_quote_id TEXT,
        contract_id   TEXT,
        deadline_at   INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_tasks_employer ON mvp_tasks(employer_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_tasks_status ON mvp_tasks(status, created_at DESC)`);

    // ── 报价（服务方对任务出价） ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_quotes (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        bidder_id     TEXT NOT NULL,
        amount        INTEGER NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'credits',
        message       TEXT NOT NULL DEFAULT '',
        delivery_days INTEGER NOT NULL DEFAULT 3,
        status        TEXT NOT NULL DEFAULT 'pending',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_quotes_task ON mvp_quotes(task_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_quotes_bidder ON mvp_quotes(bidder_id, created_at DESC)`);
    // 同一投标人对同一任务只允许一条有效报价（防刷单，数据库级兜底）
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_mvp_quote_active
      ON mvp_quotes(task_id, bidder_id) WHERE status IN ('pending','accepted')
    `);

    // ── 合同（接受报价后生成） ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_contracts (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL,
        quote_id      TEXT NOT NULL,
        employer_id   TEXT NOT NULL,
        contractor_id TEXT NOT NULL,
        amount        INTEGER NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'credits',
        status        TEXT NOT NULL DEFAULT 'pending_confirm',
        terms         TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        confirmed_at  INTEGER
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_contracts_employer ON mvp_contracts(employer_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_contracts_contractor ON mvp_contracts(contractor_id, created_at DESC)`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_mvp_contract_quote ON mvp_contracts(quote_id)`);

    // ── 交付物（文本交付） ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_deliveries (
        id            TEXT PRIMARY KEY,
        contract_id   TEXT NOT NULL,
        submitter_id  TEXT NOT NULL,
        round         INTEGER NOT NULL DEFAULT 1,
        content       TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'submitted',
        review_note   TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        reviewed_at   INTEGER
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_deliveries_contract ON mvp_deliveries(contract_id, round DESC)`);

    // ── 合同评价（雇主 → 承包方） ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_contract_ratings (
        id            TEXT PRIMARY KEY,
        contract_id   TEXT NOT NULL,
        rater_id      TEXT NOT NULL,
        ratee_id      TEXT NOT NULL,
        rating        INTEGER NOT NULL,
        comment       TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL
      )
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_mvp_rating_contract ON mvp_contract_ratings(contract_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_rating_ratee ON mvp_contract_ratings(ratee_id, created_at DESC)`);

    // ── 争议 ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_disputes (
        id            TEXT PRIMARY KEY,
        contract_id   TEXT NOT NULL,
        delivery_id   TEXT,
        initiator_id  TEXT NOT NULL,
        reason        TEXT NOT NULL,
        evidence      TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'open',
        resolution    TEXT NOT NULL DEFAULT '',
        resolver_id   TEXT,
        refund_amount INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        resolved_at   INTEGER
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_disputes_contract ON mvp_disputes(contract_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_disputes_status ON mvp_disputes(status, created_at DESC)`);
    // 同一合同同时只允许一条未结争议
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_mvp_dispute_open
      ON mvp_disputes(contract_id) WHERE status IN ('open','reviewing')
    `);

    // ── 模拟结算记录（不接真实支付） ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_settlements (
        id            TEXT PRIMARY KEY,
        contract_id   TEXT NOT NULL,
        dispute_id    TEXT,
        payer_id      TEXT NOT NULL,
        payee_id      TEXT NOT NULL,
        amount        INTEGER NOT NULL,
        currency      TEXT NOT NULL DEFAULT 'credits',
        kind          TEXT NOT NULL DEFAULT 'release',
        status        TEXT NOT NULL DEFAULT 'simulated',
        note          TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_settlements_contract ON mvp_settlements(contract_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_settlements_user ON mvp_settlements(payer_id, created_at DESC)`);

    // ── 通知（收件箱） ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_notifications (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        type          TEXT NOT NULL,
        title         TEXT NOT NULL,
        content       TEXT NOT NULL DEFAULT '',
        ref_type      TEXT,
        ref_id        TEXT,
        read          INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_notif_user ON mvp_notifications(user_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_notif_unread ON mvp_notifications(user_id, read, created_at DESC)`);

    // ── 审计日志（所有重要业务操作的不可抵赖记录） ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_audit_logs (
        id            TEXT PRIMARY KEY,
        actor_id      TEXT NOT NULL,
        action        TEXT NOT NULL,
        entity_type   TEXT NOT NULL,
        entity_id     TEXT NOT NULL,
        target_user_id TEXT,
        detail        TEXT NOT NULL DEFAULT '{}',
        ip            TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_audit_actor ON mvp_audit_logs(actor_id, created_at DESC)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_audit_entity ON mvp_audit_logs(entity_type, entity_id, created_at DESC)`);

    // ── 智能体预算 ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_agent_budgets (
        agent_id      TEXT PRIMARY KEY,
        owner_id      TEXT NOT NULL,
        total_budget  INTEGER NOT NULL DEFAULT 0,
        spent         INTEGER NOT NULL DEFAULT 0,
        currency      TEXT NOT NULL DEFAULT 'credits',
        period        TEXT NOT NULL DEFAULT 'monthly',
        status        TEXT NOT NULL DEFAULT 'active',
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_agent_budgets_owner ON mvp_agent_budgets(owner_id, created_at DESC)`);

    // ── 智能体任务建议 ──
    db.run(`
      CREATE TABLE IF NOT EXISTS mvp_agent_task_suggestions (
        id            TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        owner_id      TEXT NOT NULL,
        title         TEXT NOT NULL,
        rationale     TEXT NOT NULL DEFAULT '',
        skill_match   TEXT NOT NULL DEFAULT '[]',
        est_budget    INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'new',
        created_at    INTEGER NOT NULL
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mvp_sugg_agent ON mvp_agent_task_suggestions(agent_id, created_at DESC)`);
  },
};
