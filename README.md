# 🐿️ LingXi Engine · 灵犀引擎

> **AI-Native 即时通讯平台** — 每个用户绑定一个 AI 智能体，对话时真人与 AI 同在

[![License](https://img.shields.io/github/license/lingxi-engine/lingxi-engine?color=blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-18%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![Bench](https://img.shields.io/badge/bench-100%25%20tier--1-success)](bench/results/REPORT.md)

---

## ✨ 特性

- 🤖 **AI Agent 双向对话** — 每个用户自带 AI 分身，群聊中真人与 Agent 共存
- 🧠 **推理过程可视化** — 支持 DeepSeek R1 / OpenAI o1 等推理模型的思考链流式展示
- 🧰 **56 个内置工具** — 文件读写、Shell、Git、代码执行、搜索、图像分析、定时任务、HTTP、子代理协作
- 🧠 **长任务自治** — 50 轮工具循环、2 小时任务预算、6 种可区分的停机原因
- 🗜️ **上下文压缩** — 30K token 触发，保留最近 10 条，摘要失败自动降级
- 🎯 **目标追踪 + 子代理** — `goal-tracker` / `goal-executor` / `subagent-manager`（763 行）
- 💭 **记忆系统** — 反思（reflector）/ 检索（search）/ 衰减（decay）三件套，跨会话持久
- 🧪 **可验证评测** — 内置两档 benchmark，Tier-1 确定性免费，Tier-2 真跑模型
- 📡 **9 个消息渠道** — Telegram / Signal / iMessage / Discord / Slack / 飞书 / QQ / 微信 / WhatsApp（+ manager 统一编排）
- 🌐 **多 AI Provider** — OpenAI / DeepSeek / NVIDIA NIM / Ollama / 智谱 GLM / 自定义接入
- ⏰ **Cron 定时任务** — IANA 时区支持 + 磁盘持久化
- 💾 **零配置存储** — SQLite (sql.js)，无需安装数据库
- 🔒 **JWT 认证** — access token + 刷新令牌滚动刷新
- 📡 **WebSocket 实时推送** — 流式输出 + 工具调用进度广播

## 🚀 快速开始

```bash
# 1. 克隆并安装
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install

# 2. 配置 API Key
cp .env.template .env
# 编辑 .env，至少配置一个 Provider

# 3. 启动
npm start
# 打开 http://localhost:3456
```

**最简单的配置思路**：

| Provider | 环境变量 | 价格 | 推理过程支持 |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | 便宜 | ✅ R1 推理链 |
| NVIDIA NIM | `NVIDIA_API_KEY` | 免费额度 | ❌ |
| Ollama | 无需 Key | 免费（需本地模型） | 取决于模型 |

> 全本地运行：配 `OLLAMA_BASE_URL` + `DEFAULT_MODEL`，数据完全不出境。

## 📋 环境要求

| 依赖 | 版本 | 必须 |
|---|---|---|
| Node.js | 18+（推荐 24+） | ✅ |
| npm | 9+ | ✅ |
| Docker | 任意 | 可选（沙箱隔离） |
| Ollama | 任意 | 可选（本地模型） |

## 🛡️ 安全沙箱

> ⚠️ **v1.9.7 起，沙箱默认关闭。** 需要显式设置 `SANDBOX_ENABLED=true` 才会开启。

未开启沙箱时：

- `shell_exec` / `code_execute` 在 Docker 不可用的情况下**回退到宿主机执行**
- 文件工具不受 workspace 目录约束

**本机个人使用**：默认配置即可，Agent 需要访问本地 Ollama。
**公网 / 多用户部署**：务必设置 `SANDBOX_ENABLED=true` 或确保 Docker 运行。

## 🧪 Benchmark

两档评测，命令统一：

```bash
npm run bench:fast      # Tier-1：确定性、免费、不烧 token，可作 CI 门禁
npm run bench           # Tier-1 + Tier-2（真跑 LLM）
npm run bench:agentic   # 仅 Tier-2
```

| 档位 | 覆盖 | 判定 |
|---|---|---|
| **Tier 1** | 工具契约、长任务预算、子系统存在性、SSRF 策略 | 确定性，退出码 0 要求 100% |
| **Tier 2** | 工具选择、多步执行、指令遵循、错误恢复、诚实性 | 真模型，退出码 0 要求 ≥70% |

**没有 LLM 裁判。** 每条 Tier-2 断言都由机器验证：文件字节、回复正则、数值相等、工具调用轨迹。换个模型跑，分数会诚实地变，不会因为措辞漂移。

诚实性也计分：模型若编造彩票号码、或对「2+2」乱调工具，都会扣分。

详见 [bench/README.md](bench/README.md) 与 [bench/results/REPORT.md](bench/results/REPORT.md)。

## 🏗 架构

```
index.ts (4861 行 / 244KB)     ← HTTP + WebSocket 主入口
├── src/ai/ (1716 行)          ← Provider 注册表 / Hub / 视觉
├── src/agents/                ← Agent 生命周期
├── src/auth/ (485 行)         ← JWT + bcrypt
├── src/channels/ (1790 行)    ← 9 个 IM 渠道适配
├── src/core/ (13484 行, 44 文件)
│   ├── router.ts              ← 消息路由 + 工具调用循环
│   ├── orchestrator.ts        ← 任务编排
│   ├── goal-tracker.ts        ← 目标追踪
│   ├── goal-executor.ts       ← 目标执行 (531 行)
│   ├── subagent-manager.ts    ← 子代理管理 (763 行)
│   ├── memory-reflector.ts    ← 记忆反思
│   ├── memory-search.ts       ← 记忆检索
│   ├── memory-decay.ts        ← 记忆衰减
│   ├── compaction.ts          ← 上下文压缩 (30K/保留10)
│   ├── context-roller.ts      ← 上下文滚动
│   ├── critic.ts              ← 自我批评
│   ├── debate.ts              ← 多模型辩论
│   ├── world-model.ts         ← 世界模型
│   ├── dreamer.ts             ← 推演
│   ├── team-manager.ts        ← 团队协作
│   ├── rag-engine.ts          ← RAG 引擎
│   ├── watchdog.ts            ← 看门狗
│   ├── evaluator.ts           ← 评测记录
│   └── cron-scheduler.ts      ← 定时任务 + IANA 时区
├── src/tools/ (4710 行)
│   ├── builtin.ts             ← 56 个内置工具
│   ├── executor.ts            ← 50 轮工具循环
│   ├── search-providers.ts    ← Web 搜索多 Provider 降级
│   ├── docker-sandbox.ts      ← Docker 沙箱
│   ├── auto-skill.ts          ← 自动技能学习
│   └── registry.ts            ← 工具注册表
├── src/routes/ (5663 行, 27 文件)
├── src/storage/               ← SQLite (sql.js)
├── src/middleware/            ← JWT / Admin / 限流
├── src/mcp/                   ← MCP 协议支持
└── web/ (18301 行, 23 文件)   ← 零依赖前端
```

## 🔒 安全

修复了从 v1.0.0 的 15 个安全漏洞（详见 [CHANGELOG](CHANGELOG.md)）：

- ✅ 全局 JWT 鉴权兜底
- ✅ Admin Token 防护（fail-secure）
- ✅ shell_exec 命令白名单
- ✅ 文件操作 safePath 约束
- ✅ WebSocket 生产环境拒绝匿名连接
- ✅ Slack webhook 签名校验
- ✅ 备份文件（`.bak`）阻止公开下载
- ✅ auto-skill 名称路径穿越防护
- ✅ `signal.ts` exec → execFile（命令注入修复）
- ✅ SSRF 防护：拦截云元数据端点（AWS/GCP/Azure/阿里云）

> **SSRF 策略说明**：Agent 运行在用户本机，必须能访问本地 Ollama 和局域网服务，
> 因此**放行 localhost 与 RFC1918 网段**，只拦截云元数据端点以防 IAM 凭据窃取。
> 若要部署到公网多用户环境，请自行评估并收紧该策略（`src/tools/builtin.ts` 的 `isSsrfSafeUrl`）。

## 🔄 升级与发布

### 两条升级路径，机制完全不同

| 路径 | 实际行为 | 适用场景 |
| --- | --- | --- |
| **管理后台「🔄 一键升级」** | `POST /api/update` → `git pull --ff-only` → `npm install` → 重启。**仅管理员**（否则 403）。无 `.git` 时返回 `ok:false` 并提示改用 install.ps1 | git clone 部署 |
| **`irm http://47.93.157.83:8080/install.ps1 \| iex`** | 下载 `public/lingxi-engine.tar.gz`，`robocopy /E /IS /IT` 覆盖到 `%USERPROFILE%\lingxi-engine`，`npm install`，结束 3456 端口进程后重启 | tar 包部署 / 全新安装 |

> ⚠️ **install.ps1 是镜像覆盖，不是 merge。** 它用包内文件盖掉目标目录同名文件（不删除多余文件）。
> 本地改动可能被覆盖回旧版——这是「工作区被拽回旧版本」的成因。
> `.env` 会被检测并跳过，`data/` 不受影响。

### 版本对齐检查

```powershell
powershell -ExecutionPolicy Bypass -File scripts/publish-site.ps1 -CheckOnly
```

### 发布到官网

```powershell
powershell -ExecutionPolicy Bypass -File scripts/publish-site.ps1 -Method manual
$env:LINGXI_DEPLOY_HOST = '47.93.157.83'
$env:LINGXI_DEPLOY_USER = '<你的用户名>'
powershell -ExecutionPolicy Bypass -File scripts/publish-site.ps1 -Method scp
```

凭证一律走环境变量，**脚本内不写死任何密码、Token 或私钥**：

| 变量 | 说明 |
| --- | --- |
| `LINGXI_DEPLOY_HOST` | 服务器地址（默认 `47.93.157.83`） |
| `LINGXI_DEPLOY_USER` | SSH / FTP 用户名 |
| `LINGXI_DEPLOY_PORT` | SSH 端口（默认 `22`） |
| `LINGXI_DEPLOY_PATH` | 服务器上 `public/` 的绝对路径 |
| `LINGXI_DEPLOY_KEY` | SSH 私钥路径（可选） |

> 注意：`scripts/publish-site.ps1` 与 `pack-release.ps1` 均为 **ASCII-only** 文件。
> PowerShell 在中文系统上会把无 BOM 的 UTF-8 `.ps1` 按 GBK 解析，导致中文注释乱码或语法错误。

## 🤝 贡献

欢迎 Pull Request。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
npm run dev        # 开发模式（热重载）
npm run typecheck  # 类型检查（必须通过）
npm run bench:fast # 提交前跑一遍确定性测试（免费）
npm test           # vitest 单元测试
```

## 📄 许可证

MIT License — 详见 [LICENSE](LICENSE)。
