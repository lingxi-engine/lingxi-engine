# 手机远程控制 / Remote Access

> **v2.0.44 自部署模型：各自部署各自的灵犀，各自登录各自的实例。**
> 引擎不再默认连接任何官方共享云端；官网只提供下载与部署指南。
> 你的数据、你的算力、你的服务器 —— 全部归你。

## 三种连接方式（App v1.5.0 全部内置）

### 1. 局域网直连（自动发现，零配置）
- 手机和电脑连同一 Wi-Fi。
- App 首次启动**自动扫描**：监听引擎的 UDP 3457 灯塔广播 + 本网段 3456 端口快速探测，找到后点一下即连。
- 引擎侧无需任何配置（`LAN_DISCOVERY` 默认开启）。
- 适合：人在家里。速度最快，流量不出路由器。

### 2. 我的云端（人在外面也能用，推荐）
- 在**你自己的服务器**上部署一台云端灵犀（Docker 一键部署见 [docs/docker.md](docker.md)，或安装脚本见官网下载页）。
- App 里选「🌐 我的云端」，填入你的云端地址，登录**与电脑端相同的账号**。
- 电脑端设置 `LINGXI_HUB_URL=https://你的云端域名` 并登录同一账号：自动登记到**你自己的**云端，每 60s 心跳，并主动出站建立反向中继长连接。
- 手机「我的灵犀」自动列出你名下所有在线引擎（云端 + 电脑），点「接管」即可——**电脑不需要公网 IP、不需要端口映射、不需要 frp/cloudflared**。
- 适合：人在公司/外面，家里电脑开着灵犀。
- 隐私说明：中继流量经过**你自己的**服务器，不经过任何第三方。

### 3. 手动地址 / 纯离线
- App 手动输入任意引擎地址（公网 / Tailscale / ZeroTier 虚拟 IP 均可）。
- 完全离线：`LINGXI_HUB_URL=off`（或留空不设置），只用方式 1。

## 私有实例：不让陌生人用你的服务器

云端灵犀默认开放注册（方便你自己注册账号）。若不想让任何人注册使用你的服务器：

```env
REGISTRATION_OPEN=false
```

- 三个注册入口（`/api/auth/register`、`/api/auth/send-code`、`/api/auth/register-with-email`）全部返回 403 `registration_closed`。
- **已有账号登录不受影响**——你自己照常使用。
- 自建实例默认开放（`REGISTRATION_OPEN` 未设置即开放）：各自在各自的实例上注册各自的账号。

## 电脑端指向自己的云端

```env
# .env（电脑端引擎）
LINGXI_HUB_URL=https://lingxi.你的域名.com
```

- v2.0.44 起**默认值为空**：不设置 = 纯本地模式，不向任何外部服务器登记/心跳。
- 登录账号后自动登记 + 反向中继；`LINGXI_HUB_URL=off` 显式关闭。
- 云端那台机器本身也是完整灵犀（可跑 AI、可聊天），同时充当你私人的设备目录与中继。
- 只想让云端做纯中继（不跑 AI）：云端设 `HUB_ONLY=1`。

## 常见问题

**Q：登录云端后「我的灵犀」是空的？**
A：电脑端灵犀必须①正在运行、②设置了 `LINGXI_HUB_URL` 指向该云端、③登录了**同一个邮箱账号**。电脑端登录后会自动登记；60s 内出现在列表。

**Q：显示设备离线？**
A：电脑睡眠/断网/引擎退出都会离线。保持电脑开机且灵犀运行。反向中继断开会自动重连。

**Q：接管后聊天图片不显示？**
A：中继目前改写 `/api/*` 与 WebSocket；`/uploads/`、`/avatars/` 静态资源直连目标机器，外网场景可能加载不到（已知限制，后续版本改进）。

**Q：没有云服务器怎么办？**
A：① 局域网直连（方式 1）在家完全够用；② Tailscale/ZeroTier 免费组网后手动填虚拟 IP（方式 3）；③ 任意一台便宜 VPS 用 Docker 一键部署自己的云端（方式 2）。

---

## English (short)

**v2.0.44 self-hosting model: everyone deploys their own LingXi and signs in to their own instance.** The engine no longer connects to any official shared cloud by default; the official site only provides downloads and deployment guides.

1. **LAN direct (auto-discovery)**: App v1.5.0 scans UDP 3457 beacons + subnet port 3456 automatically. Same Wi-Fi, zero config.
2. **My Cloud**: deploy a cloud LingXi on **your own server** (Docker one-click, see docs/docker.md). In the app choose "My Cloud", enter your address, sign in with the same account as your PC. Set `LINGXI_HUB_URL=https://your-domain` on the PC engine — it registers outbound to **your own** cloud and builds a reverse relay (no public IP / port forwarding / frp needed). Your devices appear in "My LingXi" and can be taken over from anywhere. Relay traffic passes through **your own** server only.
3. **Manual / offline**: enter any engine address (public / Tailscale / ZeroTier); `LINGXI_HUB_URL=off` or unset for pure LAN.

**Private instance**: set `REGISTRATION_OPEN=false` to close public registration (all three register endpoints return 403 `registration_closed`); existing accounts keep working. Self-hosted instances default to open registration — everyone registers on their own instance.

MIT-licensed. Your data, your compute, your server.