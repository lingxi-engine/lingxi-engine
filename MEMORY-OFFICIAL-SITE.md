# 记忆 · 官网口径（正式对外官网）

> 最后更新：2026-10-16（本次为**实测复核**，不是回忆）
> 本文件是**唯一权威口径**。旧对话里出现的「官网」一律按下方规则解释。

---

## 一、术语口径（重要，避免再搞混）

| 说法 | 指代 | 服务器 | 用途 |
|---|---|---|---|
| **正式官网**（现在默认指这个） | `lingxi-engine.com`（腾讯云 香港 Lighthouse） | `43.161.224.64` | 对外品牌、SEO、引流、收款前合规 |
| 国内下载站 | 旧站 `47.93.157.83:8080` | 阿里云 北京 | 安装包分发（`install.ps1` 入口），**不对外宣传** |

> ⚠️ 以后用户说「官网」= **正式官网 `https://lingxi-engine.com`**。
> 若指的是下载站，明确问一句「你说的是下载站还是正式官网？」

---

## 二、服务器清单（2026-10-16 实测）

| IP | 归属 | 位置 | 角色 | 登录 |
|---|---|---|---|---|
| `43.161.224.64` | **腾讯云 Lighthouse** `lhins-p8119085` | **中国香港二区** | **正式官网 + 引擎运行中** | ⚠️ 22 端口**已通**，但 `lingxi_deploy` 公钥**未授权** → `Permission denied (publickey)` |
| `47.93.157.83` | 阿里云 | 北京 | 下载站（8080） | `ssh lingxi-server` 旧别名曾指向此机，现已改指香港 |
| `163.7.5.23` | Byteplus | 印尼日惹 | OpenClaw Portable 面板（80 端口被占） | 密钥被拒，只认密码 |

> 🔴 **已纠正的两个历史错误**
> 1. 记忆里曾写「香港服务器 = `163.7.5.23`」→ **错**，那台在印尼。
> 2. `deploy/DEPLOY-HK-OFFICIAL-SITE.md` 里写香港 IP = `43.161.216.80` → **错/已过期**，实测 `lingxi-engine.com` 解析到 **`43.161.224.64`**（2026-10-16 已就地修正该文档）。

**域名**：`lingxi-engine.com` → A 记录 = `43.161.224.64`（DNS 实测确认）
**到期**：⏰ **2026-10-24**（务必续费，过期官网直接下线）

---

## 三、正式官网当前状态（2026-10-16 实测）

| 项 | 状态 |
|---|---|
| 首页 `https://lingxi-engine.com/` | ✅ 200（8380 B） |
| HTTPS | ✅ **已启用**（443 可访问，证书生效） |
| `/chat/` | ✅ 200（96418 B） |
| `/m/`、`/m`（移动端聊天） | ❌ **404** —— 线上是 **2026-10-15 21:00 的构建**，不含 10-16 01:32 的 `56cb115`（新增 `/m/` 路由） |
| `/api/health` | ✅ 200，`version 2.0.32`、`agents 31`、`db true`、`commit "unknown"` |
| `/login.html` | ✅ 200 |
| `/public/version.txt` | ✅ 200 → `2.0.32`，sha256 `3284beb5…`，size 2410221，built `2026-10-15T13:08:24Z` |
| `/app` | ❌ 404（官网未暴露 app 入口，属预期） |
| 页面版本 | 首页/下载页均标注 `v2.0.32` |
| 多语言 i18n | ⚠️ 线上首页**未加载** `official-i18n.js`（本地 `deploy/site/` 有该文件） |
| 服务协议 / 隐私政策 | ❌ 未上线（`deploy/site/terms.html`、`privacy.html` 已备好，未部署） |

**下载站 `47.93.157.83:8080` 对照组（同一套代码，更新更早）**
| 路径 | 状态 |
|---|---|
| `/m/`、`/m` | ✅ **200**（96796 B）—— 移动端路由已生效 |
| `/chat/` | ✅ 200 |
| `/api/health` | ✅ 200 |
| `/public/version.txt` | ✅ 200（内容为旧格式：`2.0.32 / built: 2026-10-08 (v2.0.32 publish; local HEAD 4816ec8; SHA256 A7185DBC…)`） |
| `/mobile.html` | ❌ 404 |

