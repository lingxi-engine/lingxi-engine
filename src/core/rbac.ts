/**
 * RBAC 权限检查工具
 * 用于好友/群聊的动作级权限控制
 *
 * 2026-11-14 B2 修复：getUserChatRole/getUserFriendshipRole 原为 async（返回 Promise），
 * 但同步的 checkChatPermission/checkFriendshipPermission 未 await，导致 role 恒为 Promise
 * 对象 → actionPerms[Promise] 恒 undefined → 任何角色任何动作都被拒绝（连 owner 也不例外）。
 * 两个 getter 内部本就是同步 DB 调用，去掉 async 即可；接线前必须补测试（见 tests/rbac.test.ts）。
 */

import type { DB } from '../storage/db.js';
import { InboxManager, addAuditLog } from './inbox.js';

export type ChatRole = 'owner' | 'admin' | 'member' | 'viewer';
export type FriendshipRole = 'owner' | 'admin' | 'member';

export const CHAT_ROLE_HIERARCHY: Record<ChatRole, number> = {
  owner: 100,
  admin: 80,
  member: 50,
  viewer: 10,
};

export const FRIENDSHIP_ROLE_HIERARCHY: Record<FriendshipRole, number> = {
  owner: 100,
  admin: 80,
  member: 50,
};

/** 检查角色是否有足够权限 */
export function hasRoleLevel(currentRole: string, requiredRole: string, hierarchy: Record<string, number>): boolean {
  const currentLevel = hierarchy[currentRole] ?? 0;
  const requiredLevel = hierarchy[requiredRole] ?? 0;
  return currentLevel >= requiredLevel;
}

/** 群聊动作权限定义 */
export const CHAT_ACTIONS = {
  // 基础动作
  'chat.send': { member: true, viewer: false },
  'chat.read': { member: true, viewer: true },
  'chat.leave': { member: true, viewer: true },
  
  // 管理动作（需 admin/owner）
  'chat.invite': { admin: true, member: false },
  'chat.kick': { admin: true, member: false },
  'chat.promote': { owner: true, admin: false },
  'chat.demote': { owner: true, admin: false },
  'chat.change_mode': { admin: true, member: false },
  'chat.change_settings': { admin: true, member: false },
  'chat.delete': { owner: true, admin: false },
  'chat.transfer_ownership': { owner: true, admin: false },
  
  // AI Agent 动作
  'chat.add_agent': { admin: true, member: false },
  'chat.remove_agent': { admin: true, member: false },
} as const;

export type ChatAction = keyof typeof CHAT_ACTIONS;

/** 好友动作权限定义 */
export const FRIENDSHIP_ACTIONS = {
  'friend.chat': { member: true },
  'friend.remove': { member: true, admin: true, owner: true },
  'friend.block': { owner: true, admin: true },
} as const;

export type FriendshipAction = keyof typeof FRIENDSHIP_ACTIONS;

/** 获取用户在群聊中的角色（B2 修复：同步函数，内部为同步 DB 调用，不得加 async） */
export function getUserChatRole(db: any, chatId: string, userId: string): ChatRole | null {
  const participant = db.prepare(`SELECT role FROM participants WHERE chat_id = ? AND user_id = ?`).get(chatId, userId) as { role: string } | undefined;
  if (participant) return participant.role as ChatRole;
  
  // 检查是否为群主
  const chat = db.prepare(`SELECT owner_id FROM chats WHERE id = ?`).get(chatId) as { owner_id: string } | undefined;
  if (chat && chat.owner_id === userId) return 'owner';
  
  return null;
}

/** 获取用户在好友关系中的角色（B2 修复：同步函数，内部为同步 DB 调用，不得加 async） */
export function getUserFriendshipRole(db: any, userId1: string, userId2: string): FriendshipRole | null {
  const row = db.prepare(
    `SELECT role, status, from_user_id FROM friendships WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`
  ).get(userId1, userId2, userId2, userId1) as { role: string; status: string; from_user_id: string } | undefined;
  
  if (!row || row.status !== 'accepted') return null;
  return row.role as FriendshipRole;
}

/** 检查群聊权限 */
export function checkChatPermission(db: DB, chatId: string, userId: string, action: ChatAction, inbox?: InboxManager): { allowed: boolean; reason?: string } {
  const role = getUserChatRole(db, chatId, userId);
  if (!role) return { allowed: false, reason: '不是群聊成员' };
  
  const actionPerms = CHAT_ACTIONS[action];
  if (!actionPerms) return { allowed: false, reason: '未知动作' };
  
  const hasPerm = actionPerms[role as keyof typeof actionPerms] ?? false;
  if (!hasPerm) {
    // 记录审计日志：权限拒绝
    if (inbox) addAuditLog(inbox, 'chat_permission_denied', { chatId, userId, action, role }, undefined);
    return { allowed: false, reason: `角色 ${role} 无权执行 ${action}` };
  }
  
  // 记录审计日志：权限通过
  if (inbox) addAuditLog(inbox, 'chat_permission_granted', { chatId, userId, action, role }, undefined);
  
  return { allowed: true };
}

/** 检查好友权限 */
export function checkFriendshipPermission(db: DB, userId: string, friendId: string, action: FriendshipAction, inbox?: InboxManager): { allowed: boolean; reason?: string } {
  const role = getUserFriendshipRole(db, userId, friendId);
  if (!role) return { allowed: false, reason: '不是好友' };
  
  const actionPerms = FRIENDSHIP_ACTIONS[action];
  if (!actionPerms) return { allowed: false, reason: '未知动作' };
  
  const hasPerm = actionPerms[role as keyof typeof actionPerms] ?? false;
  if (!hasPerm) {
    // 记录审计日志：权限拒绝
    if (inbox) addAuditLog(inbox, 'friendship_permission_denied', { userId, friendId, action, role }, undefined);
    return { allowed: false, reason: `角色 ${role} 无权执行 ${action}` };
  }
  
  // 记录审计日志：权限通过
  if (inbox) addAuditLog(inbox, 'friendship_permission_granted', { userId, friendId, action, role }, undefined);
  
  return { allowed: true };
}

/** Express 中间件：群聊权限检查 */
export function requireChatPermission(action: ChatAction, getUserId: (req: any) => string, getChatId: (req: any) => string, inbox?: InboxManager) {
  return (req: any, res: any, next: any) => {
    const db = req.app?.locals?.db || req.db;
    if (!db) return res.status(500).json({ error: 'DB 未初始化' });
    
    const userId = getUserId(req);
    const chatId = getChatId(req);
    
    if (!userId || !chatId) return res.status(400).json({ error: '缺少 userId 或 chatId' });
    
    const { allowed, reason } = checkChatPermission(db, chatId, userId, action, inbox);
    if (!allowed) return res.status(403).json({ error: reason || '权限不足' });
    
    next();
  };
}

/** Express 中间件：好友权限检查 */
export function requireFriendshipPermission(action: FriendshipAction, getUserId: (req: any) => string, getFriendId: (req: any) => string, inbox?: InboxManager) {
  return (req: any, res: any, next: any) => {
    const db = req.app?.locals?.db || req.db;
    if (!db) return res.status(500).json({ error: 'DB 未初始化' });
    
    const userId = getUserId(req);
    const friendId = getFriendId(req);
    
    if (!userId || !friendId) return res.status(400).json({ error: '缺少 userId 或 friendId' });
    
    const { allowed, reason } = checkFriendshipPermission(db, userId, friendId, action, inbox);
    if (!allowed) return res.status(403).json({ error: reason || '权限不足' });
    
    next();
  };
}
