# Quick Start · 快速入门

[English](#english) | [简体中文](#简体中文)

---

## English

Get LingXi Engine running in ~5 minutes.

### 1. Prerequisites

| Path | Requirement |
|---|---|
| Node.js | v18+ (v20/v24 recommended), npm 9+ |
| Docker | Docker Engine 20+ with Compose v2 (only for the Docker path) |
| AI provider | At least one API key: OpenAI / DeepSeek / NVIDIA NIM — or a local Ollama |

### 2. Install & configure

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install

cp .env.example .env
```

Edit `.env` and set **at least one** provider:

```env
# pick one (or more)
DEEPSEEK_API_KEY=sk-...
OPENAI_API_KEY=sk-...
NVIDIA_API_KEY=nvapi-...

# optional: fully local, no key needed
# OLLAMA_BASE_URL=http://127.0.0.1:11434

# model routing (defaults are fine to start)
DEFAULT_MODEL=deepseek-chat
ROUTE_ENABLED=true
```

### 3. Run

```bash
npm start
```

Open **http://localhost:3456**, register the first account (it becomes the admin), and start chatting. Your AI agent is bound to your account automatically.

### 4. Docker path (alternative to steps 2–3)

```bash
cp .env.example .env   # add your keys
docker compose up -d
docker compose logs -f lingxi
```

Data persists in the `lingxi-data` volume. Details: [docker.md](docker.md).

### 5. First things to try

1. **Chat with your agent** — ask it to search the web or run a calculation; watch tool calls stream live.
2. **Add a friend** — on a second machine/LAN instance, add each other; both AI agents join the private chat.
3. **Multi-AI mode** — put several models in one conversation (voting / debate / roundtable).
4. **Cron job** — ask your agent to "remind me every morning at 9" and check `/api/cron`.

### 6. Verify the install

```bash
curl http://localhost:3456/api/health     # {"ok":true,"version":"2.0.x",...}
npm run typecheck                          # 0 errors
npm test                                   # full vitest suite
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| Port 3456 in use | Set `PORT=3457` in `.env` |
| "model not found" | Check the model id against `/api/providers`; strict mode (`LINGXI_STRICT_MODEL=true`) refuses silent local fallback |
| Slow replies on cloud keys | You may be falling back to local Ollama — set `LINGXI_ALLOW_LOCAL_FALLBACK=false` |
| Sandbox errors | Sandbox is opt-in: `SANDBOX_ENABLED=true` + Docker running |
| Changed `.env` but nothing happened | Restart the engine; watch startup `[ENV-SHADOW]` logs for parent-process overrides |

---

## 简体中文

5 分钟跑起灵犀引擎。

### 1. 前置条件

| 方式 | 要求 |
|---|---|
| Node.js | v18+（推荐 v20/v24），npm 9+ |
| Docker | Docker Engine 20+ 且带 Compose v2（仅 Docker 方式需要） |
| AI 服务商 | 至少一个 API Key：OpenAI / DeepSeek / NVIDIA NIM，或本地 Ollama |

### 2. 安装与配置

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
npm install

cp .env.example .env
```

编辑 `.env`，**至少配置一个**服务商：

```env
# 任选其一（可多选）
DEEPSEEK_API_KEY=sk-...
OPENAI_API_KEY=sk-...
NVIDIA_API_KEY=nvapi-...

# 可选：纯本地、无需 Key
# OLLAMA_BASE_URL=http://127.0.0.1:11434

# 模型路由（默认值即可起步）
DEFAULT_MODEL=deepseek-chat
ROUTE_ENABLED=true
```

### 3. 启动

```bash
npm start
```

打开 **http://localhost:3456**，注册第一个账号（自动成为管理员），即可开聊。你的 AI 分身会自动绑定到账号。

### 4. Docker 方式（替代第 2–3 步）

```bash
cp .env.example .env   # 填入 Key
docker compose up -d
docker compose logs -f lingxi
```

数据持久化在 `lingxi-data` 卷中，详见 [docker.md](docker.md)。

### 5. 推荐先玩这几样

1. **和分身对话** —— 让它搜索网页、算个数，观察工具调用实时流。
2. **加好友** —— 局域网另一台机器再跑一个实例，互加好友，双方 AI 一起进私聊。
3. **多 AI 模式** —— 把多个模型拉进同一会话（投票 / 辩论 / 圆桌）。
4. **定时任务** —— 对分身说「每天早上 9 点提醒我」，然后看 `/api/cron`。

### 6. 验证安装

```bash
curl http://localhost:3456/api/health     # {"ok":true,"version":"2.0.x",...}
npm run typecheck                          # 0 错误
npm test                                   # 全量 vitest
```

### 常见问题

| 现象 | 处理 |
|---|---|
| 3456 端口被占 | `.env` 里设 `PORT=3457` |
| 「找不到模型」 | 对照 `/api/providers` 检查模型 id；严格模式（`LINGXI_STRICT_MODEL=true`）拒绝静默降级本地 |
| 配了云端 Key 却很慢 | 可能静默降级到了本地 Ollama —— 设 `LINGXI_ALLOW_LOCAL_FALLBACK=false` |
| 沙箱报错 | 沙箱需显式开启：`SANDBOX_ENABLED=true` 且 Docker 在运行 |
| 改了 `.env` 没生效 | 重启引擎；看启动日志 `[ENV-SHADOW]` 是否被父进程环境遮蔽 |
