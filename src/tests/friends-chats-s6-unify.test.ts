/**
 * S6 路由统一回归测试（2026-11-19）
 * 背景：index.ts 内联旧路由注册在 registerFriendsChatsRoutes 之前，遮蔽修复版（双份漂移）。
 * 本测试验证合并后的 friends-chats.ts 同时具备内联版保护（S7/F5/F6/F8/S2）与 S5 修复：
 *  1. by-id 不返回 email/status（S7）
 *  2. send-friend 空成员会话 fail-closed（F8）
 *  3. send-friend 排除 agent 行（F5）
 *  4. send-friend 非好友本地用户拒发（F6）
 *  5. DELETE /api/participants：userId 别名 + 普通成员不能踢他人/他人AI，可退群（S2+S6）
 *  6. POST /api/participants：owner 角色收紧（拉他人一律 member；空会话封 owner 仅限建聊者）
 *  7. Mesh 兜底对非 JSON 响应返回 502 而非 500（S6 防御）
 * 全部使用独立临时 SQLite + supertest，不碰生产数据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { initDB, closeDB, DB } from '../storage/db.js';
import { registerFriendsChatsRoutes } from '../routes/friends-chats.js';

let tmpDir: string;
let app: any;
let db: any;
let currentUser: any = null;
const fakeHub = { async sendPrivateMessage() { return { ok: true }; } };

const ALICE = { sub: 'u-a1', numeric_id: 30001, sid: 's-alice' };
const BOB = { sub: 'u-b1', numeric_id: 30002, sid: 's-bob' };

function seedChat(id: string, ownerId: string, members: string[]) {
  db.createChat(id, 'group', undefined, 'S6测试群', ownerId);
  members.forEach((m, i) => db.addParticipant('p-' + id + '-' + i, id, m, undefined, i === 0 ? 'owner' : 'member'));
}
function beFriends(a: string, b: string) {
  const r = db.sendFriendRequest(a, b, 'hi');
  db.respondFriendRequest(r.id, 'accept');
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-s6-'));
  await initDB(path.join(tmpDir, 'main.db'));
  db = new DB();
  db.run("INSERT INTO users (id, username, display_name, numeric_id, email, status, created_at) VALUES ('u-a1','alice','Alice',30001,'alice@test.com','online',1)");
  db.run("INSERT INTO users (id, username, display_name, numeric_id, email, status, created_at) VALUES ('u-b1','bob','Bob',30002,'bob@test.com','online',1)");
  app = express();
  app.use(express.json());
  const requireAuth = (req: any, _res: any, next: any) => { req.user = currentUser; next(); };
  registerFriendsChatsRoutes(app, { db, requireAuth, broadcast: () => {}, getLanSocial: () => fakeHub } as any);
});

afterAll(() => {
  try { closeDB(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('S6-1 by-id 隐私（S7 同步）', () => {
  it('不再返回 email/status', async () => {
    currentUser = ALICE;
    const r = await request(app).get('/api/users/by-id?numericId=30002');
    expect(r.status).toBe(200);
    expect(r.body.user.displayName).toBe('Bob');
    expect(r.body.user.email).toBeUndefined();
    expect(r.body.user.status).toBeUndefined();
  });
});

describe('S6-2 send-friend fail-closed（F8 同步）', () => {
  it('空成员会话发消息 → 403（修复前 parts.length>0 判断放行）', async () => {
    db.createChat('chat-s6-empty', 'group');
    currentUser = ALICE;
    const r = await request(app).post('/api/chats/chat-s6-empty/send-friend').send({ content: 'hi', fromUserId: 'u-a1' });
    expect(r.status).toBe(403);
  });
});

describe('S6-3 send-friend 好友选择（F5 同步）', () => {
  it('只剩 agent 行时 → 400 无法确定好友（不会选中 agent）', async () => {
    db.createChat('chat-s6-agent', 'group');
    db.addParticipant('p-s6-a1', 'chat-s6-agent', 'u-a1', undefined, 'owner');
    db.addParticipant('p-s6-ag', 'chat-s6-agent', undefined, 'ag-x', 'member');
    currentUser = ALICE;
    const r = await request(app).post('/api/chats/chat-s6-agent/send-friend').send({ content: 'hi', fromUserId: 'u-a1' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('无法确定好友');
  });
});

describe('S6-4 send-friend 好友关系校验（F6 同步）', () => {
  it('本地用户但非好友 → 403；成为好友后 → 200 local', async () => {
    db.createChat('chat-s6-f6', 'private');
    db.addParticipant('p-s6-f6-1', 'chat-s6-f6', 'u-a1', undefined, 'owner');
    db.addParticipant('p-s6-f6-2', 'chat-s6-f6', 'u-b1', undefined, 'member');
    currentUser = ALICE;
    const r1 = await request(app).post('/api/chats/chat-s6-f6/send-friend').send({ content: 'hi', fromUserId: 'u-a1' });
    expect(r1.status).toBe(403);
    beFriends('u-a1', 'u-b1');
    const r2 = await request(app).post('/api/chats/chat-s6-f6/send-friend').send({ content: 'hi', fromUserId: 'u-a1' });
    expect(r2.status).toBe(200);
    expect(r2.body.local).toBe(true);
  });
});

describe('S6-5 移除成员（S2 同步 + userId 别名）', () => {
  it('普通成员用 userId 别名踢他人 → 403（修复前别名直接 400）', async () => {
    seedChat('chat-s6-k1', 'u-a1', ['u-a1', 'u-b1']);
    currentUser = BOB;
    const r = await request(app).delete('/api/participants').send({ userId: 'u-a1', chatId: 'chat-s6-k1' });
    expect(r.status).toBe(403);
    expect(db.getChatParticipants('chat-s6-k1').some((p: any) => p.user_id === 'u-a1')).toBe(true);
  });
  it('普通成员退群（userId 别名）→ 200，自己离开', async () => {
    currentUser = BOB;
    const r = await request(app).delete('/api/participants').send({ userId: 'u-b1', chatId: 'chat-s6-k1' });
    expect(r.status).toBe(200);
    expect(db.getChatParticipants('chat-s6-k1').some((p: any) => p.user_id === 'u-b1')).toBe(false);
  });
  it('owner 用行 id 踢人 → 200 且真实删除（修复前行 id 删不掉）', async () => {
    seedChat('chat-s6-k2', 'u-a1', ['u-a1', 'u-b1']);
    currentUser = ALICE;
    const r = await request(app).delete('/api/participants').send({ id: 'p-chat-s6-k2-1', chatId: 'chat-s6-k2' });
    expect(r.status).toBe(200);
    expect(db.getChatParticipants('chat-s6-k2').some((p: any) => p.user_id === 'u-b1')).toBe(false);
  });
  it('普通成员移除他人的 AI → 403', async () => {
    db.createChat('chat-s6-k3', 'group', undefined, 'g', 'u-a1');
    db.addParticipant('p-s6-k3-0', 'chat-s6-k3', 'u-a1', undefined, 'owner');
    db.addParticipant('p-s6-k3-1', 'chat-s6-k3', 'u-b1', undefined, 'member');
    db.addParticipant('p-s6-k3-ag', 'chat-s6-k3', undefined, 'ag-alice', 'member');
    currentUser = BOB;
    const r = await request(app).delete('/api/participants').send({ agentId: 'ag-alice', chatId: 'chat-s6-k3' });
    expect(r.status).toBe(403);
    expect(db.getChatParticipants('chat-s6-k3').some((p: any) => p.agent_id === 'ag-alice')).toBe(true);
  });
});

describe('S6-6 owner 角色收紧', () => {
  it('空会话非建聊者自助加入请求 owner → 降级 member', async () => {
    currentUser = ALICE;
    await request(app).post('/api/chats').send({ id: 'chat-s6-r1', type: 'group' });
    currentUser = BOB;
    const r = await request(app).post('/api/participants').send({ id: 'p-s6-r1-b', chatId: 'chat-s6-r1', userId: 'u-b1', role: 'owner' });
    expect(r.status).toBe(200);
    const row = db.getChatParticipants('chat-s6-r1').find((p: any) => p.user_id === 'u-b1');
    expect(row.role).toBe('member');
  });
  it('建聊者自助加入 owner → 保持 owner（建群流程不回归）', async () => {
    currentUser = ALICE;
    await request(app).post('/api/chats').send({ id: 'chat-s6-r2', type: 'group' });
    const r = await request(app).post('/api/participants').send({ id: 'p-s6-r2-a', chatId: 'chat-s6-r2', userId: 'u-a1', role: 'owner' });
    expect(r.status).toBe(200);
    const row = db.getChatParticipants('chat-s6-r2').find((p: any) => p.user_id === 'u-a1');
    expect(row.role).toBe('owner');
  });
  it('拉好友入会请求 owner → 降级 member', async () => {
    beFriends('u-a1', 'u-b1');
    seedChat('chat-s6-r3', 'u-a1', ['u-a1']);
    currentUser = ALICE;
    const r = await request(app).post('/api/participants').send({ id: 'p-s6-r3-b', chatId: 'chat-s6-r3', userId: 'u-b1', role: 'owner' });
    expect(r.status).toBe(200);
    const row = db.getChatParticipants('chat-s6-r3').find((p: any) => p.user_id === 'u-b1');
    expect(row.role).toBe('member');
  });
});

describe('S6-7 Mesh 兜底防御', () => {
  it('Mesh 返回 404 HTML → 502 清晰错误（修复前 r.json() 抛异常 → 500）', async () => {
    const srv = http.createServer((_req, res) => { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<html>Not Found</html>'); });
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as any).port;
    const oldUrl = process.env.MESH_PLATFORM_URL; const oldTok = process.env.MESH_TOKEN;
    process.env.MESH_PLATFORM_URL = 'http://127.0.0.1:' + port;
    process.env.MESH_TOKEN = 'test-token';
    try {
      db.createChat('chat-s6-mesh', 'private');
      db.addParticipant('p-s6-m1', 'chat-s6-mesh', 'u-a1', undefined, 'owner');
      db.addParticipant('p-s6-m2', 'chat-s6-mesh', '99999', undefined, 'member');
      currentUser = ALICE;
      const r = await request(app).post('/api/chats/chat-s6-mesh/send-friend').send({ content: 'hi', fromUserId: 'u-a1' });
      expect(r.status).toBe(502);
      expect(r.body.error).toContain('/api/users/find');
    } finally {
      if (oldUrl === undefined) delete process.env.MESH_PLATFORM_URL; else process.env.MESH_PLATFORM_URL = oldUrl;
      if (oldTok === undefined) delete process.env.MESH_TOKEN; else process.env.MESH_TOKEN = oldTok;
      srv.close();
    }
  });
});
