/**
 * 追加用例：好友范围规则
 *  - 好友的 Agent：必须授权（回归保护）
 *  - 非好友的 Agent：默认拒绝（安全），唯一例外是该 AI 本来就在这个群里
 *      · 不在群里 → denied / not_friend_agent
 *      · 已在群里 → allowed / already_participant
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let db: any;
let grants: any;
const ins = (sql: string, p: any[] = []) => db.getDB().run(sql, p);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-friend-'));
  process.env.LINGXI_DATA_DIR = tmpDir;
  process.env.LINGXI_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.FEATURE_AGENT_GRANTS = 'on';
  db = await import('../storage/db.js');
  await db.initDB(path.join(tmpDir, 'test.db'));
  grants = await import('../routes/agent-grants.js');
  grants.ensureAgentGrantsSchema();

  const t = Date.now();
  ins('INSERT INTO users (id, display_name, created_at, numeric_id) VALUES (?,?,?,?)', ['u-me', '我', t, 30001]);
  ins('INSERT INTO users (id, display_name, created_at, numeric_id) VALUES (?,?,?,?)', ['u-frd', '好友', t, 30002]);
  ins('INSERT INTO users (id, display_name, created_at, numeric_id) VALUES (?,?,?,?)', ['user-shared', '本机', t, 9999]);
  ins('INSERT INTO agents (id, user_id, display_name, created_at) VALUES (?,?,?,?)', ['agent-frd', 'u-frd', '好友AI', t]);
  ins('INSERT INTO agents (id, user_id, display_name, created_at) VALUES (?,?,?,?)', ['agent-shared', 'user-shared', '共享AI', t]);
  ins('INSERT INTO friendships (id, from_user_id, to_user_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    ['f-1', 'u-me', 'u-frd', 'accepted', t, t]);

  // 一个「共享 AI 本来就在里面」的群，用于豁免场景
  ins('INSERT INTO chats (id, type, name, created_at) VALUES (?,?,?,?)', ['c-has-shared', 'group', '存量群', t]);
  ins('INSERT INTO participants (id, chat_id, agent_id, role, joined_at) VALUES (?,?,?,?,?)',
    ['p-existing', 'c-has-shared', 'agent-shared', 'member', t]);
});

afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('好友范围规则', () => {
  it('好友的 AI 未授权 → 拒绝', () => {
    const r = grants.canUseAgent('agent-frd', 'u-me', { chatId: 'c1' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_grant');
  });

  it('非好友的 AI 且不在该群 → 拒绝（安全，禁止白嫖）', () => {
    const r = grants.canUseAgent('agent-shared', 'u-me', { chatId: 'c1' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_friend_agent');
  });

  it('非好友的 AI 但本来就在该群 → 放行（不打断存量群聊）', () => {
    const r = grants.canUseAgent('agent-shared', 'u-me', { chatId: 'c-has-shared' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('already_participant');
  });

  it('拒绝文案可读化：not_friend_agent 有专属提示', () => {
    const msg = grants.grantDeniedMessage('not_friend_agent');
    expect(msg).toContain('先加对方为好友');
  });

  it('自己绑定的 AI（users.agent_id）→ owner', () => {
    ins("UPDATE users SET agent_id='agent-shared' WHERE id='u-me'");
    const r = grants.canUseAgent('agent-shared', 'u-me', {});
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('owner');
    ins("UPDATE users SET agent_id=NULL WHERE id='u-me'");
  });
});
