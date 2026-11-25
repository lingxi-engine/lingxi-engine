# 手机远程控制 / Remote Access

> v2.0.43 起，官方 `lingxi-engine.com` 是**纯连接 Hub**（`HUB_ONLY=1`）：只做账号登录、设备在线目录、反向中继。**云端不跑任何 AI、不存你的聊天数据**——全部智能与数据仍在你自己的电脑上。

## 三种连接方式（App v1.4.0 全部内置）

### 1. 局域网直连（自动发现，零配置）
- 手机和电脑连同一 Wi-Fi。
- App 首次启动**自动扫描**：监听引擎的 UDP 3457 灯塔广播 + 本网段 3456 端口快速探测，找到后点一下即连。
- 引擎侧无需任何配置（`LAN_DISCOVERY` 默认开启）。
- 适合：人在家里。速度最快，流量不出路由器。

### 2. 官方连接 Hub（人在外面也能用，推荐）
- App 里选「🌐 官方连接 Hub」，登录**与电脑端相同的账号**。
- 电脑端灵犀登录同一账号后会自动登记到 Hub（`LINGXI_HUB_URL` 默认即官方地址），每 60s 心跳，并主动出站建立反向中继长连接。
- 手机「我的灵犀」自动列出你名下所有在线引擎，点「接管」即可——**电脑不需要公网 IP、不需要端口映射、不需要 frp/cloudflared**。
- 适合：人在公司/外面，家里电脑开着灵犀。
- 隐私说明：中继流量经过 Hub 运营方（与所有中继服务相同）。介意者用方式 3 自建。

### 3. 自建 Hub / 纯离线
- 任何一台有公网地址的机器（VPS/NAS/云主机）都能当 Hub：
  ```bash
  # 源码方式
  HUB_ONLY=1 BIND_ADDR=127.0.0.1 APP_PUBLIC_URL=https://你的域名 \
  JWT_SECRET=<强随机> LINGXI_HUB_URL=off FEATURE_PLATFORM=false FEATURE_MARKET=false \
  npm start
  # 或 Docker（见 docs/docker.md）
  ```
  前面再挂一层 nginx/TLS，把 `/app/`、`/m/`、`/api/auth/`、`/api/app/`（含 WebSocket 升级）反代到引擎即可。
- 电脑端与 App 都填 `LINGXI_HUB_URL=https://你的域名` / App 手动输入该地址。
- 完全离线：`LINGXI_HUB_URL=off`，只用方式 1（或 Tailscale/ZeroTier 组网后手动填虚拟 IP，App 同样支持）。

## 常见问题

**Q：登录 Hub 后「我的灵犀」是空的？**
A：电脑端灵犀必须①正在运行、②登录了**同一个邮箱账号**。电脑端登录后会自动登记；60s 内出现在列表。

**Q：显示设备离线？**
A：电脑睡眠/断网/引擎退出都会离线。保持电脑开机且灵犀运行。反向中继断开会自动重连。

**Q：接管后聊天图片不显示？**
A：中继目前改写 `/api/*` 与 WebSocket；`/uploads/`、`/avatars/` 静态资源直连目标机器，外网场景可能加载不到（已知限制，后续版本改进）。

**Q：官方 Hub 会看到我的聊天内容吗？**
A：Hub 只转发加密 HTTPS 内的请求帧，不落库聊天内容；但作为中继方理论上可见流量。强隐私需求请自建 Hub（方式 3），代码完全开源。

---

## English (short)

Since v2.0.43 the official `lingxi-engine.com` is a **connect-only Hub** (`HUB_ONLY=1`): account login + device directory + reverse relay. **No cloud AI, no chat storage** — all intelligence stays on your own computer.

1. **LAN direct (auto-discovery)**: App v1.4.0 scans UDP 3457 beacons + subnet port 3456 automatically. Same Wi-Fi, zero config.
2. **Official connect Hub**: sign in with the same account on phone and PC. The PC engine registers itself outbound (no public IP / port forwarding / frp needed). Your devices appear in "My LingXi" and can be taken over from anywhere.
3. **Self-hosted Hub / offline**: run any engine with `HUB_ONLY=1` behind your own TLS domain, point both sides at it; or `LINGXI_HUB_URL=off` for pure LAN / Tailscale use.

Privacy: relay traffic passes through the Hub operator (as with any relay). Self-host for full control — it's MIT-licensed.
