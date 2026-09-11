# F盘备份清单 — 2026-09-11 v2.0.16 收尾版

## 本次新增产物

| 文件 | 大小 | 说明 |
|---|---|---|
| lingxi-engine-git-20260911-final.bundle | 260,689,229 B | **git 全量历史 bundle**，12 refs，HEAD=`f88a98e`，已 `git bundle verify` = **okay** |
| lingxi-engine-git-20260911-full.bundle | 260,692,739 B | 中间产物（HEAD=`6f2172f`，仅 version/package-lock 对齐那次），留档 |
| lingxi-site-20260911.tar.gz | 496,036 B | **官网前端快照**（`/var/www/lingxi` 的 `server.js` + `version.txt` + `public/`，排除大二进制） |

## 为什么必须补这一版

上一份最新备份是 `lingxi-engine-git-20260909-final.bundle`（2026-09-09 11:37），其 `main` = `4db918f`。

而 09-11 的 HEAD 已经走到 `f88a98e`，中间**漏掉 3 个提交**：

| 提交 | 内容 |
|---|---|
| `735598d` | fix(security): shell_exec 防自杀保护（taskkill/pkill/killall/kill PID 统一拦截）+ market 裸引擎商品标注 |
| `5268c82` | chore(release): v2.0.16 |
| `6f2172f` | chore(release): package-lock.json 版本对齐 2.0.15 → 2.0.16 |
| `f88a98e` | feat(web): official.html + download.html 纳入版本控制（此前仅存在于服务器） |

> 教训：F 盘备份必须跟随每次 `git push` 之后重建，否则单点丢失的就是最新那几个提交。

## bundle 内 refs（12 条）

```
f88a98e refs/heads/main                     ← 当前 HEAD
5236fc3 refs/heads/master
7384fae refs/remotes/dwork/main
1a98033 refs/remotes/origin/dependabot/npm_and_yarn/multi-f58b5f4917
7d73c11 refs/remotes/origin/dependabot/npm_and_yarn/multi-f782ed4431
95b4230 refs/remotes/origin/feature/add-ci
d91a342 refs/remotes/origin/feature/executor-tool-adapter
4d224ad refs/remotes/origin/feature/executor-tool-finalize
f88a98e refs/remotes/origin/main            ← 与 GitHub 远端一致
6188148 refs/tags/pre-agi-final
f21439e refs/tags/v2.0.12-pre-agi
f88a98e HEAD
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
