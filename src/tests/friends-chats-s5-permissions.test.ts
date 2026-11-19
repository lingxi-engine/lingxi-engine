/**
 * S5 修复回归测试（2026-11-18）
 * 覆盖：
 *  1. DELETE /api/chats/:id —— 非成员 403；成员/owner 可删；本地免登录豁免
 *  2. DELETE /api/participants —— 非成员 403
 *  3. GET /api/chats/:id/participants —— 非成员 403；成员 200
 *  4. POST /api/participants —— 自助加入他人已有会话 403（含自封 owner）；
 *     首次建聊（空会话）自助加入允许；会话不存在 404
 *  5. GET /api/chats/:id/available-members —— 冒用他人 userId 403
 *  6. POST /api/chats —— owner_id 记录创建者
 *  7. send-friend —— remote-{nid} 占位 ID 解析为真实远端 userId 并走 LAN 私聊通道（不再 NaN→404）
 * 全部使用独立临时 SQLite + supertest，不碰生产数据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initDB, closeDB, DB, makePrivateChatId, upsertLanRemoteIdentity } from '../storage/db.js';
import { registerFriendsChatsRoutes } from '../routes/friends-chats.js';

let tmpDir: string;
let app: any;
let db: any;
let currentUser: any = null;
const lanCalls: any[] = [];
const fakeHub = {
  async sendPrivateMessage(from: string, to: string, content: string) {
    lanCalls.push({ from, to, content });
    return { ok: true, msgId: 'test-msg-1' };
  },
};

const ALICE = { sub: 'u-a1', numeric_id: 30001, sid: 's-alice' };
const BOB = { sub: 'u-b1', numeric_id: 30002, sid: 's-bob' };
const MALLORY = { sub: 'u-m1', numeric_id: 30003, sid: 's-mallory' };
const LOCAL_ADMIN = { sub: 'admin', sid: 'admin-auto' };

function seedChat(id: string, ownerId: string, members: string[]) {
  db.createChat(id, 'group', undefined, 'S5测试群', ownerId);
  members.forEach((m, i) => db.addParticipant('p-' + id + '-' + i, id, m, undefined, i === 0 ? 'owner' : 'member'));
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-s5-'));
  await initDB(path.join(tmpDir, 'main.db'));
  db = new DB();
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-a1','alice','Alice',30001,'online',1)");
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-b1','bob','Bob',30002,'online',1)");
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-m1','mallory','Mallory',30003,'online',1)");
  app = express();
  app.use(express.json());
  const requireAuth = (req: any, _res: any, next: any) => { req.user = currentUser; next(); };
  registerFriendsChatsRoutes(app, {
    db, requireAuth, broadcast: () => {}, getLanSocial: () => fakeHub,
  } as any);
});

afterAll(() => {
  try { closeDB(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('S5-1 删除会话权限', () => {
  it('非成员删除他人会话 → 403，会话仍在', async () => {
    seedChat('chat-s5-1', 'u-a1', ['u-a1', 'u-b1']);
    currentUser = MALLORY;
    const r = await request(app).delete('/api/chats/chat-s5-1');
    expect(r.status).toBe(403);
    expect(db.getChatById('chat-s5-1')).toBeTruthy();
  });
  it('成员删除自己的会话 → 200，会话被删', async () => {
    currentUser = BOB;
    const r = await request(app).delete('/api/chats/chat-s5-1');
    expect(r.status).toBe(200);
    expect(db.getChatById('chat-s5-1')).toBeUndefined();
  });
  it('owner（非参与者）删除会话 → 200', async () => {
    seedChat('chat-s5-2', 'u-a1', ['u-b1']);
    currentUser = ALICE;
    const r = await request(app).delete('/api/chats/chat-s5-2');
    expect(r.status).toBe(200);
  });
  it('本地免登录 admin-auto 豁免 → 200', async () => {
    seedChat('chat-s5-8', 'u-a1', ['u-a1']);
    currentUser = LOCAL_ADMIN;
    const r = await request(app).delete('/api/chats/chat-s5-8');
    expect(r.status).toBe(200);
  });
});

describe('S5-2 移除成员权限', () => {
  it('非成员踢人 → 403，成员仍在', async () => {
    seedChat('chat-s5-3', 'u-a1', ['u-a1', 'u-b1']);
    currentUser = MALLORY;
    const r = await request(app).delete('/api/participants').send({ id: 'p-chat-s5-3-1', chatId: 'chat-s5-3' });
    expect(r.status).toBe(403);
    const parts = db.getChatParticipants('chat-s5-3');
    expect(parts.some((p: any) => p.user_id === 'u-b1')).toBe(true);
  });
  it('成员踢人 → 200', async () => {
    currentUser = ALICE;
    const r = await request(app).delete('/api/participants').send({ id: 'p-chat-s5-3-1', chatId: 'chat-s5-3' });
    expect(r.status).toBe(200);
  });
});

describe('S5-3 读取成员列表权限', () => {
  it('非成员读取 → 403', async () => {
    seedChat('chat-s5-4', 'u-a1', ['u-a1', 'u-b1']);
    currentUser = MALLORY;
    const r = await request(app).get('/api/chats/chat-s5-4/participants');
    expect(r.status).toBe(403);
  });
  it('成员读取 → 200', async () => {
    currentUser = BOB;
    const r = await request(app).get('/api/chats/chat-s5-4/participants');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.participants)).toBe(true);
  });
});

describe('S5-4 自助入会越权封堵', () => {
  it('把自己加进他人已有会话（自封 owner）→ 403', async () => {
    seedChat('chat-s5-5', 'u-a1', ['u-a1', 'u-b1']);
    currentUser = MALLORY;
    const r = await request(app).post('/api/participants').send({
      id: 'p-evil-1', chatId: 'chat-s5-5', userId: 'u-m1', role: 'owner',
    });
    expect(r.status).toBe(403);
    const parts = db.getChatParticipants('chat-s5-5');
    expect(parts.some((p: any) => p.user_id === 'u-m1')).toBe(false);
  });
  it('首次建聊：空会话自助加入为 owner → 允许（建聊流程不回归）', async () => {
    currentUser = MALLORY;
    const c = await request(app).post('/api/chats').send({ id: 'chat-s5-6', type: 'private' });
    expect(c.status).toBe(200);
    const r = await request(app).post('/api/participants').send({
      id: 'p-self-6', chatId: 'chat-s5-6', userId: 'u-m1', role: 'owner',
    });
    expect(r.status).toBe(200);
    const parts = db.getChatParticipants('chat-s5-6');
    expect(parts.some((p: any) => p.user_id === 'u-m1')).toBe(true);
  });
  it('会话不存在时自助加入 → 404', async () => {
    currentUser = MALLORY;
    const r = await request(app).post('/api/participants').send({
      id: 'p-ghost', chatId: 'chat-no-such', userId: 'u-m1',
    });
    expect(r.status).toBe(404);
  });
});

describe('S5-5 available-members 身份一致性', () => {
  it('冒用他人 userId → 403', async () => {
    seedChat('chat-s5-7', 'u-a1', ['u-a1']);
    currentUser = MALLORY;
    const r = await request(app).get('/api/chats/chat-s5-7/available-members?userId=u-a1');
    expect(r.status).toBe(403);
  });
  it('查自己的 → 200', async () => {
    currentUser = MALLORY;
    const r = await request(app).get('/api/chats/chat-s5-7/available-members?userId=u-m1');
    expect(r.status).toBe(200);
  });
});

describe('S5-6 建聊记录 owner', () => {
  it('POST /api/chats 后 owner_id = 创建者', async () => {
    currentUser = ALICE;
    const r = await request(app).post('/api/chats').send({ id: 'chat-s5-owner', type: 'group', name: '归属测试' });
    expect(r.status).toBe(200);
    const chat = db.getChatById('chat-s5-owner') as any;
    expect(chat.owner_id).toBe('u-a1');
  });
});

describe('S5-7 remote-{nid} 占位 ID 路由（不再 NaN→404）', () => {
  it('remote-40001 解析为真实远端 userId，走 LAN 私聊通道', async () => {
    upsertLanRemoteIdentity({ userId: 'u-remote-1', instanceId: 'inst-remote', numericId: 40001, displayName: '远端好友' });
    const chatId = makePrivateChatId('u-a1', 'u-remote-1');
    db.createChat(chatId, 'private');
    db.addParticipant('p-r1', chatId, 'u-a1', undefined, 'owner');
    db.addParticipant('p-r2', chatId, 'remote-40001', undefined, 'member');
    currentUser = ALICE;
    const r = await request(app).post('/api/chats/' + chatId + '/send-friend').send({ content: '你好，远端朋友', fromUserId: 'u-a1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.lan).toBe(true);
    expect(lanCalls.length).toBe(1);
    expect(lanCalls[0].to).toBe('u-remote-1'); // 修复前：Number('remote-40001')=NaN → Mesh 404
    expect(lanCalls[0].content).toBe('你好，远端朋友');
  });
});
