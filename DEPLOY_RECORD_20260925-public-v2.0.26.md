# 部署记录：v2.0.26 发布到官网服务器

- 日期：2026-09-25
- 执行人：AI 助手（本地研发总智能体）
- 本地 HEAD：`d787b34`（fix(install,deploy): enable-linger + pin eol + strip BOM + fix scp upload path）
- 本地版本：`2.0.26`（`package.json` / `package-lock.json` / `version.txt` 三处对齐）
- 上一版本：`2.0.25` / `64658e7`
- 目标服务器：`47.93.157.83`（SSH 用户 `root`，密钥 `~/.ssh/lingxi_deploy`）
- 服务根目录：`/var/www/lingxi`；**唯一对外公开目录：`/var/www/lingxi/public`**
- 部署方式：`scripts/publish-site.ps1 -Method scp`（脚本自行调用 `pack-release.ps1` 重新打包）

---

## 一、本轮发布的上线产物（SHA256 实测）

| 产物 | 大小 | SHA256（线上实测） |
|---|---|---|
| `public/lingxi-engine.tar.gz` | 1,220,153 B | `c69bdaf0476b7826bfb4dea6e3074e2bea730ec08c6263d22c0867cc5e2fddda` |
| `public/install.sh` | 21,623 B | `4a94f886cebe241fb069841f9159648d4bf87c892fccb1fb35b2a5187a2b173a` |
| `public/install.ps1` | 17,734 B | `76925bcae6fe97f314158a328f734b8c7bef30951581163933a0d90f7c0026dd` |
| `public/version.txt` | 135 B | `7a083cb811132cd9fe7830c46eb2e4d27afab7ee0ec5609bedd8fef78c2cc095` |

发布前状态：`public/install.sh` 的 SHA256 为 `136168a5a861cf1b…`，**正是打补丁前的原始文件** —— 证明线上安装脚本长期未随版本更新。

---

## 二、为什么本次必须"重新打包"而不是只替换单个文件

`scripts/pack-release.ps1:161-164` 有硬门禁：`site/install.sh` 与 `site/install.ps1` **必须存在于 tarball 内**，否则打包直接 `throw`。

也就是说安装脚本是**随包分发**的（`lingxi-engine/site/install.sh`），只替换线上 `public/install.sh` 会让"包内那份"和"对外那份"不一致。故本轮走完整链路：改代码 → 升版本 → 重新打包 → 上传。

---

## 三、本轮回溯出的四处缺陷（全部实测复现，非推测）

### 1. Linux 用户级 systemd 服务随 SSH 断开而停止

`site/install.sh` 安装的是 `systemd --user` 服务，其生命周期绑在登录会话上。SSH 一断开，`user@<uid>.service` 被回收，引擎连带被杀，`Restart=on-failure` 无法自救。

- 修复：紧随 `systemctl --user enable --now` 执行 `loginctl enable-linger "$(id -un)"`；
  失败/缺失时 `warn` 降级并给出手动命令，不中断安装。

### 2. 换行符失控 —— `site/install.sh` 检出后变 CRLF（潜在致命）

仓库此前**没有任何 `.gitattributes`**，而开发机 `core.autocrlf=true`。

实测复现（`git checkout-index` 模拟全新检出）：

```
修复前：CRLF=542  LF=542   首行 = b'#!/bin/bash\r'
修复后：CRLF=0    LF=542   首行 = b'#!/bin/bash'
```

CRLF 的 shell 脚本在 Linux/macOS 上会直接 `bad interpreter` 或语法错误 —— 而该文件正是随 tarball 分发的安装入口，**等于安装器全盘失效**。

- 修复：新增 `.gitattributes`，固定 `*.sh text eol=lf`、`*.ps1/*.bat/*.cmd text eol=crlf`。

### 3. `version.txt` 的 UTF-8 BOM 让版本漂移检测永久失效

线上 `public/version.txt` 头三字节为 `EF BB BF`。根因：`scripts/publish-site.ps1` 用
`[System.Text.Encoding]::UTF8` 写文件（**该编码器会输出 BOM**），而 `pack-release.ps1`
早已改用 `UTF8Encoding $false`（v6.9 修复）—— **同一个 bug 类只修了一半**。

危害：自检/漂移检测读回的是 `<BOM>2.0.25`，而 .NET 的 `String.Trim()` **不剥离 U+FEFF**，
"本地 vs 线上"比较永远不相等，漂移检测退化为恒定告警（狼来了）。

- 修复：
  - `publish-site.ps1` 改为无 BOM 写出，**并加硬门禁**——生成后立即回读首三字节，含 BOM 即 `W-Fail` 中止发布。
  - `site/install.sh` 版本提取由 `tr -d '\r'` 改为 `tr -d '\r\357\273\277'`。
  - 本地/远端/自检三处版本号读取均补 `TrimStart([char]0xFEFF)`。
