# 模块文档：管理后台（doc-admin）

> 覆盖：`src/routes/admin.ts`（72 条路由）、`src/server/context.ts`、`src/server/rbac.ts`、
> `web/admin.html` ｜ 更新：2026-08-29

---

## 1. 模块职责

引擎管理面：Cron 定时任务、Standing Orders、会话、子代理、收件箱、审批、
Hook、技能、开发面板、日志、语音（TTS/STT）、视觉、推送、自定义模型供应商、
渠道管理、工具注册表、MCP、插件、浏览器管理。

## 2. ServerContext —— 管理后台的中枢 ⚠️

`src/server/context.ts` 定义的 `ServerContext` 是全引擎的依赖注入容器。
`createAdminRoutes(ctx)` 一次性解构 **19 个管理器**：

```
cronScheduler, sessionManager, subAgentManager, approvalManager,
hookManager, inboxManager, skillManager, debugPanel, ttsManager,
sttManager, visionManager, pushManager, customProviderManager,
telegramAdapter, toolRegistry, mcpManager, pluginManager, browserManager
(+ sessionManager 等)
```

**改 ServerContext 结构是全局大动作**：所有 createXxxRoutes 都从它取依赖，
加字段要向后兼容，删字段先全局 grep。

## 3. 路由域分布（72 条）

| 域 | 代表端点 | 管理器 |
|----|---------|--------|
| Cron | GET/POST /cron、DELETE /cron/:id、POST /cron/:id/run、PATCH /cron/:id | cronScheduler |
| Standing Orders | POST /standing-orders（name+cron+prompt+chatId+timezone） | cronScheduler |
| 会话 | 列表/详情/清理 | sessionManager |
| 子代理 | 列表/终止 | subAgentManager |
| 收件箱 | 列表/已读 | inboxManager |
| 审批 | 待审列表/批准/拒绝 | approvalManager |
| Hook | 注册/列表/删除 | hookManager |
| 技能 | 加载/列表 | skillManager |
| 日志 | 读取/级别 | logger |
| 语音/视觉 | TTS/STT/视觉 | ttsManager/sttManager/visionManager |
| 推送 | VAPID 配置/订阅 | pushManager |
| 模型供应商 | INFERENCE_BACKENDS 增删 | customProviderManager |
| 系统 | 工具注册表/MCP/插件/浏览器 | toolRegistry/mcpManager/pluginManager/browserManager |

## 4. 鉴权

- 全部路由经 `adminAuth` 中间件（middleware/admin-auth.ts）
- **admin-auto 内网免登录**规则见 doc-auth.md §3.3——公网暴露的部署
  必须确认 XFF 判断逻辑没被改动
- rbac.ts：角色权限定义

## 5. 升级接口（三平台分流）

管理后台含引擎升级端点，按平台分流（win/linux/darwin），对应
`deploy.sh` / `install.sh` / `install.ps1` 三套部署脚本。改升级逻辑
必须同步检查 doc-deploy.md 的版本号对齐清单。

---

## 回归测试清单（改 admin 必跑）

- [ ] 未登录/非管理员访问任一 admin 路由 → 401/403
- [ ] Cron：创建 → 列表可见 → runNow 执行成功 → 删除
- [ ] Cron enable/disable（PATCH）生效
- [ ] Standing Orders 创建后到点触发
- [ ] 审批流：待审 → 批准 → 工具执行；拒绝 → 不执行
- [ ] 子代理列表与终止
- [ ] 收件箱列表/已读
- [ ] 自定义供应商添加后模型列表出现新条目
- [ ] 技能列表加载、开发面板打开
- [ ] 公网来源（带 XFF）访问 admin → 被拒
- [ ] `npm run typecheck` 绿

## 坑位记录

### 2026-08-28（建档）admin.ts 单文件 72 条路由
- 现状：cron/审批/技能/语音/推送等 12+ 个域挤在一个文件（27KB）
- 待办：按域拆 admin-cron.ts / admin-agents.ts / admin-system.ts，
  拆分时保持 createAdminRoutes 工厂签名不变（主入口无需改动）