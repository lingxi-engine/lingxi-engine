# F 盘备份清单 — 2026-09-12（v2.0.17）

> **性质说明**：本清单是**时点快照记录**。执行期间有**并行 agent** 在同一工作区持续提交
> （dev 文档 + 版本号修正），故官网包与 bundle 被重打多次。下表为**最终一次**产物；
> 代码（`src/` `web/`）自 `64debb1` 起未变，仅文档与版本兜底常量在动。

## 一、最终产物

| 产物 | 字节数 | 时间 | 完整性校验 |
|---|---|---|---|
| `F:\lingxi-engine-git-20260912-final.bundle` | 260,711,646 | 09-12 04:38 | `git bundle verify` = **okay**；`refs/heads/main` = **最新 HEAD**（每次提交后整体重建） |
| `F:\lingxi-site-20260912-lean.tar.gz` | 5,928,288 | 09-12 04:39 | **MD5 `d8b774562a628f76970736286e7d891b`**（= 服务器源文件） |
| 官网发布包（服务器 3 处） | 1,292,762 | 09-12 04:38 | **MD5 `a8330f12f0fdef44f3e6a8af74f5d330`** |

备份源：本地仓库 `C:\Users\Administrator\lingxi-engine`、服务器 `root@47.93.157.83:/var/www/lingxi`。

## 二、四方对齐状态

| 位置 | 状态 |
|---|---|
| 本地 git | HEAD `b43dd42`（写入本表时），工作区无未跟踪文件 |
| GitHub `origin/main` | 与本地一致，`rev-list --left-right --count` = `0 0` |
| F 盘 bundle | `--all`，verify = okay，13 refs，历史完整 |
| F 盘站点快照 | MD5 `d8b77456…`，与服务器逐字节一致（122 条目） |
| 官网发布包 | 三处同 md5 `a8330f12…`，HTTP 全 200 |

## 三、官网代码逐文件核验（vs 仓库 HEAD）

22 个前端文件做 **nocr-md5 + 尺寸** 双比对，仓库 `web/` 与服务器 `/var/www/lingxi/public/`
**22/22 完全一致**（`index.html` 100664B / `official.html` 10666B / `download.html` 17670B /
`admin.html` / `js/app.js` / `js/i18n.js` / `sw.js` / `manifest.json` / `css/*` / `favicon.ico` / `icon.svg`）。

**架构澄清：**
- 对外首页 `/` 由 `server.js` 返回 **`public/official.html`**（10666B），非根目录 `index.html`；
- 根目录 `index.html`(86716B, 08-13) 与 `css/ js/ sw.js favicon.ico(77522B)` 为**不可达的僵尸文件**，未改动；
- 下载链 `/public/lingxi-engine-v2.0.17.tar.gz` 与通用名 `/public/lingxi-engine.tar.gz` 均 200，与 `releases/` 同 md5；
- `/public/package.json` 是指向 `/opt/lingxi-engine/package.json` 的符号链接（既有设计）。

## 四、站点快照打包规则

```
tar czf … --exclude='*node_modules*' --exclude='./site-backup-*' --exclude='./backup-*' \
  --exclude='*bak*' --exclude='*.exe' --exclude='*.zip' --exclude='./public/*.tar.gz' \
  -C /var/www/lingxi .
```
排除：`public/灵犀引擎-desktop-1.1.0-portable.exe`(80MB)、`public/*.tar.gz`(历史包约50MB)、
`node_modules`、服务器侧 `backup-*`/`site-backup-*`/`*bak*`。传输后 MD5 双向核对一致。

## 五、遗留 / 未动

- **线上引擎仍为 2.0.15**（`/api/health`）；源码已 2.0.17。升级须 **重启 PM2 `lingxi`**；
  用户明确要求「不要杀进程」，**未执行**。
- F 盘 `lingxi-engine-source-20260908.tar.gz` = 4,294,963,200 B（恰 4 GiB），**疑似截断坏档**。
- GitHub 2 个 high 级 Dependabot 漏洞，待处理。
- F 盘剩余约 2.9 GB。

## 六、本轮官网包重打记录

