/**
 * 局域网社交中枢 (LAN Social Hub)
 *
 * 把「发现层 + 传输层 + 本地 DB + 消息编排」粘合成完整的局域网社交能力：
 *   1. 按数字 ID 搜索邻居 / 加好友（跨引擎双向同步 friendships + 私聊）
 *   2. 局域网群组：每个群 = 两个确定性聊天
 *        - langroup-{id}-human  成员聊天（纯人类，跨引擎同步落库）
 *        - langroup-{id}-agents 智能体交互（各方灵犀引擎多智能体编排）
 *   3. 群消息在所有成员引擎间复制，保证每台引擎都持有完整历史，
 *      从而任意引擎都能用自己的本地 Agent 读取共享上下文进行回复。
 *
 * 关键不变量：群组两个聊天里的每条消息都会在「每个成员引擎」上各落一份，
 * 且使用同一个 msgId，前端按 msgId 去重。
 */

import type { MessageRouter } from '../core/router.js';
import {
  createChat, addParticipant, addMessage, getChatMode, setChatMode,
  getChatById, listMessages, messageExists,
  sendFriendRequest, respondFriendRequest, getFriendRequests, listFriends,
  getFriendshipById, getFriendshipByPair,
  createLanGroup, getLanGroup, listLanGroups, setLanGroupMode,
  addLanGroupMember, getLanGroupMembers, removeLanGroup,
  upsertLanRemoteIdentity, getLanRemoteIdentity, listLanRemoteIdentities,
  getAgentByUserId, getUser, getUserByNumericId,
  saveLanGroupInvite, getLanGroupInvite, listLanGroupInvites,
  updateLanGroupInviteStatus, getLanGroupInviteByGroup,
  getDB,
  deleteFriendshipByPair,
  deleteLanGroup,
  removeLanGroupMember,
  makePrivateChatId,
} from '../storage/db.js';
import {
  getLanPeers, getLanPeer, findPeerByNumericId, getLanInstanceId,
  type LanPeer, type LanUser,
} from './lan-discovery.js';
import { sendToPeer } from './lan-transport.js';

/** 社交面板订阅的专用频道（WS chatId） */
export const LAN_SOCIAL_CHANNEL = '__lan_social__';

/** 群组两个人类/智能体聊天 ID 的确定性生成 */
export function humanChatId(groupId: string): string { return `langroup-${groupId}-human`; }
export function agentChatId(groupId: string): string { return `langroup-${groupId}-agents`; }

export interface LanSocialDeps {
  router: MessageRouter;
  manager: any; // AgentManager
  broadcast: (event: any) => void;
  /** 返回本机用户列表（含 numericId / agentId），与发现层灯塔共用 */
  getLocalUsers: () => LanUser[];
}

/** 群成员在编排时的视图 */
interface AgentRosterEntry {
  userId: string;
  numericId?: number;
  displayName: string;
  agentId?: string;
  instanceId: string;
  isLocal: boolean;
}

export class LanSocialHub {
  private router: MessageRouter;
  private manager: any;
  private broadcast: (event: any) => void;
  private getLocalUsers: () => LanUser[];
  /** per-chatId 编排串行锁：同一群的并发话题排队执行，避免回复交错/回读串号 */
  private orchLocks = new Map<string, Promise<void>>();
  /** 离线邻居待补发队列：instanceId -> 待重发的群同步负载（peer 上线后自动补发） */
  private outbox = new Map<string, Array<{ path: string; body: any; ts: number }>>();
  private outboxTimer?: ReturnType<typeof setInterval>;

  constructor(deps: LanSocialDeps) {
    this.router = deps.router;
    this.manager = deps.manager;
    this.broadcast = deps.broadcast;
    this.getLocalUsers = deps.getLocalUsers;
    // P1-6: 启动时从数据库恢复离线队列
    this.loadOutboxFromDB();
    // 每 10 秒尝试把离线队列补发给已上线的邻居
    this.outboxTimer = setInterval(() => { this.flushOutbox().catch(() => {}); }, 10000);
    if (this.outboxTimer && typeof (this.outboxTimer as any).unref === 'function') (this.outboxTimer as any).unref();
  }

  // ════════════════════════════════════════════
  // 基础：本机身份 / 邻居 / 搜索
  // ════════════════════════════════════════════

  /** 本机所有用户（带 agent） */
  localUsers(): LanUser[] {
    return this.getLocalUsers();
  }

  /** 取本机主用户（默认第一个有 numericId 的） */
  primaryLocalUser(): LanUser | undefined {
    const users = this.localUsers();
    return users.find((u) => u.numericId) || users[0];
  }

  /** 在线邻居（含各自用户） */
  peers(): LanPeer[] {
    return getLanPeers();
  }

  /**
   * 按数字 ID 或昵称搜索：先查本机用户，再查在线邻居。
   * 返回可被「加好友/拉群」的目标列表。
   */
  search(q: string): Array<{ numericId: number; displayName: string; userId: string; agentId?: string; instanceId: string; local: boolean }> {
    const kw = String(q || '').trim();
    const results: Array<any> = [];
    const asNum = Number(kw);

    // 本机用户
    for (const u of this.localUsers()) {
      const hit = (kw && u.displayName.toLowerCase().includes(kw.toLowerCase())) ||
        (Number.isFinite(asNum) && u.numericId === asNum);
      if (hit) results.push({ numericId: u.numericId, displayName: u.displayName, userId: u.id, agentId: u.agentId, instanceId: getLanInstanceId(), local: true });
    }
    // 在线邻居
    for (const peer of getLanPeers()) {
      for (const u of peer.users) {
        const hit = (kw && u.displayName.toLowerCase().includes(kw.toLowerCase())) ||
          (Number.isFinite(asNum) && u.numericId === asNum);
        if (hit) results.push({ numericId: u.numericId, displayName: u.displayName, userId: u.id, agentId: u.agentId, instanceId: peer.instanceId, local: false });
      }
    }
    return results;
  }

  // ════════════════════════════════════════════
  // 好友（跨引擎）
  // ════════════════════════════════════════════

