# 灵犀引擎重构报告

## 重构概要

将 115KB 的 God File `index.ts` 拆分为模块化的路由系统，同时修复了之前发现的 Bug。

## 新文件结构

```
src/
├── server/
│   ├── context.ts    — ServerContext 接口（共享服务上下文）
│   └── rbac.ts       — RBAC 中间件（修复 Bug #4, #5）
├── routes/
│   ├── auth.ts       — 认证路由（修复 Bug #1）
│   ├── agent.ts      — Agent CRUD 路由
│   ├── chat.ts       — 聊天/参与者/消息路由
│   ├── system.ts     — 系统/健康检查/版本/用量路由
│   ├── provider.ts   — Provider 管理路由
│   ├── market.ts     — AI 员工市场路由
│   ├── rag.ts        — RAG 知识库路由
│   ├── workflow.ts   — 工作流编排路由
│   ├── upload.ts     — 文件上传路由
│   ├── friends.ts    — 好友系统路由
│   ├── admin.ts      — 管理路由（Cron/会话/子代理/收件箱/审批/Hook/技能/MCP/插件/语音/视觉/推送/积分/评价）
│   ├── channel.ts    — 渠道管理路由 + Webhook + 适配器启动
│   └── misc.ts       — 联邦通信/Mesh/标签/时间/工作区模式/群聊模式
```

## 重构成果

| 指标 | 重构前 | 重构后 |
|------|--------|--------|
| index.ts 大小 | 115KB (2538行) | 22KB (~400行) |
| src/core/index.ts | 102KB (重复) | 已删除 |
| src/core/builtin.ts | 55KB (重复) | 待删除 |
| 路由模块数 | 0 (全在一个文件) | 13 个独立模块 |
| 全局变量 | globalThis.__xxx 满天飞 | ServerContext 统一传递 |

## Bug 修复

在重构过程中同时修复了以下 Bug：

1. **Bug #1** (P0): `loginWithEmail` 路由缺 `await` → 已在 `routes/auth.ts` 中加 `async/await`
2. **Bug #3**: `startAutoSave(5000)` → 改为 `startAutoSave(30000)`
3. **Bug #4** (P1): RBAC 用 `req.user?.id` → 改为 `req.user?.sub`（JWT payload 字段）
4. **Bug #5** (P1): `d.listParticipants()` → 改为 `getChatParticipants()`（正确的 DB 函数）
5. **Bug #17**: `verificationCodes` Map 移到 `routes/auth.ts` 内部（不再全局）

## 架构改进

### 1. ServerContext 模式
所有管理器实例通过 `ServerContext` 传递，不再使用 `globalThis.__xxx`。

### 2. 路由模块化
每个路由模块导出一个 `createXxxRoutes(ctx: ServerContext): Router` 函数，
入口文件只需 `app.use('/api/xxx', createXxxRoutes(ctx))` 注册。

### 3. 删除重复文件
- `src/core/index.ts` (102KB) — 与 `index.ts` 几乎完全重复，已不再需要
- `src/core/builtin.ts` (55KB) — 与 `src/tools/builtin.ts` 重复，待删除

## 注意事项

1. `src/core/index.ts` 应该删除或重定向到新的 `index.ts`
2. `src/core/builtin.ts` 应该删除，所有引用改为 `src/tools/builtin.ts`
3. 需要检查是否有其他文件 import 了 `src/core/index.ts` 或 `src/core/builtin.ts`
4. `routes-v1.7.ts` 保持不变，仍然通过 `registerV17Routes(app, { aiHub })` 注册