- 实证：本次发布日志出现 `[OK] version.txt is BOM-less (135 bytes)`；线上首 8 字节为 `32 2e 30 2e 32 36 0a 62`（`2.0.26\nb`）。

### 4. `publish-site.ps1` 的 scp 模式把安装脚本传到了死路径

scp 分支原本上传到 `${Path_}/../install.sh`，即 `/var/www/lingxi/install.sh`。
但 `server.js:186-187` 明确**只从 `public/` 读取** `GET /install.sh` 与 `/install.ps1`：

```js
if (urlPath === '/install.sh' || urlPath === '/install.ps1') {
  const file = path.join(ROOT, 'public', path.basename(urlPath));
```

**后果：scp 模式从未真正更新过线上安装脚本。** FTP 分支（`put` 到 `$Path_`）与
`-manual` 模式提示（复制到服务器 `public/` 目录）都是对的，**只有 scp 分支写错**。

- 修复：scp 目标改为 `$Path_/install.sh` 与 `$Path_/install.ps1`。

---

## 四、发布后独立复核（不采信发布脚本自检，按字节复测）

| 检查项 | 结果 |
|---|---|
| `GET /version.txt` | ✅ 200 / 135 B / **无 BOM** / 首行 `2.0.26` |
| `GET /public/version.txt` | ✅ 与 `/version.txt` 内容一致 |
| `GET /install.sh` | ✅ 200 / 21,623 B / 与本地 `site/install.sh` **逐字节一致** |
| `GET /install.sh` 换行符 | ✅ CRLF=0，LF=553，shebang 为 `#!/bin/bash`（无 `\r`） |
| `GET /install.sh` 含修复 1 | ✅ `enable-linger` 存在；已 != 旧 SHA `136168a5a8…` |
| `GET /install.sh` 含修复 3 | ✅ `\357\273\277` 存在（两处） |
| `GET /install.ps1` | ✅ 200 / 与本地 `site/install.ps1` 一致 |
| `GET /public/lingxi-engine.tar.gz` | ✅ 200 / 与本地新打包**逐字节一致** |
| 包内 `site/install.sh` | ✅ 含 `enable-linger` 且为 LF |
| 包内 `version.txt` | ✅ 无 BOM |
| 包内 BUILD-INFO | ✅ `2.0.26 / d787b34` |
| `GET /` | ✅ 200（10,681 B） |
| `GET /download.html` | ✅ 200（20,479 B） |
| `GET /chat` `/app` `/platform` | ✅ 302 → `/download.html`（预期行为） |
| `GET /docs` | ✅ 200 |
| `GET /install.ps1`、`/version.txt` | ✅ 200 |

> 注：`GET /download` 返回 404 属**正常**——该路径本就不存在，下载页是 `/download.html`
> （`/chat`、`/app`、`/platform` 由 302 跳转过去）。复核脚本最初的路径假设有误，已确认站点无问题。

---

## 五、备份与回滚

发布前备份（线上保留）：

- `public/.bak-20260925-v2025/`：`install.sh`(20,814) `install.ps1` `version.txt` `lingxi-engine.tar.gz`(1,213,383) —— 全部为 v2.0.25 原文件
- `.bak-root-20260925-v2025/`：根目录 `version.txt` `install.ps1` 旧副本

**一键回滚**：

```bash
cd /var/www/lingxi/public
cp -av .bak-20260925-v2025/install.sh .bak-20260925-v2025/install.ps1 \
       .bak-20260925-v2025/version.txt .bak-20260925-v2025/lingxi-engine.tar.gz .
```

## 六、附带整理：根目录"死副本"

`/var/www/lingxi/version.txt` 与 `/var/www/lingxi/install.ps1` **不被 `server.js` 服务**
（`/version.txt` 走 fallback 到 `public/version.txt`；`/install.*` 明确指定 `public/`）。
它们只是会误导人的死副本，本次已同步为与 `public/` 一致，旧文件备份于 `.bak-root-20260925-v2025/`。

---

## 七、遗留事项

1. **已安装 v2.0.25 及更早版本的 Linux 服务器**，服务仍会随 SSH 断开而停止。
   无需重装，执行一次即可获得同等修复：
   ```bash
   loginctl enable-linger $USER
   systemctl --user restart lingxi-engine
   loginctl show-user $USER | grep Linger     # 期望 Linger=yes
   ```
2. 本机（Windows 开发机）运行中的引擎进程仍可能是旧版；需手动重启才能加载最新代码
   （`taskkill` 被防自杀保护拦截，因引擎本体即当前进程宿主）。
3. `skills/continue-existing-repo-delivery.json` 等 session skill 定义文件是否纳入版本跟踪，
   仍待一次性决策（仓库已有 414 个同类文件被跟踪，且随发布包分发）。
