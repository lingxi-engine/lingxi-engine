# 灵犀引擎 vs OpenClaw 差距对比报告（v2 修正版）

> 生成时间：2026-10-08
> 灵犀版本：v2.0.32（package.json / version.txt 本机实测）
> OpenClaw：原名 Clawdbot，Peter Steinberger 发起，OpenClaw 基金会（501c3）治理
> 数据来源：OpenClaw 官方 README（GitHub raw 一手抓取）+ docs.openclaw.ai skills/heartbeat 页 + 灵犀本机源码

## 数据可信度

| 标记 | 含义 |
|---|---|
| ✅ | 灵犀侧本机源码实测（文件:行号）或 OpenClaw 官方 README/文档一手抓取 |
| ⚠️ | 未在本环境一手验证的推断 |

**v1 报告的三处修正**（诚实优先）：
1. ❌ v1 说"灵犀没有浏览器控制" → **错**。`src/tools/browser.ts` 存在完整 Puppeteer 工具组（open/click/type/screenshot/extract/exec），且 `index.ts:444-455` 确认注册。真实差距只是 **puppeteer 在 optionalDependencies，默认不装**。
2. ❌ v1 说"OpenClaw 不会优先做中国渠道" → **错**。官方文档有 Feishu/QQ bot/WeChat/WeCom/Yuanbao 完整设置页。
3. ❌ v1 说"OpenClaw 无多 Agent 协作同级能力" → **错**。文档有 Multi-agent routing、Parallel specialist lanes、Sub-agents、Swarm、ACP agents。
4. 版本号修正：v2.0.32（非 2.0.30）。

---

## 一、定位：不同物种，同一战场

| | 灵犀引擎 | OpenClaw |
|---|---|---|
| 抽象层 | AI-Native IM 平台（自建 Web/移动端 IM，真人+AI 同群） | 个人助理 Gateway（寄生在现成聊天 App 上）+ Control UI/TUI/CLI |
| 形态 | 一个产品 | Gateway + 5 平台原生 App + 20+ 渠道插件 + ClawHub 插件市场 |
| 治理 | 个人项目 | OpenClaw 基金会（501c3），60+ 贡献者，OpenAI/Red Hat/NVIDIA 赞助 |
| 安装 | git clone + npm install + 手配 .env | `curl install.sh \| bash` / `iwr install.ps1 \| iex` + **onboarding 向导** + daemon |

---

## 二、能力对齐表（全部一手数据）

| 能力 | 灵犀 ✅ | OpenClaw ✅ | 差距判定 |
|---|---|---|---|
| 浏览器控制 | browser.ts 6 工具（Puppeteer，**可选依赖默认不装**） | Browser 独立文档树：profiles/多 profile/远程浏览器/CDP/Chrome 扩展/Firecrawl | **OpenClaw 明显领先**（默认启用+生态深） |
| 渠道 | 9 个（Telegram/Signal/iMessage/Discord/Slack/飞书/QQ/微信/WhatsApp） | 20+（含 Feishu/QQ/WeChat/WeCom/LINE/Zalo/Matrix/Teams/Google Chat…） | **OpenClaw 领先一倍以上** |
| 定时/主动 | cron-scheduler（IANA 时区+持久化） | **Heartbeat 自动化** + Automations + Inbound webhooks + Gmail/IMAP 触发 + Standing orders | **OpenClaw 领先**（触发源丰富度） |
| 多 Agent | 6 协作模式 + subagent-manager 763 行 | Multi-agent routing + Sub-agents + Swarm + ACP agents + 并行专家通道 | **灵犀特色但 OpenClaw 有同级** |
| 记忆 | 反思/检索/衰减三件套（数据库式） | Memory architecture + LanceDB + Memory wiki + **Active Memory + Dreaming** + Honcho | **OpenClaw 领先**（有"做梦整理记忆"机制） |
| 语音 | TTS+STT（src/voice/） | Voice call 插件（实时流式+TTS+入呼）+ FaceTime/Meet/Zoom 会议插件 | **OpenClaw 领先**（实时语音通话） |
| 搜索 | search-providers 3 家 | 20+ 搜索 provider（Brave/DuckDuckGo/Exa/Gemini/Grok/Kimi/MiniMax/Perplexity/SearXNG/Tavily…） | **OpenClaw 大幅领先** |
| 代码执行 | shell_exec 白名单 + Docker 沙箱 + Code Mode 无 | Code Mode（executors/guest API/internals）+ Exec approvals 审批流 | **各有千秋**（灵犀沙箱默认关闭是减分项） |
| 模型接入 | 6 类 Provider（OpenAI/DeepSeek/NVIDIA/Ollama…） | 模型即插件（Claude/Codex/本地模型/FM/llama.cpp/ONNX） | 打平 |
| 审批流 | ApprovalManager（registry.ts:18,104-124） | Exec approvals + Permission modes + Policy as code | OpenClaw 体系更完整 |
| MCP | src/mcp/adapter.ts | MCP servers 文档树 | 打平 |
| 安装体验 | 手动配置，410 类错误直接打蒙用户 | 安装器+onboarding 向导+自动更新+回滚 | **OpenClaw 领先** |
| 文档 | README+docs/ 踩坑笔记 | 20 语言文档站+DeepWiki+SECURITY.md | **OpenClaw 领先** |
| benchmark | **243 条断言可复现**（Tier-3 96.7%） | 未见公开 benchmark | **灵犀领先** |
| IM 产品形态 | 自建 IM，真人+AI 同群 | 无（依赖宿主 App） | **灵犀独有** |
| 中文原生 | 原生中文 | 文档有中文页，产品面向英文 | **灵犀领先** |