  /**
   * 向某个数字 ID 发起好友请求。
   * @param fromUserId 本机发起用户 id
   * @param toNumericId 目标数字 ID
   */
  async sendFriendRequest(fromUserId: string, toNumericId: number, message: string): Promise<any> {
    const fromUser = this.localUsers().find((u) => u.id === fromUserId) || this.primaryLocalUser();
    if (!fromUser) throw new Error('本机没有可用用户');
    // 修复（审查）：不能在此处用 fromUser.numericId === toNumericId 直接拒绝——
    // 各引擎 numeric_id 均从 10000 起独立分配，跨引擎同号是常态（两台引擎的首个用户都是 10000），
    // 同号的在线邻居是另一个人，必须允许走 LAN 转发。
    // “不能添加自己”的判定推迟到确认没有同号在线邻居之后。

    // 先检查目标用户是否在本机数据库中（同实例用户互相添加好友）
    const localTarget = getUserByNumericId(toNumericId);
    // 本机命中自己时绝不能走本地路径（否则请求被本机吞掉，对方引擎永远收不到），
    // 必须继续走 LAN 把请求转发给邻居引擎。
    if (localTarget && localTarget.id !== fromUser.id) {
      // 目标用户在本机，直接创建好友关系，无需 LAN 传输
      const result = sendFriendRequest(fromUser.id, localTarget.id, message);
      if (result.error) return { ok: false, error: result.error };
      // 广播通知目标用户（如果在线）
      this.broadcast({
        type: 'lan.friend.request', chatId: LAN_SOCIAL_CHANNEL,
        from: { userId: fromUser.id, numericId: fromUser.numericId, displayName: fromUser.displayName },
        toUserId: localTarget.id, message: message || '', requestId: result.id,
        timestamp: Date.now(),
      });
      return { ok: true, local: true, ...result };
    }

    // 目标用户不在本机（或本机命中是自己——数字 ID 与邻居冲突），尝试通过 LAN 发现找到对方
    const found = findPeerByNumericId(toNumericId);
    if (!found) {
      if (localTarget) {
        // 无同号在线邻居且本机持有该数字 ID → 实际是在添加自己
        throw new Error(`不能添加自己为好友（数字 ID ${toNumericId} 与本机用户「${localTarget.displayName}」相同）。若对方在另一台引擎上，请确认对方在线且处于同一网段后重试`);
      }
      throw new Error(`未找到数字 ID 为 ${toNumericId} 的在线邻居`);
    }

    const fromInfo = {
      userId: fromUser.id, numericId: fromUser.numericId,
      displayName: fromUser.displayName, agentId: fromUser.agentId,
      instanceId: getLanInstanceId(),
    };

    // 本地先记一条 pending（ outgoing ）；若已存在 pending/accepted 则短路，避免重复通知对方
    const localPending = sendFriendRequest(fromUser.id, `remote-${toNumericId}`, message);
    if (localPending && localPending.error) {
      return { ok: false, error: localPending.error };
    }

    // 发给对方引擎
    // 修复（审查）：sendToPeer 失败（对方引擎拒绝/网络不通等）时必须回滚本地 pending，
    // 否则残留的 remote-{id} 记录会永久阻塞重试（DB 查重短路为“好友申请已发送”）。
    try {
      const resp = await sendToPeer(found.peer, '/api/lan/peer/friend-request', {
        from: fromInfo,
        toNumericId,
        message,
      });
      return { ok: true, ...resp };
    } catch (e) {
      deleteFriendshipByPair(fromUser.id, `remote-${toNumericId}`);
      throw e;
    }
  }

  /** 收到好友请求（对方引擎调用） */
  handleIncomingFriendRequest(body: any): any {
    const { from, toNumericId, message } = body || {};
    if (!from || !from.userId) return { error: '缺少来源用户信息' };
    // 记录远程身份
    upsertLanRemoteIdentity({
      userId: from.userId, instanceId: from.instanceId,
      numericId: from.numericId, displayName: from.displayName, agentId: from.agentId,
    });
    // 找到本机目标用户
    const target = this.localUsers().find((u) => u.numericId === toNumericId) || this.primaryLocalUser();
    if (!target) return { error: '本机没有可接收好友请求的用户' };
    const result = sendFriendRequest(from.userId, target.id, message || '');
    // 修复：写入失败（重复申请/已是好友等）时必须如实返回错误，
    // 否则发送方看到"已发送"，但本机数据库根本没有记录，接收方永远查不到。
    if (result.error) return { error: result.error };
    // 通知本机社交面板
    this.broadcast({
      type: 'lan.friend.request', chatId: LAN_SOCIAL_CHANNEL,
      from, toUserId: target.id, message: message || '', requestId: result.id,
      timestamp: Date.now(),
    });
    return { ok: true, requestId: result.id };
  }

  /** 本机用户处理好友请求（accept/reject） */
  async respondFriendRequest(requestId: string, action: 'accept' | 'reject', responderUserId?: string): Promise<any> {
    const result = respondFriendRequest(requestId, action, responderUserId);
    if (result.error) throw new Error(result.error);
    if (action !== 'accept') return { ok: true, status: 'denied' };

    // 查出这条申请的双方（直接读 friendship 行）
    const row = this.findFriendshipById(requestId);
    if (!row) return { ok: true, status: 'accepted' };
    const fromUserId = row.from_user_id;   // 发起者
    const toUserId = row.to_user_id;       // 本机用户

    // 先检查发起者是否是本地用户
    const localFrom = getUser(fromUserId);
    if (localFrom) {
      // 本地用户之间的好友申请，直接建私聊
      const chatId = this.ensurePrivateChat(fromUserId, toUserId, localFrom.agent_id);
      this.broadcast({ type: 'lan.friend.accepted', chatId: LAN_SOCIAL_CHANNEL, friendUserId: fromUserId, chatId2: chatId, timestamp: Date.now() });
      return { ok: true, status: 'accepted', chatId, local: true };
    }

    // 远程用户（LAN 邻居）
    const remote = getLanRemoteIdentity(fromUserId);
    if (!remote) return { ok: true, status: 'accepted', note: '远程身份缺失，仅本地生效' };

    // 本机建私聊
    const chatId = this.ensurePrivateChat(fromUserId, toUserId, remote.agentId);

    // 回调对方引擎，让对方也建关系 + 私聊
    const toUser = this.localUsers().find((u) => u.id === toUserId);
    const toInfo = {
      userId: toUserId, numericId: toUser?.numericId, displayName: toUser?.displayName || '用户',
      agentId: toUser?.agentId, instanceId: getLanInstanceId(),
    };
    const peer = getLanPeer(remote.instanceId);
    if (peer) {
      try {
        await sendToPeer(peer, '/api/lan/peer/friend-accept', { from: toInfo, to: remote, chatId });
      } catch (e: any) {
        console.error('[LAN] 回调好友接受失败:', e.message);
      }
    }
    this.broadcast({ type: 'lan.friend.accepted', chatId: LAN_SOCIAL_CHANNEL, friendUserId: fromUserId, chatId2: chatId, timestamp: Date.now() });
    return { ok: true, status: 'accepted', chatId };
  }

  /** 对方接受后的回调（对方引擎调用）：本机补建关系 + 私聊 */
  handleFriendAccept(body: any): any {
    const { from, to, chatId } = body || {};
    if (!from || !to) return { error: '缺少信息' };
    // from = 对方（接受者），to = 本机发起者
    upsertLanRemoteIdentity({
      userId: from.userId, instanceId: from.instanceId,
      numericId: from.numericId, displayName: from.displayName, agentId: from.agentId,
    });
    // 把之前 pending 的申请置为 accepted
    // 尝试三种方式找到 pending 的好友申请记录
    let row = this.findFriendshipByPair(to.userId, from.userId);
    if (!row) row = this.findFriendshipByPair(from.userId, to.userId);
    if (!row) {
      // B发请求时用了 remote-{numericId} 假ID，直接搜 from_user_id + to_user_id LIKE 'remote-%'
      try {
        const raw = getDB();
        const stmt = raw.prepare("SELECT * FROM friendships WHERE from_user_id = ? AND to_user_id LIKE 'remote-%' AND status = 'pending' LIMIT 1");
        stmt.bind([to.userId]);
        if (stmt.step()) {
          row = stmt.getAsObject();
          // 把 remote-{nid} 更新为真实 userId
          raw.run("UPDATE friendships SET to_user_id = ? WHERE id = ?", [from.userId, row.id]);
        }
        stmt.free();
      } catch (_e) { /* 忽略查询错误 */ }
    }
    if (row) respondFriendRequest(row.id, 'accept', String(to.userId || ''));
    else sendFriendRequest(to.userId, from.userId, '');
    // 建私聊（用对方给的 chatId 保证一致）
    this.ensurePrivateChat(to.userId, from.userId, from.agentId, chatId);
    this.broadcast({ type: 'lan.friend.accepted', chatId: LAN_SOCIAL_CHANNEL, friendUserId: from.userId, chatId2: chatId, timestamp: Date.now() });
    return { ok: true };
  }

