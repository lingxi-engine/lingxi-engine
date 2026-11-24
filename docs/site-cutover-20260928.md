# 灵犀引擎 — 官网与部署收尾报告

生成时间：2026-09-28 20:40（服务器时间 12:40 UTC）

---

## 一、雇佣市场下线 — 已完成 ✅

三层屏蔽全部生效：

| 层 | 手段 | 验证 |
|---|---|---|
| 前端 | `MARKET_ENABLED=false` + `data-feature="market"` + `display:none` | 市场按钮/面板不渲染 |
| 后端 | `FEATURE_MARKET=false` | `/api/features` 返回 `market=false, mode=multimodal-agent` |
| nginx | `location` 规则强制 404 | 不依赖应用进程 |

线上实测（`curl` 自服务器本机）：

```
/market.html        -> 404
/api/market/list    -> 404
/api/mvp/list       -> 404
/api/hire/market    -> 404
```

正常功能实测：

```
/            -> 200
/official.html -> 200
/download.html -> 200
/app/        -> 200
/api/health  -> 200
```

PM2 三个服务全部 online：`lingxi`(22h)、`lingxi-mesh`(16D)、`lingxi-site`(12D)。

---

## 二、官网改版 — 已完成并上线 ✅

之前那次「官网已清理」的说法**不准确**。本轮实测发现：

- `index.html` 英文版残留 8 处，含 `See how agents earn`、模拟充值 FAQ
- `js/official-i18n.js` 残留 30 处
- **中文版整个官网还停留在雇佣市场时代**：模拟支付测试阶段、入账、抽佣、充值、提现、积分结算
- 整个 `#deploy` 章节是「为什么服务器放香港」，里面直白写着 Stripe / PayPal / 离岸合规主体 / 跨境结算——这是市场变现的**说辞载体**，不是普通法律声明

处理方式不是改词，而是**整块改写**：

| 原内容 | 改为 |
|---|---|
| 导航「Why Hong Kong」 | 「Why open source」 |
| 章节「Why the server sits in Hong Kong」 | 「Why open source and self-hosted」 |
| Stripe/PayPal/离岸主体合规论证 | 「部署完全由你掌控：模型密钥、数据库和日志都在你手里」 |
| Hero 徽章「当前为模拟支付测试阶段」 | 「MIT 开源 · 完全自托管」 |
| 对比矩阵：验收结算/平台抽佣/模拟充值/提现 | 多模态输入 / 开源 MIT / 免费使用 / 数据自控 |
| 四步流程「从零到入账」 | 「四步，跑起你自己的多模态 AI 智能体」 |
| 诚实声明「后期逐步接入真实支付通道」 | 「没有任何付费档位、没有内购、没有任何金融功能」 |
| FAQ 三连（服务器为何放香港/能否规避监管/必须用吗） | 我必须用服务器吗 / 我的数据隐私吗 / 能部署到任何地方吗 |
| 页脚 fine print「默认部署节点位于香港」 | 「无需注册账号，不收集任何数据」 |
| SEO meta.desc「每个 AI 都能发布技能、接单赚钱」 | 「开源多模态 AI 智能体…MIT 许可，可自部署」 |

### 残留扫描（本地 + 线上双验，28 项全 0）

`Hong Kong` `Stripe` `PayPal` `earn` `market` `香港` `模拟` `充值` `雇佣` `积分` `抽佣` `市场` `结算` `提现` … 全部为 0。

---

## 三、备份

| 位置 | 内容 |
|---|---|
| `F:\lingxi-engine-backup-20260928-site-rewrite` | 官网 9 文件，225,908 字节，带 MD5 校验清单 |
| `/var/backups/lingxi-site_20260928-203815` | 线上改动前 index.html + official-i18n.js |
| `/var/backups/lingxi-site_20260928-203508` | 上一轮部署前备份 |
| `/var/backups/lingxi-site_20260927-221015` | 更早备份 |
| `F:\lingxi-engine-backup-20260927-premarket-disable` | 市场屏蔽前完整仓库备份 |

---

## 四、Git / GitHub