| 时间 | HEAD | 包 md5 | 说明 |
|---|---|---|---|
| 04:24 | 9df43e3 | `56c0f831` | 补 `DEPLOY_RECORD_20260912.md` |
| 04:28 | adb458f | `0cd1bb43` | CHANGELOG 补齐 2.0.13~2.0.17 |
| 04:31 | e18939e | `ba689c88` | DEPLOY_RECORD 补记 |
| 04:33 | d653c44 | `2e2220af` | .bak 归档补记 |
| 04:35 | 93fea33 | `6dc2adaa` | **版本号漂移修正**（health/admin 兜底 2.0.17） |
| 04:38 | b43dd42 | `a8330f12` | 最终（DEPLOY_RECORD 126 行） |

旧版本备份于服务器 `/var/www/lingxi/backup-20260912-v2017b/`。

## 七、第三轮收尾（同日再后段）：发布包 v6.7 清理重建 + 官网覆盖上传

### 1. 编码缺陷修复（阻断性）
- `scripts/pack-release.ps1` v6.7 含中文注释，但保存为 **UTF-8 无 BOM**；PowerShell 5.1 按 GBK 解码 → 注释字节可能被误读为 `'` `"` 反引号而破坏语法
- 处理：重存为 **UTF-8 with BOM**（`EF BB BF`，实测首三字节合格），中文注释保留；`Parser::ParseFile` 校验 PARSE-OK
- 备份：`scripts/pack-release.ps1.bak-20260912-v67-preBOM`

### 2. v6.7 打包器清理效果（服务端实测对比）

| | 旧包（04:40 版） | 新包（v6.7） |
|---|---|---|
| 条目 | 738 | **707** |
| 垃圾项 | **33**（24×`.pyc` + `__pycache__/` + 5×tests-data json + 3×`_result.txt` + 1×`.bak`） | **0** |
| 大小 | 1,293,601 B | 1,173,394 B |
| `.env` 泄漏 | 无 | 无 |
| `.env.example` | 有 | 有（显式校验） |

- 产物 MD5：`cdf997e2a37be8a4c1c0facf2fe54c0e`
- 打包器 7 组内置校验全部 `[OK]`（结构 / 垃圾 / env / key files / v5 安全 / v2.0.17 平台管理 / v2.0.17 推理流）

### 3. 官网覆盖上传（47.93.157.83）
- 服务端备份：`/var/www/lingxi/backup-20260912-v2017-clean/`（可回滚）
- 三处覆盖（`releases/`、`public/` 带版本名、`public/lingxi-engine.tar.gz`）→ **md5 三处一致**
- 外网下载回算 md5 = MATCH ✅（最硬证据：用户真能下到一致的包）
- 站内 6 个 URL 全 200，无 404

### 4. 工作区清理
- 31 个会话临时脚本整体移入 `workspace/_archive/20260912-scratch/`（移动可逆，未删除）
- 该目录被 `.gitignore` 第 77 行 `workspace/` 覆盖，不影响仓库状态

### 5. 本轮提交与备份刷新（本次收尾）
- 提交内容：`scripts/pack-release.ps1`（BOM 修复）+ `DEPLOY_RECORD_20260912.md`（并入第九节）+ 本清单第七章
- F 盘 `lingxi-engine-git-20260912-final.bundle` **整体重建**（跟随 `main` 最新），并留一份带哈希快照 `…-0261254.bundle`
- 官网快照：`lingxi-site-20260912-v2017-final.tar.gz`

### 6. 仍未处理
- **线上引擎仍为 2.0.15**（`/api/health`），源码已 2.0.17；升级须**重启 PM2 `lingxi`** —— 用户明确要求「不要杀进程」，**未执行**（三轮均未触碰任何进程，PID 3069242 / 3070698 / 3073051 restart 计数 82/23/10 未变）
- GitHub 2 个 high 级 Dependabot 告警：上游无补丁（详见 `DEPLOY_RECORD_20260912.md` 第八节）
- ~~`.env` 的 `DEFAULT_MODEL=glm-5.3:cloud` 为幽灵模型~~ **已解决（09-12 06:16）**：本地 Ollama 已实际支持 `glm-5.3:cloud`（`/v1/chat/completions` 实测回 OK、finish=stop），`.env` 三处模型配置一致指向；**服务器侧仍为真幽灵**（服务器 Ollama 仅装 qwen2.5 且需认证，glm 系列调 401），详见 `docs/server-env-audit-20260912.md`