  /** 好友列表（合并本地 friendships 与远程身份解析） */
  friends(userId: string) {
    const friends = listFriends(userId);
    return friends.map((f: any) => {
      // 先检查是否是本地用户
      const localFriend = getUser(f.friendId);
      if (localFriend) {
        return {
          friendId: f.friendId,
          displayName: localFriend.display_name || f.friendName || f.friendId,
          numericId: localFriend.numeric_id,
          agentId: localFriend.agent_id || f.friendAgentId,
          instanceId: getLanInstanceId(),
          online: localFriend.status === 'online',
          chatId: makePrivateChatId(f.fromUserId, f.toUserId),
          isLocal: true,
        };
      }
      const remote = getLanRemoteIdentity(f.friendId);
      return {
        friendId: f.friendId,
        displayName: remote?.displayName || f.friendName || f.friendId,
        numericId: remote?.numericId,
        agentId: remote?.agentId || f.friendAgentId,
        instanceId: remote?.instanceId,
        online: remote ? !!getLanPeer(remote.instanceId) : false,
        chatId: makePrivateChatId(f.fromUserId, f.toUserId),
        isLocal: false,
      };
    });
  }

  friendRequests(userId: string) {
    const { incoming, outgoing, pendingIncoming } = getFriendRequests(userId);
    const resolve = (uid: string) => {
      const local = this.localUsers().find((u) => u.id === uid);
      if (local) return { displayName: local.displayName, numericId: local.numericId };
      const r = getLanRemoteIdentity(uid);
      return r ? { displayName: r.displayName, numericId: r.numericId } : { displayName: uid };
    };
    return {
      incoming: incoming.map((r: any) => ({ ...r, fromName: resolve(r.fromUserId).displayName, fromNumericId: resolve(r.fromUserId).numericId })),
      // v2.1.7: 红点专用 —— 只含待处理(pending)申请，历史 accepted/denied 不参与计数
      pendingIncoming: (pendingIncoming || []).map((r: any) => ({ ...r, fromName: resolve(r.fromUserId).displayName, fromNumericId: resolve(r.fromUserId).numericId })),
      outgoing: outgoing.map((r: any) => ({ ...r, toName: resolve(r.toUserId).displayName })),
    };
  }

  // ════════════════════════════════════════════
  // 群组
  // ════════════════════════════════════════════

  /**
   * 创建局域网群组并邀请成员（按数字 ID）。
   * @param ownerUserId 本机创建者
   * @param name 群名
   * @param memberNumericIds 成员数字 ID 列表（可含创建者自己）
   */
  async createGroup(ownerUserId: string, name: string, memberNumericIds: number[], chatMode = 'free'): Promise<any> {
    const owner = this.localUsers().find((u) => u.id === ownerUserId) || this.primaryLocalUser();
    if (!owner) throw new Error('本机没有可用用户');

    const groupId = 'lg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    createLanGroup(groupId, name, getLanInstanceId(), chatMode);

    // 收集成员：创建者 + 各数字 ID 对应的用户
    const members: AgentRosterEntry[] = [];
    const addMember = (u: { id: string; numericId: number; displayName: string; agentId?: string }, instanceId: string, isLocal: boolean) => {
      if (members.some((m) => m.userId === u.id)) return;
      members.push({ userId: u.id, numericId: u.numericId, displayName: u.displayName, agentId: u.agentId, instanceId, isLocal });
    };
    addMember(owner as any, getLanInstanceId(), true);

    const invitedPeers: LanPeer[] = [];
    for (const nid of memberNumericIds) {
      if (nid === owner.numericId) continue;
      // 先找本机
      const localU = this.localUsers().find((u) => u.numericId === nid);
      if (localU) { addMember(localU as any, getLanInstanceId(), true); continue; }
      // 再找邻居
      const found = findPeerByNumericId(nid);
      if (!found) throw new Error(`未找到数字 ID 为 ${nid} 的在线邻居`);
      addMember(found.user as any, found.peer.instanceId, false);
      upsertLanRemoteIdentity({ userId: found.user.id, instanceId: found.peer.instanceId, numericId: found.user.numericId, displayName: found.user.displayName, agentId: found.user.agentId });
      if (!invitedPeers.some((p) => p.instanceId === found.peer.instanceId)) invitedPeers.push(found.peer);
    }

    // 本地落库：群成员 + 两个聊天
    this.materializeGroupLocally(groupId, name, getLanInstanceId(), chatMode, members);

    // 邀请远程成员引擎 - 失败时入离线队列重试
    const groupDef = {
      group: { id: groupId, name, ownerInstance: getLanInstanceId(), chatMode },
      members: members.map((m) => ({ instanceId: m.instanceId, userId: m.userId, numericId: m.numericId, displayName: m.displayName, agentId: m.agentId })),
    };
    for (const peer of invitedPeers) {
      try {
        await sendToPeer(peer, '/api/lan/peer/group-invite', groupDef);
      } catch (e: any) {
        console.error(`[LAN] 邀请 ${peer.instanceId} 失败:`, e.message);
        // 入离线队列，等对方上线后自动重发
        this.enqueueForPeer(peer.instanceId, '/api/lan/peer/group-invite', groupDef);
      }
    }

    this.broadcast({ type: 'lan.group.created', chatId: LAN_SOCIAL_CHANNEL, groupId, name, timestamp: Date.now() });
    return { ok: true, groupId, name, memberCount: members.length };
  }

  /** 收到群邀请（对方引擎调用）：自动接受，立即本地建群 */
  handleGroupInvite(body: any): any {
    const { group, members } = body || {};
    if (!group || !Array.isArray(members)) return { error: '缺少群组信息' };
    // 如果已存在，跳过
    if (getLanGroup(group.id)) return { ok: true, note: '已存在' };

    // 记录远程身份
    for (const m of members) {
      if (m.instanceId !== getLanInstanceId()) {
        upsertLanRemoteIdentity({ userId: m.userId, instanceId: m.instanceId, numericId: m.numericId, displayName: m.displayName, agentId: m.agentId });
      }
    }

    // P0-3 修复: 不再自动接受，保存邀请并通知前端让用户确认
    // 找到本机被邀请的用户
    const localUsers = this.localUsers();
    const invitedUser = localUsers.find(u =>
      members.some((m: any) => m.numericId === u.numericId)
    ) || localUsers[0];

    if (invitedUser) {
      try {
        saveLanGroupInvite({
          id: 'invite-' + group.id + '-' + invitedUser.id,
          groupId: group.id,
          groupName: group.name,
          ownerInstance: group.ownerInstance || '',
          ownerUserId: members.find((m: any) => m.instanceId === (group.ownerInstance || ''))?.userId || '',
          invitedUserId: invitedUser.id,
          invitedUserNumericId: invitedUser.numericId,
          inviterName: members.find((m: any) => m.instanceId === (group.ownerInstance || ''))?.displayName || '未知',
          groupDef: { group, members },
        });
      } catch (e: any) {
        console.warn('[LAN] 保存群邀请失败:', e.message);
      }
    }

    // 广播给前端：有新的群邀请待确认
    this.broadcast({
      type: 'lan.group.invite.pending',
      chatId: LAN_SOCIAL_CHANNEL,
      groupId: group.id,
      groupName: group.name,
      inviterName: members.find((m: any) => m.instanceId === (group.ownerInstance || ''))?.displayName || '未知',
      memberCount: members.length,
      timestamp: Date.now(),
    });

    return { ok: true, pending: true };
  }

