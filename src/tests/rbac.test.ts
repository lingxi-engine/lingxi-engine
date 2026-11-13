/**
 * B2 回归测试：RBAC 权限检查 async/await 错配修复
 *
 * 锁死不变式：
 *   1. getUserChatRole/getUserFriendshipRole 必须是同步函数（返回值不是 Promise）
 *   2. owner/admin/member/viewer 按 CHAT_ACTIONS 显式映射正确放行/拒绝
 *   3. 非成员/非好友/未知动作一律拒绝（fail-closed）
 *   4. 未 accepted 的好友关系视为无角色
 *
 * 注：CHAT_ACTIONS 为显式角色映射（如 chat.send 只列 member/viewer），
 * 本测试锁定该映射语义；层级展开（hasRoleLevel）属接线前的设计决策，不在 B2 范围。
 */
import { describe, it, expect } from 'vitest';
import {
  getUserChatRole,
  getUserFriendshipRole,
  checkChatPermission,
  checkFriendshipPermission,
  hasRoleLevel,
  CHAT_ROLE_HIERARCHY,
} from '../core/rbac.js';

/** 内存 mock DB：模拟 better-sqlite3 的 prepare().get() 同步接口 */
function mockDb(tables: { participants?: any[]; chats?: any[]; friendships?: any[] }) {
  return {
    prepare(sql: string) {
      return {
        get(...args: any[]) {
          if (sql.includes('FROM participants')) {
            return tables.participants?.find((p) => p.chat_id === args[0] && p.user_id === args[1]);
          }
          if (sql.includes('FROM chats')) {
            return tables.chats?.find((c) => c.id === args[0]);
          }
          if (sql.includes('FROM friendships')) {
            const [a, b] = args;
            return tables.friendships?.find(
              (f) => (f.from_user_id === a && f.to_user_id === b) || (f.from_user_id === b && f.to_user_id === a),
            );
          }
          return undefined;
        },
      };
    },
  };
}

const chatDb = mockDb({
  participants: [
    { chat_id: 'c1', user_id: 'u-member', role: 'member' },
    { chat_id: 'c1', user_id: 'u-admin', role: 'admin' },
    { chat_id: 'c1', user_id: 'u-viewer', role: 'viewer' },
  ],
  chats: [{ id: 'c1', owner_id: 'u-owner' }],
});

const friendDb = mockDb({
  friendships: [
    { from_user_id: 'a', to_user_id: 'b', role: 'member', status: 'accepted' },
    { from_user_id: 'a', to_user_id: 'c', role: 'admin', status: 'accepted' },
    { from_user_id: 'a', to_user_id: 'd', role: 'member', status: 'pending' },
  ],
});

describe('B2: 角色解析必须是同步的（回归锁）', () => {
  it('getUserChatRole 返回字符串而非 Promise', () => {
    const role = getUserChatRole(chatDb, 'c1', 'u-member');
    expect(role).not.toBeInstanceOf(Promise);
    expect(role).toBe('member');
  });

  it('getUserFriendshipRole 返回字符串而非 Promise', () => {
    const role = getUserFriendshipRole(friendDb, 'a', 'b');
    expect(role).not.toBeInstanceOf(Promise);
    expect(role).toBe('member');
  });

  it('无参与者记录时按 chats.owner_id 回退为 owner', () => {
    expect(getUserChatRole(chatDb, 'c1', 'u-owner')).toBe('owner');
  });

  it('非成员返回 null', () => {
    expect(getUserChatRole(chatDb, 'c1', 'u-stranger')).toBeNull();
  });

  it('pending 好友关系返回 null', () => {
    expect(getUserFriendshipRole(friendDb, 'a', 'd')).toBeNull();
  });

  it('好友查询双向对称', () => {
    expect(getUserFriendshipRole(friendDb, 'b', 'a')).toBe('member');
  });
});

describe('B2: checkChatPermission 按角色正确放行/拒绝', () => {
  it('member 可以 chat.send（修复前恒 false）', () => {
    expect(checkChatPermission(chatDb as any, 'c1', 'u-member', 'chat.send').allowed).toBe(true);
  });

  it('viewer 不能 chat.send 但可以 chat.read', () => {
    const send = checkChatPermission(chatDb as any, 'c1', 'u-viewer', 'chat.send');
    expect(send.allowed).toBe(false);
    expect(send.reason).toContain('viewer');
    expect(checkChatPermission(chatDb as any, 'c1', 'u-viewer', 'chat.read').allowed).toBe(true);
  });

  it('member 不能 chat.invite，admin 可以', () => {
    expect(checkChatPermission(chatDb as any, 'c1', 'u-member', 'chat.invite').allowed).toBe(false);
    expect(checkChatPermission(chatDb as any, 'c1', 'u-admin', 'chat.invite').allowed).toBe(true);
  });

  it('owner 可以 chat.delete，admin 不行', () => {
    expect(checkChatPermission(chatDb as any, 'c1', 'u-owner', 'chat.delete').allowed).toBe(true);
    expect(checkChatPermission(chatDb as any, 'c1', 'u-admin', 'chat.delete').allowed).toBe(false);
  });

  it('非成员拒绝且原因为「不是群聊成员」', () => {
    const r = checkChatPermission(chatDb as any, 'c1', 'u-stranger', 'chat.read');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('不是群聊成员');
  });

  it('未知动作拒绝（fail-closed）', () => {
    const r = checkChatPermission(chatDb as any, 'c1', 'u-owner', 'chat.nuke' as any);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('未知动作');
  });
});

describe('B2: checkFriendshipPermission 按角色正确放行/拒绝', () => {
  it('accepted 好友 member 可以 friend.chat（修复前恒 false）', () => {
    expect(checkFriendshipPermission(friendDb as any, 'a', 'b', 'friend.chat').allowed).toBe(true);
  });

  it('member 不能 friend.block，admin 可以', () => {
    expect(checkFriendshipPermission(friendDb as any, 'a', 'b', 'friend.block').allowed).toBe(false);
    expect(checkFriendshipPermission(friendDb as any, 'a', 'c', 'friend.block').allowed).toBe(true);
  });

  it('pending 关系拒绝且原因为「不是好友」', () => {
    const r = checkFriendshipPermission(friendDb as any, 'a', 'd', 'friend.chat');
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('不是好友');
  });

  it('无关系拒绝', () => {
    expect(checkFriendshipPermission(friendDb as any, 'a', 'z', 'friend.chat').allowed).toBe(false);
  });
});

describe('角色层级工具（既有功能不回归）', () => {
  it('hasRoleLevel 按层级比较', () => {
    expect(hasRoleLevel('owner', 'admin', CHAT_ROLE_HIERARCHY)).toBe(true);
    expect(hasRoleLevel('member', 'admin', CHAT_ROLE_HIERARCHY)).toBe(false);
    expect(hasRoleLevel('unknown', 'member', CHAT_ROLE_HIERARCHY)).toBe(false);
  });
});
