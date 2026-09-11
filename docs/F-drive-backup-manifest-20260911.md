# F盘备份清单 — 2026-09-11 v2.0.16 收尾版

## 本次新增产物

| 文件 | 大小 | 说明 |
|---|---|---|
| lingxi-engine-git-20260911-final.bundle | ~260.7 MB | **git 全量历史 bundle**，12 refs，`main` = 当前最新提交，`git bundle verify` = **okay / complete history** |
| lingxi-engine-git-20260911-full.bundle | 260,692,739 B | 中间产物（HEAD=`6f2172f`，仅 version/package-lock 对齐那次），留档 |
| lingxi-site-20260911.tar.gz | 496,036 B | **官网前端快照**（`/var/www/lingxi` 的 `server.js` + `version.txt` + `public/`，排除大二进制） |

> 清单不写死 commit 哈希：`-final.bundle` 在每次提交后重建，始终跟随 `main` 最新。
> 核对方法：`git bundle list-heads F:\lingxi-engine-git-20260911-final.bundle`

## 为什么必须补这一版

上一份最新备份是 `lingxi-engine-git-20260909-final.bundle`（2026-09-09 11:37），其 `main` = `4db918f`。

而 09-11 的提交链已经走到 `3949587`，中间**漏掉 4 个提交**：

| 提交 | 内容 |
|---|---|
| `735598d` | fix(security): shell_exec 防自杀保护（taskkill/pkill/killall/kill PID 统一拦截）+ market 裸引擎商品标注 |
| `5268c82` | chore(release): v2.0.16 |
| `6f2172f` | chore(release): package-lock.json 版本对齐 2.0.15 → 2.0.16 |
| `f88a98e` | feat(web): official.html + download.html 纳入版本控制（此前仅存在于服务器） |
| `3949587` | docs: 2026-09-11 一致性收尾记录 + 本清单 |

> 教训：F 盘 bundle 必须跟随每次 `git push` 之后重建，否则单点丢失的恰好是最新那几个提交。

## bundle 内 refs（12 条）

```
refs/heads/main                                   ← 当前 HEAD
refs/heads/master                    (5236fc3)
refs/remotes/dwork/main              (7384fae)
refs/remotes/origin/dependabot/npm_and_yarn/multi-f58b5f4917
refs/remotes/origin/dependabot/npm_and_yarn/multi-f782ed4431
refs/remotes/origin/feature/add-ci
refs/remotes/origin/feature/executor-tool-adapter
refs/remotes/origin/feature/executor-tool-finalize
refs/remotes/origin/main                          ← 与 GitHub 远端一致
refs/tags/pre-agi-final              (6188148)
refs/tags/v2.0.12-pre-agi            (f21439e)
HEAD
```

## 恢复方法

```bash
# git 全量历史（推荐）
git clone F:\lingxi-engine-git-20260911-final.bundle lingxi-engine-restored

# 官网前端
tar -xzf F:\lingxi-site-20260911.tar.gz        # 解出 server.js / version.txt / public/
```

## 注意

- F 盘剩余空间约 **3.87 GB**（盘总容量 62 GB），后续全量源码快照（400 MB 级）需先清理旧档。
- 官网的大文件（安装包 tar.gz / desktop exe 83 MB）**不在**本快照内，它们由服务器 `releases/` 维护。
