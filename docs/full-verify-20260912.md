# 全量核查记录 — 2026-09-12（今日 37 提交四方对齐实测）

> 核查时间：2026-09-12 06:17–06:45（Asia/Shanghai）
> 范围：2026-09-12 03:20–05:52 的 37 个提交（v2.0.17 发布链：推理流修复 → 打包清理 → BOM 修复 → 四方同步）
> 方式：全只读实测 + F 盘快照回验，零进程操作

## 一、版本控制（git / GitHub）

| 项 | 实测 |
|---|---|
| 本地 HEAD | `6b138bd`（含本核查记录提交） |
| origin/main | `6b138bd`（ahead/behind = 0/0）✅ |
| 工作区 | 零真实改动（494 个 `M` 全为 CRLF 假象，`--ignore-cr-at-eol` 后归零）✅ |
| 未跟踪文件 | 无 ✅ |

## 二、今日核心修改逐项验证

| 修改 | 验证方式 | 结果 |
|---|---|---|
| `pack-release.ps1` BOM 修复 | 首三字节 = `EF BB BF`，10959 B，PSParser Tokenize | **ParseErrors: 0** ✅ |
| 版本号五处对齐 | version.txt / package.json / package-lock.json / index.ts:592 / admin.ts:499 | 全部 `2.0.17` ✅ |
| Ollama reasoning 双键 | 服务端 grep `reasoning_content` 读取点 13 处全带 `reasoning` 兜底；app.js 1076/1080/4610 三处双键 | ✅ |
| PWA 缓存 bump | `web/sw.js:2` = `lingxi-v18` | ✅ |
| 编译 | `tsc --noEmit` | **0 错误** ✅ |
| 测试 | `vitest run` | **28/28 passed**（2 test files）✅ |
| DEPLOY_RECORD 第九节 | UTF-8 读入，九节齐全 | ✅ |
| 5 个新增 skills JSON | 逐个 ConvertFrom-Json | 全部 OK ✅ |

## 三、F 盘备份

| 项 | 实测 |
|---|---|
| bundle | `lingxi-engine-git-20260912-final-6b138bd.bundle`，13 refs，main = `6b138bd`，`git bundle verify` = okay ✅ |
| 官网快照 | `lingxi-site-20260912-v2017-final.tar.gz`，123 条目，md5 `3ac1b233008ea11b660d1367efa9bc03` ✅ |
| **快照回验（上轮悬项）** | 解包比对：快照内 `public/version.txt` = `c69169c3…`、`public/download.html` = `4be2230d…`，与服务器线上 md5 **逐字节一致** | **PASS** ✅ |

## 四、官网线上（http://47.93.157.83:8080 实测）

| 项 | 实测 |
|---|---|
| `/public/version.txt` | `2.0.17`，built 05:48:40，含 v6.7 清理说明 ✅ |
| `/public/lingxi-engine-v2.0.17.tar.gz` | HTTP 200，1173394 B，下载回算 md5 = `cdf997e2a37be8a4c1c0facf2fe54c0e` **与本地打包产物一致** ✅ |
| `/js/app.js`、`/sw.js` | 与本地 `web/` **FC 逐字节一致** ✅ |
| `/download.html` | 4 处 v2.0.17、主下载链指向 v2.0.17.tar.gz ✅ |
| `/install.sh` | `VERSION="2.0.17"` ✅ |
| `/CHANGELOG.md` | 含 2 处 2.0.17 ✅ |
| **全链接扫描** | **21/21 URL 全 200**（version/install.sh/install.ps1/tar.gz×2/页面×6/js×3/css×3/sw/favicon/manifest/icon/CHANGELOG）✅ |
| 服务器备份 | `/var/www/lingxi/backup-20260912-v2017-clean/`（public-generic / public-v2.0.17 / releases-v2.0.17 / version.txt）✅ |

## 五、域名误报澄清（重要）

核查中曾怀疑 `lingxi-engine.cn` 域名过期被删（CNNIC whois 三次 "No matching record"，阿里/谷歌/114 DNS 全 NXDOMAIN）。深挖后确认：

- **该域名从未注册**，非过期事故
- install.sh / install.ps1 全部官方地址为 `http://47.93.157.83:8080`
- 服务器未装 nginx，node 直接监听 8080（pid 3073051）
- git 全历史 `-S "lingxi-engine.cn"` 零命中

结论：官网一直走裸 IP，一切正常。此前报告中的"域名"为口语称呼，不存在域名事故。

## 六、进程安全

PM2 三进程 restart 计数全程未变：`lingxi-mesh 82` / `lingxi 23` / `lingxi-site 10`。本地引擎进程同样未动。

## 七、遗留（待授权，均需重启或外部操作）

1. 本地引擎进程为 2.0.16 快照（03:20 启动，早于 v2.0.17 提交），推理流修复未进内存
2. 服务器引擎 `/api/health` 仍报 2.0.15，升级需重启 PM2
3. GitHub 2 个 high 级 Dependabot（image-size，上游无补丁，DoS-only）

## 八、补充核查（06:16–06:45 第二轮）

| 项 | 实测 |
|---|---|
| 官网全链接扫描 | 21/21 URL 全 200（含 public/install.ps1、market 系列、favicon）✅ |
| 今日 mtime 全量扫描 | 37 文件中 34 个已提交；`.env`/`data/*` 为运行时数据不入库；`scripts/*.bak-*` 为打包前备份，符合预期 ✅ |
| F 盘 bundle 引用 | `final-6b138bd.bundle` main = `6b138bd` = HEAD = origin/main ✅ |
| **幽灵模型已扶正** | 06:16 并行修复：Ollama 实测新增 `glm-5.3:cloud`（/api/chat 响应正常），`.env` DEFAULT/TOOL/REPLY_MODEL 三处一致指向；providers.json Ollama 列表已含 5.3 ✅ |
| F 盘空间 | 剩余 2.19 GB，18 个 bundle 建议清理至最近 3 个（待授权） |

遗留仅剩（均需重启/授权）：本地引擎 2.0.16 快照待重启、服务器引擎 2.0.15 待升级、GitHub 2 个 Dependabot high（上游无补丁）。