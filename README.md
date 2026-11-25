# 🐿️ LingXi Engine · 灵犀引擎

> **AI-Native 即时通讯平台** — 每个用户绑定一个 AI 智能体，对话时真人与 AI 同在

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![CI](https://github.com/lingxi-engine/lingxi-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/lingxi-engine/lingxi-engine/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-602%20passing-brightgreen)](https://github.com/lingxi-engine/lingxi-engine/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-18%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![Version](https://img.shields.io/badge/version-2.0.43-orange)](CHANGELOG.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## ✨ 特性

- 🤖 **AI Agent 双向对话** — 每个用户自带 AI 分身，群聊中真人与 Agent 共存
- 🧠 **推理过程可视化** — 支持 DeepSeek R1 / OpenAI o1 等推理模型的思考链流式展示
- 🔧 **56 个内置工具** — web_search / code_execute / shell_exec / 文件读写 / 时间计算 / Git 操作 / 子代理委派 / 多模型协作
- 🛡️ **安全沙箱** — Docker 隔离执行代码和命令，**需显式开启**（见下方说明）
- 📦 **零依赖前端** — 单文件 HTML，无需 React/Vue
- 🔌 **9 个消息渠道** — Telegram / Signal / iMessage / Discord / Slack / WhatsApp / 飞书 / 企业微信 / QQ Bot
- 🌐 **多 AI Provider** — OpenAI / DeepSeek / NVIDIA NIM / Ollama 即插即用
- ⏰ **Cron 定时任务** — 带时区支持 + 磁盘持久化
- 💾 **SQLite 存储** — 零配置本地数据库（sql.js，WASM 实现）
- 🔒 **JWT 认证** — access token + 刷新令牌滚动刷新
- 📡 **WebSocket 实时推送** — 流式输出 + 工具调用进度广播
- 🧩 **MCP 支持** — 通过 `src/mcp/adapter.ts` 接入外部 Model Context Protocol 服务
- 📱 **移动端 App** — `mobile-app/` 提供 Android / iOS 客户端（v1.2.0）
- 🐍 **Python 自主引擎** — `lingxi_engine/` 独立 Python 子系统（记忆 / 元认知 / 议会 / 沙箱 / 群体智能）

## 🚀 快速开始

```bash
# 1. 克隆并安装
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install

# 2. 配置 API Key
cp .env.example .env
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
| Ollama | 无需 Key | 免费 (需 GPU) | 取决于模型 |

### ⚠️ 关于安全沙箱

Docker 沙箱**默认关闭**（v1.9.7 起改为显式开启）。未开启时 `shell_exec` / `code_execute`
直接在宿主机执行，仅靠命令白名单和 `safePath` 约束。

```bash
# 开启沙箱隔离（推荐生产环境启用）
echo "SANDBOX_ENABLED=true" >> .env
```

未安装 Docker 时会打印降级警告并继续运行。生产部署请务必开启。

## 📋 环境要求

| 依赖 | 版本 | 必须 |
|---|---|---|
| Node.js | 18+ (推荐 24+) | ✅ |
| npm | 9+ | ✅ |
| Docker | 任意 | 可选 (沙箱隔离，需 `SANDBOX_ENABLED=true`) |
| Ollama | 任意 | 可选 (本地模型) |
| Python 3.11+ | 仅跑 `lingxi_engine/` 回归测试时需要 | 可选 |

## 🏗 架构

```
index.ts (4468 行)                    ← HTTP + WebSocket 主入口
├── src/ai/                           ← AI 接入 (RedisHub + ProviderRegistry + 故障转移)
├── src/agents/                       ← Agent 生命周期 (创建/删除/模型切换)
├── src/auth/                         ← JWT + bcrypt 认证
├── src/core/
│   ├── router.ts                     ← 消息路由 + 工具调用循环
│   ├── cron-scheduler.ts             ← 定时任务 + IANA时区 + 持久化
│   ├── docker-sandbox.ts             ← Docker 沙箱隔离
│   ├── hooks.ts                      ← 可编程钩子系统
│   ├── inbox.ts                      ← 站内通知
│   ├── compaction.ts                 ← 上下文压缩
│   ├── memory-reflector.ts           ← 记忆反思
│   ├── push.ts                       ← APNs + FCM 推送
│   ├── session-manager.ts            ← 会话生命周期
│   ├── ws-handler.ts                 ← WebSocket 协议处理
│   ├── subagent-manager.ts           ← 子代理派生与结果回收
│   ├── autonomy.ts                   ← 自主任务执行
│   ├── retry-coordinator.ts          ← 统一自动重试
│   └── watchdog.ts                   ← 进程守护
├── src/tools/
│   ├── builtin.ts                    ← 56 个内置工具 + Docker沙箱集成
│   ├── executor.ts                   ← 工具调用循环 (默认 50 轮工具循环)
│   ├── search-providers.ts           ← Web 搜索 (多 Provider)
│   ├── auto-skill.ts                 ← 自动技能学习
│   └── registry.ts                   ← 工具注册表
├── src/memory/                       ← 记忆系统 (事实冲突检测 / 语义去重 / 写入集成)
├── src/mcp/adapter.ts                ← MCP 协议适配
├── src/middleware/
│   ├── jwt-auth.ts                   ← JWT 鉴权 (required/optional)
│   ├── admin-auth.ts                 ← Admin Token 鉴权 (fail-secure)
│   └── rate-limit.ts                 ← 内存限流 (X-Forwarded-For)
├── src/storage/db.ts                 ← SQLite (sql.js) 数据库
├── src/channels/                     ← 9 个渠道适配 (discord/feishu/imessage/qqbot/signal/slack/telegram/wechat/whatsapp)
├── src/voice/                        ← TTS + STT
├── src/cli/chat.ts                   ← CLI 客户端 (bin: lingxi)
└── web/index.html                    ← 前端单文件 (1129 行)
```

### 长任务预算

| 配置项 | `.env` | `.env.example` | 说明 |
|---|---|---|---|
| `TASK_TIMEOUT_SECONDS` | 7200（2 小时） | 1200（20 分钟） | 单任务最长执行时间 |
| 工具循环轮数 | 50 轮（代码硬编码，`executor.ts` 默认值） | — | 超出即强制收尾 |

> `.env` 与 `.env.example` 的超时值不同：前者是开发机实测配置，后者是给新用户的保守默认值。
> 如需长任务，自行调大 `TASK_TIMEOUT_SECONDS`。

## 🔒 安全

修复了从 v1.0.0 的 15 个安全漏洞 (详见 [CHANGELOG](CHANGELOG.md))：

- ✅ 全局 JWT 鉴权兜底
- ✅ Admin Token 防护 (fail-secure)
- ✅ Docker 沙箱隔离 (shell_exec + code_execute)，**需 `SANDBOX_ENABLED=true`**
- ✅ shell_exec 命令白名单
- ✅ 文件操作 safePath 约束
- ✅ WebSocket 生产环境拒绝匿名连接
- ✅ Slack webhook 签名校验
- ✅ 备份文件 (.bak) 阻止公开下载
- ✅ auto-skill 名称路径穿越防护
- ✅ singal.ts exec → execFile (命令注入修复)

## 🔄 升级与发布

### 两条升级路径，机制完全不同

| 路径 | 实际行为 | 适用场景 |
| --- | --- | --- |
| **管理后台点「🔄 一键升级到最新版」** | `POST /api/update` → `git pull --ff-only` → `npm install` → 重启。**仅管理员**（否则 403）。部署目录没有 `.git` 时直接返回 `ok:false` 并提示改用 install.ps1 | git clone 部署 |
| **`irm http://<SERVER_IP>:8080/install.ps1 \| iex`** | 从 `http://<SERVER_IP>:8080/public/lingxi-engine.tar.gz` 下载安装包，`robocopy /E /IS /IT` 覆盖到 `%USERPROFILE%\lingxi-engine`，`npm install`，结束 3456 端口进程后重启 | tar 包部署 / 全新安装 |

> ⚠️ **install.ps1 是镜像覆盖，不是 merge。** 它会用包内文件盖掉目标目录同名文件（不删除多余文件）。
> 部署目录里的本地改动可能被覆盖回旧版——这是「工作区被拽回旧版本」的成因。
> `.env` 会被检测并跳过，`data/` 不受影响。

### 版本对齐检查

```powershell
# 对比本地与线上版本，不上传任何东西（安全，建议发布前先跑）
powershell -ExecutionPolicy Bypass -File scripts/publish-site.ps1 -CheckOnly
```

输出示例（版本脱节时）：

```
[INFO] local version: 2.0.25 (commit 37c0eec)
[INFO] live version: 2.0.23
[WARN] VERSION DRIFT: local 2.0.25 vs live 2.0.23
[WARN] -> users running irm http://<SERVER_IP>:8080/install.ps1 | iex will install the stale 2.0.23
```

### 发布到官网

```powershell
# 1) 无凭证 / 只想要产物：打包并打印待上传清单
powershell -ExecutionPolicy Bypass -File scripts/publish-site.ps1 -Method manual

# 2) 有 SSH 访问：打包 + 上传 + 自动自检
$env:LINGXI_DEPLOY_HOST = '<SERVER_IP>'
$env:LINGXI_DEPLOY_USER = '<你的用户名>'
$env:LINGXI_DEPLOY_PATH = '/var/www/lingxi/public'
powershell -ExecutionPolicy Bypass -File scripts/publish-site.ps1 -Method scp
```

凭证一律走环境变量，**脚本内不写死任何密码、Token 或私钥**：

| 变量 | 说明 |
| --- | --- |
| `LINGXI_DEPLOY_HOST` | 服务器地址（默认 `<SERVER_IP>`） |
| `LINGXI_DEPLOY_USER` | SSH / FTP 用户名 |
| `LINGXI_DEPLOY_PORT` | SSH 端口（默认 `22`） |
| `LINGXI_DEPLOY_PATH` | 服务器上 `public/` 的绝对路径 |
| `LINGXI_DEPLOY_KEY` | SSH 私钥路径（可选） |

上传产物只有两个文件：`lingxi-engine.tar.gz` 和 `version.txt`。
脚本会在上传后自动回读 `public/version.txt` 校验版本是否生效。

> 注意：`scripts/publish-site.ps1` 与 `pack-release.ps1` 均为 **ASCII-only** 文件。
> PowerShell 在中文系统上会把无 BOM 的 UTF-8 `.ps1` 按 GBK 解析，导致中文注释变成乱码甚至语法错误。

## 🧪 测试

```bash
npm run typecheck   # TypeScript 类型检查 (必须通过)
npm test            # Vitest 单元测试
npm run verify:deploy  # 部署校验

# README 数字一致性门禁（工具数/渠道数/沙箱默认值/循环轮数/超时值）
npx tsx scripts/check-docs.mts

# Python 自主引擎回归 (152 项断言)
cd lingxi_engine/tests && python run_all.py
```

CI 分三个 job：`python-engine`（152 断言）、`ts-engine`（typecheck + vitest）、`hygiene-check`（BOM / 垃圾文件 / 巨石行数棘轮 / shell LF）。

## 🤝 贡献

欢迎 Pull Request。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
npm run dev        # 开发模式 (热重载)
npm run typecheck  # 类型检查 (必须通过)
```

改代码时请顺手跑 `npx tsx scripts/check-docs.mts`——README 里的工具数、渠道数、
沙箱默认值、循环轮数、超时值都是写死的数字，代码一改就会说谎。

## 📄 许可证

MIT License — 详见 [LICENSE](LICENSE)。

---

## 🐳 Docker 自部署

不想装 Node？用容器一条命令跑起来：

```bash
cp .env.example .env   # 填入至少一个 API Key
docker compose up -d
# 打开 http://localhost:3456
```

数据持久化在命名卷中，升级不丢数据。详见 [docs/docker.md](docs/docker.md)。

## 🌍 English Docs

- English README: [README.en.md](README.en.md)
- Bilingual quick start: [docs/quickstart.md](docs/quickstart.md)
- Docker guide: [docs/docker.md](docs/docker.md)
- Remote access (phone / Hub): [docs/remote-access.md](docs/remote-access.md)
- Security policy: [SECURITY.md](SECURITY.md) · Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## 📊 可观测性

引擎内置 Prometheus 风格指标：`GET /metrics`（HTTP 请求数/耗时、AI 调用数、token 用量）。
访问控制：可信本机来源直接放行，远程需 `X-Admin-Token`；`METRICS_ENABLED=false` 可关闭。


## 📱 手机远程控制

手机 App 是「遥控器」：算力永远在你自己的电脑上。三种连接方式（App v1.4.0 全部内置）：

1. **局域网直连**：同一 Wi-Fi 下 App 自动扫描发现引擎（UDP 灯塔 + 网段探测），点一下即连，零配置。
2. **官方连接 Hub**：`lingxi-engine.com` 自 v2.0.43 起是纯连接 Hub（`HUB_ONLY=1`）——只做账号登录、设备目录、反向中继，**云端不跑 AI、不存聊天数据**。手机与电脑登录同一账号后，人在外面也能一键接管家里电脑，无需公网 IP / 端口映射。
3. **自建 Hub / 纯离线**：任何服务器 `HUB_ONLY=1` 即可自建；`LINGXI_HUB_URL=off` 纯局域网或 Tailscale 组网。

详见 [docs/remote-access.md](docs/remote-access.md)。