## 八、全量核查轮次 bundle 追加（09-12 06:25–06:40）

「检查今日修改」任务五轮核查期间，每轮记录提交后均重建 bundle，F 盘现状：

| bundle | main 提交 | verify |
|---|---|---|
| `…-final-6b138bd.bundle` | `6b138bd` 核查记录 v1 | okay |
| `…-final-b036bc9.bundle` | `b036bc9` 补充第八节 | okay |
| `…-final-fc8c1c8.bundle` | `fc8c1c8` 服务器环境核查 | okay |
| `…-final-5dd5ace.bundle` | `5dd5ace` 运行日志核查 | okay |
| `…-final-HEAD.bundle` | `4e51800` 技能体系核查（**当前最新**） | okay |

- 官网快照 `lingxi-site-20260912-v2017-final.tar.gz`（md5 `3ac1b233`）经解包回验与服务器线上逐字节一致
- F 盘剩余空间 1.22 GB；当日 9 个 bundle 共 2.35 GB，建议清理至最近 3 个（待授权）

## 九、F 盘空间归档（09-12 07:10，响应第八章清理建议）

- **动作**：24 个 bundle 中的 22 个旧 bundle + 5 个旧站点快照，Move-Item 移至 D:\lingxi-archive\（git-bundles / site-snapshots 两个子目录），移动可逆零删除
- **F 盘保留**：最新 2 个 bundle（-final-ed666d0 / -final-9493ef3）+ lingxi-site-20260912-v2017-final.tar.gz
- **空间**：F 盘 753 MB → 6.0 GB；D 盘归档 23 bundles + 5 snapshots（D 盘总空闲 25 GB）
- **快照独立复验**：lingxi-site-20260912-v2017-final.tar.gz（md5 3ac1b233）本地解包 + 服务器 find -exec md5sum 逐文件比对，107 文件全部一致；快照不含服务器侧 *.bak-* 备份与 public/*.tar.gz 历史包（打包规则既定排除，见第四章）

## 十、安全加固轮终态（09-12 07:40–07:55，第十六节后）

### F 盘当前持有
- `lingxi-engine-git-20260912-final.bundle`（260,730,740 B，main = 0beec6c，16 节全记录）
- `lingxi-site-20260912-lockdown.tar.gz`（86,581,306 B，md5 dec5c617851143108916f9e226f152f0，官网锁定版快照：server.js + public/ + docs/ + version.txt）
- 历史快照：lingxi-site-20260911.tar.gz（496 KB）、lingxi-site-20260912-v2017-final.tar.gz（5.8 MB）

### 本日安全加固轮（对 F 盘的影响）
- git bundle 重建 6 次（e03b015 → b539c45 → f4d029e → 11b511f → fc9456e → 73c3b30 → bd76a29 → 0beec6c），每次 verify okay
- 官网快照从 v2017-final（升级前）升级为 lockdown（终态，含归档后公开面 20 项）
- D:\lingxi-archive\ 不变（22 bundle + 5 快照历史归档）

### 服务器归档区（非公开，可回滚）
- /var/www/lingxi/archive-20260912-locked/：30 项（引擎 UI 壳/旧版本包/泄漏文档 V11/tmp 历史备份）
- /opt/lingxi-engine-backups/20260912-prelock/：engine-src-2.0.15.tar.gz
- /opt/lingxi-engine/.env.bak-20260912-prelock、.env.platform.bak-20260912
- /var/www/lingxi/server.js.bak-20260912-prelock、official.html.bak-20260912-prelock

### 本地 .env 修复（本轮新增）
- 幽灵模型 glm-5.3:cloud ×3（DEFAULT/TOOL/REPLY）→ glm-5.2:cloud（实测存在于本地 Ollama，/v1/models 200）
- 备份：.env.bak-20260912-premodel
- 生效时机：下次引擎重启（运行中进程不受影响，本地进程未动——用户红线）
