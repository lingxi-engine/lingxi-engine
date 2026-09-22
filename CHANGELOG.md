# 更新日志 CHANGELOG

本文档记录灵犀引擎各版本变更。日期格式 YYYY-MM-DD。

## [2.0.23] - 2026-09-22

### 修复（自 v2.0.22 tag 以来 7 个 commit 的累积变更）

- **collab 黑洞修复**（hub.ts + subagent-manager.ts）：collabSpeak 新增 Promise.race 硬超时兜底，消除 L5-005 永久卡 running；OpenAI client 补齐 timeout:120000 + maxRetries:1
- **bench SUMMARY 汇总修复**（ws-adapter.cjs）：manual 题不再被跳过统计；NaN% 改为 -；残缺 JSON 容错；新增 --summarize 离线重算入口
- **打包器修复**（pack-release.ps1）：SW 缓存门禁改为正则，修复打包永久失败；排除测试数据目录
- **版本治理**：.gitignore 清理；新增诊断技能文件
- **安全与一致性修复（platform/runtime）**：
  - `src/storage/db.ts`：积分/钱包金额统一拒绝 `<=0`、`NaN`、`Infinity`，阻断负数消费绕过；
  - `src/platform-server.ts`：充值仅接受 `USD/CNY`，管理员积分变更限制为有限整数且禁止扣成负余额；
  - `src/platform-server.ts`：`/api/hire/order` 改为事务执行（扣款/入账/订单/listing 更新时间同事务），扣款使用余额条件原子更新并检查 `changes()`，新增 `hire_orders.request_id` + 幂等唯一索引；
  - `src/routes/channel.ts`：微信 POST webhook 补齐与 GET 一致的签名校验；飞书无效 token 返回 403；
  - `src/middleware/*` + `src/platform-server.ts`：管理 token 比较统一为 timing-safe，query token 默认禁用，仅允许显式开发模式开关兼容；
  - `src/tools/executor.ts`：最终兜底 completion 透传 `AbortSignal`；
  - `src/core/docker-sandbox.ts`：Docker 可用性检测缓存复用，`network` 安全默认改为禁网（显式开启才联网）。

### 迁移说明

- 平台库 `hire_orders` 新增 `request_id` 字段与唯一索引 `idx_hire_orders_idem(listing_id,buyer_id,request_id) WHERE request_id <> ''`；旧数据可无缝迁移。

### 版本对齐

- package.json / version.txt / CHANGELOG.md 统一 2.0.23
- Git tag v2.0.23 指向 HEAD

## [2.0.22] - 2026-09-22

### 工具调用 & 评测度量修复（解决 L4/L5 重跑问题）

- **web_fetch 大页面截断修复**（`src/tools/builtin.ts`）：新增 `offset` 分段读取，返回 `total_chars`/`truncated`/`next_offset`；HTML 正文抽取（去 nav/header/footer/aside/form/script/style，优化 `<article>/<main>`）；错误分类 `http_403`/`http_429`/`http_5xx`/`timeout`/`too_large`/`network` 并标记 `retryable`。不再仅靠加大预算绕过
- **子 Agent 事件回传修复**（G6 steps=0 根因）：`SubAgentManager` 新增全局进度回调 `setProgressHandler`，`index.ts` 将其接到 WebSocket `broadcast`，发送 `agent.tool.call`。子代理内部工具调用不再丢失，bench 步数/工具调用统计恢复真实（详见 `bench/L5-STEPS0-ROOTCAUSE.md`）
- **bench 适配器度量自检**：ws-adapter.cjs 对「steps=0 但输出含工具痕迹」的记录标记 `metricSuspect`，SUMMARY 追加告警
- **修复违规扫描漏报**：ws-adapter.cjs 的 `scanViolations` 转义被写坏，导致含正则特殊字符的违规片段永不命中，已修正

### 版本治理

- `/api/health` 的 `version` 改为运行时读 `package.json`（回退 `version.txt`），消除硬编码漂移
- 版本统一为 **2.0.22**（`package.json` / `package-lock.json` / `version.txt`）
- 打包脚本版本动态化：`scripts/pack-release.ps1` 原本硬编码 `2.0.20`（升版后 FAIL），改为从 `package.json` 读取；打包时写入 `BUILD-INFO.json`（version/commit/buildTime）并加一致性断言
- 部署验 SHA 校验：新加 `scripts/verify-deploy.cjs`（`npm run verify:deploy`），比对线上 `/api/health` 的 version/commit 与代码，漂移则 exit 1

## [2.0.21] - 2026-09-21

### 版本治理 + 可观测性补齐

- `/api/health` 新增 `commit`（短 SHA）与 `buildTime` 字段，运行时可直接比对线上实例与代码版本，消除「代码 vs 运行态」盲区（`index.ts`）
- 版本号统一为 **2.0.21**：`package.json` / `package-lock.json` / `version.txt` 三处对齐（此前 package-lock 滞后于 2.0.19）
- 补齐 CHANGELOG 中 2.0.18 / 2.0.20 此前仅发版未记录，本次一并说明

### 评测进度补记（非代码变更）

- v35-L4 对抗题 5 题、v35-L5 多 Agent 5 题均已跑（详见 `workspace/bench/results/v35-L4`、`v35-L5`）
- 已知口径缺陷：L4 自动达标率因 manual 题不入分母而虚高（自动 100% vs 人工终审 1/5），待修判分汇总逻辑

## [2.0.17] - 2026-09-12