  /** 用户主动接受群邀请（方案C - 保留但主流程已改为自动接受） */
  async acceptGroupInvite(inviteId: string, userId: string): Promise<any> {
    const invite = getLanGroupInvite(inviteId);
    if (!invite) throw new Error('邀请不存在');
    if (invite.invited_user_id !== userId) throw new Error('无权接受此邀请');
    if (invite.status !== 'pending') throw new Error('该邀请已被处理');

    // 检查是否已建群
    if (getLanGroup(invite.group_id)) {
      updateLanGroupInviteStatus(inviteId, 'accepted');
      return { ok: true, groupId: invite.group_id, note: '已存在' };
    }

    // 解析 groupDef
    const groupDef = typeof invite.group_def === 'string'
      ? JSON.parse(invite.group_def)
      : invite.group_def;
    const { group, members } = groupDef;

    // 本地落库建群
    this.materializeGroupLocally(
      group.id, group.name, invite.owner_instance || group.ownerInstance,
      group.chatMode || 'free', members
    );

    // 更新邀请状态
    updateLanGroupInviteStatus(inviteId, 'accepted');

    // 通知创建者引擎：A已接受
    const ownerPeer = getLanPeer(invite.owner_instance);
    if (ownerPeer) {
      try {
        await sendToPeer(ownerPeer, '/api/lan/peer/group-invite-accepted', {
          groupId: group.id,
          userId,
        });
      } catch (e: any) {
        console.error('[LAN] 通知群创建者接受失败:', e.message);
      }
    }

    this.broadcast({
      type: 'lan.group.invite.accepted',
      chatId: LAN_SOCIAL_CHANNEL,
      groupId: group.id,
      groupName: group.name,
      timestamp: Date.now(),
    });

    return { ok: true, groupId: group.id, name: group.name };
  }

  /** 用户拒绝群邀请 */
  rejectGroupInvite(inviteId: string, userId: string): any {
    const invite = getLanGroupInvite(inviteId);
    if (!invite) throw new Error('邀请不存在');
    if (invite.invited_user_id !== userId) throw new Error('无权拒绝此邀请');
    if (invite.status !== 'pending') throw new Error('该邀请已被处理');

    updateLanGroupInviteStatus(inviteId, 'rejected');

    this.broadcast({
      type: 'lan.group.invite.rejected',
      chatId: LAN_SOCIAL_CHANNEL,
      inviteId,
      groupId: invite.group_id,
      timestamp: Date.now(),
    });

    return { ok: true, status: 'rejected' };
  }

  /** 查看待确认的群邀请 */
  listPendingInvites(userId: string): any[] {
    return listLanGroupInvites(userId, 'pending').map((inv: any) => ({
      inviteId: inv.id,
      groupId: inv.group_id,
      groupName: inv.group_name,
      inviterName: inv.inviter_name || '',
      createdAt: inv.created_at,
    }));
  }

  /** 收到对方已接受邀请的回调（B的引擎调用） */
  handleGroupInviteAccepted(body: any): any {
    const { groupId, userId } = body || {};
    if (!groupId) return { error: '缺少 groupId' };
    this.broadcast({
      type: 'lan.group.invite.accepted',
      chatId: LAN_SOCIAL_CHANNEL,
      groupId,
      joinedUserId: userId,
      timestamp: Date.now(),
    });
    return { ok: true };
  }

  /** 本地建群：写 lan_groups/members + 两个聊天 + 参与者 */
  private materializeGroupLocally(groupId: string, name: string, ownerInstance: string, chatMode: string, members: AgentRosterEntry[] | any[]) {
    if (!getLanGroup(groupId)) createLanGroup(groupId, name, ownerInstance, chatMode);
    const hChat = humanChatId(groupId);
    const aChat = agentChatId(groupId);
    if (!getChatById(hChat)) createChat(hChat, 'group');
    if (!getChatById(aChat)) createChat(aChat, 'group');
    setChatMode(aChat, chatMode);
    for (const m of members) {
      addLanGroupMember({ groupId, instanceId: m.instanceId, userId: m.userId, numericId: m.numericId, displayName: m.displayName, agentId: m.agentId });
      // 人类聊天：加用户
      this.safeAddParticipant(`p-${hChat}-${m.userId}`, hChat, m.userId, undefined, 'member');
      // 智能体聊天：加该成员的 agent
      if (m.agentId) this.safeAddParticipant(`p-${aChat}-${m.agentId}`, aChat, m.userId, m.agentId, 'agent');
    }
  }

  private safeAddParticipant(id: string, chatId: string, userId?: string, agentId?: string, role = 'member') {
    try { addParticipant(id, chatId, userId, agentId, role); } catch (_e) { /* 重复忽略 */ }
  }

  listGroups() {
    return listLanGroups().map((g: any) => ({
      id: g.id, name: g.name, ownerInstance: g.owner_instance, chatMode: g.chat_mode, createdAt: g.created_at,
      memberCount: getLanGroupMembers(g.id).length,
      humanChatId: humanChatId(g.id), agentChatId: agentChatId(g.id),
    }));
  }

  getGroup(groupId: string) {
    const g = getLanGroup(groupId);
    if (!g) return null;
    const members = getLanGroupMembers(groupId).map((m) => ({
      userId: m.user_id, numericId: m.numeric_id, displayName: m.display_name, agentId: m.agent_id,
      instanceId: m.instance_id, online: !!getLanPeer(m.instance_id), local: m.instance_id === getLanInstanceId(),
    }));
    return { id: g.id, name: g.name, ownerInstance: g.owner_instance, chatMode: g.chat_mode, createdAt: g.created_at, members, humanChatId: humanChatId(groupId), agentChatId: agentChatId(groupId) };
  }

  async setGroupMode(groupId: string, mode: string): Promise<any> {
    if (!setLanGroupMode(groupId, mode)) throw new Error('无效模式');
    setChatMode(agentChatId(groupId), mode);
    // 同步给所有成员引擎
    for (const peer of this.groupRemotePeers(groupId)) {
      try { await sendToPeer(peer, '/api/lan/peer/group-mode', { groupId, mode }); } catch (_e) {}
    }
    return { ok: true, mode };
  }

  handleGroupMode(body: any): any {
    const { groupId, mode } = body || {};
    if (getLanGroup(groupId)) { setLanGroupMode(groupId, mode); setChatMode(agentChatId(groupId), mode); }
    return { ok: true };
  }

  // ════════════════════════════════════════════
  // 群消息同步（人类聊天）
  // ════════════════════════════════════════════

