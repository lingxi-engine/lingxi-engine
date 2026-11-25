# LingXi Skill Catalog

> Curated built-in skills shipped with LingXi Engine. **52 skills** across 8 categories.
>
> This catalog is generated from the git-tracked skill set (`node scripts/gen-skill-catalog.mjs`).
> Auto-learned skill variants created at runtime are local-only and never shipped in releases.

Each skill is a JSON prompt-and-tool recipe the engine can reuse for similar tasks. Enable/disable them via `GET/POST /api/skills` or the Skills panel in the web UI.

## Contents

- [Code Quality & Debugging](#code-quality-debugging) (11)
- [Audit, Security & Release](#audit-security-release) (10)
- [Deployment & Ops](#deployment-ops) (7)
- [AI, Models & Agents](#ai-models-agents) (9)
- [Documents & Reports](#documents-reports) (3)
- [Media & Creative](#media-creative) (3)
- [Productivity & Workflow](#productivity-workflow) (5)
- [Other](#other) (4)

## Code Quality & Debugging

| Skill | Description |
|---|---|
| [`bug-check`](../skills/bug-check.json) | 对项目进行全面回归测试和代码审查，输出含复现步骤和严重程度的bug清单 |
| [`chat-session-isolation-debug`](../skills/chat-session-isolation-debug.json) | 排查聊天应用中消息是否按会话 ID 隔离，通过定位消息追加/渲染函数、对比多套实现页面，定位缺失的 chatId 过滤逻辑。 |
| [`check-missing-frontend-feature`](../skills/check-missing-frontend-feature.json) | 根据文档或后端代码描述的功能，排查前端代码是否遗漏了对应实现。 |
| [`code-patching-with-line-endings`](../skills/code-patching-with-line-endings.json) | 在修改代码文件时，先检查并统一换行符（CRLF/LF），避免精确匹配失败。 |
| [`code-review-and-fix`](../skills/code-review-and-fix.json) | 审查工作区代码，发现并修复问题（包括安全、逻辑、测试），必要时实现配置开关。 |
| [`code-version-sync-check`](../skills/code-version-sync-check.json) | 只读排查本地 Git、远端仓库、备份目录与线上部署代码的版本差异，输出对比结论 |
| [`complex-code-fix-task-splitting`](../skills/complex-code-fix-task-splitting.json) | 遇到复杂代码修复或重构任务时，先拆分为多个子任务，分步执行并验证，避免一次性处理导致卡死或超时。 |
| [`config-mismatch-debugging`](../skills/config-mismatch-debugging.json) | 排查项目中多层配置（如系统提示词、环境变量、运行时记录）不一致的问题，并梳理关系给出修复建议。 |
| [`cross-system-id-harmonization`](../skills/cross-system-id-harmonization.json) | 当用户反馈两个系统（如引擎与平台）的用户ID格式或生成逻辑不一致时，自动分析源码、定位差异、修改代码并验证修复效果。 |
| [`debug-frontend-ui-issue`](../skills/debug-frontend-ui-issue.json) | 当 UI 组件（如按钮）失效时，通过多轮工具调用排查根因，处理工具故障、工作目录错位、编码乱码等干扰，最终定位并修复 CSS/JS 缺陷。 |
| [`login-auth-bug-fix`](../skills/login-auth-bug-fix.json) | 当用户报告登录报错（如邮箱或密码错误）时，系统性地检查前后端认证逻辑、定位并修复多个叠加漏洞。 |

## Audit, Security & Release

| Skill | Description |
|---|---|
| [`code-audit-and-fix`](../skills/code-audit-and-fix.json) | 读取相关代码文件，生成审计报告，分批修复问题并验证结果。 |
| [`code-fix-and-verify`](../skills/code-fix-and-verify.json) | 当用户反馈代码问题或需求时，先核查现状、定位根因、实施修复并验证结果。 |
| [`code-release-workflow`](../skills/code-release-workflow.json) | 修改代码后执行Git提交、GitHub推送、本地备份、打包上传及部署测试的标准流程。 |
| [`code-security-audit`](../skills/code-security-audit.json) | 对项目进行全量代码安全审查，识别 P0/P1 漏洞并逐一修复验证 |
| [`codebase-audit-and-refactor`](../skills/codebase-audit-and-refactor.json) | 审查代码库功能逻辑，排查修复Bug，清理脏数据，运行测试验证并进行架构重构。 |
| [`codebase-health-audit`](../skills/codebase-health-audit.json) | 对代码库进行全景式检查：核心模块代码阅读、单元测试运行、类型检查、生成结构化报告 |
| [`cross-environment-feature-removal-audit`](../skills/cross-environment-feature-removal-audit.json) | 审计并移除目标功能在本地目录、Git 仓库、远端平台和服务器中的前后端、接口、数据及文档残留。 |
| [`open-source-naming-risk-analysis`](../skills/open-source-naming-risk-analysis.json) | 在开源项目前搜索同名冲突、评估商标风险、提供改名建议与决策路径 |
| [`pre-open-source-sensitive-scan`](../skills/pre-open-source-sensitive-scan.json) | 扫描代码库识别商业核心或敏感文件，并提供开源前的处理建议。 |
| [`scheduled-task-audit`](../skills/scheduled-task-audit.json) | 检查代码库中的定时任务调度、配置和执行链路，发现问题后进行最小化修复并验证。 |

## Deployment & Ops

| Skill | Description |
|---|---|
| [`check-repo-github-sync`](../skills/check-repo-github-sync.json) | 检查本地代码仓库是否为最新版本，并确认今天的修改是否已提交并推送到 GitHub 远程。 |
| [`feature-disable-rollout`](../skills/feature-disable-rollout.json) | 安全地下线一个产品功能，并同步处理前端入口、后端接口、官网、GitHub、备份和生产环境。 |
| [`github-ci-failure-triage`](../skills/github-ci-failure-triage.json) | 根据 GitHub Actions 通知、日志和仓库状态，定位 CI 失败根因并执行修复、验证和后续维护。 |
| [`local-ai-mcp-deployment`](../skills/local-ai-mcp-deployment.json) | 在本地环境部署开源AI模型或工作流，并将其封装为MCP Server供外部调用。 |
| [`mobile-remote-control-client`](../skills/mobile-remote-control-client.json) | 将移动端实现为无本地算力、登录同一账号后连接并操控本地或云端灵犀引擎的远程客户端。 |
| [`remote-server-deployment-troubleshooting`](../skills/remote-server-deployment-troubleshooting.json) | 系统排查 DNS、SSH、网络出口、防火墙和端口问题，并安全完成网站部署与上线验证。 |
| [`ubuntu-nginx-static-site-deployment`](../skills/ubuntu-nginx-static-site-deployment.json) | 诊断远程连通性，并在 Ubuntu 服务器上完成静态站点下载校验、Nginx 配置、HTTPS 签发与上线验收。 |

## AI, Models & Agents

| Skill | Description |
|---|---|
| [`api-model-provider-debug`](../skills/api-model-provider-debug.json) | 排查并修复 AI 模型 provider 调用失败问题，如 400 非法模型 ID、410 模型下线、Key 或配置错误。 |
| [`brainstorm-summary-collation`](../skills/brainstorm-summary-collation.json) | 将多轮头脑风暴结果进行去重合并、状态检查与落盘归档 |
| [`email-checker`](../skills/email-checker/SKILL.md) | Skill bundle (see SKILL.md) |
| [`long-task-force-completion`](../skills/long-task-force-completion.json) | 针对需要长时间运行、可能被中断的AI任务，设计可断点续传、自愈、无人值守的工程化执行方案，并输出为文档。 |
| [`memory-persistence`](../skills/memory-persistence.json) | 当用户要求「记住」某个关键信息（项目代号、配置、决策等）时，将其写入 memory 目录并同步更新机器可读与人读索引，最后校验回读。 |
| [`model-routing-debug`](../skills/model-routing-debug.json) | 排查工具调用模型与回复模型分离配置是否生效，检查后端路由代码并验证修复。 |
| [`multi-agent-collab-implementation`](../skills/multi-agent-collab-implementation.json) | 根据设计文档实现多智能体协作模式，涉及代码结构分析、多文件修改和验证。 |
| [`music-generation`](../skills/music-generation.json) | 使用AI模型（如MusicGen、DiffRhythm）生成或制作歌曲/音乐 |
| [`ollama-connection-troubleshoot`](../skills/ollama-connection-troubleshoot.json) | 当用户报告连接Ollama本地模型失败（404/模型未找到等错误）时，系统地检查本地Ollama服务状态、可用模型列表、环境变量配置和代码逻辑，定位根因并给出修复方案 |

## Documents & Reports

| Skill | Description |
|---|---|
| [`analyze-and-generate-word-report`](../skills/analyze-and-generate-word-report.json) | 当用户要求诊断问题、分析方向或总结材料，并输出Word文档到桌面时使用 |
| [`application-material-docx-generator`](../skills/application-material-docx-generator.json) | 根据官方通知文件起草申报材料并生成带分页的合并Word文档 |
| [`weekly-report-generator`](../skills/weekly-report-generator.json) | 根据用户固化的报告偏好生成符合要求的周报草稿 |

## Media & Creative

| Skill | Description |
|---|---|
| [`comfyui-task-executor`](../skills/comfyui-task-executor.json) | 在本地 Windows 环境启动/检查 ComfyUI，验证模型与资源，提交生成工作流并等待结果，必要时用 ffmpeg 做后处理。 |
| [`short-video-production`](../skills/short-video-production.json) | 从环境探测到成片导出的端到端短视频制作技能，涵盖场景生成、动效剪辑和最终验证。 |
| [`web-design-iteration`](../skills/web-design-iteration.json) | 在本地网页预览文件中迭代修改视觉元素，使用文件工具编辑并指导用户刷新查看。 |

## Productivity & Workflow

| Skill | Description |
|---|---|
| [`autonomous-product-comparison`](../skills/autonomous-product-comparison.json) | 通过多源检索、并行分析和持续校验，自主完成同类产品能力对比与优化建议，不中途等待用户发送“继续”。 |
| [`check-and-resume-task`](../skills/check-and-resume-task.json) | 检查长任务的当前进度，汇报已完成与未完成步骤，并自动继续执行剩余工作。 |
| [`check-project-folder-integrity`](../skills/check-project-folder-integrity.json) | 当用户要求检查某个项目文件夹是否完整、文档是否齐全时，通过列出目录结构、关键文件检查、文档质量评估等方式给出报告。 |
| [`persistent-user-preferences`](../skills/persistent-user-preferences.json) | 将用户声明的长期偏好持久化到工作区文件，并在后续任务中读取并严格遵守这些偏好。 |
| [`structured-task-planning`](../skills/structured-task-planning.json) | 在启动复杂任务前通过结构化问答澄清需求与验收标准，随后拆解子任务并逐步执行和汇报进度。 |

## Other

| Skill | Description |
|---|---|
| [`benchmark-analysis`](../skills/benchmark-analysis.json) | 对项目基准测试报告进行多步核验：收集数据→运行验证脚本→交叉比对版本→人工复核→输出综合评估结论 |
| [`weather-briefing`](../skills/weather-briefing/SKILL.md) | Skill bundle (see SKILL.md) |
| [`weather-query`](../skills/weather-query.json) | 查询指定城市的近期天气预报 |
| [`website-accessibility-diagnosis`](../skills/website-accessibility-diagnosis.json) | 通过 DNS、端口、服务器配置和境内外多节点实测，定位网站无法访问的真实原因并给出修复方案。 |

---

Regenerate after curating skills: `node scripts/gen-skill-catalog.mjs`
