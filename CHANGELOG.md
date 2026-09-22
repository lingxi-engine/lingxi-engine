# 更新日志 CHANGELOG

本文档记录灵犀引擎各版本变更。日期格式 YYYY-MM-DD。

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
- **bench 适配器度量自检**：`ws-adapter.cjs` 对「steps=0 但输出含工具痕迹」的记录打 `metricSuspect` 标记，SUMMARY 追加告警行
- **修复违规扫描漏报**：`ws-adapter.cjs` 的 `scanViolations` 转义被写坏，导致含正则特殊字符的违规片段永不命中，已修正

### 版本治理
- `/api/health` 的 `version` 改为运行时读取 `package.json`（回退 `version.txt`），消除硬编码漂移
- 版本统一至 **2.0.22**（`package.json` / `package-lock.json` / `version.txt`）
- **打包脚本版本动态化**：`scripts/pack-release.ps1` 原本硬编码 `2.0.20`（升版后必 FAIL），改为从 `package.json` 读取；打包时写入 `BUILD-INFO.json`（version/commit/buildTime）并加一致性断言
- **部署后 SHA 校验**：新增 `scripts/verify-deploy.cjs`（`npm run verify:deploy`），比对线上 `/api/health` 的 version/commit 与代码，漂移则 exit 1

## [2.0.21] - 2026-09-21

### 版本治理 + 可观测性补齐
- `/api/health` 新增 `commit`（短 SHA）与 `buildTime` 字段，运行时可直接比对线上实例与代码版本，消除「代码态 ≠ 运行态」盲区（`index.ts`）
- 版本号统一至 **2.0.21**：`package.json` / `package-lock.json` / `version.txt` 三处对齐（此前 package-lock 滞后在 2.0.19）
- 补齐 CHANGELOG：2.0.18–2.0.20 此前仅发版未记录，本次一并说明

### 评测进度补记（非代码变更）
- v35-L4 对抗题 5 题、v35-L5 多 Agent 5 题均已跑（详见 `workspace/bench/results/v35-L4`、`v35-L5`）
- 已知口径缺陷：L4 自动达标率因 manual 题不入分母而虚高（自动 100% vs 人工终审 1/5），待修判分汇总逻辑

## [2.0.17] - 2026-09-12

### 推理过程显示修复 + 持久化
- Ollama OpenAI 兼容层实际返回 `reasoning`（非 `reasoning_content`），改为双字段兼容，覆盖 router / critic / debate / memory-reflector / thought-tree / world-model / executor 等 11 处读取点
- 推理内容随消息入库持久化，刷新页面与历史回读仍可见，双键兼容既有数据
- LAN 联机群聊：跨引擎 payload 与本机接收侧补齐 reasoning 字段，推理气泡常驻
- 多步任务 `agent.task` 推理事件接入前端展示
- PWA 缓存 v15 → v18，确保前端推理渲染立即生效
- 版本一致性：version.txt / package.json / 官网下载页 / install.sh 统一 2.0.17

## [2.0.16] - 2026-09-11

### shell_exec 防自杀保护 + 市场裸引擎标注
- shell_exec 统一拦截 taskkill / pkill / killall / Stop-Process，防止 Agent 误杀引擎自身进程
- 市场对「纯 API 转售 / 裸引擎」类商品加标注，配合平台评测背书
- 版本一致性：version / package-lock 对齐 2.0.16

## [2.0.15] - 2026-09-09

### 平台管理后台 + 部署修复
- 新增 7 个 admin API（dashboard / usage 等）+ platform-admin.html 管理界面（PLATFORM_ADMIN_TOKEN 鉴权）
- platform-server 改为加载 .env.platform，避免吞掉主引擎 .env（PORT=3456 EADDRINUSE）
- multer 升级与依赖版本对齐

## [2.0.14] - 2026-09-07

