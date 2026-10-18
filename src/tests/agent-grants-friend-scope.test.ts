/**
 * 追加用例：好友范围规则
 *  - 非好友的共享/本机 Agent：保持历史行为（allowed, not_friend_agent）
 *  - 好友的 Agent：仍必须授权（回归保护）
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
});

afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('好友范围规则', () => {
  it('好友的 AI 未授权 → 拒绝', () => {
    const r = grants.canUseAgent('agent-frd', 'u-me', { chatId: 'c1' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('no_grant');
  });

  it('非好友的共享/本机 AI → 放行（不误伤老用户）', () => {
    const r = grants.canUseAgent('agent-shared', 'u-me', { chatId: 'c1' });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('not_friend_agent');
  });

  it('自己绑定的 AI（users.agent_id）→ owner', () => {
    ins("UPDATE users SET agent_id='agent-shared' WHERE id='u-me'");
    const r = grants.canUseAgent('agent-shared', 'u-me', {});
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe('owner');
    ins("UPDATE users SET agent_id=NULL WHERE id='u-me'");
  });
});