  /** 本机用户在群人类聊天发消息：落库 + 本地广播 + 同步到所有成员引擎 */
  async sendHumanMessage(senderUserId: string, groupId: string, content: string): Promise<any> {
    const group = getLanGroup(groupId);
    if (!group) throw new Error('群组不存在');
    const chatId = humanChatId(groupId);
    const sender = this.localUsers().find((u) => u.id === senderUserId);
    const msgId = 'lmsg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ts = Date.now();

    // 本地落库 + 广播
    addMessage({ id: msgId, chatId, senderType: 'user', senderId: senderUserId, content, type: 'text', timestamp: ts });
    this.broadcast({ type: 'message.new', chatId, from: senderUserId, senderId: senderUserId, senderType: 'user', senderName: sender?.displayName, content, msgId, timestamp: ts });

    // 同步到其他成员引擎
    const payload = { groupId, chatId, box: 'human', msg: { id: msgId, senderId: senderUserId, senderName: sender?.displayName, content, ts } };
    for (const peer of this.groupRemotePeers(groupId)) {
      sendToPeer(peer, '/api/lan/peer/group-message', payload).catch((e) => console.error('[LAN] 群消息同步失败:', e.message));
    }
    return { ok: true, msgId };
  }

  /** 收到群消息（对方引擎调用）：落库 + 本地广播（按 msgId 去重） */
  handleGroupMessage(body: any): any {
    const { groupId, chatId, msg } = body || {};
    if (!chatId || !msg) return { error: '缺少消息' };
    // 去重：已落库则直接返回，不再重复广播（否则前端会收到重复消息）
    if (msg.id && messageExists(msg.id)) return { ok: true, dedup: true };
    try {
      addMessage({ id: msg.id, chatId, senderType: msg.senderType || 'user', senderId: msg.senderId, content: msg.content, type: 'text', timestamp: msg.ts, metadata: msg.reasoning ? { reasoning: msg.reasoning } : undefined });
    } catch (_e) {
      // 并发写入触发主键冲突时兜底，视为已去重，避免向 peer 返回 500
      return { ok: true, dedup: true };
    }
    this.broadcast({ type: 'message.new', chatId, from: msg.senderId, senderId: msg.senderId, senderType: msg.senderType || 'user', senderName: msg.senderName, content: msg.content, msgId: msg.id, timestamp: msg.ts, reasoning: msg.reasoning });
    return { ok: true };
  }

  // ════════════════════════════════════════════
  // 智能体交互（多智能体编排）
  // ════════════════════════════════════════════

  /**
   * 在群智能体聊天里发起一个话题，触发各方灵犀引擎按编排模式回复。
   */
  async postAgentTopic(senderUserId: string, groupId: string, topic: string): Promise<any> {
    const group = getLanGroup(groupId);
    if (!group) throw new Error('群组不存在');
    const chatId = agentChatId(groupId);
    const mode = (group.chat_mode as string) || 'free';
    const sender = this.localUsers().find((u) => u.id === senderUserId);
    const topicMsgId = 'lmsg-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ts = Date.now();

    // 话题作为用户消息落库 + 广播 + 同步
    addMessage({ id: topicMsgId, chatId, senderType: 'user', senderId: senderUserId, content: topic, type: 'text', timestamp: ts });
    this.broadcast({ type: 'message.new', chatId, from: senderUserId, senderId: senderUserId, senderType: 'user', senderName: sender?.displayName, content: topic, msgId: topicMsgId, timestamp: ts });
    const topicPayload = { groupId, chatId, box: 'agents', msg: { id: topicMsgId, senderId: senderUserId, senderName: sender?.displayName, content: topic, ts } };
    this.broadcastToGroup(groupId, '/api/lan/peer/group-message', topicPayload);

    // 异步编排各成员 Agent 回复
    this.orchestrateAgents(groupId, chatId, mode, topicMsgId, topic).catch((e) => {
      console.error('[LAN] 智能体编排失败:', e.message);
      this.broadcast({ type: 'error', chatId, message: '智能体编排失败: ' + e.message });
    });
    return { ok: true, msgId: topicMsgId, mode };
  }

  // ════════════════════════════════════════════
  // 好友/群组管理（删除/退出）
  // ════════════════════════════════════════════

