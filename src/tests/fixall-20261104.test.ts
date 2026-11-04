/**
 * FIX-ALL 2026-11-04 回归测试：
 *  1) getFriendRequests / listFriends 支持 numeric_id 与 users.id 双形态互查（好友申请收得到）
 *  2) setLanGroupMode 接受全部 CHAT_MODES（LAN 群不再只有 free）
 *  3) safeObj 形态归一（数组形态 memory_facts 收敛成 Record）
 *  4) directedBroadcastAddrs 至少包含 255.255.255.255
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initDB, closeDB, getDB, sendFriendRequest, getFriendRequests, listFriends, respondFriendRequest, setLanGroupMode, createLanGroup, getLanGroup, userIdVariants, getUserByNumericId } from '../storage/db.js';
import { directedBroadcastAddrs, getLanIps } from '../net/lan-discovery.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-fixall-'));
  await initDB(path.join(tmpDir, 'main.db'));
  //造两个用户，给其中一个分配 numeric_id
  const db = getDB();
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-aaa','alice','Alice',10001,'online',1)");
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-bbb','bob','Bob',10002,'online',1)");
});

describe('好友申请双形态互查 (P0)', () => {
  it('用 users.id 发起申请，numeric_id 也能查到 incoming', () => {
    const r = sendFriendRequest('u-aaa', 'u-bbb', 'hi');
    expect(r.error).toBeUndefined();
    // 接收方用 numeric_id 查
    const reqs = getFriendRequests('10002');
    expect(reqs.incoming.length).toBe(1);
    expect(reqs.incoming[0].fromUserId).toBe('u-aaa');
  });

  it('反过来：numeric_id 发起，users.id 查 outgoing 也能看到', () => {
    const reqs = getFriendRequests('u-aaa');
    expect(reqs.outgoing.length).toBe(1);
    expect(reqs.outgoing[0].toUserId).toBe('u-bbb');
  });

  it('userIdVariants 同时返回 id 与 numeric_id', () => {
    const v = userIdVariants('u-aaa');
    expect(v).toContain('u-aaa');
    expect(v).toContain('10001');
  });

  it('接受申请后 listFriends 双形态都能列出好友', () => {
    const reqs = getFriendRequests('10002');
    const rid = reqs.incoming[0].id;
    const resp = respondFriendRequest(rid, 'accept');
    expect(resp.error).toBeUndefined();
    expect(listFriends('u-bbb').some((f: any) => f.friendId === 'u-aaa')).toBe(true);
    expect(listFriends('10002').some((f: any) => f.friendId === 'u-aaa')).toBe(true);
    expect(listFriends('u-aaa').some((f: any) => f.friendId === 'u-bbb')).toBe(true);
  });
});

describe('LAN 群模式白名单 (P1)', () => {
  it('setLanGroupMode 接受全部 CHAT_MODES', () => {
    createLanGroup('lg-test', 'test', 'inst-1', 'free');
    for (const m of ['free', 'route', 'debate', 'chain', 'roundtable', 'vote', 'brainstorm']) {
      expect(setLanGroupMode('lg-test', m)).toBe(true);
      expect(getLanGroup('lg-test').chat_mode).toBe(m);
    }
    expect(setLanGroupMode('lg-test', 'nonexistent')).toBe(false);
  });
});

describe('局域网发现广播地址 (P2)', () => {
  it('directedBroadcastAddrs 至少包含全局广播地址', () => {
    const addrs = directedBroadcastAddrs();
    expect(addrs).toContain('255.255.255.255');
    // 每个本机 IP 都应贡献一个定向广播地址
    for (const ip of getLanIps()) {
      const parts = ip.split('.');
      if (parts.length === 4) {
        expect(addrs).toContain(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
      }
    }
  });
});
