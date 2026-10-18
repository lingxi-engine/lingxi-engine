/**
 * AI 授权 v1.2 — 新增能力回归
 *
 * 覆盖文档《AI授权方案 v1.1》第十节「后续可做」三项：
 *   1. 群聊多人场景：3 人以上群逐个成员都要有授权，不再只补第一个人
 *   2. 授权续期提醒：到期前 1 天推送，且只推一次（reminded_at 去重）
 *   3. 按技能/工具维度细分授权：白名单外的工具拒绝（tool_not_granted）
 *
 * 附带：主人批量授权 / 批量审批 / 续期 接口
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

let tmpDir: string;
let db: any;
let grants: any;
let app: any;

const ins = (sql: string, p: any[] = []) => db.getDB().run(sql, p);
const now = () => Date.now();

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-v12-'));
  process.env.LINGXI_DATA_DIR = tmpDir;
  process.env.LINGXI_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.FEATURE_AGENT_GRANTS = 'on';
  db = await import('../storage/db.js');
  await db.initDB(path.join(tmpDir, 'test.db'));
  grants = await import('../routes/agent-grants.js');
  grants.ensureAgentGrantsSchema();

  const t = now();
  // 主人 + 三个借用者（都跟主人是好友）
  ins('INSERT INTO users (id, display_name, created_at, numeric_id) VALUES (?,?,?,?)', ['u-owner', '主人', t, 21001]);
  for (const [id, name, nid] of [['u-a', '甲', 21002], ['u-b', '乙', 21003], ['u-c', '丙', 21004]]) {
    ins('INSERT INTO users (id, display_name, created_at, numeric_id) VALUES (?,?,?,?)', [id, name, t, nid]);
    ins('INSERT INTO friendships (id, from_user_id, to_user_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ['fr-' + id, 'u-owner', id, 'accepted', t, t]);
  }
  ins('INSERT INTO agents (id, user_id, display_name, created_at) VALUES (?,?,?,?)', ['agent-owner', 'u-owner', '主人AI', t]);

  // 3 人群：主人 + 甲乙丙
  ins('INSERT INTO chats (id, type, name, created_at) VALUES (?,?,?,?)', ['chat-3', 'group', '三人群', t]);
  ins('INSERT INTO participants (id, chat_id, user_id, role, joined_at) VALUES (?,?,?,?,?)', ['p-o', 'chat-3', 'u-owner', 'owner', t]);
  for (const u of ['u-a', 'u-b', 'u-c']) {
    ins('INSERT INTO participants (id, chat_id, user_id, role, joined_at) VALUES (?,?,?,?,?)', ['p-' + u, 'chat-3', u, 'member', t]);
  }

  app = express();
  app.use(express.json());
  const requireAuth: any = (req: any, _res: any, next: any) => {
    req.user = { sub: req.headers['x-uid'] || '' };
    next();
  };
  grants.registerAgentGrantsRoutes(app, { requireAuth, broadcast: () => {} });
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('① 群聊多人：存量迁移补齐每个成员', () => {
  it('3 人群一次迁移后，甲乙丙各自都有授权', () => {
    // 把主人的 AI 拉进群
    ins('INSERT INTO participants (id, chat_id, agent_id, role, joined_at) VALUES (?,?,?,?,?)',
      ['p-agent', 'chat-3', 'agent-owner', 'agent', now()]);
    const created = grants.migrateLegacyAgentParticipants();
    expect(created).toBe(3);
    for (const u of ['u-a', 'u-b', 'u-c']) {
      const r = grants.canUseAgent('agent-owner', u, { chatId: 'chat-3' });
      expect(r.allowed).toBe(true);
      expect(r.reason).toBe('granted');
    }
  });

  it('重复执行迁移是幂等的（不会重复补）', () => {
    const again = grants.migrateLegacyAgentParticipants();
    expect(again).toBe(0);
  });
});

describe('② 续期提醒：到期前 1 天提醒且只提醒一次', () => {
  it('24 小时内到期的授权会被提醒一次，第二次扫描为 0', () => {
    const t = now();
    ins(`INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, status, created_at, decided_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ['g-soon', 'agent-owner', 'u-owner', 'u-a', 'group', 'chat-3', 'accepted', t, t, t + 6 * 3600_000]);

    const first = grants.runGrantReminders();
    expect(first).toBeGreaterThanOrEqual(1);

    const row = db.getDB().exec(`SELECT reminded_at FROM agent_grants WHERE id='g-soon'`)[0]?.values?.[0]?.[0];
    expect(Number(row)).toBeGreaterThan(0);

    const second = grants.runGrantReminders();
    expect(second).toBe(0);
  });

  it('还早（>24h）的授权不提醒', () => {
    const t = now();
    ins(`INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, status, created_at, decided_at, expires_at, reminded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['g-later', 'agent-owner', 'u-owner', 'u-b', 'group', 'chat-3', 'accepted', t, t, t + 5 * 24 * 3600_000, 0]);
    grants.runGrantReminders();
    const v = db.getDB().exec(`SELECT reminded_at FROM agent_grants WHERE id='g-later'`)[0]?.values?.[0]?.[0];
    expect(Number(v)).toBe(0);
  });

  it('GET /api/agent-grants/expiring 分出「我是主人 / 我是借用人」', async () => {
    const asOwner = await request(app).get('/api/agent-grants/expiring').set('x-uid', 'u-owner');
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.asOwner.length).toBeGreaterThanOrEqual(1);

    const asGrantee = await request(app).get('/api/agent-grants/expiring').set('x-uid', 'u-a');
    expect(asGrantee.status).toBe(200);
    expect(asGrantee.body.asGrantee.length).toBeGreaterThanOrEqual(1);
    expect(asGrantee.body.asGrantee[0].hoursLeft).toBeGreaterThan(0);
  });
});

describe('③ 按技能维度细分授权', () => {
  it('授权限定 skills 后：白名单内工具放行，白名单外拒绝', () => {
    const t = now();
    ins(`INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, status, skills, created_at, decided_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['g-skill', 'agent-owner', 'u-owner', 'u-c', 'group', 'chat-skill', 'accepted', JSON.stringify(['web_search']), t, t, null]);

    const ok = grants.canUseAgent('agent-owner', 'u-c', { chatId: 'chat-skill', tool: 'web_search' });
    expect(ok.allowed).toBe(true);

    const bad = grants.canUseAgent('agent-owner', 'u-c', { chatId: 'chat-skill', tool: 'shell_exec' });
    expect(bad.allowed).toBe(false);
    expect(bad.reason).toBe('tool_not_granted');
  });

  it('skills 为空 = 不限制工具', () => {
    const r = grants.canUseAgent('agent-owner', 'u-b', { chatId: 'chat-3', tool: 'shell_exec' });
    expect(r.allowed).toBe(true);
  });

  it('POST /api/agent-grants/check-tool 返回细分结论', async () => {
    const r = await request(app)
      .post('/api/agent-grants/check-tool')
      .set('x-uid', 'u-c')
      .send({ agentId: 'agent-owner', chatId: 'chat-skill', tool: 'shell_exec' });
    expect(r.status).toBe(200);
    expect(r.body.allowed).toBe(false);
    expect(r.body.reason).toBe('tool_not_granted');
  });
});

describe('④ 主人批量授权 / 批量审批 / 续期', () => {
  it('批量授权整个群：一次给全员开通', async () => {
    const t = now();
    ins('INSERT INTO chats (id, type, name, created_at) VALUES (?,?,?,?)', ['chat-4', 'group', '新群', t]);
    ins('INSERT INTO participants (id, chat_id, user_id, role, joined_at) VALUES (?,?,?,?,?)', ['q-o', 'chat-4', 'u-owner', 'owner', t]);
    for (const u of ['u-a', 'u-b']) {
      ins('INSERT INTO participants (id, chat_id, user_id, role, joined_at) VALUES (?,?,?,?,?)', ['q-' + u, 'chat-4', u, 'member', t]);
    }

    const r = await request(app)
      .post('/api/agent-grants/bulk')
      .set('x-uid', 'u-owner')
      .send({ agentId: 'agent-owner', scope: 'group', chatId: 'chat-4', ttlHours: 24 });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(2);

    expect(grants.canUseAgent('agent-owner', 'u-a', { chatId: 'chat-4' }).allowed).toBe(true);
    expect(grants.canUseAgent('agent-owner', 'u-b', { chatId: 'chat-4' }).allowed).toBe(true);
  });

  it('非主人批量授权 → 403', async () => {
    const r = await request(app)
      .post('/api/agent-grants/bulk')
      .set('x-uid', 'u-a')
      .send({ agentId: 'agent-owner', scope: 'group', chatId: 'chat-4' });
    expect(r.status).toBe(403);
  });

  it('批量审批：一次同意多条 pending', async () => {
    const t = now();
    for (const [gid, gid2] of [['g-batch-1', 'u-b'], ['g-batch-2', 'u-c']]) {
      ins(`INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, status, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        [gid, 'agent-owner', 'u-owner', gid2, 'group', 'chat-3', 'pending', t]);
    }
    const r = await request(app)
      .patch('/api/agent-grants/batch-decide')
      .set('x-uid', 'u-owner')
      .send({ ids: ['g-batch-1', 'g-batch-2'], action: 'accept', ttlHours: 48 });
    expect(r.status).toBe(200);
    expect(r.body.done.length).toBe(2);
    expect(r.body.failed.length).toBe(0);
  });

  it('续期：expired 记录可恢复为 accepted', async () => {
    const t = now();
    ins(`INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, status, created_at, decided_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ['g-old', 'agent-owner', 'u-owner', 'u-a', 'group', 'chat-old', 'expired', t, t, t - 1000]);

    const r = await request(app)
      .post('/api/agent-grants/g-old/renew')
      .set('x-uid', 'u-owner')
      .send({ ttlHours: 24 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('accepted');
    expect(r.body.expiresAt).toBeGreaterThan(now());
  });

  it('借用人不能替主人续期 → 403', async () => {
    const r = await request(app)
      .post('/api/agent-grants/g-old/renew')
      .set('x-uid', 'u-a')
      .send({ ttlHours: 24 });
    expect(r.status).toBe(403);
  });
});

describe('⑤ 群内授权总览', () => {
  it('返回成员 × 智能体的授权矩阵', async () => {
    const r = await request(app).get('/api/agent-grants/chat/chat-3').set('x-uid', 'u-owner');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.members)).toBe(true);
    expect(r.body.members.length).toBe(4);
    const agentRow = r.body.agents.find((a: any) => a.agentId === 'agent-owner');
    expect(agentRow).toBeTruthy();
    const ownerCell = agentRow.grants.find((g: any) => g.userId === 'u-owner');
    expect(ownerCell.status).toBe('owner');
  });

  it('非成员访问 → 403', async () => {
    ins('INSERT INTO users (id, display_name, created_at, numeric_id) VALUES (?,?,?,?)', ['u-out', '路人', now(), 21999]);
    const r = await request(app).get('/api/agent-grants/chat/chat-3').set('x-uid', 'u-out');
    expect(r.status).toBe(403);
  });
});
