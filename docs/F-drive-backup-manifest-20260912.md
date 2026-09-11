# F 盘备份清单 — 2026-09-12（v2.0.17）

## 一、本次备份产物

| 产物 | 字节数 | 生成时间 | 完整性校验 |
|---|---|---|---|
| `F:\lingxi-engine-git-20260912-final.bundle` | 260,700,105 | 09-12 04:19 | `git bundle verify` = **okay**；`refs/heads/main` = `9df43e3` |
| `F:\lingxi-site-20260912-lean.tar.gz` | 5,922,771 | 09-12 04:20 | **MD5 `ef2a56ac9cd80305be542794322221b5`**，与服务器源文件逐字节一致 |

备份源：本地仓库 `C:\Users\Administrator\lingxi-engine`（HEAD `9df43e3`）、
服务器 `root@47.93.157.83:/var/www/lingxi`。

## 二、校验方法与结果

### 1. 引擎源码 bundle
```
git bundle create F:\lingxi-engine-git-20260912-final.bundle --all
git bundle verify   F:\lingxi-engine-git-20260912-final.bundle   → is okay
git bundle list-heads …                                          → refs/heads/main = 9df43e31d2ba03a1112ec2874ddad34c434d284b
```
含 13 个 ref（main / master / 远端跟踪分支 / 2 个 tag），历史完整，可独立克隆还原。

### 2. 站点快照
打包命令（在服务器执行，排除可再生与历史堆积内容）：
```
tar czf /tmp/site12-lean.tar.gz \
  --exclude='*node_modules*' --exclude='./site-backup-*' --exclude='./backup-*' \
  --exclude='*bak*' --exclude='*.exe' --exclude='*.zip' --exclude='./public/*.tar.gz' \
  -C /var/www/lingxi .
```
- `gzip -t` 通过；`tar tzf` 可完整列出，**122 个条目**
- 内含关键文件：`./server.js`、`./version.txt`（2.0.17）、`./public/download.html`、
  `./public/version.txt`、`./releases/lingxi-engine-v2.0.17.tar.gz`、`./api/server.js`
- 传输后 MD5 双向核对一致：本地 `ef2a56ac…` == 服务器 `ef2a56ac…`

### 3. 排除项说明（体积主要来源）
| 排除内容 | 大小/原因 |
|---|---|
| `public/灵犀引擎-desktop-1.1.0-portable.exe` | 80 MB，桌面端二进制，非站点代码 |
| `public/*.tar.gz`（历史版本包） | 约 50 MB，历史堆积，可由 git 重建 |
| `*/node_modules/*` | 可再生依赖 |
| `site-backup-*` / `backup-*` / `*bak*` | 服务器侧自身的历史备份 |

> 另有并行流程生成的 `lingxi-site-20260912.tar.gz`（含全部二进制的完整快照，约 186 MB 源）与
> `lingxi-site-20260912-final.tar.gz`（329 KB 精简版），与本清单的 `-lean` 版本并存。

## 三、并行产物说明

本次执行期间存在**并行 agent** 在同一工作区作业，F 盘上另有：
- `lingxi-engine-git-20260912-v2017.bundle`（03:48，main = `64debb1`，中间态，已被 `-final` 取代）
- `lingxi-engine-git-20260911-final.bundle`（09-11，main = `732734a`）

以上均为历史快照，保留不删，以 `-final` 为当日最终基线。

## 四、遗留

- F 盘 `lingxi-engine-source-20260908.tar.gz` 体积 4,294,963,200 B，恰为 4 GiB（2³²），
  **疑似写入截断的坏档**，建议复核或重做。
- F 盘剩余空间 3.0 GB（总 57.8 GB）。
