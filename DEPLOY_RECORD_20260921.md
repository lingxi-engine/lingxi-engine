# Lingxi Engine 部署记录 — 2026-09-21（四地同步：git / GitHub / F盘 / 官网打包上传）

## 结论速览

| 渠道 | 目标版本 | 执行前 | 执行后 |
|---|---|---|---|
| 本地 git (main) | cb3f23e | 8038d5c + 12 个未提交变更 + 2 个垃圾文件 | ✅ 已提交，工作区干净 |
| GitHub origin/main | cb3f23e | 8038d5c（落后 3 提交） | ✅ push 成功 `8038d5c..cb3f23e` |
| dwork (D:\lingxi-engine-oss) | cb3f23e | 8038d5c | ✅ fast-forward 同步 |
| F 盘 bundle | 全分支+refs | 最新停在 09-18 (17748bf) | ✅ `lingxi-engine-git-20260921-final-cb3f23e.bundle`（verify okay, complete history） |
| F 盘发布包 | v2.0.20 | 最新 tar 停在 09-18 | ✅ `lingxi-engine-v2.0.20-20260921-2315.tar.gz`（1,139,764 B，MD5 7933a2…） |
| 官网下载包 | v2.0.20 | 09-18 包（1,082,635 B，MD5 048f51…） | ✅ 重新打包上传，MD5 三处一致 |

## 一、发现并修复的关键问题

**`pack-release.ps1` 排除表漏了 `data-bench*`（本次最重要发现）**

- 现象：首次打包产物 **4,547,375 B**，约为线上包（1,082,635 B）的 4.2 倍。
- 定位：`$excludeDirs = @(...)` 只硬编码排除了 `data-smoke-b13b`，**未排除 `data-bench` / `data-bench2` … `data-bench19`**。这些是 09-18 之后基准测试新产生的运行时数据目录（约 15 MB，共 179 个 tar 条目）。
- 反证：线上 09-18 包内 `data-bench` 条目数 = **0**，说明它们本就该被排除。
- 修复：`$excludeDirsRegex` 由 `'^backup[_-]'` 改为 `'^backup[_-]|^data-bench'`。
- 结果：重打 **1,139,764 B（1.09 MB）**，`data-bench` 条目 **0**，26 项断言全绿（1 WARN 为 pay-route 自动探测的已知局限，与 09-18 记录一致）。
- 脚本备份：`scripts/pack-release.ps1.bak-20260921-databench`；补丁写入确认 **BOM 前后均为 False**。

**BOM 复核（09-18 遗留关注点）**

- `package.json` 首字节 `7b 0a`（干净 `{`）✅
- `index.ts` 首字节 `EF BB BF`，但**新旧包完全一致** → 历史既有，非本次引入（Node/tsx 对 .ts 的 BOM 容忍；09-18 CI success 的 17748bf 即含此文件）。

## 二、git 整理

- 提交 `cb3f23e`「备份前提交」：12 文件 / +132 −6
  - L5 回归修复：`src/core/router.ts`、`src/core/ws-handler.ts`、`src/tools/executor.ts`
  - bench 脚本：`workspace/bench/start-bench-3621.cmd`
  - 8 个 session skill 入库
- 推送 `origin/main`（8038d5c..cb3f23e）与 `dwork`（8038d5c..cb3f23e）
- 清理：2 个沙箱误建垃圾文件（`nul') do @echo %i`、`{console.log(x.taskId`）已删除

## 三、官网打包上传（47.93.157.83:/var/www/lingxi/public）

- 上传前备份：`lingxi-engine-v2.0.20.tar.gz.bak-20260921-pre-repack`、`lingxi-engine.tar.gz.bak-20260921-pre-repack`、`version.txt.bak-20260921`
- 新包 MD5 `7933a2a4874476a70168bbcf813b8b5d`，具名包与通用包**一致**
- `version.txt` 更新 built 行（标注 L5 修复 + 技能入库 + md5）
- 验证：站内 200 / 外网 `http://47.93.157.83/lingxi-engine.tar.gz` → **200，1,139,764 B，1.76s**

## 四、遗留说明（有意不动）

- **版本号仍为 2.0.20**：本次为同版本重打包，与 09-18 先例一致。因含真实缺陷修复，建议下次正式发布 bump 至 2.0.21。
- **线上引擎进程未重启**（/opt/lingxi-engine）：属独立变更，不在「备份+官网包」范围内。
- `master` 分支与 main 分叉，历史线保留不动，已入 bundle。
