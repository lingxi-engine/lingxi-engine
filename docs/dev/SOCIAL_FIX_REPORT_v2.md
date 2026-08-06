# 社交系统第二轮修复报告

## 修复日期：2026-07-29

---

## 修复清单

### 🔴 P0 — 致命Bug（2个）

| # | 问题 | 文件 | 修复内容 |
|---|------|------|---------|
| **1** | `createHire()` 参数不匹配 | `index.ts:1272` | 调用传7个单独参数 → 改为传对象 `{id, listingId, buyerId, sellerId, agentId, title, price, chatId}` |
| **2** | 重复市场路由（安全漏洞） | `index.ts:1635-1786` | 删除无 `requireAuth` 的第二套市场路由，移除安全风险 |

### 🟠 P1 — 高优先级（2个）- 已由第一轮修复

| # | 问题 | 文件 | 状态 |
|---|------|------|------|
| **3** | `sendFriendRequest` 数组下标越界 | `src/storage/db.ts:713` | ✅ 上一轮已修 `existingRow[3]` → `existingRow[1]` |
| **4** | `getChatMode` 数组访问 | `src/storage/db.ts` | ✅ 上一轮已修 `row?.chat_mode` → `row?.[0]` |

---

## Bug 1 详解：`createHire()` 参数不匹配

**问题代码：**
```typescript
// 传了7个独立参数
createHire(listingId, buyerId, listing.publisher_id, listing.agent_id, listing.title, price, chatId);
```

**函数签名（期望对象）：**
```typescript
createHire(params: { id, listingId, buyerId, sellerId, agentId, title, price, chatId }): void
```

**结果：** `params` 被赋值为字符串 `listingId`，后续 `params.id` / `params.listingId` 全是 `undefined`，雇佣记录写入时所有字段为空。

**修复：**
```typescript
createHire({
  id: 'hire-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  listingId, buyerId,
  sellerId: listing.publisher_id,
  agentId: listing.agent_id,
  title: listing.title, price, chatId
});
```

## Bug 2 详解：重复市场路由（安全漏洞）

**问题：** `index.ts` 中有两套 `/api/market/*` 路由：
- 第一套（1222行起）：**有 `requireAuth`** ✅
- 第二套（1635行起）：**无 `requireAuth`** ❌ — 任何人都可访问市场API

**修复：** 删除第二套完整路由块（含市场/积分/员工/雇佣操作），所有功能已由第一套覆盖或将在后续统一管理。

---

## 现存未修复问题（非阻塞）

| 问题 | 说明 |
|------|------|
| `src/routes/` 死代码 | `friends.ts`/`chat.ts`/`profile.ts`/`market.ts` 定义了但从未导入 |
| `rbac()` `d` 变量未使用 | `const d = getDB();` 声明了但未使用 |
| 增强功能缺失 | 图片消息/@提醒/消息撤回/已读回执/群管理 — 规划中 |
