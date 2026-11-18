/**
 * 好友系统修复回归测试（2026-11-15）
 * 覆盖审查报告中的 DB 层修复：
 *  F1 拒绝/撤回后重新加好友不再撞 UNIQUE 500（旧行复用为 pending）
 *  F2 withdrawFriendRequest：仅 pending 可撤回，撤回后可重发
 *  F3 listFriends 数字 ID 查询不再返回「自己」（归一化 canonical 比较）
 *  F4 好友名字解析真实昵称（不再恒为空）
 *  F8 好友请求附言 200 字符上限
 * 全部使用独立临时 SQLite，不碰生产数据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  initDB, closeDB, getDB,
  sendFriendRequest, getFriendRequests, listFriends,
  respondFriendRequest, withdrawFriendRequest, getFriendshipById,
} from '../storage/db.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-friendfix-'));
  await initDB(path.join(tmpDir, 'main.db'));
  const db = getDB();
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-a1','alice','Alice',20001,'online',1)");
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-b1','bob','Bob',20002,'online',1)");
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-c1','carol','Carol',20003,'online',1)");
});

afterAll(() => {
  try { closeDB(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('F1 拒绝后重新加好友（不再 500）', () => {
  it('发送 → 拒绝 → 再发送：复用旧行为 pending，不抛 UNIQUE', () => {
    const r1 = sendFriendRequest('u-a1', 'u-b1', '第一次');
    expect(r1.error).toBeUndefined();
    const rid = (r1 as any).id;
    const rej = respondFriendRequest(rid, 'reject');
    expect(rej.ok).toBe(true);
    // 修复前：这里直接 INSERT 撞 UNIQUE(from_user_id,to_user_id) 抛错
    const r2 = sendFriendRequest('u-a1', 'u-b1', '第二次');
    expect(r2.error).toBeUndefined();
    expect((r2 as any).status).toBe('pending');
    // 旧行被复用（id 不变），附言更新
    const row = getFriendshipById(rid) as any;
    expect(row.status).toBe('pending');
    expect(row.message).toBe('第二次');
    // 接收方能看到新的 incoming
    const reqs = getFriendRequests('20002');
    expect(reqs.incoming.some((r: any) => r.id === rid)).toBe(true);
  });

  it('拒绝后重发再接受 → 成为好友', () => {
    const reqs = getFriendRequests('u-b1');
    const rid = reqs.incoming.find((r: any) => r.fromUserId === 'u-a1')!.id;
    const acc = respondFriendRequest(rid, 'accept');
    expect(acc.ok).toBe(true);
    expect(listFriends('u-a1').some((f: any) => f.friendId === 'u-b1')).toBe(true);
  });
});

describe('F3/F4 listFriends 数字 ID 与真实昵称', () => {
  it('我主动加的好友：numeric_id 查询返回好友而非自己', () => {
    // u-a1(20001) 主动加的 u-b1(20002)。修复前数字 ID 查会返回 u-a1 自己
    const byStr = listFriends('u-a1');
    const byNum = listFriends('20001');
    expect(byStr.some((f: any) => f.friendId === 'u-b1')).toBe(true);
    expect(byNum.some((f: any) => f.friendId === 'u-b1')).toBe(true);
    expect(byNum.some((f: any) => f.friendId === 'u-a1')).toBe(false); // 不再返回自己
    expect(byNum.some((f: any) => f.friendId === '20001')).toBe(false);
  });

  it('对方主动加我：numeric_id 查询同样正确', () => {
    const byNum = listFriends('20002');
    expect(byNum.some((f: any) => f.friendId === 'u-a1')).toBe(true);
    expect(byNum.some((f: any) => f.friendId === 'u-b1')).toBe(false);
  });

  it('F4 好友名字为真实昵称，不再恒为空', () => {
    const fa = listFriends('20001').find((f: any) => f.friendId === 'u-b1') as any;
    const fb = listFriends('20002').find((f: any) => f.friendId === 'u-a1') as any;
    expect(fa.friendName).toBe('Bob');
    expect(fb.friendName).toBe('Alice');
  });
});

describe('F2 撤回好友请求', () => {
  it('pending 可撤回；撤回后行被删除、可重新发送', () => {
    const r = sendFriendRequest('u-c1', 'u-a1', '加个好友');
    expect(r.error).toBeUndefined();
    const rid = (r as any).id;
    const w = withdrawFriendRequest(rid);
    expect(w.ok).toBe(true);
    expect(getFriendshipById(rid)).toBeUndefined();
    // 撤回后可重发（全新 INSERT，不撞 UNIQUE）
    const r2 = sendFriendRequest('u-c1', 'u-a1', '再来一次');
    expect(r2.error).toBeUndefined();
    expect((r2 as any).status).toBe('pending');
  });

  it('非 pending 不可撤回；不存在的请求报错', () => {
    // u-a1 ↔ u-b1 已是 accepted
    const reqs = getFriendRequests('u-a1');
    const acceptedRow = getDB().prepare("SELECT id FROM friendships WHERE status='accepted' LIMIT 1").get() as any;
    expect(acceptedRow).toBeTruthy();
    const w = withdrawFriendRequest(acceptedRow.id);
    expect(w.ok).toBe(false);
    expect(w.error).toContain('待处理');
    const w2 = withdrawFriendRequest('no-such-id');
    expect(w2.ok).toBe(false);
    expect(reqs).toBeTruthy();
  });
});

describe('F8 附言长度上限', () => {
  it('超过 200 字符的附言被截断', () => {
    const long = 'x'.repeat(300);
    const r = sendFriendRequest('u-b1', 'u-c1', long);
    expect(r.error).toBeUndefined();
    const reqs = getFriendRequests('u-c1');
    const inc = reqs.incoming.find((x: any) => x.fromUserId === 'u-b1') as any;
    expect(inc.message.length).toBe(200);
  });
});
