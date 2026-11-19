/**
 * S7 跨引擎好友身份命名空间 — LanSocialHub 集成回归测试
 *
 * 复现并验证修复：
 *  1. 接收侧身份碰撞：两台引擎首个用户 ID 相同（'10001'），旧代码收申请必报「不能添加自己为好友」
 *  2. 接受回执：snake_case 行误当 camelCase（remote.instanceId 恒 undefined）+ to 传 DB 行 → 对端 to.userId undefined
 *  3. 私聊会话 ID 双侧不对称 → 四元组规范 ID
 *  4. peer/friend-remove 回声乒乓 → notifyPeer=false 切断
 *  5. handleFriendAccept 兜底只建 pending 不接受
 *  6. friends()/friendRequests() 远程身份解析恒 undefined
 *
 * 真实 better-sqlite3 临时库 + mock 发现层/传输层/E2EE，不碰生产库。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mocks = vi.hoisted(() => ({
  selfInstance: 'lingxi-lan-bbbbbbbbbbbb',
  peers: new Map<string, any>(),
  sendToPeer: vi.fn(async (_peer: any, _path: string, _body: any) => ({ ok: true })),
}));

vi.mock('../net/lan-discovery.js', () => ({
  getLanInstanceId: () => mocks.selfInstance,
  getLanPeers: () => [...mocks.peers.values()],
  getLanPeer: (id: string) => mocks.peers.get(id),
  findPeerByNumericId: (nid: number) => {
    for (const p of mocks.peers.values()) {
      const u = (p.users || []).find((x: any) => x.numericId === nid);
      if (u) return { peer: p, user: u };
    }
    return undefined;
  },
}));
vi.mock('../net/lan-transport.js', () => ({ sendToPeer: mocks.sendToPeer }));
vi.mock('../security/e2ee.js', () => ({
  isE2EE: () => false,
  getPeerPublicKey: () => null,
  encryptForPeer: () => null,
  decryptFromPeer: (_d: any, _i: any, c: string) => c,
  getIdentityPublicKeyB64: () => 'pk-test',
  setPeerPublicKey: () => {},
}));

import { initDB, closeDB, getDB, sendFriendRequest, upsertLanRemoteIdentity, makePrivateChatId } from '../storage/db.js';
import { LanSocialHub } from '../net/lan-social.js';
import { xlanAlias, makeCrossEnginePrivateChatId } from '../net/lan-identity.js';

const INST_A = 'lingxi-lan-aaaaaaaaaaaa';
const INST_B = 'lingxi-lan-bbbbbbbbbbbb'; // 默认 self = 引擎 B
const ALIAS_A = xlanAlias(INST_A, '10001'); // A 引擎的 '10001' 在 B 库里的别名
const ALIAS_B = xlanAlias(INST_B, '10001'); // B 引擎的 '10001' 在 A 库里的别名
const CANONICAL = makeCrossEnginePrivateChatId(INST_A, '10001', INST_B, '10001');

const peerA = { instanceId: INST_A, lanIp: '127.0.0.1', port: 3498, users: [{ id: '10001', numericId: 10001, displayName: 'RemoteAlice' }] };
const peerB = { instanceId: INST_B, lanIp: '127.0.0.1', port: 3499, users: [{ id: '10001', numericId: 10001, displayName: 'RemoteBob' }] };

let tmpDir: string;
let hub: LanSocialHub;
let broadcasts: any[];

function makeHub(localDisplayName: string) {
  broadcasts = [];
  return new LanSocialHub({
    router: {} as any,
    manager: { list: () => [] },
    broadcast: (e: any) => broadcasts.push(e),
    getLocalUsers: () => [{ id: '10001', numericId: 10001, displayName: localDisplayName }],
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-xlan-'));
  await initDB(path.join(tmpDir, 'main.db'));
  getDB().run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('10001','localuser','LocalUser',10001,'online',1)");
  mocks.selfInstance = INST_B;
  mocks.peers.clear();
  mocks.sendToPeer.mockClear();
  mocks.sendToPeer.mockImplementation(async () => ({ ok: true }));
  hub = makeHub('LocalBob');
});

afterEach(() => {
  try { clearInterval((hub as any).outboxTimer); } catch { /* ignore */ }
  try { closeDB(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('S7-1 接收侧身份碰撞（加不上好友的最后一块硬骨头）', () => {
  it('跨引擎同 ID 用户发来的申请不再报「不能添加自己为好友」', () => {
    const r = hub.handleIncomingFriendRequest({
      from: { userId: '10001', instanceId: INST_A, numericId: 10001, displayName: 'RemoteAlice' },
      toNumericId: 10001, message: '跨引擎做朋友',
    });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.requestId).toBeTruthy();
    const row = getDB().prepare('SELECT * FROM friendships WHERE id = ?').get(r.requestId) as any;
    expect(row.from_user_id).toBe(ALIAS_A);
    expect(row.to_user_id).toBe('10001');
    expect(row.status).toBe('pending');
    // 身份按别名落库，不覆盖本机用户
    const ident = getDB().prepare('SELECT * FROM lan_remote_identities WHERE user_id = ?').get(ALIAS_A) as any;
    expect(ident).toBeTruthy();
    expect(ident.instance_id).toBe(INST_A);
    expect(ident.display_name).toBe('RemoteAlice');
  });

  it('同实例回环拒绝', () => {
    const r = hub.handleIncomingFriendRequest({
      from: { userId: '10001', instanceId: INST_B, numericId: 10001, displayName: 'Self' },
      toNumericId: 10001,
    });
    expect(r.error).toContain('不能添加自己');
  });

  it('缺 instanceId 拒绝（防无命名空间落库）', () => {
    const r = hub.handleIncomingFriendRequest({ from: { userId: '10001', numericId: 10001 }, toNumericId: 10001 });
    expect(r.error).toBeTruthy();
  });

  it('两个不同引擎的同 ID 用户身份行互不覆盖', () => {
    hub.handleIncomingFriendRequest({ from: { userId: '10001', instanceId: INST_A, numericId: 10001, displayName: 'AliceA' }, toNumericId: 10001 });
    const instC = 'lingxi-lan-cccccccccccc';
    hub.handleIncomingFriendRequest({ from: { userId: '10001', instanceId: instC, numericId: 10001, displayName: 'AliceC' }, toNumericId: 10001 });
    const rows = getDB().prepare('SELECT * FROM lan_remote_identities').all() as any[];
    expect(rows.length).toBe(2);
    expect(rows.map(r => r.display_name).sort()).toEqual(['AliceA', 'AliceC']);
  });
});

describe('S7-2 接受回执（此前从未成功发出）', () => {
  function incoming() {
    return hub.handleIncomingFriendRequest({
      from: { userId: '10001', instanceId: INST_A, numericId: 10001, displayName: 'RemoteAlice' },
      toNumericId: 10001, message: 'hi',
    });
  }

  it('接受 → 规范私聊 ID + 回执 to 为 camelCase 原始发起者信息', async () => {
    mocks.peers.set(INST_A, peerA);
    const r = incoming();
    const acc = await hub.respondFriendRequest(r.requestId, 'accept');
    expect(acc.ok).toBe(true);
    expect(acc.chatId).toBe(CANONICAL);
    expect(mocks.sendToPeer).toHaveBeenCalledTimes(1);
    const [peer, p, body] = mocks.sendToPeer.mock.calls[0];
    expect(peer.instanceId).toBe(INST_A);
    expect(p).toBe('/api/lan/peer/friend-accept');
    expect(body.from.instanceId).toBe(INST_B);
    expect(body.from.userId).toBe('10001');
    expect(body.to.userId).toBe('10001');        // 原始发起者 raw ID（此前恒 undefined）
    expect(body.to.instanceId).toBe(INST_A);
    expect(body.chatId).toBe(CANONICAL);
    // 本地会话 + 参与者
    const chat = getDB().prepare('SELECT * FROM chats WHERE id = ?').get(CANONICAL) as any;
    expect(chat).toBeTruthy();
    const parts = getDB().prepare('SELECT user_id FROM participants WHERE chat_id = ?').all(CANONICAL) as any[];
    expect(parts.map(x => x.user_id).sort()).toEqual(['10001', ALIAS_A].sort());
  });

  it('对方离线 → 回执入离线队列（此前直接丢失）', async () => {
    const r = incoming();
    const acc = await hub.respondFriendRequest(r.requestId, 'accept');
    expect(acc.ok).toBe(true);
    expect(mocks.sendToPeer).not.toHaveBeenCalled();
    const q = getDB().prepare('SELECT * FROM lan_outbox WHERE instance_id = ?').all(INST_A) as any[];
    expect(q.length).toBe(1);
    expect(q[0].path).toBe('/api/lan/peer/friend-accept');
    const body = JSON.parse(q[0].body);
    expect(body.to.userId).toBe('10001');
    expect(body.chatId).toBe(CANONICAL);
  });

  it('本地-本地好友流程不受影响（旧私聊 ID 格式保持）', async () => {
    getDB().run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('10002','u2','本地乙',10002,'online',1)");
    const r = sendFriendRequest('10001', '10002', '本地加好友');
    expect(r.error).toBeUndefined();
    const acc = await hub.respondFriendRequest(r.id!, 'accept');
    expect(acc.local).toBe(true);
    expect(acc.chatId).toBe(makePrivateChatId('10001', '10002'));
    expect(mocks.sendToPeer).not.toHaveBeenCalled();
  });
});

describe('S7-3 发起方接收接受回调（handleFriendAccept）', () => {
  beforeEach(() => {
    // 切换视角：self = 引擎 A，本机用户 '10001' 是发起者
    mocks.selfInstance = INST_A;
    hub = makeHub('LocalAlice');
  });

  it('别名占位行转正 + accepted + 规范会话', () => {
    upsertLanRemoteIdentity({ userId: ALIAS_B, instanceId: INST_B, numericId: 10001, displayName: 'RemoteBob' });
    const pend = sendFriendRequest('10001', ALIAS_B, 'hi');
    expect(pend.error).toBeUndefined();
    const r = hub.handleFriendAccept({
      from: { userId: '10001', instanceId: INST_B, numericId: 10001, displayName: 'RemoteBob' },
      to: { userId: '10001', instanceId: INST_A },
      chatId: CANONICAL,
    });
    expect(r.ok).toBe(true);
    const row = getDB().prepare('SELECT * FROM friendships WHERE id = ?').get(pend.id!) as any;
    expect(row.status).toBe('accepted');
    expect(row.to_user_id).toBe(ALIAS_B);
    expect(getDB().prepare('SELECT * FROM chats WHERE id = ?').get(CANONICAL)).toBeTruthy();
  });

  it('历史 remote-% 占位行也能转正（向后兼容）', () => {
    getDB().run("INSERT INTO friendships (id, from_user_id, to_user_id, status, message, created_at, updated_at, role) VALUES ('friend-legacy','10001','remote-10001','pending','',1,1,'member')");
    const r = hub.handleFriendAccept({
      from: { userId: '10001', instanceId: INST_B, numericId: 10001, displayName: 'RemoteBob' },
      to: { userId: '10001', instanceId: INST_A },
      chatId: CANONICAL,
    });
    expect(r.ok).toBe(true);
    const row = getDB().prepare('SELECT * FROM friendships WHERE id = ?').get('friend-legacy') as any;
    expect(row.status).toBe('accepted');
    expect(row.to_user_id).toBe(ALIAS_B);
  });

  it('无 pending 行时补建并立即接受（此前只建 pending 卡半途）', () => {
    const r = hub.handleFriendAccept({
      from: { userId: '10001', instanceId: INST_B, numericId: 10001, displayName: 'RemoteBob' },
      to: { userId: '10001', instanceId: INST_A },
      chatId: CANONICAL,
    });
    expect(r.ok).toBe(true);
    const rows = getDB().prepare('SELECT * FROM friendships').all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('accepted');
    expect(rows[0].to_user_id).toBe(ALIAS_B);
  });

  it('to 为指向本实例的别名时剥回 raw ID', () => {
    const r = hub.handleFriendAccept({
      from: { userId: '10001', instanceId: INST_B, numericId: 10001, displayName: 'RemoteBob' },
      to: { userId: xlanAlias(INST_A, '10001'), instanceId: INST_A },
    });
    expect(r.ok).toBe(true);
    const rows = getDB().prepare('SELECT * FROM friendships').all() as any[];
    expect(rows[0].from_user_id).toBe('10001');
    expect(rows[0].status).toBe('accepted');
  });
});

describe('S7-4 好友列表 / 请求列表解析', () => {
  async function becomeFriends() {
    mocks.peers.set(INST_A, peerA);
    const r = hub.handleIncomingFriendRequest({
      from: { userId: '10001', instanceId: INST_A, numericId: 10001, displayName: 'RemoteAlice' },
      toNumericId: 10001,
    });
    await hub.respondFriendRequest(r.requestId, 'accept');
  }

  it('friends() 远程好友：昵称/数字ID/实例/在线/规范会话全部正确', async () => {
    await becomeFriends();
    const list = hub.friends('10001');
    expect(list.length).toBe(1);
    const f = list[0];
    expect(f.friendId).toBe(ALIAS_A);
    expect(f.displayName).toBe('RemoteAlice');   // 此前恒为 friendId 兜底
    expect(f.numericId).toBe(10001);
    expect(f.instanceId).toBe(INST_A);
    expect(f.online).toBe(true);                 // 此前恒 false
    expect(f.isLocal).toBe(false);
    expect(f.chatId).toBe(CANONICAL);
  });

  it('friendRequests() incoming 解析远端昵称', () => {
    hub.handleIncomingFriendRequest({
      from: { userId: '10001', instanceId: INST_A, numericId: 10001, displayName: 'RemoteAlice' },
      toNumericId: 10001,
    });
    const box = hub.friendRequests('10001');
    expect(box.incoming.length).toBe(1);
    expect(box.incoming[0].fromName).toBe('RemoteAlice');
    expect(box.incoming[0].fromNumericId).toBe(10001);
    expect(box.pendingIncoming.length).toBe(1);
  });
});

describe('S7-5 跨引擎私聊收发', () => {
  async function becomeFriends() {
    mocks.peers.set(INST_A, peerA);
    const r = hub.handleIncomingFriendRequest({
      from: { userId: '10001', instanceId: INST_A, numericId: 10001, displayName: 'RemoteAlice' },
      toNumericId: 10001,
    });
    await hub.respondFriendRequest(r.requestId, 'accept');
    mocks.sendToPeer.mockClear();
  }

  it('sendPrivateMessage：规范会话 + wire 传对方 raw ID + toInstance', async () => {
    await becomeFriends();
    const r = await hub.sendPrivateMessage('10001', ALIAS_A, '你好，跨引擎的朋友！');
    expect(r.ok).toBe(true);
    expect(r.queued).toBeFalsy();
    expect(mocks.sendToPeer).toHaveBeenCalledTimes(1);
    const [, p, body] = mocks.sendToPeer.mock.calls[0];
    expect(p).toBe('/api/lan/peer/private-message');
    expect(body.chatId).toBe(CANONICAL);
    expect(body.fromInstance).toBe(INST_B);
    expect(body.fromUserId).toBe('10001');
    expect(body.toUserId).toBe('10001');   // 对方本机 raw ID（此前传本机别名，对方无法归一）
    expect(body.toInstance).toBe(INST_A);
    expect(body.msg.content).toBe('你好，跨引擎的朋友！');
    // 本地落库
    const m = getDB().prepare('SELECT * FROM messages WHERE chat_id = ?').get(CANONICAL) as any;
    expect(m.content).toBe('你好，跨引擎的朋友！');
    expect(m.sender_id).toBe('10001');
  });

  it('对方离线 → 私聊入离线队列', async () => {
    await becomeFriends();
    mocks.peers.clear();
    const r = await hub.sendPrivateMessage('10001', ALIAS_A, '离线消息');
    expect(r.ok).toBe(true);
    expect(r.queued).toBe(true);
    const q = getDB().prepare('SELECT * FROM lan_outbox WHERE instance_id = ?').all(INST_A) as any[];
    expect(q.some(x => x.path === '/api/lan/peer/private-message')).toBe(true);
  });

  it('handlePrivateMessage：发送方别名化落库 + 规范会话 + 去重', () => {
    const body = {
      chatId: CANONICAL, fromInstance: INST_A, fromUserId: '10001', toUserId: '10001',
      msg: { id: 'm-xlan-1', content: '来自 A 的消息', ts: 1700000000000 },
    };
    const r = hub.handlePrivateMessage(body);
    expect(r.ok).toBe(true);
    const m = getDB().prepare('SELECT * FROM messages WHERE id = ?').get('m-xlan-1') as any;
    expect(m.chat_id).toBe(CANONICAL);
    expect(m.sender_id).toBe(ALIAS_A);  // 与好友列表 friendId 一致，前端可归属
    expect(m.content).toBe('来自 A 的消息');
    const parts = getDB().prepare('SELECT user_id FROM participants WHERE chat_id = ?').all(CANONICAL) as any[];
    expect(parts.map(x => x.user_id).sort()).toEqual(['10001', ALIAS_A].sort());
    // 去重
    const r2 = hub.handlePrivateMessage(body);
    expect(r2.dedup).toBe(true);
    expect((getDB().prepare('SELECT COUNT(*) c FROM messages WHERE id = ?').get('m-xlan-1') as any).c).toBe(1);
  });

  it('handlePrivateMessage：toUserId 为指向本实例的别名时归一', () => {
    const r = hub.handlePrivateMessage({
      chatId: CANONICAL, fromInstance: INST_A, fromUserId: '10001',
      toUserId: xlanAlias(INST_B, '10001'),
      msg: { id: 'm-xlan-2', content: '别名收件', ts: 1700000000001 },
    });
    expect(r.ok).toBe(true);
    const parts = getDB().prepare('SELECT user_id FROM participants WHERE chat_id = ?').all(CANONICAL) as any[];
    expect(parts.map(x => x.user_id)).toContain('10001');
  });
});

describe('S7-6 删好友乒乓循环切断', () => {
  async function becomeFriends() {
    mocks.peers.set(INST_A, peerA);
    const r = hub.handleIncomingFriendRequest({
      from: { userId: '10001', instanceId: INST_A, numericId: 10001, displayName: 'RemoteAlice' },
      toNumericId: 10001,
    });
    await hub.respondFriendRequest(r.requestId, 'accept');
    mocks.sendToPeer.mockClear();
  }

  it('notifyPeer=false（peer 回调入口）：只删本地，不再回声通知', async () => {
    await becomeFriends();
    const r = await hub.removeFriend('10001', ALIAS_A, false);
    expect(r.ok).toBe(true);
    expect(mocks.sendToPeer).not.toHaveBeenCalled();  // 循环切断
    expect(getDB().prepare('SELECT COUNT(*) c FROM friendships').get()).toEqual({ c: 0 });
  });

  it('notifyPeer=true（用户主动删）：通知一次，wire 带 raw ID + fromInstance', async () => {
    await becomeFriends();
    const r = await hub.removeFriend('10001', ALIAS_A);
    expect(r.ok).toBe(true);
    expect(mocks.sendToPeer).toHaveBeenCalledTimes(1);
    const [, p, body] = mocks.sendToPeer.mock.calls[0];
    expect(p).toBe('/api/lan/peer/friend-remove');
    expect(body.userId).toBe('10001');        // 对方本机 raw ID
    expect(body.friendId).toBe('10001');      // 我的 raw ID
    expect(body.fromInstance).toBe(INST_B);
    expect(getDB().prepare('SELECT COUNT(*) c FROM friendships').get()).toEqual({ c: 0 });
  });
});

describe('S7-7 发送侧定向与占位行', () => {
  it('instanceId 定向：同号本机用户不吞请求，占位行用目标别名', async () => {
    mocks.peers.set(INST_A, peerA);
    const r = await hub.sendFriendRequest('10001', 10001, '定向申请', INST_A);
    expect(r.ok).toBe(true);
    expect(r.local).toBeFalsy();
    expect(mocks.sendToPeer).toHaveBeenCalledTimes(1);
    const [, p, body] = mocks.sendToPeer.mock.calls[0];
    expect(p).toBe('/api/lan/peer/friend-request');
    expect(body.from.instanceId).toBe(INST_B);
    expect(body.toNumericId).toBe(10001);
    const row = getDB().prepare('SELECT * FROM friendships WHERE from_user_id = ?').get('10001') as any;
    expect(row.to_user_id).toBe(ALIAS_A);  // 不再是 remote-10001
    expect(row.status).toBe('pending');
  });

  it('sendToPeer 失败 → 占位行回滚，可重试', async () => {
    mocks.peers.set(INST_A, peerA);
    mocks.sendToPeer.mockImplementation(async () => { throw new Error('网络不通'); });
    await expect(hub.sendFriendRequest('10001', 10001, 'hi', INST_A)).rejects.toThrow('网络不通');
    expect(getDB().prepare('SELECT COUNT(*) c FROM friendships').get()).toEqual({ c: 0 });
    // 重试成功
    mocks.sendToPeer.mockImplementation(async () => ({ ok: true }));
    const r = await hub.sendFriendRequest('10001', 10001, 'hi', INST_A);
    expect(r.ok).toBe(true);
  });

  it('无同号在线邻居且本机持有该 ID → 明确报「添加自己」', async () => {
    await expect(hub.sendFriendRequest('10001', 10001, 'hi')).rejects.toThrow('不能添加自己');
  });
});