  /** 删除好友 */
  async removeFriend(userId: string, friendId: string): Promise<any> {
    try {
      // 如果对方是远程用户，通知对方引擎删除好友关系
      const remote = getLanRemoteIdentity(friendId);
      if (remote && remote.instanceId !== getLanInstanceId()) {
        const peer = getLanPeer(remote.instanceId);
        if (peer) {
          try {
            await sendToPeer(peer, '/api/lan/peer/friend-remove', {
              userId: friendId,
              friendId: userId,
            });
          } catch (e: any) {
            console.error('[LAN] 通知对方删除好友失败:', e.message);
          }
        }
      }

      deleteFriendshipByPair(userId, friendId);
      this.broadcast({ type: 'lan.friend.removed', chatId: LAN_SOCIAL_CHANNEL, userId, friendId, timestamp: Date.now() });
      return { ok: true };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  /** 删除群组 */
  async deleteGroup(userId: string, groupId: string): Promise<any> {
    try {
      const group = getLanGroup(groupId);
      if (!group) return { error: '群组不存在' };

      // 获取群成员中的远程实例，通知它们群组被删除
      const members = getLanGroupMembers(groupId);
      const notified = new Set<string>();
      for (const m of members) {
        const remote = getLanRemoteIdentity(m.user_id);
        if (remote && remote.instanceId !== getLanInstanceId() && !notified.has(remote.instanceId)) {
          notified.add(remote.instanceId);
          const peer = getLanPeer(remote.instanceId);
          if (peer) {
            try {
              await sendToPeer(peer, '/api/lan/peer/group-deleted', { groupId, name: group.name });
            } catch (e: any) {
              console.error('[LAN] 通知远程成员群组已删除失败:', e.message);
            }
          }
        }
      }

      deleteLanGroup(groupId);
      this.broadcast({ type: 'lan.group.deleted', chatId: LAN_SOCIAL_CHANNEL, groupId, timestamp: Date.now() });
      return { ok: true };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  /** 退出群组 */
  async leaveGroup(userId: string, groupId: string): Promise<any> {
    try {
      const group = getLanGroup(groupId);
      if (!group) return { error: '群组不存在' };

      // 通知群内其他远程实例
      const members = getLanGroupMembers(groupId);
      const localUser = this.localUsers().find(u => u.id === userId);
      for (const m of members) {
        if (m.user_id === userId) continue;
        const remote = getLanRemoteIdentity(m.user_id);
        if (remote && remote.instanceId !== getLanInstanceId()) {
          const peer = getLanPeer(remote.instanceId);
          if (peer) {
            try {
              await sendToPeer(peer, '/api/lan/peer/group-member-left', {
                groupId, userId, displayName: localUser?.displayName || userId,
              });
            } catch (e: any) { /* 静默 */ }
          }
        }
      }

      removeLanGroupMember(groupId, userId);
      this.broadcast({ type: 'lan.group.member_left', chatId: LAN_SOCIAL_CHANNEL, groupId, userId, timestamp: Date.now() });
      return { ok: true };
    } catch (e: any) {
      return { error: e.message };
    }
  }

  /** 编排各成员 Agent（per-chatId 串行锁包装）。
   *  同一群的并发话题排队执行，避免回复交错、latestAgentMessage 回读串号、跨引擎重复同步。 */
  private orchestrateAgents(groupId: string, chatId: string, mode: string, triggerMsgId: string, topic: string): Promise<void> {
    const ORCH_TIMEOUT = 180_000;  // P1-11: 120秒超时，防止 Promise 永不 resolve 卡死队列
    const run = () => Promise.race([
      this.orchestrateAgentsCore(groupId, chatId, mode, triggerMsgId, topic),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('编排超时(' + ORCH_TIMEOUT/1000 + 's)')), ORCH_TIMEOUT)),
    ]);
    const prev = this.orchLocks.get(chatId) ?? Promise.resolve();
    // 前一个无论成败，后续都继续（, run 兜底），失败的编排不会卡死队列
    const tail = prev.then(run, run);
    this.orchLocks.set(chatId, tail);
    tail.finally(() => { if (this.orchLocks.get(chatId) === tail) this.orchLocks.delete(chatId); }).catch(() => {});
    return tail;
  }

  /** 编排各成员 Agent。本机 Agent 直接 generateReply，远程 Agent 发 peer invoke。 */
  private async orchestrateAgentsCore(groupId: string, chatId: string, mode: string, triggerMsgId: string, topic: string) {
    const roster = this.buildRoster(groupId);
    const agents = roster.filter((r) => r.agentId);
    if (agents.length === 0) {
      this.broadcast({ type: 'lan.agent.note', chatId, message: '群里没有可用的灵犀引擎' });
      return;
    }

    if (mode === 'chain') {
      // 链式：串行，后者读前者输出
      let context = topic;
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        const prompt = `（链式协作第 ${i + 1}/${agents.length} 步）请基于上文继续：\n${context}`;
        const content = await this.invokeAgent(a, chatId, triggerMsgId, topic, prompt);
        if (content) context += `\n\n【${a.displayName}】${content}`;
      }
    } else if (mode === 'route') {
      // 路由：只挑一个（轮询简化为第一个在线）
      const a = agents.find((x) => x.isLocal) || agents[0];
      await this.invokeAgent(a, chatId, triggerMsgId, topic);    } else if (mode === 'debate') {
      // 辩论：① 各方立场并行开火 → ② 主持人总结（跨引擎多阶段）
      const stances = ['支持方', '反对方', '中立分析方', '批判性思维方'];
      const replies: string[] = [];
      await Promise.all(agents.map(async (a, i) => {
        const stance = stances[i % stances.length];
        const content = await this.invokeAgent(a, chatId, triggerMsgId, topic,
          `【辩论模式 - 你是${stance}】\n\n议题：${topic}\n\n请从「${stance}」的立场出发进行论述：1. 清晰表明立场；2. 给出 2-3 个论据；3. 引用事实或逻辑支撑；4. 避免人身攻击，针对议题不针对人。`);
        if (content) replies.push(`【${a.displayName}（${stance}）】\n${content}`);
      }));
      if (replies.length > 0) {
        await this.invokeAgent(agents[0], chatId, triggerMsgId, topic,
          `【辩论总结】\n\n以下是各方观点：\n${replies.join('\n\n').slice(0, 8000)}\n\n请作为中立的总结者，归纳各方主要观点，指出共识和分歧，给出综合评价。`);
      }
    } else if (mode === 'roundtable') {
      // 圆桌：① 第1轮并行 → ② 第2轮（回应他人）→ ③ 主持人总结
      const maxRounds = 3;
      const round1: string[] = [];
      await Promise.all(agents.map(async (a) => {
        const content = await this.invokeAgent(a, chatId, triggerMsgId, topic,
          `【圆桌讨论 - 第 1 轮 / 共 ${maxRounds} 轮】\n\n议题：${topic}\n\n你是参与者之一。请发表你的看法：1. 对这个问题的理解；2. 你的建议或方案；3. 对其他成员可能的质疑点。稍后其他成员会回复你，保持开放态度。`);
        if (content) round1.push(`【${a.displayName}】\n${content}`);
      }));
      const round2: string[] = [];
      await Promise.all(agents.map(async (a) => {
        const content = await this.invokeAgent(a, chatId, triggerMsgId, topic,
          `【圆桌讨论 - 第 2 轮 / 共 ${maxRounds} 轮】\n\n以下是第一轮发言：\n${round1.join('\n\n').slice(0, 8000)}\n\n请基于以上内容，回应其他成员的观点，补充或修正你的看法。`);
        if (content) round2.push(`【${a.displayName}】\n${content}`);
      }));
      await this.invokeAgent(agents[0], chatId, triggerMsgId, topic,
        `【圆桌总结】\n\n以下是两轮讨论内容：\n${[...round1, ...round2].join('\n\n').slice(0, 12000)}\n\n圆桌讨论已结束。请作为主持人对本次讨论做一个简洁的总结，归纳各方达成的共识和主要分歧。`);
    } else if (mode === 'vote') {
      // 投票：① 独立投票 → ② 开票统计（跨引擎多阶段）
      const votes: string[] = [];
      await Promise.all(agents.map(async (a) => {
        const content = await this.invokeAgent(a, chatId, triggerMsgId, topic,
          `【投票模式】\n\n议题：${topic}\n\n请投出你的一票。回复格式：\n✅ 我选择：选项X\n理由：（一句话说明为什么）`);
        if (content) votes.push(`【${a.displayName}】\n${content}`);
      }));
      if (votes.length > 0) {
        await this.invokeAgent(agents[0], chatId, triggerMsgId, topic,
          `【投票开票】\n\n以下是各位 AI 的投票结果：\n${votes.join('\n\n').slice(0, 8000)}\n\n请作为计票员：1. 统计每个选项的得票数；2. 用清单列出开票结果；3. 宣布得票最高的方案，并简述各方理由。`);
      }
    } else if (mode === 'brainstorm') {
      // 头脑风暴：① 发散 → ② 收敛 → ③ 主持人汇总行动项（跨引擎三阶段）
      const ideas: string[] = [];
      await Promise.all(agents.map(async (a) => {
        const content = await this.invokeAgent(a, chatId, triggerMsgId, topic,
          `【头脑风暴 - 第 1 阶段：发散】\n\n议题：${topic}\n\n规则（必须遵守）：1. 只输出点子，不要解释过程；2. 禁止批评、禁止否定（包括自我否定）；3. 质大于量：给出 3-5 个具体、可执行的点子；4. 欢迎大胆、非常规的想法；5. 每个点子以「- 」开头，一句话说清。`);
        if (content) ideas.push(`【${a.displayName}】\n${content}`);
      }));
      const converged: string[] = [];
      await Promise.all(agents.map(async (a) => {
        const content = await this.invokeAgent(a, chatId, triggerMsgId, topic,
          `【头脑风暴 - 第 2 阶段：收敛】\n\n议题：${topic}\n\n以下是各成员的第一轮点子：\n${ideas.join('\n\n').slice(0, 8000)}\n\n请：1. 从【别人的点子】中挑 1-2 个最有潜力、最值得做的；2. 各用一句话说明：为什么值得做 + 怎么补全它；3. 也可以合并两个点子成一个更强的方案；4. 不要重复罗列自己的点子，不要客套。`);
        if (content) converged.push(`【${a.displayName}】\n${content}`);
      }));
      await this.invokeAgent(agents[0], chatId, triggerMsgId, topic,
        `【头脑风暴 - 第 3 阶段：汇总】\n\n议题：${topic}\n\n以下是各位成员的发散与收敛意见：\n${[...ideas, ...converged].join('\n\n').slice(0, 12000)}\n\n请作为主持人输出一份头脑风暴成果：1. 去重合并所有点子（明显重复的合并，保留表述更好的）；2. 按「可行性 × 创新性」挑出 Top 3；3. 每个入选点子给出一句落地建议（第一步做什么）；4. 最后输出「行动项」清单：编号 + 一句话。`);
    } else {
      // free：并行一轮
      await Promise.all(agents.map((a) => this.invokeAgent(a, chatId, triggerMsgId, topic)));
    }
  }

