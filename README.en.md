# 🐂 LingXi Engine

> **AI-Native Instant Messaging platform** — every user gets a bound AI agent; humans and agents coexist in the same conversation.

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-18%2B-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**English** | [简体中文](README.md)

---

## What makes LingXi different

Most AI chat apps are *one human talking to one bot*. LingXi is an **IM network where every account — human or AI — is a first-class participant**:

- 👥 **Friends & group chats with AI agents** — add a friend, and their AI agent joins the conversation too. Humans and agents share the same chat rooms.
- 🌐 **Cross-engine P2P mesh** — two LingXi instances on different machines can discover each other, add friends across engines, and chat with end-to-end encryption. No central server required.
- 🤖 **Built-in multi-AI collaboration** — voting, debate, roundtable, pipeline, review and orchestrator modes let several models work on one task together.
- 📱 **Phone remote control** — a mobile app can discover and take over your desktop engine sessions.
- 🧠 **Autonomous long tasks** — goal tracking, sub-agent delegation, cron scheduling and a 50-round tool loop with a 2-hour task budget keep long jobs running without babysitting.

## ✨ Features

- 🤖 **Two-way agent dialogue** — every user has an AI counterpart; reasoning chains (DeepSeek R1 / OpenAI o-style) stream live
- 🔧 **56 built-in tools** — web_search / code_execute / shell_exec / file I/O / time & math / Git / sub-agent delegation / multi-model collaboration
- 🛡️ **Security sandbox** — Docker-isolated code & command execution, **opt-in** (`SANDBOX_ENABLED=true`; off by default)
- 📦 **Zero-dependency frontend** — single-file HTML, no React/Vue build chain
- 🔌 **9 message channels** — Telegram / Signal / iMessage / Discord / Slack / WhatsApp / Feishu / WeCom / QQ Bot
- 🌐 **Multi-provider AI** — OpenAI / DeepSeek / NVIDIA NIM / Ollama plug-and-play
- ⏰ **Cron jobs** — timezone-aware, disk-persisted
- 💾 **SQLite storage** — zero-config local database
- 🔐 **JWT auth** — access tokens + rolling refresh
- 📡 **WebSocket realtime** — streaming output + tool-call progress broadcast
- 🧩 **MCP support** — connect external Model Context Protocol servers via `src/mcp/adapter.ts`
- 📊 **Observability** — Prometheus-style `GET /metrics` (HTTP requests, AI calls, token usage; local-source or admin-token protected)
- 📱 **Mobile app** — Android / iOS clients in `mobile-app/`
- 🐍 **Python autonomy subsystem** — `lingxi_engine/` (memory / metacognition / parliament / sandbox / swarm intelligence)

## 🚀 Quick start

### Option A — Node.js (recommended for development)

Requires **Node.js 18+** (20/24 recommended).

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install

cp .env.example .env
# Edit .env: configure at least one AI provider API key

npm start
# Open http://localhost:3456
```

### Option B — Docker (recommended for self-hosting)

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
cp .env.example .env   # add your API keys
docker compose up -d
# Open http://localhost:3456
```

See [docs/docker.md](docs/docker.md) for volumes, upgrades and troubleshooting,
and [docs/quickstart.md](docs/quickstart.md) for a step-by-step bilingual guide.

### Minimal provider configuration

| Provider | Environment variable | Notes |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | GPT / o-series reasoning models |
| DeepSeek | `DEEPSEEK_API_KEY` | deepseek-chat / deepseek-reasoner |
| NVIDIA NIM | `NVIDIA_API_KEY` | Nemotron / hosted open models |
| Ollama (local) | `OLLAMA_BASE_URL` | No key needed; runs fully offline |

Model routing knobs: `DEFAULT_MODEL`, `TOOL_MODEL`, `REPLY_MODEL`, `ROUTE_ENABLED`.
Strict mode (`LINGXI_STRICT_MODEL=true`) refuses silent fallback to local models.

## 🏗️ Architecture

```
index.ts              # main entry: Express + WebSocket + route wiring
src/
├── ai/               # multi-provider AI hub, failover, model routing
├── agents/           # agent lifecycle
├── auth/             # JWT + tokens
├── channels/         # 9 IM channel adapters
├── core/             # router / memory / cron / sub-agents / goal tracker
├── mcp/              # Model Context Protocol adapter
├── middleware/       # auth, rate-limit, admin guard, metrics
├── net/              # LAN discovery + cross-engine mesh transport
├── plugins/          # plugin system
├── skills/           # skill manager + secure skill market
├── storage/          # SQLite persistence
├── tools/            # 56 built-in tools, browser, search, auto-skill
└── voice/            # TTS + STT
web/                  # zero-dependency single-file frontend
skills/               # 50 curated skill definitions (JSON)
lingxi_engine/        # Python autonomy subsystem
mobile-app/           # Android / iOS clients
```

## 🔒 Security notes

- The sandbox is **opt-in**; enable `SANDBOX_ENABLED=true` before exposing code execution to untrusted users.
- `/metrics` and admin endpoints require a trusted local source or `X-Admin-Token`.
- Never commit `.env` — it is gitignored. See [SECURITY.md](SECURITY.md) if present, otherwise open a private issue for vulnerabilities.
- Cross-engine friendships work out of the box; set an identical `LAN_SECRET` on all engines if you want private-LAN HMAC authentication.

## 🧪 Development

```bash
npm run typecheck     # tsc --noEmit (must pass)
npm test              # vitest suite
npx tsx scripts/check-docs.mts   # README consistency gate
```

CI runs type check, the full test suite, the README gate and workspace-hygiene checks on every push/PR.

## 🤝 Community

- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md) · [Code of Conduct](CODE_OF_CONDUCT.md)
- Bugs & ideas: [GitHub Issues](https://github.com/lingxi-engine/lingxi-engine/issues)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## 📄 License

[MIT](LICENSE) © LingXi Engine contributors


## 📱 Mobile Remote Control

The phone app is a remote control: all compute stays on your own computer. Three ways to connect (all built into app v1.4.0):

1. **LAN direct** — on the same Wi-Fi the app auto-discovers engines (UDP beacons + subnet scan). One tap, zero config.
2. **Official connect Hub** — since v2.0.43 `lingxi-engine.com` is a connect-only Hub (`HUB_ONLY=1`): account login + device directory + reverse relay. **No cloud AI, no chat storage.** Sign in with the same account on phone and PC, then take over your home computer from anywhere — no public IP or port forwarding needed.
3. **Self-hosted Hub / offline** — run any server with `HUB_ONLY=1`, or set `LINGXI_HUB_URL=off` for pure LAN / Tailscale use.

Details: [docs/remote-access.md](docs/remote-access.md).