# Docker Deployment · Docker 部署

[English](#english) | [简体中文](#简体中文)

---

## English

### Quick run

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
cp .env.example .env        # add at least one provider API key
docker compose up -d
docker compose logs -f lingxi
```

Open http://localhost:3456 and register the first account (becomes admin).

### What the image does

- **Multi-stage build**: `node:20-bookworm` installs dependencies, `node:20-bookworm-slim` runs the engine as the non-root `node` user.
- **`--omit=optional`**: skips `puppeteer`, `node-datachannel`, `bonjour-service`. The engine degrades gracefully:
  - P2P direct connections → relay-only mode
  - mDNS LAN discovery → UDP broadcast only
  - Browser tool → reports "puppeteer not installed"
  To get full functionality, build with all deps: `docker build --build-arg ...` is not needed — simply run `npm ci` (without `--omit=optional`) in a custom image, or install the extras inside the container.
- **devDependencies are kept** because the entry point is `tsx index.ts` (TypeScript runner).
- **Healthcheck** polls `/api/health` every 30s; `docker compose ps` shows `(healthy)`.

### Data & persistence

All state (SQLite database, uploads, cron jobs, skill state) lives under `/app/data`, backed by the named volume `lingxi-data`.

```bash
# inspect
docker volume inspect lingxi-engine_lingxi-data

# backup (stop writes first for a consistent SQLite snapshot)
docker compose stop lingxi
docker run --rm -v lingxi-engine_lingxi-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/lingxi-data-$(date +%F).tar.gz -C /data .
docker compose start lingxi
```

### Upgrade

```bash
git pull
docker compose build --pull
docker compose up -d      # volume keeps your data
```

### Configuration

Everything is configured through `.env` (passed via `env_file`). Common knobs:

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3456; also change the `ports:` mapping) |
| `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `NVIDIA_API_KEY` | provider keys |
| `DEFAULT_MODEL` / `TOOL_MODEL` / `REPLY_MODEL` | model routing |
| `LINGXI_STRICT_MODEL=true` | refuse silent fallback to local models |
| `LINGXI_ALLOW_LOCAL_FALLBACK=false` | never fall back to Ollama |
| `SANDBOX_ENABLED=true` | Docker code sandbox (see warning below) |
| `METRICS_ENABLED=false` | disable `/metrics` |
| `ADMIN_TOKEN` | admin API token (also protects remote `/metrics`) |

### Code sandbox warning

The sandbox executes code in **sibling Docker containers**, which requires mounting `/var/run/docker.sock` (commented out in `docker-compose.yml`). That grants root-equivalent host control — enable it only on fully trusted machines. Without the socket, keep `SANDBOX_ENABLED` off; `code_execute` then runs in-process with the tool whitelist.

### Troubleshooting

| Symptom | Fix |
|---|---|
| `better-sqlite3` build fails | The deps stage includes python3/make/g++; ensure you are not building behind a proxy that blocks prebuilt-binary downloads |
| Container unhealthy | `docker compose logs lingxi` — usually a missing API key or port conflict |
| Port already allocated | Change `ports:` to `"3457:3456"` |
| `.env` changes ignored | `docker compose up -d` recreates the container with new env |
| Permission denied on /app/data | The image runs as `node` (uid 1000); named volumes are chowned automatically. Bind mounts must be writable by uid 1000 |

---

## 简体中文

### 快速运行

```bash
git clone https://github.com/lingxi-engine/lingxi-engine.git
cd lingxi-engine
cp .env.example .env        # 至少填一个服务商 API Key
docker compose up -d
docker compose logs -f lingxi
```

打开 http://localhost:3456，注册第一个账号（自动成为管理员）。

### 镜像设计

- **多阶段构建**：`node:20-bookworm` 装依赖，`node:20-bookworm-slim` 以非 root 的 `node` 用户运行。
- **`--omit=optional`**：跳过 `puppeteer` / `node-datachannel` / `bonjour-service`，引擎自动降级：
  - P2P 直连 → 纯 relay 模式
  - mDNS 局域网发现 → 仅 UDP 广播
  - 浏览器工具 → 提示「未安装 puppeteer」
- **保留 devDependencies**：入口是 `tsx index.ts`（TypeScript 运行器）。
- **健康检查**：每 30s 探测 `/api/health`，`docker compose ps` 可见 `(healthy)`。

### 数据持久化

全部状态（SQLite 库、上传文件、定时任务、技能状态）都在 `/app/data`，由命名卷 `lingxi-data` 承载。

```bash
# 备份（先停写，保证 SQLite 快照一致）
docker compose stop lingxi
docker run --rm -v lingxi-engine_lingxi-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/lingxi-data-$(date +%F).tar.gz -C /data .
docker compose start lingxi
```

### 升级

```bash
git pull
docker compose build --pull
docker compose up -d      # 数据卷不受影响
```

### 代码沙箱警告

沙箱通过**兄弟 Docker 容器**执行代码，需要挂载 `/var/run/docker.sock`（compose 中已注释）。这等同于授予宿主机 root 权限——只在你完全信任的机器上开启。不挂 socket 就保持 `SANDBOX_ENABLED` 关闭。

### 常见问题

| 现象 | 处理 |
|---|---|
| better-sqlite3 编译失败 | deps 阶段已带 python3/make/g++；检查代理是否拦截了预编译二进制下载 |
| 容器 unhealthy | `docker compose logs lingxi` —— 通常是缺 API Key 或端口冲突 |
| 端口被占 | `ports:` 改成 `"3457:3456"` |
| 改 `.env` 没生效 | `docker compose up -d` 重建容器即可 |
| /app/data 权限拒绝 | 镜像以 node(uid 1000) 运行；命名卷自动 chown，绑定挂载需对 uid 1000 可写 |
