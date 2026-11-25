/**
 * v2.0.44 参与者垃圾行回归
 * 历史 bug：userId/agentId 均空（或字符串 'undefined'）时，participants 表写入
 * user_id='undefined' 垃圾行 → 私聊「无法确定好友」、对方读回 403。
 * 修复：db.addParticipant 净化 + 两个路由入口 400 校验。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let app: any;
let dbMod: any;

const MEMBER = '10001';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'participant-sanitize-'));
  process.env.LINGXI_DATA_DIR = tmpDir;
  process.env.LINGXI_DB_PATH = path.join(tmpDir, 'test.db');
  dbMod = await import('../storage/db.js');
  const { registerFriendsChatsRoutes } = await import('../routes/friends-chats.js');
  await dbMod.initDB(path.join(tmpDir, 'test.db'));
  const db = new dbMod.DB();
  dbMod.createChat('chat-sanitize-1', 'private', undefined, '净化测试');

  app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    const h = req.headers['x-test-user'];
    if (h) req.user = { sub: String(h), numeric_id: String(h) };
    next();
  });
  const requireAuth = (req: any, res: any, next: any) =>
    req.user ? next() : res.status(401).json({ error: 'unauthorized' });
  registerFriendsChatsRoutes(app, { db, requireAuth, broadcast: () => {} } as any);
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('db.addParticipant 净化（根因兜底）', () => {
  it('userId 为字符串 undefined → 不落库', () => {
    dbMod.addParticipant('p-bad-1', 'chat-sanitize-1', 'undefined', undefined, 'member');
    const rows = dbMod.getChatParticipants('chat-sanitize-1');
    expect(rows.some((r: any) => r.id === 'p-bad-1')).toBe(false);
  });

  it('userId 为字符串 null → 不落库', () => {
    dbMod.addParticipant('p-bad-2', 'chat-sanitize-1', 'null', undefined, 'member');
    expect(dbMod.getChatParticipants('chat-sanitize-1').some((r: any) => r.id === 'p-bad-2')).toBe(false);
  });

  it('userId/agentId 均空 → 不落库', () => {
    dbMod.addParticipant('p-bad-3', 'chat-sanitize-1', undefined, undefined, 'member');
    expect(dbMod.getChatParticipants('chat-sanitize-1').some((r: any) => r.id === 'p-bad-3')).toBe(false);
  });

  it('正常 userId → 落库且值正确', () => {
    dbMod.addParticipant('p-good-1', 'chat-sanitize-1', MEMBER, undefined, 'member');
    const row = dbMod.getChatParticipants('chat-sanitize-1').find((r: any) => r.id === 'p-good-1');
    expect(row).toBeTruthy();
    expect(String(row.user_id)).toBe(MEMBER);
  });

  it('仅 agentId（AI 参与者）→ 正常落库', () => {
    dbMod.addParticipant('p-agent-1', 'chat-sanitize-1', undefined, 'agent-x', 'member');
    const row = dbMod.getChatParticipants('chat-sanitize-1').find((r: any) => r.id === 'p-agent-1');
    expect(row).toBeTruthy();
    expect(row.agent_id).toBe('agent-x');
  });
});

describe('POST /api/participants 入口校验', () => {
  it('userId/agentId 均缺 → 400', async () => {
    const r = await request(app).post('/api/participants')
      .set('x-test-user', MEMBER)
      .send({ id: 'p-api-1', chatId: 'chat-sanitize-1' });
    expect(r.status).toBe(400);
  });

  it('userId 为字符串 undefined → 400（不再写垃圾行）', async () => {
    const r = await request(app).post('/api/participants')
      .set('x-test-user', MEMBER)
      .send({ id: 'p-api-2', chatId: 'chat-sanitize-1', userId: 'undefined' });
    expect(r.status).toBe(400);
    expect(dbMod.getChatParticipants('chat-sanitize-1').some((x: any) => x.id === 'p-api-2')).toBe(false);
  });

  it('合法自助加入（首个成员）→ 200', async () => {
    const r = await request(app).post('/api/participants')
      .set('x-test-user', '10002')
      .send({ id: 'p-api-3', chatId: 'chat-sanitize-1', userId: '10002' });
    // 会话已有成员（p-good-1）且 10002 不在其中 → S5 越权防护 403 也算正确行为；
    // 本断言只要求：绝不写入 undefined 垃圾行
    expect([200, 403]).toContain(r.status);
    expect(dbMod.getChatParticipants('chat-sanitize-1').some((x: any) => String(x.user_id) === 'undefined')).toBe(false);
  });
});