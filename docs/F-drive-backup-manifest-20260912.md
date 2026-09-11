# F 盘备份清单 — 2026-09-12（v2.0.17）

## 一、本次备份产物

| 产物 | 字节数 | 生成时间 | 完整性校验 |
|---|---|---|---|
| `F:\lingxi-engine-git-20260912-final.bundle` | 260,714,569 | 09-12 04:28 | `git bundle verify` = **okay**；`refs/heads/main` = `adb458f` |
| `F:\lingxi-site-20260912-lean.tar.gz` | 5,927,898 | 09-12 04:29 | **MD5 `61f1cda64a9c1b43bf341fd259a2f8df`**，与服务器源文件逐字节一致 |

备份源：本地仓库 `C:\Users\Administrator\lingxi-engine`（HEAD `adb458f`）、
服务器 `root@47.93.157.83:/var/www/lingxi`。

## 二、校验方法与结果

### 1. 引擎源码 bundle
```
git bundle create F:\lingxi-engine-git-20260912-final.bundle --all
git bundle verify   …   → is okay
git bundle list-heads … → refs/heads/main = adb458fbf2c9238a980492771f961837bb1fe9f6
```
含 13 个 ref（main / master / 远端跟踪分支 / 2 个 tag），历史完整，可独立克隆还原。

### 2. 站点快照
打包命令（在服务器执行，排除可再生与历史堆积内容）：
```
tar czf /tmp/site12-lean3.tar.gz \
  --exclude='*node_modules*' --exclude='./site-backup-*' --exclude='./backup-*' \
  --exclude='*bak*' --exclude='*.exe' --exclude='*.zip' --exclude='./public/*.tar.gz' \
  -C /var/www/lingxi .
```
- `gzip -t` 通过；`tar tzf` 可完整列出，**122 个条目**
- 内含关键文件：`./server.js`、`./version.txt`（2.0.17）、`./public/download.html`、
  `./public/version.txt`、`./public/CHANGELOG.md`（含 2.0.17）、`./releases/lingxi-engine-v2.0.17.tar.gz`
- 传输后 MD5 双向核对一致：本地 `61f1cda6…` == 服务器 `61f1cda6…`

### 3. 排除项说明（体积主要来源）
| 排除内容 | 大小/原因 |
|---|---|
| `public/灵犀引擎-desktop-1.1.0-portable.exe` | 80 MB，桌面端二进制，非站点代码 |
| `public/*.tar.gz`（历史版本包） | 约 50 MB，历史堆积，可由 git 重建 |
| `*/node_modules/*` | 可再生依赖 |
| `site-backup-*` / `backup-*` / `*bak*` | 服务器侧自身的历史备份 |

## 三、并行产物说明

本次执行期间存在**并行 agent** 在同一工作区作业，F 盘上另有：
- `lingxi-engine-git-20260912-v2017.bundle`（03:48，main = `64debb1`，中间态）
- `lingxi-site-20260912.tar.gz`（全量含二进制快照）与 `lingxi-site-20260912-final.tar.gz`（329 KB 精简版）

以上均为历史快照，保留不删，以 `-final` 为当日最终基线。

## 四、遗留

- F 盘 `lingxi-engine-source-20260908.tar.gz` 体积 4,294,963,200 B，恰为 4 GiB（2³²），
  **疑似写入截断的坏档**，建议复核或重做。
- F 盘剩余空间约 2.9 GB（总 57.8 GB）。

## 五、更新记录

- **04:24 官网 v2.0.17 首次重打包**：补入 `DEPLOY_RECORD_20260912.md`，md5 `56c0f831…`。
- **04:28 官网 v2.0.17 二次重打包**：追平 `adb458f`（CHANGELOG 补齐 2.0.13~2.0.17），
  三处 md5 统一为 `0cd1bb435abee11dfc40c03c8fe61101`；同步更新 `/public/CHANGELOG.md`（8619 B）；
  HTTP 实测全 200。站点快照随之刷新：md5 `61f1cda6…`（前值 `860450bb…`）。
- 旧版本一律备份于服务器 `/var/www/lingxi/backup-20260912-v2017b/`。

## 六、官网代码逐文件核验（与仓库 HEAD 比对）

对 22 个前端文件做 **nocr-md5 + 尺寸**双比对，仓库 `web/` 与服务器 `/var/www/lingxi/public/`
**22/22 完全一致**，含 `index.html`(100664B) / `official.html`(10666B) / `download.html`(17670B) /
`admin.html` / `js/app.js` / `js/i18n.js` / `sw.js` / `manifest.json` / `css/*` / `favicon.ico` / `icon.svg` 等。

**架构澄清（核查中发现）：**
- 对外首页 `/` 实际由 `server.js` 返回 **`public/official.html`**（10666B），而非根目录 `index.html`；
- 根目录 `index.html`(86716B, 08-13) 及 `css/ js/ sw.js favicon.ico(77522B)` 为**不可达的僵尸文件**
  （静态服务全部走 `public/`），与本任务无关，未改动；
- 下载链 `/public/lingxi-engine-v2.0.17.tar.gz` 与通用名 `/public/lingxi-engine.tar.gz` 均 200，
  且与 `releases/` 同 md5。
