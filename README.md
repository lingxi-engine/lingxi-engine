# 🐿️ LingXi Engine

[English](README.md) | [简体中文](README.zh-CN.md)

> **AI-Native Instant Messaging Platform** — every user gets a bound AI agent; in every conversation, humans and AI are present together.

[![License](https://img.shields.io/github/license/lingxi-engine/lingxi-engine?color=blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-24%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

---

## ✨ Features

- 🤖 **Two-way Human ↔ Agent Chat** — every user has their own AI avatar; agents coexist with humans in group chats
- 🧠 **Visible Reasoning** — streaming chain-of-thought for reasoning models like DeepSeek R1 / OpenAI o1
- 🔧 **Rich Tool System** — web_search / code_execute / shell_exec / file I/O / time & math
- 🛡️ **Secure Sandbox** — code and shell execution isolated in Docker, on by default
- 📦 **Zero-dependency Frontend** — single-file HTML (1,811 lines); no React/Vue needed
- 🔌 **Multi-channel** — Telegram / Signal / iMessage adapters built in
- 🌐 **Multi-provider AI** — OpenAI / DeepSeek / NVIDIA NIM / Ollama, plug and play
- ⏰ **Cron Scheduling** — IANA timezone support + disk persistence
- 💾 **SQLite Storage** — zero-config local database
- 🔒 **JWT Auth** — access tokens + rolling refresh tokens
- 📡 **WebSocket Realtime** — streaming output + tool-call progress broadcasts

## 🚀 Quick Start

```bash
# 1. Clone and install
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install

# 2. Configure API keys
cp .env.example .env
# Edit .env — configure at least one provider

# 3. Start
npm start
# Open http://localhost:3456
```

**Simplest provider setup**:

| Provider | Env Variable | Cost | Reasoning Support |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | Cheap | ✅ R1 chain-of-thought |
| NVIDIA NIM | `NVIDIA_API_KEY` | Free tier | ❌ |
| Ollama | No key needed | Free (GPU required) | Depends on model |

## 📋 Requirements

| Dependency | Version | Required |
|---|---|---|
| Node.js | 18+ (24+ recommended) | ✅ |
| npm | 9+ | ✅ |
| Docker | any | Optional (sandbox isolation) |
| Ollama | any | Optional (local models) |

## 🏗 Architecture

```
index.ts (1,849 lines)      ← HTTP + WebSocket main entry
├── src/ai/                 ← AI access (RedisHub + ProviderRegistry)
├── src/agents/             ← Agent lifecycle (create/delete/switch models)
├── src/auth/               ← JWT + bcrypt authentication
├── src/core/
│   ├── router.ts           ← Message routing + tool-call loop
│   ├── cron-scheduler.ts   ← Cron jobs + IANA timezones + persistence
│   ├── docker-sandbox.ts   ← Docker sandbox isolation
│   ├── hooks.ts            ← Programmable hook system
│   ├── inbox.ts            ← In-app notifications
│   ├── compaction.ts       ← Context compaction
│   ├── memory-reflector.ts ← Memory reflection
│   ├── push.ts             ← APNs + FCM push
│   ├── session-manager.ts  ← Session lifecycle
│   └── ws-handler.ts       ← WebSocket protocol handling
├── src/tools/
│   ├── builtin.ts          ← 15 built-in tools + Docker sandbox integration
│   ├── executor.ts         ← Tool-call loop
│   ├── search-providers.ts ← Web search (3 providers)
│   ├── auto-skill.ts       ← Auto skill learning
│   └── registry.ts         ← Tool registry
├── src/middleware/
│   ├── jwt-auth.ts         ← JWT auth (required/optional)
│   ├── admin-auth.ts       ← Admin token auth (fail-secure)
│   └── rate-limit.ts       ← In-memory rate limiting (X-Forwarded-For)
├── src/storage/db.ts       ← SQLite (better-sqlite3)
├── src/channels/           ← Telegram / Signal / iMessage adapters
├── src/voice/              ← TTS + STT
└── web/index.html          ← Single-file frontend (1,811 lines)
```

## 🔒 Security

15 security vulnerabilities fixed since v1.0.0 (see [CHANGELOG](CHANGELOG.md)):

- ✅ Global JWT auth fallback
- ✅ Admin token protection (fail-secure)
- ✅ Docker sandbox isolation (shell_exec + code_execute)
- ✅ Command whitelist for shell_exec
- ✅ safePath constraints on file operations
- ✅ Anonymous WebSocket connections rejected in production
- ✅ Slack webhook signature verification
- ✅ Backup files (.bak) blocked from public download
- ✅ Path-traversal protection in auto-skill naming
- ✅ signal.ts exec → execFile (command injection fix)

## 🤝 Contributing

Pull requests welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm run dev        # dev mode with hot reload
npm run typecheck  # type check (must pass)
```

## 📄 License

MIT License — see [LICENSE](LICENSE).


## 🔐 安全配置（生产部署必读）

- 仓库中只有不含真实凭据的 `.env.example`；真实密钥放本地 `.env`（已被 .gitignore 排除），绝不提交。
- 生产环境（`DEV_MODE=false`）启动时强制校验，缺失或弱默认值将**拒绝启动**：

| 变量 | 用途 | 生成方式 |
|---|---|---|
| `JWT_SECRET` | 登录令牌签名密钥 | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_TOKEN` | 管理员令牌 | `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"` |
| `MESH_TOKEN` | 多机组网令牌（多机必须一致） | 同上（32 字节） |

- 开发模式缺失的密钥自动生成并持久化到数据目录（主引擎 `data/.secrets.json`、移动端 `.mobile-secrets.json`，权限 0600），重启复用，不打印到日志。
- 密码使用 bcrypt 哈希存储与校验；WebSocket 匿名连接仅限本机回环，生产模式拒绝未认证连接。
