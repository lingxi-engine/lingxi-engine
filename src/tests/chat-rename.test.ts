/**
 * 会话/群聊重命名 — 集成测试（v2.0.25）
 *
 * 覆盖 PATCH /api/chats/:id/name：
 *   - 未登录 → 401
 *   - 会话不存在 → 404
 *   - 空名称 / 超长名称 → 400
 *   - 参与者可改名，名称真实落库
 *   - 非参与者 → 403（越权防护）
 *   - 群聊(type=group)同样可改名（与新建群聊体验对齐）
 *
 * 说明：friends-chats.ts 内部走 getDB() 全局单例，因此这里通过
 * initDB 建真实库后注册路由，用 supertest 打真实 HTTP。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;
let app: any;
let broadcastEvents: any[] = [];

const MEMBER = 'u-rename-member';
const OUTSIDER = 'u-rename-outsider';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-chat-test-'));
  process.env.LINGXI_DATA_DIR = tmpDir;
  process.env.LINGXI_DB_PATH = path.join(tmpDir, 'test.db');
  // 动态 import，确保 initDB 读到上面的数据目录
  const { initDB, createChat, addParticipant, getChatById } = await import('../storage/db.js');
  const { registerFriendsChatsRoutes } = await import('../routes/friends-chats.js');

  const db = await initDB(path.join(tmpDir, 'test.db'));

  // 造两个会话：一个私聊、一个群聊
  createChat('chat-private-1', 'private', undefined, '旧私聊名');
  addParticipant('p-rn-1', 'chat-private-1', MEMBER, undefined, 'member');
  createChat('team-group-1', 'group', undefined, '旧群聊名');
  addParticipant('p-rn-2', 'team-group-1', MEMBER, undefined, 'member');

  app = express();
  app.use(express.json());
  // 模拟 jwtAuth：从 header 注入 user
  app.use((req: any, _res: any, next: any) => {
    const h = req.headers['x-test-user'];
    if (h) req.user = { sub: String(h), numeric_id: String(h) };
    next();
  });
  const requireAuth = (req: any, res: any, next: any) =>
    req.user ? next() : res.status(401).json({ error: 'unauthorized' });

  broadcastEvents = [];
  registerFriendsChatsRoutes(app, {
    db,
    requireAuth,
    broadcast: (e: any) => broadcastEvents.push(e),
  } as any);
});

afterAll(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('PATCH /api/chats/:id/name — 会话重命名', () => {
  it('未登录 → 401', async () => {
    const r = await request(app).patch('/api/chats/chat-private-1/name').send({ name: '新名字' });
    expect(r.status).toBe(401);
  });

  it('会话不存在 → 404', async () => {
    const r = await request(app)
      .patch('/api/chats/no-such-chat/name')
      .set('x-test-user', MEMBER)
      .send({ name: '新名字' });
    expect(r.status).toBe(404);
  });

  it('名称为空 → 400', async () => {
    const r = await request(app)
      .patch('/api/chats/chat-private-1/name')
      .set('x-test-user', MEMBER)
      .send({ name: '   ' });
    expect(r.status).toBe(400);
  });

  it('名称超长(>60) → 400', async () => {
    const r = await request(app)
      .patch('/api/chats/chat-private-1/name')
      .set('x-test-user', MEMBER)
      .send({ name: 'x'.repeat(61) });
    expect(r.status).toBe(400);
  });

  it('参与者可改私聊名，且真实落库', async () => {
    const r = await request(app)
      .patch('/api/chats/chat-private-1/name')
      .set('x-test-user', MEMBER)
      .send({ name: '项目评审会' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.name).toBe('项目评审会');
    expect(r.body.oldName).toBe('旧私聊名');

    const { getChatById } = await import('../storage/db.js');
    const row = getChatById('chat-private-1');
    expect(row?.name).toBe('项目评审会');
  });

  it('改名会广播 chat.renamed 事件', async () => {
    broadcastEvents = [];
    const r = await request(app)
      .patch('/api/chats/chat-private-1/name')
      .set('x-test-user', MEMBER)
      .send({ name: '周会' });
    expect(r.status).toBe(200);
    expect(broadcastEvents.some((e) => e.type === 'chat.renamed' && e.chatId === 'chat-private-1')).toBe(true);
  });

  it('群聊(type=group)同样可改名 —— 与新建群聊体验对齐', async () => {
    const r = await request(app)
      .patch('/api/chats/team-group-1/name')
      .set('x-test-user', MEMBER)
      .send({ name: '技术攻坚组' });
    expect(r.status).toBe(200);
    const { getChatById } = await import('../storage/db.js');
    expect(getChatById('team-group-1')?.name).toBe('技术攻坚组');
  });

  it('非参与者 → 403（越权防护）', async () => {
    const r = await request(app)
      .patch('/api/chats/chat-private-1/name')
      .set('x-test-user', OUTSIDER)
      .send({ name: '我想抢注' });
    expect(r.status).toBe(403);
    const { getChatById } = await import('../storage/db.js');
    expect(getChatById('chat-private-1')?.name).toBe('周会'); // 未被篡改
  });

  it('名称首尾空白被裁剪后落库', async () => {
    const r = await request(app)
      .patch('/api/chats/chat-private-1/name')
      .set('x-test-user', MEMBER)
      .send({ name: '   trimmed  ' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('trimmed');
  });

  it('恰好 60 字符 → 允许', async () => {
    const n60 = 'a'.repeat(60);
    const r = await request(app)
      .patch('/api/chats/chat-private-1/name')
      .set('x-test-user', MEMBER)
      .send({ name: n60 });
    expect(r.status).toBe(200);
  });
});
