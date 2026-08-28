# 灵犀引擎 · 架构总览（ARCHITECTURE）

> 版本：2.0.13 ｜ 更新：2026-08-29 ｜ 维护规则：改架构必须同步改本文档
> 读者：所有改代码的人。**动手前先读完这份，再读对应模块文档。**

---

## 1. 一句话定位

AI-native IM 平台：每个用户自带一个 AI Agent，支持多模型协作、AI 员工市场（积分结算）、工作流、多渠道接入（Telegram/微信/Discord 等 10 个）。

## 2. 技术栈（改版本必须更新此表）

| 组件 | 版本 | 说明 |
|------|------|------|
| Node + tsx | tsx ^4.19 | **无编译直接跑 TS**，`npm start` = `tsx index.ts` |
| TypeScript | ^5.6 | `npm run typecheck` 全量检查 |
| Express | ^4.21 | HTTP 服务 |
| ws | ^8.18 | WebSocket（聊天主通道） |
| sql.js | ^1.11 | **SQLite 的 WASM 版，内存库 + 定期落盘**（见 §4 重要约束） |
| openai SDK | ^4.72 | 所有模型调用的统一客户端 |
| Electron | 33.x | 桌面壳（独立仓库 lingxi-desktop） |
| Capacitor | — | Android/iOS 壳（src/app/） |

## 3. 入口与目录职责（单一事实源问题 ⚠️）

**当前真实入口是根目录 `index.ts`（约 5000 行巨石文件）**，`package.json` 的
`start/dev` 都指向它。`src/index.ts`（55KB "Project Hub"）是旧入口/备用入口，
两者并存是历史包袱，**修改路由前必须确认改的是哪一份**。

| 目录 | 职责 | 规模 |
|------|------|------|
| `index.ts`（根） | **主入口**：Express 装配 + 232 条内联路由 + 挂载 7 个路由工厂 | ~5000 行 |
| `src/index.ts` | 旧入口（Project Hub），与根入口并存 ⚠️ 待合并 | 55KB |
| `src/routes/` | 路由工厂（`createXxxRoutes(ctx)` 模式），18 个文件 | ~215 条路由 |
| `src/core/` | AI 核心：路由器/多AI模式/记忆/RAG/子代理/沙箱 | 44 个文件 |
| `src/tools/` | 工具系统：builtin.ts(95KB) 注册所有内置工具 | 9 个文件 |
| `src/ai/` | 模型接入：hub.ts 统一调度，provider-registry 多供应商 | 4 个文件 |
| `src/storage/db.ts` | **全部数据层**：sql.js 内存库 + 落盘，79KB 单文件 | 1 个文件 |
| `src/auth/` | V7 持久身份：注册/登录/JWT | 2 个文件 |
| `src/channels/` | 10 个 IM 渠道接入（tg/wx/discord/slack/飞书…） | 10 个文件 |
| `src/net/` | LAN 发现/传输/局域社交 | 3 个文件 |
| `src/middleware/` | jwt-auth / admin-auth / rate-limit | 3 个文件 |
| `web/` | 官方 Web UI（index.html 87KB + app.js 261KB + i18n.js 179KB） | — |
| `src/app/` | Capacitor 移动壳（Android Java / iOS Swift） | — |
| `workspace/site_inner/` | **部署副本（构建产物，禁止手改）** | ~11K 行 |
| `docs/` | 本文档体系 | — |

### 三副本问题（最高优先级技术债）

同一份服务端代码存在三处：
1. `src/` —— 唯一应手改的源码
2. `workspace/site_inner/src/` —— 部署用手工副本（~11K 行）
3. 根目录 `index.ts` 内联的 232 条路由 —— 与 src/routes/ 职责重叠

**规则**：修 bug 只改 `src/`；`site_inner` 用 `scripts/sync-site-inner.ps1` 同步；
根目录 index.ts 的内联路由逐步迁移进 src/routes/（迁移一条删一条）。

## 4. 关键架构约束（改代码前必读）

1. **dotenv 必须最先加载**：ESM 的 import 会被提升，`import 'dotenv/config'`
   必须放在 index.ts 第一行，否则 hub.ts 等模块读到的 env 全是空。
2. **db.ts 必须先于其他模块加载**（v2.0.6 修复）：ESM 加载顺序问题会导致
   db 导出被截断。新增顶层 import 时注意顺序。
3. **sql.js 是内存库**：数据靠 `saveToDisk()` 定期落盘 + 退出时保存。
   ⚠️ 意味着：崩溃可能丢最近一段写入；大事务要考虑落盘时机。
4. **路由工厂模式**：`src/routes/*.ts` 每个文件导出 `createXxxRoutes(ctx: ServerContext)`，
   在主入口 `app.use('/api/xxx', createXxxRoutes(ctx))` 挂载。新路由一律走这个模式，
   **禁止再往根 index.ts 里加内联路由**。
5. **版本号三处对齐**：`package.json` / `version.txt` / 引擎内常量，发版必须同步。

## 5. 模块关系图

```
客户端（Web / Electron / Capacitor / 移动H5）
        │ HTTP + WebSocket
        ▼
根 index.ts（Express 主入口）
  ├─ middleware: jwt-auth → admin-auth → rate-limit
  ├─ src/routes/*（215 条模块化路由，逐步迁移中）
  ├─ 内联路由 232 条（待迁移 ⚠️）
  ├─ core/ws-handler（WS 消息 → processUserMessage）
  │     └─ core/router（MessageRouter，65KB，模型路由/多AI编排）
  │           ├─ ai/hub（模型调用统一出口）
  │           ├─ core/chat-modes（自由/路由/辩论/链式）
  │           ├─ tools/registry + tools/builtin（工具调用，沙箱内）
  │           └─ core/subagent-manager（子代理）
  ├─ channels/*（10 个 IM 渠道 → 统一消息入口）
  ├─ core/instance-mesh + net/lan-*（多实例/局域网）
  └─ storage/db.ts（sql.js 内存库 → 落盘）
```

## 6. 文档索引

| 文档 | 覆盖 | 对应代码量 |
|------|------|-----------|
| doc-auth.md | 认证/用户/JWT | ~2,000 行 |
| doc-chat.md | 会话/多AI/WS | ~3,500 行 |
| doc-wallet-market.md | 钱包/积分/市场/雇佣 | ~2,500 行 |
| doc-admin.md | 管理后台 | routes/admin.ts 72 条路由 |
| doc-webui.md | Web 前端 | ~4,000 行 |
| doc-deploy.md | 部署/发版 | 脚本 + 三平台 |
| doc-core.md | core/ 44 个 AI 模块 | ~11,000 行 |
| doc-tools-channels.md | 工具系统 + 渠道 | ~6,000 行 |

## 7. 改动纪律（违反 = 回滚）

- [ ] 新路由必须放 `src/routes/`，走工厂模式
- [ ] 改完跑 `npm run typecheck`，绿了才算完
- [ ] 修 bug 必须在对应模块文档追加"坑位记录"
- [ ] 改核心模块必须跑该文档末尾的回归清单
- [ ] 禁止手工同步 site_inner（用脚本）
- [ ] 单文件超 800 行必须拆（当前违规名单：根 index.ts、db.ts、router.ts、
      ws-handler.ts、builtin.ts、app.js、i18n.js——按此优先级逐步偿还）