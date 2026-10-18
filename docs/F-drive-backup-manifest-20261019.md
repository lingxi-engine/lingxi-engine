# 灵犀引擎 v2.0.34 备份记录（含 F 盘阻塞说明）

- 生成时间：2026-10-19 03:10 (Asia/Shanghai)
- 源码目录：`C:\Users\Administrator\lingxi-engine`
- 版本：2.0.34
- git：`main` @ `13d0fe8`（已推送 GitHub）

---

## 一、已完成且可验证的备份

| # | 位置 | 内容 | 校验 |
|---|---|---|---|
| 1 | GitHub `lingxi-engine/lingxi-engine` `main` @ `13d0fe8` | 全部提交 | `git log` |
| 2 | `D:\lingxi-backup-20261019\lingxi-engine-code-2.0.34.tar.gz` | 代码归档 **22.38 MB / 125,762 条目** | SHA256 `9626604…A03A9C` |
| 3 | 生产 `/opt/lingxi-engine` | v2.0.34 运行中 | `/api/health` |
| 4 | 生产 `/opt/backup-lx134b-20261019-024728` | 部署前快照 | — |
| 5 | 本机 `C:\Users\Administrator\lingxi-engine` | 工作区，`git status` 干净 | — |

归档内已确认包含：`version.txt`、`src/routes/agent-grants.ts`、`web/app/grants.html`、`web/js/app.js`、`DEPLOY_RECORD_20261019-v2.0.34.md`。

排除项：`node_modules` / `.git` / `diffrhythm-local`（18.53 GB 模型）/ `workspace` / `uploads` / `data-*` / `*.log`。

---

## 二、F 盘备份：阻塞未完成（需一次人工介入）

### 现象

2026-10-19 00:02 与 00:34 先后启动的两个 `robocopy` 指向**同一目标目录**，且**未排除 `diffrhythm-local`（18.5 GB 模型目录）**：

1. 双进程并发写同一目标，实际进度极慢；
2. 运行 1 小时后彻底停滞：F: 盘 `read`/`write` 均挂起到超时（根目录 `dir` 能响应，进备份子目录即阻塞）；
3. 可用空间 37.0 GB → 25.64 GB 后不再变化（已写约 11.4 GB，主要是模型文件）；
4. 进程 **25284 / 29752** 仍存活；本机「防自杀保护」策略禁止 `taskkill` / `Stop-Process`，因此无法自动清理。

### 解除方式（二选一，约 1 分钟）

**A. 结束进程（推荐）**

```powershell
Stop-Process -Name Robocopy -Force
```

或任务管理器 → 详细信息 → 结束两个 `Robocopy.exe`。

**B. 重启主机**（F 盘 I/O 堆积会一并清空）

### 解除后重跑

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\Administrator\lingxi-engine\_backup_to_F.ps1
```

脚本已就绪，特性：

- **单线程**（`/MT:1`），不再并发
- **排除** `diffrhythm-local`、`node_modules`、`.git`、`data-*`、`workspace`、`uploads`
- 目标目录带时间戳，不覆盖历史备份
- 开跑前先探测 F 盘可写，不可写则直接退出并提示
- 结束打印文件数 / 总大小 / 关键文件存在性 / 生成 `_SHA256.txt` 与 `_BACKUP-INFO.txt`

预计耗时：几分钟（约 2.4 GB，不含模型目录）。

---

## 三、历史备份参照

| 目录 | 时间 |
|---|---|
| `F:\lingxi-engine-backup-20261016-011700` | 2026-10-16 |
| `F:\lingxi-engine-backup-20261015-210813` | 2026-10-15 |
| `F:\lingxi-engine-backup-20261019-000256` | 2026-10-19（本次，**未完成**，解除阻塞后可删除） |

## 四、清理建议（解除阻塞后）

```powershell
# 删掉半成品目录，回收约 11.4 GB
Remove-Item 'F:\lingxi-engine-backup-20261019-000256' -Recurse -Force
# 顺手清掉探测残留
Remove-Item 'F:\_write_probe.txt','F:\_nodetest.txt','F:\_copytest.txt' -Force -ErrorAction SilentlyContinue
```
