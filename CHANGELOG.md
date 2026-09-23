# 更新日志 CHANGELOG

本文档记录灵犀引擎各版本变更。日期格式 YYYY-MM-DD。

## [2.0.25] - 2026-09-24

### 新功能：会话/群聊重命名（新建会话与新建群聊体验对齐）

- **`PATCH /api/chats/:id/name`**（`src/routes/friends-chats.ts`）：私聊与群聊通用改名端点。
  - 权限：`requireAuth` + 参与者校验（JWT `sub`/`numeric_id` 必须命中 `participants` 表），非参与者返回 403；本地免登录模式（`admin-auto`/`admin-token`）跳过一致性检查。
  - 校验：会话不存在 404；名称为空/纯空白 400；超过 60 字符 400；首尾空白裁剪。
  - 成功后广播 `chat.renamed` 事件，多端同步。
- **前端 `web/js/app.js`**：
  - `newChat()` 新增命名 `prompt`（此前硬编码「新会话」，导致「点新建总是新会话」）；空名 toast 提示后放弃创建，与 `showCreateGroup()` 的必填语义一致，ESC 依旧静默取消。
  - 新增 `renameChat(chatId)`，会话列表每项新增 ✏️ 按钮（置于 🗑 左侧，`stopPropagation` 防误触切换），改名后同步 `myChats`/`chatTitle`/列表渲染。
- **i18n**：新增 8 个 key（`chat.newChatNamePh`/`chat.renameChatPh`/`chat.renameTitle`/`chat.renameEmpty`/`chat.renameTooLong`/`chat.renamed`/`chat.renameFail`/`chat.selectChatFirst`），覆盖简/繁/英/日/韩/越 6 语言。
- **测试**：新增 `src/tests/chat-rename.test.ts`（10 例，真实 `initDB` + supertest 打真实 HTTP），覆盖 401/404/400/403 越权防护、名称真实落库、`chat.renamed` 广播、群聊同名可改、空白裁剪、60 字符边界。

### 版本治理

- 版本统一为 **2.0.25**（`package.json` / `package-lock.json` / `version.txt` 三处对齐）；修正功能注释中误写的 `v2.1.5` 版本口径漂移。
- 测试总数 90 → **100**，CI 注释同步更新。

## [2.0.24] - 2026-09-23

### 新功能：灵犀 MVP 市场闭环

- **MVP 服务层**（`src/core/mvp-market/service.ts`，约 1000 行）：任务 → 报价 → 合同 → 交付 → 验收 → 评价 → 争议 → 结算 → 通知 → 审计日志全链路状态机，26 个业务方法。
- **MVP 路由层**（`src/routes/mvp-market.ts`，346 行）：26 个端点，挂载于 `/api/mvp`（`index.ts`），传入 `requireAuth`/`optAuth`/`adminAuth` 权限中间件。
- **智能体能力**：创建智能体、配置技能、设置预算（`setAgentBudget`）、生成任务建议（`generateTaskSuggestions`）。
- **数据库**：11 张 MVP 表迁移；账本无漂移校验。
- **测试**：新增 `src/tests/mvp-market.test.ts`（59 例）+ `src/tests/mvp-initdb.test.ts`（3 例，走真实 `initDB()` 迁移链验证 11 张表真能建出来）。
- **CI**：ts-engine job 接入 Vitest suite 步骤，闭环测试在 push/PR 自动跑。

### 修复

- **CI YAML 损坏**（commit `2cd5245`）：历史 commit `8038d5c` 用 PowerShell 处理 BOM 时把 `ci.yml` 里 BOM gate 的中文注释写成 GBK 乱码，并吞掉第三行换行符，导致 `run: |` 挤进注释行、整个 workflow 无法解析。已从 `1b915e1` 提取正确原文做字节级恢复（保持 CRLF、无 BOM）。
- 清理误提交的 0 字节垃圾文件 `{const` 与 `m[1].toUpperCase()+'`。

### 版本治理

- 版本统一为 **2.0.24**（`package.json` / `package-lock.json` / `version.txt`）。

## [2.0.23] - 2026-09-22

### 修复（自 v2.0.22 tag 以来 7 个 commit 的累积变更）

- **collab 黑洞修复**（hub.ts + subagent-manager.ts）：collabSpeak 新增 Promise.race 硬超时兜底，消除 L5-005 永久卡 running；OpenAI client 补齐 timeout:120000 + maxRetries:1
- **bench SUMMARY 汇总修复**（ws-adapter.cjs）：manual 题不再被跳过统计；NaN% 改为 -；残缺 JSON 容错；新增 --summarize 离线重算入口
- **打包器修复**（pack-release.ps1）：SW 缓存门禁改为正则，修复打包永久失败；排除测试数据目录
- **版本治理**：.gitignore 清理；新增诊断技能文件

### 版本对齐

- package.json / version.txt / CHANGELOG.md 统一 2.0.23
- Git tag v2.0.23 指向 HEAD

## [2.0.22] - 2026-09-22

### 工具层 & 评测度量修复（解锁 L4/L5 重跑）
- **web_fetch 大页面截断修复**（`src/tools/builtin.ts`）：新增 `offset` 分段读取，返回 `total_chars`/`truncated`/`next_offset`；HTML 正文抽取（去 nav/header/footer/aside/form/script/style，优先 `<article>/<main>`）；错误分类 `http_403`/`http_429`/`http_5xx`/`timeout`/`too_large`/`network` 并标注 `retryable`。不再仅靠加大预算绕过
- **多 Agent 事件回传修复（G6 steps=0 根因）**：`SubAgentManager` 新增全局进度回调 `setProgressHandler`，`index.ts` 将其接到 WebSocket `broadcast`，发出 `agent.tool.call`。子代理内部工具调用不再丢失，bench 步数/工具调用统计恢复真实（详见 `bench/L5-STEPS0-ROOTCAUSE.md`）
- **bench 适配器度量自检**（`ws-adapter.cjs` 对「steps=0 但输出含工具痕迹」的记录打 `metricSuspect` 标记，SUMMARY 追加告警行）
- **修复违规扫描漏报**：`ws-adapter.cjs` 的 `scanViolations` 转义被写坏，导致含正则特殊字符的违规片段永不命中，已修正

### 版本治理
- `/api/health` 的 `version` 改为运行时读取 `package.json`（回退 `version.txt`），消除硬编码漂移
- 版本统一至 **2.0.22**（`package.json` / `package-lock.json` / `version.txt`）
- **打包脚本版本动态化**：`scripts/pack-release.ps1` 原本硬编码 `2.0.20`（升版后必 FAIL），改为从 `package.json` 读取；打包时写入 `BUILD-INFO.json`（version/commit/buildTime）并加一致性断言
- **部署后 SHA 校验**：新增 `scripts/verify-deploy.cjs`（`npm run verify:deploy`），比对线上 `/api/health` 的 version/commit 与代码，漂移则 exit 1

## [2.0.21] - 2026-09-21

### 版本治理 + 可观测性补齐
- `/api/health` 新增 `commit`（短 SHA）与 `buildTime` 字段，运行时可直接比对线上实例与代码版本，消除「代码态 ≠ 运行态」盲区（`index.ts`）
- 版本号统一至 **2.0.21**：`package.json` / `package-lock.json` / `version.txt` 三处对齐（此前 package-lock 滞后）
