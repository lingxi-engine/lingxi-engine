# F 盘备份清单 — 2026-09-12（v2.0.17）

> 注：本次执行期间有**并行 agent** 在同一工作区作业（持续追加 `DEPLOY_RECORD_20260912.md` 等 dev 文档），
> 官网包与 bundle 在本轮内被重打多次。以下为**最终一次**的产物与校验值。

## 一、最终产物

| 产物 | 字节数 | 时间 | 完整性校验 |
|---|---|---|---|
| `F:\lingxi-engine-git-20260912-final.bundle` | 260,685,886 | 09-12 04:33 | `git bundle verify` = **okay**；`refs/heads/main` = `d653c44` |
| `F:\lingxi-site-20260912-lean.tar.gz` | 5,928,123 | 09-12 04:33 | **MD5 `bbbb8d2ad8ace36fcb675e5c722b0c72`**（= 服务器源文件） |
| 官网发布包（服务器 3 处） | 1,292,292 | 09-12 04:33 | **MD5 `2e2220affecf706e7520401fe3f074d5`** |

备份源：本地仓库 `C:\Users\Administrator\lingxi-engine`、
服务器 `root@47.93.157.83:/var/www/lingxi`。

## 二、四方对齐状态

| 位置 | 状态 |
|---|---|
| 本地 git | HEAD `d653c44`，工作区无未跟踪文件 |
| GitHub `origin/main` | `d653c44`，`rev-list --left-right --count` = `0 0` |
| F 盘 bundle | `d653c44`，verify = okay，13 refs，历史完整 |
| F 盘站点快照 | MD5 `bbbb8d2a…`，与服务器逐字节一致（122 条目） |
| 官网发布包 | 三处同 md5 `2e2220af…`，HTTP 全 200 |

## 三、官网代码逐文件核验（vs 仓库 HEAD）

22 个前端文件做 **nocr-md5 + 尺寸** 双比对，仓库 `web/` 与服务器 `/var/www/lingxi/public/`
**22/22 完全一致**（`index.html` 100664B / `official.html` 10666B / `download.html` 17670B /
`admin.html` / `js/app.js` / `js/i18n.js` / `sw.js` / `manifest.json` / `css/*` / `favicon.ico` / `icon.svg`）。

**架构澄清：**
- 对外首页 `/` 由 `server.js` 返回 **`public/official.html`**（10666B），非根目录 `index.html`；
- 根目录 `index.html`(86716B, 08-13) 与 `css/ js/ sw.js favicon.ico(77522B)` 为**不可达的僵尸文件**
  （静态服务全走 `public/`），未改动；
- 下载链 `/public/lingxi-engine-v2.0.17.tar.gz` 与通用名 `/public/lingxi-engine.tar.gz` 均 200，与 `releases/` 同 md5；
- `/public/package.json` 是指向 `/opt/lingxi-engine/package.json` 的符号链接（既有设计）。

## 四、站点快照打包规则

```
tar czf … --exclude='*node_modules*' --exclude='./site-backup-*' --exclude='./backup-*' \
  --exclude='*bak*' --exclude='*.exe' --exclude='*.zip' --exclude='./public/*.tar.gz' \
  -C /var/www/lingxi .
```
排除项：`public/灵犀引擎-desktop-1.1.0-portable.exe`(80MB)、`public/*.tar.gz`(历史版本包约50MB)、
`node_modules`、服务器侧 `backup-*`/`site-backup-*`/`*bak*`。传输后 MD5 双向核对一致。

## 五、遗留 / 未动

- **线上引擎仍为 2.0.15**（`/api/health`），源码已是 2.0.17。升级须 **重启 PM2 `lingxi`**，
  用户明确要求「不要杀进程」，**未执行**。
- F 盘 `lingxi-engine-source-20260908.tar.gz` = 4,294,963,200 B（恰 4 GiB），**疑似截断坏档**。
- GitHub 2 个 high 级 Dependabot 漏洞，待处理。
- F 盘剩余约 2.9 GB。

## 六、本轮更新记录

- 04:24 官网重打包（补 `DEPLOY_RECORD_20260912.md`），md5 `56c0f831…`
- 04:28 追平 `adb458f`（CHANGELOG 补齐），md5 `0cd1bb43…`，同步 `/public/CHANGELOG.md`
- 04:31 追平 `e18939e`，md5 `ba689c88…`
- 04:33 追平 `d653c44`，md5 `2e2220af…`（最终）
- 旧版本备份于服务器 `/var/www/lingxi/backup-20260912-v2017b/`