---

## 三、真实差距清单（修正后，按优先级）

### 🔴 P0 治理与生态（量级差，无法速胜）
- OpenClaw：基金会治理 + 60+ 贡献者 + OpenAI/RedHat/NVIDIA/Amazon 赞助 + ClawHub 插件市场 + 20 语言文档。
- 灵犀：单人项目。**这不是补功能能追的，是组织形态差距。**

### 🔴 P0 开箱体验（可速胜，最该先做）
- OpenClaw：install.sh → onboarding 向导（验证模型访问→建工作区→配 Gateway）→ dashboard。
- 灵犀：clone→改 .env→找 Key→npm install，出错（如 410）无引导。**用户第一小时流失点。**

### 🟠 P1 浏览器默认可用性
- 灵犀工具组不弱（6 工具+内网防护），但 puppeteer 是 optionalDependencies **默认不装**，`init()` 失败只打一行 log。
- OpenClaw 浏览器是文档树级投入（profiles/远程/CDP/扩展）。
- **行动：默认安装或提供 `npm run setup:browser`。**

### 🟠 P1 主动自动化触发源
- 灵犀 cron 只有时间触发。OpenClaw 有 webhook/Gmail/IMAP/standing orders。
- **行动：补 webhook 触发器，成本最低收益大。**

### 🟠 P1 记忆可解释性
- OpenClaw 有 Memory wiki（用户可读）+ Active Memory + Dreaming（离线整理）。
- 灵犀三件套是黑盒。**行动：做记忆可视化面板。**

### 🟡 P2 实时语音通话
- OpenClaw 有实时语音（流式+入呼+会议插件）。灵犀只有 TTS/STT。

### 🟡 P2 搜索 provider 广度
- 3 vs 20+。灵犀搜索弱是老问题（v1 报告已记录"只返回营销页"）。

### 🟢 P3 技术债
- index.ts 4861 行等巨石文件（灵犀自己报告承认）。OpenClaw 是 pnpm workspace 多包仓库。

---

## 四、灵犀护城河（保留，但缩水）

1. **自建 IM 产品形态**——真人+AI 同群，OpenClaw 架构（寄生网关）做不到。这是真护城河。
2. **243 条可复现 benchmark**——OpenClaw 无公开数据，选型背书独有。
3. **原生中文产品**——OpenClaw 文档有中文但产品英文向。
4. ~~多 Agent 协作模式~~ → 降级：OpenClaw 有同级能力（Swarm/ACP/并行专家），灵犀 6 模式仍是特色但非独有。
5. ~~中文渠道~~ → 删除：OpenClaw 有 Feishu/QQ/WeChat/WeCom 文档。

---

## 五、行动建议（修订版）

| 优先级 | 行动 | 理由 |
|---|---|---|
| 1 | **onboarding 向导**（启动时检测 .env/Key/模型连通性，失败给修复指引） | 410 错误直接打蒙用户，第一小时定生死 |
| 2 | **浏览器默认可用**（默认装 puppeteer 或 setup 命令） | 工具已写好，差临门一脚 |
| 3 | **webhook 触发器**（补齐主动自动化） | 成本最低的能力跃迁 |
| 4 | **记忆可视化面板** | 对齐 Memory wiki 的可解释性 |
| 5 | 修图片粘贴即发送 bug + 多模态识别 | 已知缺陷清零 |
| 6 | Linux 一键部署 + install.sh | 对齐安装体验 |
| 7 | 社区运营（Discussions+贡献指南激活） | 长期飞轮 |
| 8 | 考虑把 475 个同质 skills 精修为 10 个旗舰 | 以一当百 |

## 六、一句话总结

**OpenClaw 是基金会治理、生态完整的"个人助理操作系统"；灵犀是工程扎实、可自证但单兵作战的"AI 原生 IM 平台"。**
真实差距不在功能数量（浏览器工具灵犀其实有），而在：**① 治理形态 ② 开箱体验 ③ 默认可用性**。
好消息是 ②③ 是工程问题，一两周能补；坏消息是 ① 是时间+运营问题，急不来。
灵犀的胜负手是把自己的护城河（真人+AI 同群 IM、benchmark 自证、中文原生）打透，而不是在 OpenClaw 的主场（渠道数量、插件市场）硬拼。