### 子代理系统修复 + 安全守卫恢复
- delegate_task 加入 general-assistant 技能白名单，setSubAgentManager() 完成实例接线，复杂任务自动拆分派发子代理生效
- 失败/超时任务保留期 24h → 10min（env SUBAGENT_FAIL_RETAIN_MS 可调），完成任务仍保留 24h
- 恢复 3 处开源清洗时丢失的安全修复：MESH_TOKEN 弱值检测（生产模式拒绝启动）、mobile verify-email 路由 + admin 邀请码端点（timingSafeEqual 鉴权）
- 修复市场雇佣接口 d.getAgent 崩溃
- 版本一致性：version.txt / package.json / 官网下载页统一 2.0.14

## [2.0.13] - 2026-08-27

### 登录态与市场修复
- api() 不再携带平台 JWT（本地引擎免登录通道）；登录即显示已登录/退出
- /me 走平台验证并回填 lanMeId；修复登录后添加模型 401
- 版本号统一 2.0.13 + 打包脚本动态版本 + 缓存版本号刷新

## [2.0.12] - 2026-08-14

### 版本号统一
- 全量对齐至 2.0.12：package.json、package-lock.json、version.txt、src/version.txt、docs/dev/version.txt
- `/api/health` 版本号 fallback 由 2.0.7 对齐为 2.0.12

### 修复汇总（自 2.0.8 以来）
- 好友系统（v2.0.10）：3 个搜索入口统一 `/api/users/search`；`platformApi('/api/lan/*')` 迁移为 `api()` 并传 userId；`/api/user/me` → `/api/auth/me`；deleteFriend 改用 `POST /api/lan/remove-friend`；后端 `/api/lan/friends`、`/api/lan/friend-requests` 增加 JWT fallback 获取 userId
- 前端 platformApi 全量本地回退（v2.0.11）：平台不可达时自动降级本地模式，切换安全可逆

## [2.0.8] - 2026-08-09

### 功能修复（前端）
- 恢复右侧栏「任务监控」：删除 index.html 硬编码假任务卡片，新增 `loadTaskMonitor()` 调用 `/api/cron` 渲染真实定时任务（运行/暂停/删除按钮绑定事件）
- 恢复右侧栏「目标任务」：删除 index.html 硬编码假目标列表，新增 `loadRightGoals()` 调用 `/api/goals` 渲染真实目标
- 新增左侧栏「个人信息卡片」：`loadProfileCard()` 调用 `/api/auth/me` + `/api/profile` 填充 pcName/pcId/pcCredits/pdName/pdId/pdCredits/pdBio（之前 HTML 有占位符但 app.js 无填充代码）
- 新增「反向提问」前端入口：`askGoal()` / `askAIAboutGoal()` 调用 `POST /api/goals/:id/ask`，在管理面板和右侧栏目标列表加 ❓ 按钮（后端路由一直存在，前端从未实现调用）
- 恢复「反问多选」表单：`renderGoalQAForm()` 检测 AI 返回的 Q:/A:/B:/C: 格式，在消息下方渲染复选框 + 自定义输入框 + 三个操作按钮（完善目标 / 加入验收标准 / 生成新目标）
- 恢复「继续反问」：`continueReverseAsk()` 收集已勾选选项 + 自定义输入作为 extra 上下文传给 `askAIAboutGoal()`，后端 `/ask` 路由同步支持 extra 参数
- 上述功能在 1d04051 提交清理 app.js 时被误删，已在 3cce96f 提交中全部恢复

### Bug 修复
- 修复 `friends.ts` 第 111 行 `require()` 在 ESM 模块中不可用（改为 `import { getDB }`）
- 新增 `POST /api/update` 路由（admin.ts），前端「一键升级」按钮不再 404
- 移除 index.html 硬编码假数据（申总/10086 等），改为「加载中…」占位
- `web/app.js` 废弃文件重命名为 `.bak`

### 部署同步
- 全部修复已同步至服务器 `/opt/lingxi-engine/`，PM2 已重启
- 下载包 `lingxi-engine.tar.gz` 已重建（5.3MB）

## [2.0.7] - 2026-07-28

