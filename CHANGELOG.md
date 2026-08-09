# 更新日志 CHANGELOG

本文档记录灵犀引擎各版本变更。日期格式 YYYY-MM-DD。

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
- 依据：workspace/ 留存四个对应版本交付包；v1.8.0 引入模板引擎（存在欠账，见开发文档 P1-3）
- 无逐版提交记录，详情不可考

### [1.7.x]（1.7.1 / 1.7.2 / 1.7.3）
- v1.7 路由体系：/api/dream、/api/entities；Mesh 实例组网（mesh-platform）
- 依据：src/routes-v1.7.ts、workspace/deploy-backup-v1.7.2.tar.gz
- 无逐版提交记录，详情不可考
