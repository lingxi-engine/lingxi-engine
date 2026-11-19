/**
 * S7: 跨引擎身份命名空间（LAN Identity Namespace）
 *
 * 各引擎的 numeric_id / userId 独立分配（两台引擎的首个用户 ID 相同是常态），
 * 远端用户落到本机库时必须带实例命名空间，否则：
 *   - 收好友申请撞本机同号用户 → 「不能添加自己为好友」
 *   - lan_remote_identities 主键 user_id 跨引擎互相覆盖
 *   - 私聊会话 ID 两侧不对称 → 消息无法路由
 *
 * 别名格式：xlan:<instanceId>:<rawUserId>
 * （instanceId 形如 lingxi-lan-<12hex>，不含冒号，可安全解析）
 */

export const XLAN_PREFIX = 'xlan:';

/** 远端用户在本机的命名空间别名 */
export function xlanAlias(instanceId: string, rawUserId: string): string {
  return XLAN_PREFIX + instanceId + ':' + rawUserId;
}

/** 解析别名；非别名返回 null */
export function parseXlanAlias(id: string): { instanceId: string; rawUserId: string } | null {
  const m = /^xlan:([^:]+):(.+)$/.exec(String(id || ''));
  return m ? { instanceId: m[1], rawUserId: m[2] } : null;
}

export function isXlanAlias(id: string): boolean {
  return String(id || '').startsWith(XLAN_PREFIX);
}

/**
 * 跨引擎私聊规范会话 ID：双方用同一四元组（各自实例+用户 / 对方实例+用户）计算，
 * 排序后拼接 → 两侧必然相同。与本机-本机私聊的 makePrivateChatId 互不冲突。
 */
export function makeCrossEnginePrivateChatId(instA: string, userA: string, instB: string, userB: string): string {
  const pair = [instA + ':' + userA, instB + ':' + userB].sort();
  return 'chat-xlan-' + pair[0] + '-' + pair[1];
}
