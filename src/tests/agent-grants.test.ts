/**
 * AI 使用权授权（agent_grants）— 回归测试
 *
 * 锁死需求：「加好友后默认没有授权，需 AI 主人同意；授权范围限定某群或好友」。
 * 不变式：
 *   1. 默认拒绝（无记录 → no_grant）
 *   2. 自己 owner 永远可用
 *   3. scope=group 只对指定 chatId 生效
 *   4. 撤销后立即失效
 *   5. 过期后自动失效（惰性判定）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let db: any;
let grants: any;

function ins(sql: string, params: any[] = []) {
  db.getDB().run(sql, params);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-test-'));
  process.env.LINGXI_DATA_DIR = tmpDir;
  process.env.LINGXI_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.FEATURE_AGENT_GRANTS = 'on';
  db = await import('../storage/db.js');
  await db.initDB(path.join(tmpDir, 'test.db'));
  grants = await import('../routes/agent-grants.js');
  grants.ensureAgentGrantsSchema();

  const t = Date.now();
  ins('INSERT INTO users (id, display_name, created_at, numeric_id) VALUES (?,?,?,?)', ['u-owner', '主人', t, 20001]);
  ins('INSERT INTO users (id, display_name, created_at, numeric_id) VALUES (?,?,?,?)', ['u-peer', '借用者', t, 20002]);
  ins('INSERT INTO agents (id, user_id, display_name, created_at) VALUES (?,?,?,?)', ['agent-owner', 'u-owner', '主人的AI', t]);
  ins('INSERT INTO agents (id, user_id, display_name, created_at) VALUES (?,?,?,?)', ['agent-peer', 'u-peer', '借用者的AI', t]);
  ins(
    'INSERT INTO friendships (id, from_user_id, to_user_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ['fr-1', 'u-owner', 'u-peer', 'accepted', t, t]
  );
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('canUseAgent — 默认拒绝 / 显式同意 / 范围限制', () => {
  it('加了好友但没授权 → 拒绝（no_grant）', () => {
    const r = grants.canUseAgent('agent-owner', 'u-peer', { chatId: 'chat-A' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_grant');
  });

  it('自己的 AI 永远可用（owner）', () => {
    const r = grants.canUseAgent('agent-peer', 'u-peer', {});
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('owner');
  });

  it('pending 状态 → 仍拒绝，理由是 pending_approval', () => {
    ins(`INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ['g-pending', 'agent-owner', 'u-owner', 'u-peer', 'group', 'chat-A', 'pending', Date.now()]);
    const r = grants.canUseAgent('agent-owner', 'u-peer', { chatId: 'chat-A' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('pending_approval');
  });

  it('accepted + 范围内 → 允许', () => {
    ins(`INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ['g-ok', 'agent-owner', 'u-owner', 'u-peer', 'group', 'chat-A', 'accepted', Date.now()]);
    const ok = grants.canUseAgent('agent-owner', 'u-peer', { chatId: 'chat-A' });
    expect(ok.allowed).toBe(true);
    expect(ok.reason).toBe('granted');
  });

  it('accepted 但换一个群 → 拒绝（out_of_scope）', () => {
    const r = grants.canUseAgent('agent-owner', 'u-peer', { chatId: 'chat-B' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('out_of_scope');
  });

  it('撤销后立即失效', () => {
    ins(`DELETE FROM agent_grants WHERE id='g-pending'`);
    ins(`UPDATE agent_grants SET status='revoked' WHERE id='g-ok'`);
    const r = grants.canUseAgent('agent-owner', 'u-peer', { chatId: 'chat-A' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_grant');
  });

  it('过期授权自动失效（惰性判定为 expired）', () => {
    const past = Date.now() - 1000;
    ins(`INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, status, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ['g-expired', 'agent-owner', 'u-owner', 'u-peer', 'group', 'chat-C', 'accepted', past - 10000, past]);
    const r = grants.canUseAgent('agent-owner', 'u-peer', { chatId: 'chat-C' });
    expect(r.allowed).toBe(false);
    const st = db.getDB().prepare(`SELECT status FROM agent_grants WHERE id='g-expired'`);
    st.step();
    expect(st.getAsObject().status).toBe('expired');
    st.free();
  });

  it('功能开关 off 时回退旧行为（允许）', () => {
    const prev = process.env.FEATURE_AGENT_GRANTS;
    process.env.FEATURE_AGENT_GRANTS = 'off';
    const r = grants.canUseAgent('agent-owner', 'u-peer', { chatId: 'chat-Z' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('feature_disabled');
    process.env.FEATURE_AGENT_GRANTS = prev;
  });

  it('管理员虚拟身份旁路（本地免登录不误伤）', () => {
    const r = grants.canUseAgent('agent-owner', 'admin-auto', {});
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('bypass_identity');
  });
});