> 📌 **一句话**：手机端要连云端聊天，**下载站 `http://47.93.157.83:8080/m/` 现在就能用**；
> **正式官网 `https://lingxi-engine.com/m/` 要等下一次部署**。

---

## 四、部署通道现状

| 通道 | 状态 |
|---|---|
| GitHub `origin` | ✅ `ssh://git@ssh.github.com:443/lingxi-engine/lingxi-engine.git`，`main = 56cb115` |
| 本机 `A` 仓 `C:\Users\Administrator\lingxi-engine` | ✅ `56cb115`，与 origin 同步，remote `dwork` → `D:\lingxi-engine-oss` |
| 本机 `B` 仓 `D:\lingxi-engine-oss`（开源/Oss 工作区） | ✅ 已 `pull --ff-only` 至 `56cb115` |
| 香港服务器 SSH | ❌ `openclaw-deploy@43.161.224.64` 公钥被拒 → **无法自动部署官网** |
| 官网发布脚本 | `scripts/publish-site.ps1`（目标 `47.93.157.83:8080`，**只管下载站**，不是官网） |
| 官网部署脚本 | `deploy/deploy-official-site.sh`（需 SSH 到香港机） |

**要恢复自动化部署，二选一**：
- **A（推荐）**：在香港机上执行一次
  ```bash
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  # 本机 C:\Users\Administrator\.ssh\lingxi_deploy.pub 的内容追加进去
  echo '<lingxi_deploy.pub 内容>' >> ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys
  ```
- **B**：腾讯云控制台 → Lighthouse → 用「登录」/ TAT 在线执行，或重置密钥后告知新密钥位置。

---

## 五、支付与合规口径

- 平台抽成 **10%**，服务方 **90%**，环境变量 `PLATFORM_FEE_RATE` 可调（0~0.5）
- 资金闭环已打通（mvp 任务市场 + agent 雇佣市场统一费率）
- **当前为模拟支付**，`/api/wallet/recharge` 明确标注未接真实支付，不可提现
- 接真实支付前必须完成：
  1. 服务协议 + 隐私政策 + 数据处理说明（页面已写好，**未上线**）
  2. 支付网关回调幂等
  3. 提现审核 + 风控
  4. 每日自动对账跑批
  5. 主体与收款路径（腾讯云香港仅为技术节点，**不等于**已具备收款资质）

---

## 六、社区与合伙人（已定策略）

- 论坛：**现在不建**。用 GitHub Discussions 过渡；等市场真有人接单成功再上 Discourse
- 合伙人：**现在一个都别招**。缺的是用户和成交，不是产能
- 当前只找：① 能带第一批用户的人 ② 支付合规顾问 ③ 反复提 PR 的贡献者
- 招人条件：1~2 人、股权 60%+、4 年 vesting + 1 年 cliff、先 advisor 试 2~3 个月
- 细节见 `COFOUNDER-AND-COMMUNITY-STRATEGY.md`

---

## 七、备份与磁盘（2026-10-16 实测）

- 备份根目录：`F:\`（卷标「灵犀引擎」，约 57.8 GB）
- 本次清理前 **仅剩 90.9 MB 空闲**（99.85% 满，下一次备份必失败）
- 元凶：`lingxi-engine-backup-20260907-110618\diffrhythm-local`（18,972 MB）+ `lingxi-engine-backup-20260908\diffrhythm-local`（18,831 MB）—— **两份重复的本地模型目录**，`C:\Users\Administrator\lingxi-engine\diffrhythm-local` 已有同一份
- 已删除上述两份重复副本 → **空闲 37,905.5 MB（约 37 GB）**
- ⚠️ 备份目录均为**纯文件拷贝，不含 `.git`**（`lingxi-engine-backup-20261016-011700` 实测无 `.git`）→ 只能当文件快照，不能当仓库回滚点
