# 社交模块 Bug 修复报告 (v2.0)

## 修复日期: 2026-07-28
## 修复者: AI助手 (运行在灵犀引擎上)

---

## 已修复的 Bug 清单

### 🔴 P0 — 严重 (已修复 4 个)

| # | Bug | 文件 | 描述 |
|---|-----|------|------|
| 1 | `getParticipantRole` 调用不存在的方法 `d.listParticipants` | `index.ts:104` | 改为 `getChatParticipants(chatId)`，该函数未导入则补导入 |
| 2 | `rbac()` 中间件用 `req.user?.id` 但 JWT payload 实际存 `sub` | `index.ts:113` | 改为 `req.user?.sub \|\| req.user?.id` |
| 3 | Push 推送未接线，新消息不推送给用户 | `index.ts` | 在 `broadcast()` 函数中劫持 `message.new` 事件，自动调用 `pushManager.sendToUser()` 通知聊天中的其他参与者 |
| 4 | 好友系统没有删除好友接口 | `index.ts:905`, `routes/friends.ts` | 添加 `DELETE /api/friends/:id` 端点，删除双向好友关系+私聊参与者 |

### 🟠 P1 — 高 (已修复 3 个)

| # | Bug | 文件 | 描述 |
|---|-----|------|------|
| 5 | 没有消息未读计数 | `index.ts:925`, `storage/db.ts` | 新增 `chat_read_state` 表追踪已读位置；新增 `GET /api/unread-count` 和 `POST /api/chats/:id/read` API |
| 6 | 双向好友申请可致重复记录 | `storage/db.ts:684` | `sendFriendRequest` 增加反向检查：先查 A→B，若不存在再查 B→A |
| 7 | 聊天列表按用户过滤是 O(n) 全表扫描 | `routes/chat.ts:33` | 改为 `SELECT DISTINCT c.* FROM chats c INNER JOIN participants p ... WHERE p.user_id=?` SQL JOIN 查询 |

### 🟡 P2 — 中等 (已修复 2 个)

| # | Bug | 文件 | 描述 |
|---|-----|------|------|
| 8 | `DB` 类缺少 `listParticipants` 方法 | `storage/db.ts:940` | 添加 `listParticipants` 别名指向 `getChatParticipants`，兼容旧代码 |
| 9 | `/api/users` 不返回在线状态和 numeric_id | `index.ts` | 响应中增加 `status` 和 `numericId` 字段 |

### 🟢 P3 — 官网更新

| # | 更新 | 文件 | 描述 |
|---|------|------|------|
| 10 | 官网显示修复通知横幅 | `web/index.html` | 连接后自动弹出「社交模块已修复」提示，8秒后自动消失 |

---

## 修复统计

| 级别 | 总数 |
|------|------|
| P0 严重 | 4 |
| P1 高 | 3 |
| P2 中等 | 2 |
| P3 官网 | 1 |
| **合计** | **10** |

---

## 后续建议

1. **WebSocket ACK 机制**：当前 `ws.send()` 是 fire-and-forget，建议加消息队列和 ACK 重试
2. **好友搜索 SQL 注入修复**：`/api/users` 的 filter 是全内存过滤，但安全依赖上层，建议加参数化查询
3. **LAN 社交群邀请**：当前是自动接受模式，建议改为用户手动确认
4. **联邦消息权限校验**：`/api/federation/message` 不检查发送者是否是该聊天的参与者