### 安全（P0）
- 收紧 admin-auto 免登录兜底：无 token 自动放行仅限本地/内网来源（loopback 与 RFC1918 私有地址），公网来源必须携带有效 JWT 或 ADMIN_TOKEN（src/middleware/jwt-auth.ts）
- WebSocket 免登录连接同步收紧：与 HTTP 中间件一致，仅信任本地/内网来源（index.ts）
- 新增 `isTrustedLocalSource()` 统一来源判断；确需公网免登录可显式设置 `ALLOW_PUBLIC_ADMIN_AUTO=1`（不推荐）

### 修复（P0）
- 恢复聊天输入区完整功能：补回 📎 文件上传按钮（真实 file input + 预览栏）、🎙️ 语音录制按钮（按住说话）；停止按钮与排队栏本就存在（web/index.html，仅改 HTML，未动 app.js）

### 变更
- 版本号统一为 2.0.7（此前 package.json=2.0.4 与 version.txt=2.0.6 不一致）
- 补建本 CHANGELOG（此前断更）

## [2.0.6] - 2026-08-08 前后（补记）

- v2.0.5：个人本地引擎免登录兜底（无认证头自动以 admin 放行）
- 通用 API 限流（30 次/分钟）

## [2.0.4] - 2026-08-08

- 全面社交功能升级：在线状态 / 编辑资料 / 头像上传 / 表情反应 / 输入提示 / 拉黑 / 免打扰
- 补全路由挂载 profile/misc/upload，增强 /auth/me 返回字段
- shell_exec 增加审批，系统提示词禁止擅执行危险命令
- 生成超时保底：3 分钟后自动重置生成状态，不再永久卡住
- 目标任务 AI 自评：汇报进度 + 自动检测完成
- 反向提问：其他输入框 + 继续反问按钮
- docker-sandbox、router、builtin 工具、workflow 路由、web 前端更新，新增 skills

---

## 历史版本补记（依据 git 提交与交付物回溯，Git 纳管始于 2026-08-05，此前无提交记录）

> 说明：v2.0.3 及更早版本先于 Git 纳管，版本号对应关系依据交付物（workspace/*.tar.gz、部署脚本）与提交主题推断，非逐版精确。

### [2.0.3] - 2026-08-07 前后（推断）
- 目标任务自主执行循环（AI 回复后自动继续直到完成）
- 反向提问结构化问答表单（复选框 + 三动作）
- 队列栏显示/清空 + 目标执行停止按钮
- 依据：workspace/deploy-v203.ps1 部署脚本

### [2.0.2] - 2026-08-06 前后（推断）
- 工作流执行引擎（POST /api/workflows/:id/run + 前端运行按钮）
- Skills 注入 AI 提示词 + 渠道状态 API
- 补充记忆反思 API（POST /api/agents/:id/reflect）、/api/rag/scan-workspace、/api/update
- 大规模死代码清理（旧版 app.js 167KB/178KB 等）

### [2.0.1] - 2026-08-05 前后（推断）
- 代码审查修复：PORT 校验 / 邮箱正则 / 用户创建事务 / bcrypt 容错
- 删除死代码 src/index.ts + src/src/（97 文件）
- 修复 getClient() fallback 透传原始模型名导致云端 API 400
- Orchestrator skipped 级联 + SubAgent 超时双重通知

### [2.0.0] - 2026-08 初
- V5 架构：审批 / Hooks / 收件箱 / 技能 / 渠道；V7 JWT 鉴权 + ADMIN_TOKEN 快速通道
- 依据：交付物 lingxi-engine-v2.0.0.tar.gz

### [1.8.x]（1.8.0 / 1.8.1 / 1.8.2 / 1.8.5）
- 依据：`workspace/` 留存四个对应版本交付包；v1.8.0 引入模板引擎（存在欠账，见开发文档 P1-3）
- 无逐版提交记录，详情不可考

### [1.7.x]（1.7.1 / 1.7.2 / 1.7.3）
- v1.7 路由体系：/api/dream、/api/entities；Mesh 实例组网（mesh-platform）
- 依据：src/routes-v1.7.ts、workspace/deploy-backup-v1.7.2.tar.gz
- 无逐版提交记录，详情不可考
