# F盘备份清单 — 2026-09-07 v2.0.14 最终版

## 本次发布核心产物（全部对应 git d37b20a）

| 文件 | 大小 | 说明 |
|---|---|---|
| lingxi-engine-v2.0.14-20260907-1945.tar.gz | 1.1 MB | **发布安装包**（与官网/服务器 MD5 一致：672f026d665890716dc53e77bfa4fc62） |
| lingxi-engine-v2.0.14-20260907-1930.tar.gz | 1.1 MB | 发布安装包（stash 补丁前版本，留档对比） |
| lingxi-engine-git-20260907-final.bundle | 249 MB | **git 全量历史 bundle**（12 refs，含 d37b20a，已 verify） |
| lingxi-engine-source-20260907-1945.tar.gz | 411 MB | **源码全量快照**（排除 node_modules/.git/data/logs） |
| release-v2.0.14-20260907.md | 2 KB | 发布收尾记录 |

## 历史归档

| 目录/文件 | 说明 |
|---|---|
| _archive_20260907/ | 今日 11 个 backup_*/release* 目录归档（从项目目录移出） |
| lingxi-engine-backup-20260907-094236 ~ 173110 | 今日 5 份全量代码备份（full.tar.gz） |
| lingxi-engine-v2.0.13-20260904-final.tar.gz | 上一版本留档 |
| lingxi-engine-backup-20260828 ~ 20260906 | 更早历史备份 |

## 恢复方法

- 安装包：tar -xzf lingxi-engine-v2.0.14-20260907-1945.tar.gz → npm install → npm run dev
- git 历史：git clone F:\lingxi-engine-git-20260907-final.bundle lingxi-engine-restored
- 源码快照：tar -xzf lingxi-engine-source-20260907-1945.tar.gz（含 data/ 之外的完整工作区）