# 官网部署 · 腾讯云香港（一条命令版）

提交：`9aa24fd`　站点包已在 GitHub，服务器可直连拉取

---

## 🚨 当前阻塞：服务器公网完全不通

| 检查 | 结果 |
|---|---|
| DNS 解析 | ✅ `lingxi-engine.com` → `43.161.216.80` |
| SSH 22 / HTTP 80 | ❌ Connection timed out |
| 9 个常用端口扫描 | ❌ 全部超时 |
| ping | ❌ 100% 丢包 |

**结论：安全组入站规则没开，或服务器未真正运行。**

---

## 第 1 步：开安全组（腾讯云控制台）

云服务器 → `lhins-p8119085`（灵犀官网）→ **安全组** → 关联安全组 → 入站规则 → 添加：

| 类型 | 来源 | 协议端口 | 策略 |
|---|---|---|---|
| 自定义 | `0.0.0.0/0` | `TCP:22` | 允许 |
| 自定义 | `0.0.0.0/0` | `TCP:80` | 允许 |
| 自定义 | `0.0.0.0/0` | `TCP:443` | 允许 |

> ⚠️ 22 端口建议后续改成白名单（只放你常用 IP），别长期对全网开放。

---

## 第 2 步：确认实例在运行

控制台看状态必须是 **「运行中」**。若显示「已关机」/「隔离中」→ 点「启动」。

若 22 已通但仍失败 → 用密钥登录后执行：

```bash
# 若是云镜/安全组件拦截
systemctl stop firewalld 2>/dev/null; systemctl disable firewalld 2>/dev/null
iptables -F 2>/dev/null
# 或检查腾讯云安全组件 agent
systemctl status tat_agent 2>/dev/null
```

---

## 第 3 步：粘贴这一条命令部署

腾讯云控制台 → 点「登录」→ 网页终端，粘贴：

```bash
git clone --depth 1 https://github.com/lingxi-engine/lingxi-engine.git /tmp/lx && cd /tmp/lx && DOMAIN=lingxi-engine.com bash deploy/deploy-official-site.sh
```

**成功输出**：
```
[ok] 端口 80 空闲
[ok] 文件已放置 → /var/www/lingxi-site
[ok] nginx 配置 → /etc/nginx/conf.d/lingxi-site.conf
[自检] → HTTP 200
 官网部署完成
   http://lingxi-engine.com/  |  https://lingxi-engine.com/
```

---

## 第 4 步：验收

| 检查 | 命令 / 位置 |
|---|---|
| 首页 | 浏览器打开 `https://lingxi-engine.com/` |
| 英文默认 | 首屏应显示英文 |
| 切中文 | 右上角语言按钮 |
| 服务协议 | `/terms.html` |
| 隐私政策 | `/privacy.html` |
| GitHub 链接 | 页脚 GitHub → 应跳转到仓库 |

---

## 🛠 备选：SSH 部署（密钥已配好）

私钥已在本机找到并验证匹配：`C:\Users\Administrator\Downloads\lingxi.pem`

```powershell
cd C:\Users\Administrator\Downloads
ssh -i lingxi.pem root@43.161.216.80 "git clone --depth 1 https://github.com/lingxi-engine/lingxi-engine.git /tmp/lx && cd /tmp/lx && DOMAIN=lingxi-engine.com bash deploy/deploy-official-site.sh"
```

> 密码登录未采用 —— root 密码贴进聊天即永久留档。

---

## 📋 本轮已完成

| 项 | 状态 |
|---|---|
| 4 个占位链接（GitHub/Docs/Terms/Privacy） | ✅ 已填真实地址 |
| `terms.html` 服务协议 | ✅ 已写（12 节，含模拟支付专章） |
| `privacy.html` 隐私政策 | ✅ 已写（10 节，含不收集真实支付数据） |
| HTML 标签平衡校验 | ✅ 20 类全过 |
| 部署脚本 `bash -n` 语法 | ✅ 通过 |
| 推 GitHub | ✅ `9aa24fd` |
| 8 项部署后自检清单 | ✅ `README_DEPLOY_SITE.md` |

**唯一未完成：服务器入站端口** —— 这需要你在控制台点几下，我在公网侧无能为力。

---

## ⚠️ 两个提醒

1. **服务器 2026-10-24 到期** —— 距今约一个月，官网刚上线就断站代价很高，请尽快续费。
2. **服务协议我按「无真实资金」写** —— 真接支付前必须重写第 2 节（费率、提现、税务、退款、拒付），不能直接沿用。
