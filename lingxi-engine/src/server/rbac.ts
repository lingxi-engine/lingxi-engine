/**
 * RBAC — 基于角色的访问控制中间件
 * 
 * 修复 Bug #4: 使用 JWT payload 的 `sub` 字段而非不存在的 `id` 字段
 * 修复 Bug #5: 使用 db.getChatParticipants 而非不存在的 d.listParticipants
 */
import { getDB, getChatParticipants } from '../storage/db.js';

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

const ROLE_HIERARCHY: Record<Role, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

/**
 * 获取用户在指定群聊中的角色
 */
export function getParticipantRole(chatId: string, userId: string): Role | null {
  try {
    const participants = getChatParticipants(chatId);
    const p = participants.find(
      (x: any) => x.user_id === userId || x.agent_id === userId
    );
    return (p?.role as Role) || null;
  } catch {
    return null;
  }
}

/**
 * RBAC 中间件工厂：要求指定角色才能访问
 * 
 * 修复: 使用 req.user.sub (JWT payload) 而非 req.user.id
 */
export function rbac(requiredRole: Role) {
  return (req: any, res: any, next: any) => {
    const chatId = req.params.id || req.params.chatId || req.body?.chatId;
    // Bug #4 修复: JWT payload 用 sub 字段，不是 id
    const userId = (req.user?.sub || req.user?.id || '') as string;
    if (!chatId || !userId) {
      return res.status(403).json({ error: '缺少 chatId/userId' });
    }
    const role = getParticipantRole(chatId, userId);
    if (!role) {
      return res.status(403).json({ error: '不在群聊中' });
    }
    if (ROLE_HIERARCHY[role] < ROLE_HIERARCHY[requiredRole]) {
      return res
        .status(403)
        .json({ error: `需要 ${requiredRole} 权限，当前角色: ${role}` });
    }
    next();
  };
}