  /** 调用单个 Agent（本机直接跑，远程发 peer invoke），并把回复广播+同步给所有成员 */
  private async invokeAgent(entry: AgentRosterEntry, chatId: string, triggerMsgId: string, topic: string, customPrompt?: string): Promise<string> {
    if (entry.isLocal) {
      return this.runLocalAgent(entry, chatId, triggerMsgId, customPrompt);
    }
    // 远程：让对方引擎跑它自己的 Agent
    const peer = getLanPeer(entry.instanceId);
    if (!peer) {
      this.broadcast({ type: 'lan.agent.note', chatId, message: `${entry.displayName} 的引擎离线，跳过` });
      return '';
    }
    try {
      const resp = await sendToPeer(peer, '/api/lan/peer/agent-invoke', {
        chatId, agentId: entry.agentId, triggerMsgId, topic, customPrompt,
        groupId: chatId.replace(/^langroup-/, '').replace(/-agents$/, ''),
      }, { timeoutMs: 120000 });
      return resp?.content || '';
    } catch (e: any) {
      this.broadcast({ type: 'lan.agent.note', chatId, message: `${entry.displayName} 的引擎调用失败: ${e.message}` });
      return '';
    }
  }

  /** 本机 Agent 回复：流式广播 + 同步给其他成员。
   *  注意：router.generateReply 内部已把回复落库（id 形如 msg-xxx），此处不再重复 addMessage，
   *  而是回读刚落库的消息拿到权威 id，用它做最终广播与跨引擎同步，保证各成员引擎存的是同一个 msgId。 */
  private async runLocalAgent(entry: AgentRosterEntry, chatId: string, triggerMsgId: string, customPrompt?: string): Promise<string> {
    const agentId = entry.agentId!;
    const bubbleId = 'lmsg-agent-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const agentSenderId = `agent:${agentId}`;
    let full = '';
    this.broadcast({ type: 'agent.streaming.start', chatId, from: agentSenderId, senderId: agentSenderId, senderType: 'agent', msgId: bubbleId, replyTo: triggerMsgId, timestamp: Date.now() });
    try {
      const reply = await this.router.generateReply(
        chatId, agentId, triggerMsgId,
        (chunk: string) => { full += chunk; this.broadcast({ type: 'agent.streaming.chunk', chatId, from: agentSenderId, senderId: agentSenderId, msgId: bubbleId, chunk }); },
        (thinkChunk: string) => { this.broadcast({ type: 'agent.streaming.think', chatId, from: agentSenderId, senderId: agentSenderId, msgId: bubbleId, think: thinkChunk }); },
        undefined,
        undefined,
        customPrompt
      );
      if (reply && !full) full = reply;
      if (reply && full !== reply) full = reply;
    } catch (e: any) {
      this.broadcast({ type: 'agent.streaming.end', chatId, from: agentSenderId, msgId: bubbleId, error: e.message });
      this.broadcast({ type: 'lan.agent.note', chatId, message: `${entry.displayName} 的灵犀引擎报错: ${e.message}` });
      return '';
    }
    // 关闭打字气泡
    this.broadcast({ type: 'agent.streaming.end', chatId, from: agentSenderId, msgId: bubbleId });

    // 回读 generateReply 刚落库的消息，拿到权威 id（保证跨引擎一致）
    const persisted = this.latestAgentMessage(chatId, agentId);
    const msgId = persisted?.id || bubbleId;
    const content = persisted?.content || full;
    const ts = persisted?.timestamp || Date.now();
    const reasoning = persisted?.reasoning || '';

    // 最终完整消息广播（用权威 id）
    this.broadcast({ type: 'message.new', chatId, from: agentSenderId, senderId: agentSenderId, senderType: 'agent', senderName: entry.displayName, content, msgId, replyTo: triggerMsgId, timestamp: ts, reasoning });
    // 同步给其他成员引擎（同一 msgId，落库去重）
    const groupId = chatId.replace(/^langroup-/, '').replace(/-agents$/, '');
    const payload = { groupId, chatId, box: 'agents', msg: { id: msgId, senderType: 'agent', senderId: agentId, senderName: entry.displayName, content, ts, reasoning } };
    this.broadcastToGroup(groupId, '/api/lan/peer/group-message', payload);
    return content;
  }

