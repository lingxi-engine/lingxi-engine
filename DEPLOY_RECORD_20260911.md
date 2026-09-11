# Lingxi Engine 部署记录 — 2026-09-11 (v2.0.16 一致性收尾)

## 起因

核查「git / GitHub / F盘备份 / 官网代码」四者是否为最新，并把落后的补齐。

## 一、核查结论（改动前）

| 检查对象 | 状态 |
|---|---|
| 本地 git HEAD | `5268c82` = v2.0.16 |
| GitHub `origin/main` | `5268c82` ✅ 与本地一致 |
| F 盘最新 bundle（20260909-final） | `4db918f` ❌ 落后 2 个提交（漏 `735598d`、`5268c82`） |
| 官网 `public/` 前端 | ❌ 13/14 文件落后（index/admin/css/js/sw 等），且 6 处 404 |
| `/var/www/lingxi/version.txt` | 2.0.16 ✅ |
| 官网 `public/version.txt` | 2.0.14 ❌ |
| `workspace/site_inner/` | ❌ `index.ts` 少 46 行、`package.json` multer 版本旧、version.txt=2.0.14 |
| 服务器 PM2 `lingxi` 引擎 | 2.0.15 ❌（需重启，本次未动） |

### 官网 6 处 404（全部已修）

```
/public/lingxi-engine-v2.0.16.tar.gz   404 → 200   ← download.html 主打下载链，最严重
/market.html                           404 → 200   ← 新 index.html 有链接指向它
/market.js                             404 → 200
/market.css                            404 → 200
/platform-admin.html                   404 → 200
/favicon.ico                           404 → 200
```

根因：`releases/lingxi-engine-v2.0.16.tar.gz` 已上传，但 `public/` 下只有通用名 `lingxi-engine.tar.gz`，
`download.html` 引用的**精确版本名**文件从未落盘。其余 5 个是 `web/` 前端未同步。

## 二、本次执行的动作

1. **本地提交** `6f2172f`：`package-lock.json` 2.0.15 → 2.0.16（`5268c82` 发布时漏改的文件）。
2. **推送 GitHub**：`5268c82..6f2172f`、`6f2172f..f88a98e` 两次 push，远端重新对齐。
3. **F 盘备份**：
   - `lingxi-engine-git-20260911-final.bundle`（HEAD `f88a98e`，12 refs，verify = okay）
   - `lingxi-site-20260911.tar.gz`（官网前端快照，496 KB）
4. **官网前端同步**（仓库 `web/` → 服务器 `public/`，用 `git archive HEAD:web` 打 tar 上传解包）：
   - 同步 19 个文件：index/admin/install/market/model-management/model-mgmt/platform-admin/sw.js/manifest.json/icon.svg/favicon.ico/market.css + `css/{style,mobile,market}.css` + `js/{app,i18n,market}.js`
   - 服务器已有备份：`/var/www/lingxi/site-backup-20260911/before-sync-20260911.tar`
5. **修复 404**：`cp releases/lingxi-engine-v2.0.16.tar.gz public/`（三者 md5 一致 `278fcbe1b9bfdf0419b84bb874c66b1a`）。
6. **修 `public/version.txt`**：2.0.14 → 2.0.16（含 built 时间与变更说明）。
7. **修 `/platform` 孤儿页**：该目录是聊天 UI 的旧副本（`app.js?v=20260827d`）且 `css/` 为空——
   请求 `/platform/css/style.css` 会被兜底逻辑吐回 HTML，样式全废。已用当前版本资产补齐，
   备份 `/var/www/lingxi/site-backup-20260911/platform-before-20260911.tar`。
8. **`official.html` / `download.html` 纳入版本库**（提交 `f88a98e`）——此前只存在于服务器，脱离版本控制。
9. **`site_inner` 同步**：跑 `scripts/sync-site-inner.ps1` 正式同步，再 `-CheckOnly` 复核 = **fully in sync**。

## 三、验证（逐字节）

- 服务器 `public/` 9 个关键文件与仓库 `HEAD:web`，**raw md5 与去 CR md5 双双一致**：
  `index.html / admin.html / market.js / model-management.html / sw.js / icon.svg / css/style.css / js/app.js / js/i18n.js`
- 全站 URL 扫描：`/`、`/app`、`/download.html`、`/market.html`、`/css/*`、`/js/*`、`/public/lingxi-engine-v2.0.16.tar.gz` 等 **全部 200**，404 清零。
- `git diff --numstat`：工作树相对 HEAD 无残留内容改动（494 个 `M` 是 stat 缓存噪声，blob 哈希逐条相同）。

## 四、遗留事项（需人工决策）

1. **服务器引擎仍是 2.0.15**，`/opt/lingxi-engine` 未升级。
   → 升级需重启 PM2 `lingxi` 进程；**本次按指示「不要杀进程」，未执行**。
   规划停机窗口后再做：`pm2 restart lingxi --update-env`。
2. **`/opt/lingxi-engine/web`（`/chat/*` 静态）仍是 2.0.15 的 UI**。
   单独替换有前后端 API 不匹配风险，应与引擎本体一起升。
3. `/platform` 是**无任何引用的孤儿页面**（全站 & 仓库搜索 0 处引用）——
   本次选择「补齐资产使其可用」而非删除。若要下线，建议在 `server.js` 加 301 → `/app`，
   但那需要重启 `lingxi-site`，故未做。
4. GitHub 提示 default 分支有 **2 个 high 级 Dependabot 漏洞**，待处理。
5. 官网仍有大量 `*.bak-*` 历史文件堆积在 `public/`，建议归档。

## 五、关键路径速查

| 项 | 路径 |
|---|---|
| 仓库根 | `C:\Users\Administrator\lingxi-engine` |
| 官网前端源（唯一真相） | `web/`（提交后用 `scripts/sync-site-inner.ps1` 同步到 `workspace/site_inner`） |
| 服务器 | `ssh lingxi-server`（别名 → root@47.93.157.83，密钥 `~/.ssh/lingxi_deploy`） |
| 官网根目录 | `/var/www/lingxi`（`server.js`，PM2 进程 `lingxi-site`，端口 8080） |
| 引擎安装 | `/opt/lingxi-engine`（PM2 进程 `lingxi`，端口 3456） |
| 平台 API | 端口 3001 |
| 官网备份 | `/var/www/lingxi/site-backup-20260911/` |