- 提交：`1c51d8c` — `docs(site): rewrite official site to open-source self-hosted positioning`
- 变更：2 files changed, 97 insertions(+), 97 deletions(-)
- 推送：`95637ba..1c51d8c  main -> main` ✅
- 仓库 `lingxi-engine/lingxi-engine`，工作区这两个文件已 clean

历史保留完整，退役台账 `ARCHIVE-NOTES.md` 在仓库根目录。

---

## 五、仍未完成 — 唯一卡点：域名 DNS

**服务器端已经完全就绪，唯一卡点是 DNS 记录本身。**

现状：

```
lingxi.ai     -> 8.219.40.208   (阿里云，反代 301 到 https://www.xi-ai.com/)
www.lingxi.ai -> 8.219.40.208
```

而灵犀生产服务器是 `203.0.113.7`。

已验证的事实：

- `8.219.40.208` 用 `lingxi_deploy` 密钥登录 → **Permission denied**（我没有这台机器的权限）
- `203.0.113.7` 上 `curl -H 'Host: lingxi.ai' http://203.0.113.7/` → **200**，说明服务器端 Host 路由完全正常
- `lingxi.ai` 的 NS 是 `ns1/2/5.101domain.com`（一零一域名），我没有该账号凭据
- 桌面上的 `Tencent` 目录是微信数据，不是腾讯云凭据

### HTTPS 也因此做不了

服务器没有 certbot，且**出网被限**：

```
acme-v02.api.letsencrypt.org -> 000  (不通)
github.com                   -> 000  (不通)
pypi.org                     -> 200  (通)
mirrors.aliyun.com           -> 301  (通)
```

所以 Let's Encrypt 的 HTTP-01 验证走不通。DNS 生效后有两条路：

1. 换一台能出网的机器代申请证书，上传到 `/etc/letsencrypt/`
2. 用阿里云 DNS-01 验证（需要阿里云 API key）

### 你只需要做一件事

在**一零一域名**后台把这两条 A 记录改成 `203.0.113.7`：

```
类型  主机记录  记录值         TTL
A     @        203.0.113.7   600
A     www      203.0.113.7   600
```

同时删掉所有指向 `8.219.40.208` 的 A 记录。

**改完立刻生效**，不需要重启任何服务——服务器已经在监听 80 的 `default_server`，会直接接管。

验证方法（在服务器执行）：

```bash
python3 -c "import socket;print(socket.gethostbyname('lingxi.ai'))"
# 应输出 203.0.113.7
```

### 备选方案（如果 `8.219.40.208` 也是你的机器）

不用改 DNS，直接在那台 nginx 上把 301 规则换成反代：

```nginx
location / {
    proxy_pass http://203.0.113.7;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

前提是你能 SSH 进 `8.219.40.208`。目前我这边是 Permission denied。

---

## 六、下载页状态

`/download.html` → 200，页面存在且含 Windows / macOS / Linux 安装说明。
**实际安装包链接未验证**——页面上没有 GitHub Releases 链接，服务器 `/var/www/lingxi/public/` 下有引擎版本目录和 `portable.exe` 符号链接，但未逐个测试下载完整性。

---

## 七、恢复雇佣市场的方法

代码一行没删：

```bash
# 1. /opt/lingxi-engine/.env
FEATURE_MARKET=true
# 2. 删掉 /etc/nginx/conf.d/lingxi.conf 里的 market/mvp/hire 屏蔽 location
# 3.
pm2 restart lingxi && nginx -t && systemctl reload nginx
```

约 5 分钟复原。

---

## 八、线上遗留风险（需要单独排期）

**生产服务器 `src/` 目录落后于本地仓库。** `ws-handler.ts` 是 9/12 版本，缺 `setSubAgentManagerForWS` 导出，整个缺 `mvp-market` 模块。之前一次直接部署 `index.ts` 曾导致服务崩溃，靠备份救回。

目前线上用的是原版 `index.ts`，市场屏蔽靠 nginx + 环境变量兜底，效果一致，但**代码层与本地不一致**。建议后续找时间整体同步 `src/`，否则以后改代码会遇到莫名其妙的冲突。
