# 手机端接管 · 自建部署指南（Mobile Relay / Self-host）

> 适用版本：v2.0.36 起
> 一句话：**手机装上 App 或打开网页 → 登录你的账号 → 「我的灵犀」里出现你自己的电脑和云端 → 点「接管」就能操控**。
> 前提只有一个：那台电脑（或云端）上的灵犀**正在运行**、并且**登录了同一个账号**。

---

## 一、三端是什么关系

| 角色 | 说明 |
|---|---|
| 手机 | 只做界面，不跑模型。三语：简体中文 / 繁體中文 / English |
| 云端灵犀（Hub） | 既是普通引擎，也是「设备目录 + 中继转发站」 |
| 电脑灵犀（Node） | 你在自己电脑上跑的那台。登录账号后自动登记到 Hub，并每 60 秒心跳 |

手机只看得到**心跳没断且在线的**设备，离线设备点不了接管；对离线设备申请票据会被直接拒绝（`409 instance_offline`）。

---

## 二、电脑在 NAT 后面也能被操控（反向中继）

电脑的 endpoint 常常是 `http://192.168.1.6:3456`，手机在外网根本连不上。
所以：**电脑主动出站**用 WebSocket 连 Hub，建立一条长连接；手机要访问电脑时，
Hub 把请求沿这条连接反向送回去。电脑不需要公网 IP、不需要端口映射、不需要 frp / cloudflared。

链路示意：

```
手机浏览器/App  ──HTTPS──▶  Hub(你的域名)  ◀──WSS(出站长连接)──  你的电脑
   │                            │
   │  ① 登录 / 列设备            │  ② 申请一次性接管票据
   │  ③ 打开 /app/relay.html ──▶ │  ④ 换取「那台电脑本地签发的 token」
   │  ⑤ 之后所有 /api/ 与 /ws 都走 /api/app/relay/x/<实例>/... → 电脑
```

**成功判据（在 Hub 上看）**：设备列表里该设备 `online: true` 且 `relayConnected: true`。
只有绿点而 `relayConnected: false`，就是「假在线」——点接管一定会失败。

---

## 三、装（三种入口，任选）

1. **Android**：打开 `https://你的域名/lingxi-app.apk` 安装
2. **iPhone**：Safari 打开 `https://你的域名/app/` → 分享 → 添加到主屏幕
3. **直接用浏览器**：`https://你的域名/app/`

---

## 四、自建 Hub（开源自部署必读）

默认会连官方云端 `https://lingxi-engine.com` 当目录。想完全用自己的服务器：

```bash
# 电脑端（以及任何要当目录的节点）的 .env
LINGXI_HUB_URL=https://你的域名
```

- 手机、电脑、云端三边填**同一个**地址，才会出现在同一个「我的灵犀」列表里
- 完全离线 / 只用局域网：`LINGXI_HUB_URL=off`（此时设备列表为空，走「连接自建引擎 / 局域网电脑」直连）
- 手机端也能临时改：登录页 → 「连接自建引擎 / 局域网电脑」→ 填引擎地址

### Nginx 必须放开 WebSocket

中继和聊天流式回复都依赖 WebSocket，反代必须透传 `Upgrade`：

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3456;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

检验命令（应返回 `101`）：

```bash
curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" \
     -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     https://你的域名/ws?id=probe
```

---

## 五、故障排查对照表

| 现象 | 大概率原因 | 怎么查 |
|---|---|---|
| 手机里看不到电脑 | 电脑没登录同一账号 / 心跳没通 | `curl 127.0.0.1:3456/api/app/status` 看 `linked`、`lastHeartbeatError` |
| 有绿点，点接管报错 | 中继没建立（`relayConnected=false`） | 看电脑日志有没有「反向中继已建立」；旧密钥失效会自动重新登记 |
| 反复「连接失败」 | Nginx 没透传 Upgrade | 用上面那条 curl，返回 400/426 就是配置问题 |
| 页面 404 / 400 on `/api/app/relay` | 旧版本 bug（v2.0.36 已修） | 升级到 2.0.36+ |
| 接管后界面显示未登录 | 中继请求没带 token（v2.0.36 已修） | 升级 `web/js/relay-shim.js` |
| 云服务器上看不到自己的电脑 | 云端重启后设备记录丢了 | 电脑端会自动重新登记（60 秒内），看 `/api/app/status` 的 `lastHeartbeatOk` |

---

## 六、安全模型（为什么别人伪造不了）

- **一次性接管票据**：60 秒、绑定实例、用完即废；重放返回 401
- **接管会话键**：12 小时、绑定实例，只能穿过中继访问那一台设备
- **中继握手**：电脑必须带 `X-Instance-Id` + `X-Instance-Secret`（48 位随机），Hub 用常量时间比较，错一个字节就 401
- **离线即拒**：超过 150 秒没心跳，申请票据直接 409，不给「撞运气」的机会
- **设备之间互相看不到**：目录按 owner 隔离，A 账号看不到 B 账号的机器
- **Token 只发一次**：接管时由目标电脑本地签发，Hub 不能拿它去冒充用户

---

## 七、三语

- 界面：右上角「中文 ▾」切换简体 / 繁體 / English，选择会记住
- 中继引导页 `/app/relay.html`：跟随系统语言（zh / zh-Hant / en）
- 首次启动跟随系统语言，Android 原生弹窗另有 `values-zh-rTW` 一套

---

## 八、一分钟自检清单

```bash
# 1. 引擎活着
curl -s http://127.0.0.1:3456/api/health

# 2. 这台机器绑定了哪个账号
curl -s http://127.0.0.1:3456/api/app/status

# 3. 云端能看到它、且中继在线（需登录 token）
curl -s -H "Authorization: Bearer $TOKEN" https://你的域名/api/app/instances

# 4. 中继握手入口存在（匿名应返回 401，不是 400/404）
curl -i -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  https://你的域名/api/app/relay?instanceId=probe
```