  /** 取某聊天里某 Agent 最新一条已落库消息 */
  private latestAgentMessage(chatId: string, agentId: string): { id: string; content: string; timestamp: number; reasoning: string } | null {
    const msgs = listMessages(chatId, 20) as any[];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.sender_id === agentId && m.sender_type === 'agent') {
        let reasoning = '';
        try {
          const md = typeof m.metadata === 'string' ? JSON.parse(m.metadata || '{}') : (m.metadata || {});
          reasoning = md.reasoning || md.reasoning_content || '';
        } catch (e) {}
        return { id: m.id, content: m.content, timestamp: m.timestamp, reasoning };
      }
    }
    return null;
  }

  /** 收到远程引擎的 Agent 调用请求：跑本机指定 Agent，回复内容（并由 runLocalAgent 负责广播+同步） */
  async handleAgentInvoke(body: any): Promise<any> {
    const { chatId, agentId, triggerMsgId, customPrompt } = body || {};
    if (!chatId || !agentId) return { error: '缺少 chatId/agentId' };
    // 确认是本机 Agent
    const agents = this.manager.list();
    const agent = agents.find((a: any) => a.id === agentId);
    if (!agent) return { error: '该 Agent 不在本实例' };
    // 越权防护：校验该 Agent 确属此群成员，避免远程 peer 调用任意本机 Agent
    const invokeGroupId = chatId.replace(/^langroup-/, '').replace(/-agents$/, '');
    const invokeGroup = getLanGroup(invokeGroupId);
    if (!invokeGroup) return { error: '群组不存在' };
    const invokeMembers = getLanGroupMembers(invokeGroupId);
    if (!invokeMembers.some((m: any) => (m.agent_id || m.agentId) === agentId)) {
      return { error: '该 Agent 不在此群组中' };
    }
    // v5-P0-B 修复: 来源 IP 校验 fail-closed — 无来源 IP 或无法匹配群成员引擎 IP 时一律拒绝
    const reqIp = String((body as any)._requestIp || '').replace(/^::ffff:/, ''); // P0-1: from body
    if (!reqIp) {
      console.warn('[LAN][Security] Agent invoke rejected: 缺少来源IP');
      return { error: '请求来源缺失，拒绝执行' };
    }
    const memberIps = new Set<string>();
    for (const m of invokeMembers) {
      if (m.instanceId !== getLanInstanceId()) {
        const peer = getLanPeer(m.instanceId);
        if (peer?.lanIp) memberIps.add(String(peer.lanIp).replace(/^::ffff:/, ''));
      }
    }
    if (memberIps.size === 0 || !memberIps.has(reqIp)) {
      console.warn('[LAN][Security] Agent invoke rejected:', reqIp, 'expected:', [...memberIps]);
      return { error: '请求来源不在群组成员中' };
    }
    const entry: AgentRosterEntry = {
      userId: agent.userId || agent.user_id, displayName: agent.displayName || agent.display_name, agentId: agent.id,
      instanceId: getLanInstanceId(), isLocal: true,
    };
    const content = await this.runLocalAgent(entry, chatId, triggerMsgId || ('remote-' + Date.now()), customPrompt);
    return { ok: true, content };
  }

  // ════════════════════════════════════════════
  // 工具方法
  // ════════════════════════════════════════════

  /** 群成员对应的远程邻居实例（去重，排除自己） */
  private groupRemotePeers(groupId: string): LanPeer[] {
    const members = getLanGroupMembers(groupId);
    const peers: LanPeer[] = [];
    for (const m of members) {
      if (m.instanceId === getLanInstanceId()) continue;
      const p = getLanPeer(m.instanceId);
      if (p && !peers.some((x) => x.instanceId === p.instanceId)) peers.push(p);
    }
    return peers;
  }

  /** 群成员里所有远程实例 ID（含当前离线的，去重，排除自己）——用于离线补发 */
  private groupRemoteInstanceIds(groupId: string): string[] {
    const ids = new Set<string>();
    for (const m of getLanGroupMembers(groupId)) {
      if (m.instanceId && m.instanceId !== getLanInstanceId()) ids.add(m.instanceId);
    }
    return [...ids];
  }

  /**
   * 群消息广播同步：在线邻居立即直发，离线邻居入 outbox 待其上线后补发。
   * 替代原先只对在线 peer fire-and-forget 的同步，避免离线成员永久丢消息。
   */
  private broadcastToGroup(groupId: string, path: string, body: any): void {
    const online = this.groupRemotePeers(groupId);
    const onlineIds = new Set(online.map((p) => p.instanceId));
    for (const peer of online) {
      sendToPeer(peer, path, body).catch(() => {
        // 直发失败（可能刚掉线）→ 入队补发
        this.enqueueForPeer(peer.instanceId, path, body);
      });
    }
    for (const instanceId of this.groupRemoteInstanceIds(groupId)) {
      if (!onlineIds.has(instanceId)) this.enqueueForPeer(instanceId, path, body);
    }
  }

  /** 入离线补发队列（每个 peer 最多保留 200 条，且丢弃超过 1 小时的旧消息） */
  private enqueueForPeer(instanceId: string, path: string, body: any): void {
    const now = Date.now();
    let q = this.outbox.get(instanceId);
    if (!q) { q = []; this.outbox.set(instanceId, q); }
    q.push({ path, body, ts: now });
    // 去重：同一 msg.id 只留最新（避免重复补发同一条群消息）
    const seen = new Set<string>();
    const dedup: typeof q = [];
    for (let i = q.length - 1; i >= 0; i--) {
      const mid = q[i].body?.msg?.id;
      if (mid) { if (seen.has(mid)) continue; seen.add(mid); }
      dedup.unshift(q[i]);
    }
    //  pruning: 过期 + 限量
    const pruned = dedup.filter((it) => now - it.ts < 3600_000).slice(-200);
    this.outbox.set(instanceId, pruned);
    this.persistOutbox();
  }

  /** P1-6: 从数据库加载离线队列 */
  private loadOutboxFromDB(): void {
    try {
      const db = getDB();
      if (!db) return;
      // 确保表存在
      db.run(`CREATE TABLE IF NOT EXISTS lan_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        path TEXT NOT NULL,
        body TEXT NOT NULL,
        ts INTEGER NOT NULL
      )`);
      const stmt = db.prepare('SELECT instance_id, path, body, ts FROM lan_outbox ORDER BY ts ASC');
      stmt.bind();
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        let q = this.outbox.get(row.instance_id);
        if (!q) { q = []; this.outbox.set(row.instance_id, q); }
        try {
          q.push({ path: row.path, body: JSON.parse(row.body), ts: row.ts });
        } catch { /* 损坏的 JSON 跳过 */ }
      }
      stmt.free();
      const total = [...this.outbox.values()].reduce((s, q) => s + q.length, 0);
      if (total > 0) console.log(`[LAN] 离线队列已加载: ${this.outbox.size} 个邻居, ${total} 条待补发`);
    } catch (e: any) {
      console.warn('[LAN] 加载离线队列失败:', e.message);
    }
  }

  /** P1-6: 持久化离线队列到数据库 */
  private persistOutbox(): void {
    try {
      const db = getDB();
      if (!db) return;
      db.run('DELETE FROM lan_outbox');
      for (const [instanceId, queue] of this.outbox.entries()) {
        for (const item of queue) {
          db.run('INSERT INTO lan_outbox (instance_id, path, body, ts) VALUES (?, ?, ?, ?)',
            [instanceId, item.path, JSON.stringify(item.body), item.ts]);
        }
      }
    } catch (e: any) {
      console.warn('[LAN] 持久化离线队列失败:', e.message);
    }
  }

  /** 把离线队列补发给已上线的邻居；成功即移除，失败保留待下次。 */
  private async flushOutbox(): Promise<void> {
    if (this.outbox.size === 0) return;
    const now = Date.now();
    for (const [instanceId, queue] of [...this.outbox.entries()]) {
      if (!queue || queue.length === 0) { this.outbox.delete(instanceId); continue; }
      const peer = getLanPeer(instanceId);
      if (!peer) {
        // 仍离线：清掉过期项
        const fresh = queue.filter((it) => now - it.ts < 3600_000);
        if (fresh.length) this.outbox.set(instanceId, fresh); else this.outbox.delete(instanceId);
        continue;
      }
      const remaining: typeof queue = [];
      for (const item of queue) {
        if (now - item.ts >= 3600_000) continue; // 过期丢弃
        try {
          await sendToPeer(peer, item.path, item.body, { retries: 0 });
        } catch {
          remaining.push(item); // 失败保留，下轮再试
        }
      }
      if (remaining.length) this.outbox.set(instanceId, remaining); else this.outbox.delete(instanceId);
    }
    // P1-6d: 同步内存变化到数据库，防止进程重启后重复补发
    this.persistOutbox();
  }

  /** 群成员编排视图 */
  private buildRoster(groupId: string): AgentRosterEntry[] {
    return getLanGroupMembers(groupId).map((m) => ({
      userId: m.user_id, numericId: m.numeric_id, displayName: m.display_name, agentId: m.agent_id,
      instanceId: m.instance_id, isLocal: m.instance_id === getLanInstanceId(),
    }));
  }

  /** 建/取私聊（双方用户 + 双方 agent） */
  private ensurePrivateChat(userA: string, userB: string, remoteAgentId?: string, forcedChatId?: string): string {
    const chatId = forcedChatId || makePrivateChatId(userA, userB);
    if (!getChatById(chatId)) {
      createChat(chatId, 'private');
      this.safeAddParticipant(`p-${chatId}-1`, chatId, userA, undefined, 'member');
      this.safeAddParticipant(`p-${chatId}-2`, chatId, userB, undefined, 'member');
      const aAgent = getAgentByUserId(userA);
      if (aAgent) this.safeAddParticipant(`p-${chatId}-a1`, chatId, undefined, aAgent.id, 'agent');
      if (remoteAgentId) this.safeAddParticipant(`p-${chatId}-a2`, chatId, undefined, remoteAgentId, 'agent');
    }
    return chatId;
  }

  private findFriendshipById(id: string): any {
    return getFriendshipById(id);
  }

  private findFriendshipByPair(fromUserId: string, toUserId: string): any {
    return getFriendshipByPair(fromUserId, toUserId);
  }
}
