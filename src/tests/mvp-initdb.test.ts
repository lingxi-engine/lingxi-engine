/**
 * 灵犀 MVP 闭环 — 真实启动路径迁移验证
 *
 * 与 mvp-market.test.ts（手动调用 MVP_MARKET_MIGRATION.up）不同，
 * 本测试走真实的 initDB() 完整迁移链（_dbInit → runMigrations → 账本记账），
 * 验证生产环境启动时 MVP 的 11 张表确实能建出来、账本一致无漂移。
 * 防止未来迁移注册被误删/改名后静默失效。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDB, getDB, closeDB, getSchemaStatus } from '../storage/db.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const MVP_MIGRATION_ID = '20260923_001_mvp_market_loop';

const MVP_TABLES = [
  'mvp_tasks',
  'mvp_quotes',
  'mvp_contracts',
  'mvp_deliveries',
  'mvp_contract_ratings',
  'mvp_disputes',
  'mvp_settlements',
  'mvp_notifications',
  'mvp_audit_logs',
  'mvp_agent_budgets',
  'mvp_agent_task_suggestions',
] as const;

describe('MVP 迁移 · initDB 全链路', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-initdb-test-'));
    await initDB(path.join(tmp, 'test.db'));
  });

  afterAll(async () => {
    try { await closeDB(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it('通过真实 initDB() 建出全部 11 张 MVP 表', () => {
    const db = getDB();
    for (const t of MVP_TABLES) {
      const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`);
      expect(r[0]?.values?.length, `表 ${t} 缺失`).toBeGreaterThan(0);
    }
  });

  it('迁移账本记录 MVP 迁移已应用，且无 pending、无漂移', () => {
    const st = getSchemaStatus();
    expect(st.applied, 'MVP 迁移应已应用').toContain(MVP_MIGRATION_ID);
    expect(st.pending, '不应存在未执行迁移').toEqual([]);
    expect(st.drift, '表结构不应有漂移').toEqual([]);
  });

  it('MVP 核心表结构包含关键状态列（状态机可用）', () => {
    const db = getDB();
    // 抽查任务表与报价表的关键列，确认迁移不只是建了空壳表
    const taskCols = db.exec(`PRAGMA table_info(mvp_tasks)`)[0]?.values?.map((r: any) => r[1]) ?? [];
    const quoteCols = db.exec(`PRAGMA table_info(mvp_quotes)`)[0]?.values?.map((r: any) => r[1]) ?? [];
    expect(taskCols).toEqual(expect.arrayContaining(['status', 'employer_id', 'budget', 'title']));
    expect(quoteCols).toEqual(expect.arrayContaining(['status', 'task_id', 'bidder_id', 'amount']));
  });
});
