# 灵犀官网 · 部署手册（腾讯云香港）

> 状态：**包已就绪，卡在腾讯云防火墙未放行**
> 更新时间：2026-09-26

---

## 一、目标

| 项 | 值 |
|---|---|
| 服务器 | 腾讯云轻量应用服务器（Lighthouse）`43.161.216.80` |
| 实例 | `lhins-p8119085` / 灵犀官网 / 中国香港二区 |
| 域名 | `lingxi-engine.com`（A 记录已指向该 IP ✅） |
| 站点目录 | `/opt/lingxi-site` |
| 规格 | 2核 2GB / 40GB SSD / 200Mbps |
| 到期 | **2026-10-24** ⚠️ 需续费 |

---

## 二、阻塞原因（已用对照实验锁定）

从本机（阿里云北京出口）实测：

| 目标 | 端口 | 结果 |
|---|---|---|
| 阿里云北京 `47.93.157.83` | 22 / 80 | ✅ **True** |
| 印尼 `163.7.5.23` | 22 | ✅ **True** |
| **腾讯香港 `43.161.216.80`** | **22/80/443/8080/8443** | ❌ **全 False** |

同一出口、同一时刻，**只有这台腾讯香港不通** → 问题在腾讯云侧，不在本地网络。

同时服务器内部（通过 TAT 控制台执行）显示：

```
● ssh.service - OpenBSD Secure Shell server
   Active: active (running) since Thu 2026-09-24 16:26:34 CST
LISTEN 0 4096 0.0.0.0:22 users:(("sshd",pid=5396))
inet 10.5.0.11/22 ... eth0
Unit firewalld.service could not be found.   ← 正常，Ubuntu 24.04 不装 firewalld
```

机器本身健康，**拦截点在腾讯云的防火墙规则层**。

### 重要提示

`lhins-` 前缀代表**轻量应用服务器（Lighthouse）**。
Lighthouse 使用**独立的「防火墙」页面**，与 CVM 的「安全组」不是同一套系统。
若之前查看的是安全组页面，**规则可能并未关联到本实例**。

---

## 三、需要你做的（1 分钟）

腾讯云控制台 → **轻量应用服务器** → 灵犀官网 → **防火墙**

确认存在以下入站规则：

| 应用类型 | 来源 | 协议端口 | 策略 |
|---|---|---|---|
| SSH | `0.0.0.0/0` | TCP:22 | 允许 |
| HTTP | `0.0.0.0/0` | TCP:80 | 允许 |
| HTTPS | `0.0.0.0/0` | TCP:443 | 允许 |

若页面为空，直接点「一键放通」或手动添加以上三条。

---

## 四、两条部署路径

### 路径 A：控制台粘贴（推荐，无需 SSH）

1. 将 `deploy/PASTE-INTO-TENCENT-CONSOLE.sh`（53,668 字节）内容复制
2. 腾讯云控制台 → 实例 → **登录**（网页终端 / VNC）
3. 粘贴并回车（文件较大，粘贴需 10–20 秒）
4. 如提示权限，用 TAT 执行器运行：

```bash
bash PASTE-INTO-TENCENT-CONSOLE.sh
```

该脚本**自带站点文件**（base64 内嵌 33,825 字节 tar 包），不需要服务器联网拉取代码。

**脚本执行内容：**

| 步骤 | 动作 |
|---|---|
| 1 | 放行 22/80/443（ufw + iptables） |
| 2 | 安装 nginx / certbot / curl |
| 3 | 解包内嵌站点到 `/opt/lingxi-site` |
| 4 | 写 nginx 配置并校验语法 |
| 5 | 申请 Let's Encrypt 证书，切 HTTPS |
| 6 | 自检并输出结果 |

**幂等**：可重复执行，已完成的步骤会跳过。

### 路径 B：SSH 直连（防火墙放通后最快）

端口通了之后，在本机执行：

```bash
ssh -i C:\Users\Administrator\Downloads\lingxi.pem root@43.161.216.80
```

私钥已验证与腾讯云密钥 `skey-gndounnj` 匹配，无需密码。

---

## 五、部署包清单

| 文件 | 大小 | 说明 |
|---|---|---|
| `deploy/PASTE-INTO-TENCENT-CONSOLE.sh` | 53,668 B | 自包含粘贴安装器（含站点） |
| `deploy/unlock-and-deploy.sh` | 8,068 B | 需先上传站点包到 `/tmp/` |
| `deploy/site/index.html` | 28,146 B | 官网首页（中英双语） |
| `deploy/site/js/official-i18n.js` | 28,816 B | i18n 词典，133 个 key |
| `deploy/site/terms.html` | 8,949 B | 服务协议（模拟支付声明） |
| `deploy/site/privacy.html` | 7,996 B | 隐私政策 |
| `deploy/site/robots.txt` | 193 B | 爬虫规则 |

---

## 六、已完成验证

| 检查 | 结果 |
|---|---|
| `bash -n` 语法校验 | ✅ SYNTAX_OK |
| base64 字符集纯净 | ✅ |
| 解码后字节数 | ✅ 33,825 B（45,100 → 33,825） |
| tar 包有效性 | ✅ 6 个条目 |
| 解包后文件完整性 | ✅ index/terms/privacy/robots/i18n 全部 present |
| HTML 标签配对 | ✅ 25 类标签零不匹配 |
| i18n key 覆盖 | ✅ 133/133 有译文 |
| 乱码 U+FFFD | ✅ 0 |
| charset / viewport | ✅ 均存在 |

---

## 七、上线后待办

1. **续费**：实例 2026-10-24 到期
2. **HTTPS 验证**：确认 `https://lingxi-engine.com` 正常访问
3. **搜索引擎**：提交 sitemap 到 Google Search Console / Bing
4. **法务复核**：`terms.html` / `privacy.html` 目前是基础草稿，
   接入真实支付前**必须经律师审核**（涉及跨境数据、退款、税务）
5. **凭据替换**：页脚 GitHub 链接目前指向 `github.com/lingxi-engine/lingxi-engine`
   （仓库为私有，公开前需确认是否调整）
6. **证书续期**：certbot 已配置，重跑脚本或 `certbot renew` 即可
