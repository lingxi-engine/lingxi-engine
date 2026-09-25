# 更新日志 CHANGELOG

本文档记录灵犀引擎各版本变更。日期格式 YYYY-MM-DD。

## [2.0.27] - 2026-09-25

本轮修的是**验证器自己的可信度**：两处「测试在说谎」被实测揪出。前者让验证模式输出错的版本号，
后者是一个**恒为假失败**的用例——而它一直挂着「4/4 通过」的名头。

### 修复 7：`install.sh --dry-run` 打印 `vunknown`（验证模式给出误导性版本号）

- `--dry-run` 不真下载解压，因而读不到包内 `version.txt`，banner 与「📥 下载灵犀引擎 vX」
  双双打印 `vunknown`——**一个专门用来做验证的模式，输出却是错的**。
- 修复：新增 `fetch_site_version()`，包内读不到版本时回退站点索引 `version.txt`
  （与 tar 包由 `publish-site.ps1` 同批次写入，版本硬门禁保证二者一致）。
- **诚实性约束**：站点也不可达时输出 `unknown` 并明确告警，**绝不编造版本号**。
- 真机实测（腾讯云 / 阿里云 Linux）：
  - 站点可达 → banner `v2.0.26`、下载行 `v2.0.26`
  - 站点不可达（`LINGXI_BASE_URL=http://127.0.0.1:9`）→ `vunknown` + `部署包内无 version.txt，无法确认版本`

### 修复 8：`test-install-linger.sh` 的「无 loginctl」用例**恒为假失败**

- 该用例想模拟"系统里没有 loginctl"，写法却是 `PATH="$TMPD:$PATH"`——**把真实 PATH 追加了回来**，
  宿主机自带的 `/usr/bin/loginctl` 依旧被 `command -v` 找到，于是走成功分支，用例**永远 FAIL**。
- 影响面：CI 的 `Installer logic tests` 步骤在该用例上一直红灯，"4/4 通过"的说法不成立
  （本轮实测复现：原版 install.sh 上 3/4，报 `FAIL: 未见缺失 loginctl 提示`）。
- 修复两处：
  1. `mode=none` 时 PATH **真正隔离**为 `$TMPD`；
  2. PATH 被隔离后裸 `bash` 找不到自己（实测 `rc=127: bash: command not found`），
     改用 `$BASH_BIN`（`command -v bash`）绝对路径调用。
- 新增防退化断言：**隔离不成功直接判 FAIL**，避免该用例哪天又悄悄失去意义。
- 修复后实测：**4/4 ALL CASES PASS**（原版与新版 install.sh 双向验证均通过）。

### 新增：`scripts/test-install-version-fallback.sh`（13 项，抽取式测试）

从真实 `site/install.sh` 抽取 `fetch_site_version()` 与两处调用点，用**桩 curl** 驱动，**不依赖网络**：

- 静态断言：定义存在 / dry-run 与部署后 else 两处调用存在 / 调用次数恰为 3 /
  无硬编码 `VERSION="x.y.z"` / LF-only / 无 BOM
- 行为断言：纯 LF、BOM+CRLF、无尾换行 三种输入均正确解析；
  **站点不可达 → 空输出（不编造版本号）**；无 curl 且无 wget → 空输出

### CI

- `hygiene-check` 的 installer 测试步骤并入 `test-install-version-fallback.sh`，覆盖 +13 项断言。

### 修复 9：`install.sh` 升级还原把 `.env` / `data` / `uploads` 落成脏名 —— **升级即掉配置**

- **`site/install.sh`**：`run cp -R "/tmp/lingxi-keep-$keep" "$INSTALL_DIR/"` 误以为 `cp` 会按
  「目标目录 + 原名」落文件；实际上 `cp` 按**源 basename** 命名，产物是 `lingxi-keep-.env`、
  `lingxi-keep-data`、`lingxi-keep-uploads`。三个用户资产**一个都没归位**。
- **后果链**：`.env` 不在 → 第 333 行 `[ ! -f "$INSTALL_DIR/.env" ]` 成立 → **重新生成随机
  `JWT_SECRET` / `ADMIN_TOKEN`**。用户表现为「升一次级，API Key 全没了、历史会话打不开」。
- **实测复现**（Git Bash 自带 GNU coreutils，与 Linux 同语义；非推断）：
  - 原版逻辑 → `.env` 缺失 ✗、`data/lingxi.db` 缺失 ✗、`uploads/f.txt` 缺失 ✗，脏名残留 3 个
  - 修复逻辑 → 三者在位 ✅（内容逐字节一致），脏名残留 0
- 修复要点：目录必须走 `cp -R "$SRC/." "$DEST/"` **合并内容** —— `uploads/` 在 tar 包内本就存在，
  若改成 `cp -R "$SRC" "$INSTALL_DIR/uploads"` 会被嵌套成 `uploads/lingxi-keep-uploads`；
  文件（`.env`）走显式目标名 `cp -R "$SRC" "$INSTALL_DIR/.env"`。
- **真机佐证**：升级日志出现 `✅ 已生成 .env（含随机密钥）` —— 旧 `.env` 本该被还原，
  轮不到重新生成。这一行就是该缺陷的指纹。
- 线上 `public/install.sh` 已定点更新并校验：SHA256 `c2476059…`、22915 → 23489 字节、
  `git ls-files --eol` = `i/lf w/lf attr/text eol=lf`、CR=0；旧版备份为
  `install.sh.bak-20260925-keepfix`（可一键回滚）。版本号动态读自 `version.txt`，故本次不涉及版本变更。
### 题外：发布元数据漂移（非代码缺陷，已清理）

- 发布服务器 `/var/www/lingxi/version.txt` 曾写着 `local HEAD d787b34` —— 该 commit
  **在 main 历史中不存在**，SHA 也对不上任何实际产物；已备份为
  `version.txt.bak-20260925-stale-d787b34` 并同步为与 `public/version.txt` 一致。

## [2.0.26] - 2026-09-25

本轮为**安装器可靠性修复**：在真实 Linux 服务器上验证安装流程时，沿调用链挖出三处独立缺陷。

### 修复 1：Linux 用户级 systemd 服务会随 SSH 断开而停止

- **`site/install.sh`**：脚本安装的是 `systemd --user` 服务，而用户级服务的生命周期绑在登录会话上。
  SSH 一断开，`user@<uid>.service` 被回收，引擎连带被杀，`Restart=on-failure` 无法自救——
  日志里的「登录自启 + 崩溃自动拉起」实际上只在「有人登录」时成立。
  - 紧随 `systemctl --user enable --now` 执行 `loginctl enable-linger "$(id -un)"`，
    使服务常驻，并在机器重启后自动拉起。
  - 降级策略：`loginctl` 不存在或返回非 0 时输出 `warn` 并给出手动命令，**不中断安装**。
  - 影响面：所有 Linux + systemd 用户会话环境。**已安装用户**手动执行一次
    `loginctl enable-linger $USER && systemctl --user restart lingxi-engine` 即可获得同等修复。

### 修复 2：换行符失控 —— `site/install.sh` 检出后会变成 CRLF（潜在致命）

- **新增 `.gitattributes`**：仓库此前**没有任何换行符约束**，而开发机 `core.autocrlf=true`。
  实测复现：`git checkout-index` 模拟一次全新检出后，`site/install.sh` 由 0 个 CRLF 变成 **542 个 CRLF**，
  首行成为 `#!/bin/bash\r`。该文件会被 `pack-release.ps1` 打进 tarball 分发给 Linux/macOS 用户，
  CRLF 的 shell 脚本会直接 `bad interpreter` 或语法错误 —— **安装器全盘失效**。
  - 现固定 `*.sh text eol=lf`（POSIX shell 必须 LF）、`*.ps1/*.bat/*.cmd text eol=crlf`，
    不再依赖使用者本地的 git 配置。
  - 验证：修复后模拟检出 `CRLF=0 / LF=542 / 首行 #!/bin/bash`。

### 修复 3：`version.txt` 的 UTF-8 BOM 让版本漂移检测永久失效

- 线上 `public/version.txt` 头三字节为 `EF BB BF`。根因：`scripts/publish-site.ps1` 用
  `[System.Text.Encoding]::UTF8` 写文件（该编码器**会输出 BOM**），而 `pack-release.ps1`
  早已改用 `UTF8Encoding $false` —— 同一个 bug 类**只修了一半**。
- 危害：`publish-site.ps1` 读回的是 `<BOM>2.0.25`，而 .NET 的 `String.Trim()` **不剥离 U+FEFF**，
  导致「本地 vs 线上」比较永远不相等，漂移检测退化为恒定告警（狼来了）。
- 修复 `publish-site.ps1`：改为无 BOM 写出，**并加硬门禁**——生成后立即回读首三字节，
  出现 BOM 直接 `W-Fail` 中止发布；本地/远端版本号读取均补 `TrimStart([char]0xFEFF)`。
- 修复 `site/install.sh`：版本号提取由 `tr -d '\r'` 改为 `tr -d '\r\357\273\277'`，
  同时剔除 CR 与 BOM，避免 banner / 桌面菜单 / systemd `Description` 出现幽灵字符。

### 修复 4：`publish-site.ps1` 的 scp 模式把安装脚本传到了死路径

- `scripts/publish-site.ps1` 的 scp 分支上传目标是 `${Path_}/../install.sh`，
  即 `/var/www/lingxi/install.sh`。但 `server.js:185-193` 明确**只从 `public/` 读取**
  `GET /install.sh` 与 `/install.ps1` —— 父目录是不被服务的死路径。
- 后果：**scp 模式从来没有真正更新过线上安装脚本**，线上 `public/install.sh` 一直是旧版
  （实测其 SHA256 = `136168a5a8…`，正是打补丁前的原始文件）。用户 `curl … | bash` 拿到的仍是旧逻辑。
  FTP 分支（把文件 put 到 `$Path_`）与 `-manual` 模式提示（复制到服务器 public/ 目录）都是对的，
  **只有 scp 分支写错了**。
- 修复：scp 目标改为 `$Path_/install.sh` 与 `$Path_/install.ps1`，与 FTP 分支及 `server.js` 路由对齐。
- 附带修复：发布后自检的版本比对只 `.Trim()` 不剥 BOM，会误报自检失败；已补 `TrimStart([char]0xFEFF)`。
### 修复 5：`loginctl` 调用未走 `run()`，破坏 `--dry-run` 契约

修复 1 引入时漏了这一点：`install.sh` 里所有会产生副作用的命令都通过 `run()` 包裹
（`DRY_RUN=1` 时只打印 `[dry-run]` 不执行），上下文 `systemctl` 也都是 `run systemctl ...`，
唯独新加的 `loginctl enable-linger` 是裸调用。

**在真实 Linux 服务器上实测复现**（`bash install.sh --dry-run`，并用 PATH 探针替换 `loginctl`）：

```
  [dry-run] systemctl --user daemon-reload              <- 正确：空转
  [dry-run] systemctl --user enable --now lingxi-engine.service   <- 正确：空转
PROBE: loginctl executed with args: enable-linger root  <- 错误：真的执行了
```

即 `--dry-run` 模式下仍会真实改写系统状态。已改为 `run loginctl enable-linger ...`。
测试同步升级：新增 `dry-run 不得有副作用` 用例（探针写入标记文件，断言标记不存在）；
`run()` 实现改为从 `install.sh` 中抽取，避免测试与实现漂移。

### 补充：CRLF 致死机制的实测证据（真 Linux）

此前对 CRLF 危害的描述停留在推断。本次在真实 Linux（kernel 6.6.102 / bash 5.2.15）上逐场景实测：

| 场景 | 结果 |
|---|---|
| `./install.sh` 直接执行（内核读 shebang） | ❌ `cannot execute: required file not found` |
| `bash install.sh` | ⚠️ 能跑，但输出带 `\r`（数据被污染） |
| `curl ... \| bash`（用户真实用法） | ❌ 多行 `if/then/fi` 结构报 `syntax error: unexpected end of file` |
| 变量比较 `if [ "$V" = "x" ]` | ❌ `syntax error: unexpected end of file` |

结论：`install.sh` 通篇是多行 `if ...; then` 块，因此 CRLF 版本在 `curl | bash` 下**根本无法执行**，
安装器全盘失效——与修复 2 的判断一致，现已有实证。
（注意：测试须在真 Linux 上做。Git Bash / MSYS2 会**掩盖**该问题，本地测不出来。）

### CI 加固

`.github/workflows/ci.yml` 的 `hygiene-check` 新增两步：

1. **Shell scripts: syntax check + LF gate** —— 对所有被跟踪的 `*.sh` 跑 `bash -n`，
   并用 `grep -qU $'\r'` 硬拦 CRLF（第二道防线，防止 `.gitattributes` 被误删或新脚本带 CRLF）。
   含自检：若 `*.sh` 一个都没找到，直接报错退出，避免门禁退化成空跑。
2. **Installer logic tests** —— 跑 `scripts/test-install-linger.sh` 与 `scripts/test-version-parse.sh`。

两个门禁均已本地逐条模拟通过；LF 探测器另做了自检（对 CRLF / 混合 / LF 三种样本判定正确）。
### 修复 6：`publish-site.ps1` 的 `-manual` 提示文案与实际不符

`-manual` 模式只打印提示不上传，提示里有两处错误（实际运行该模式逐字确认）：

- 标题写 `Copy these two files`，但下面**列了四条**。
- 第 3/4 条写成 `$SiteUrl/install.sh`，缺 `/public/`，与第 1/2 条（`$SiteUrl/public/...`）不一致；
  且 `server.js` 明确只从 `public/` 提供这两个文件，按旧提示放置会落到不被服务的路径。

修复后实际输出：

```
[WARN] manual mode: no upload performed. Copy these four files into the server public/ dir:
  1) <tarball>      ->  http://47.93.157.83:8080/public/lingxi-engine.tar.gz
  2) <version.txt>  ->  http://47.93.157.83:8080/public/version.txt
  3) <install.sh>   ->  http://47.93.157.83:8080/public/install.sh
  4) <install.ps1>  ->  http://47.93.157.83:8080/public/install.ps1
```

> 说明：上一轮我在 `publish-site.ps1` 的注释里写「FTP 分支与 -manual 提示都是对的」，
> 那是**未经实测的推断，且是错的**。本轮实跑 `-Method manual` 后才发现并修正。
### 测试

- **`scripts/test-install-linger.sh`**：从真实 `install.sh` 中**抽取**补丁块（而非复制副本，防止测试与实现漂移），
  mock `loginctl` 覆盖「成功 / 失败 / 不存在」三分支 → **3/3 PASS**。
- **`scripts/test-version-parse.sh`**：覆盖「纯 LF / BOM+LF / BOM+CRLF / CRLF / 无尾换行」5 种形态 → **5/5 PASS**，
  并附字节级证据（`ef bb bf 32 2e 30 2e 32 36` → `32 2e 30 2e 32 36`）。

### 版本治理

- 版本统一为 **2.0.26**（`package.json` / `package-lock.json` / `version.txt` 三处对齐）。
- 门禁：`tsc --noEmit` **0 错误**；`vitest run` **100/100 通过**；`bash -n site/install.sh` 通过；
  `publish-site.ps1` PowerShell 解析 **0 错误**。
- 安装脚本随 tarball 分发（`pack-release.ps1` 有硬门禁校验 `site/install.sh` 在包内），
  故本次**必须重新打包**，不能只替换线上单个文件。
## [2.0.25] - 2026-09-24

### 新功能：会话/群聊重命名（新建会话与新建群聊体验对齐）

- **`PATCH /api/chats/:id/name`**（`src/routes/friends-chats.ts`）：私聊与群聊通用改名端点。
  - 权限：`requireAuth` + 参与者校验（JWT `sub`/`numeric_id` 必须命中 `participants` 表），非参与者返回 403；本地免登录模式（`admin-auto`/`admin-token`）跳过一致性检查。
  - 校验：会话不存在 404；名称为空/纯空白 400；超过 60 字符 400；首尾空白裁剪。
  - 成功后广播 `chat.renamed` 事件，多端同步。
- **前端 `web/js/app.js`**：
  - `newChat()` 新增命名 `prompt`（此前硬编码「新会话」，导致「点新建总是新会话」）；空名 toast 提示后放弃创建，与 `showCreateGroup()` 的必填语义一致，ESC 依旧静默取消。
  - 新增 `renameChat(chatId)`，会话列表每项新增 ✏️ 按钮（置于 🗑 左侧，`stopPropagation` 防误触切换），改名后同步 `myChats`/`chatTitle`/列表渲染。
- **i18n**：新增 8 个 key（`chat.newChatNamePh`/`chat.renameChatPh`/`chat.renameTitle`/`chat.renameEmpty`/`chat.renameTooLong`/`chat.renamed`/`chat.renameFail`/`chat.selectChatFirst`），覆盖简/繁/英/日/韩/越 6 语言。
- **测试**：新增 `src/tests/chat-rename.test.ts`（10 例，真实 `initDB` + supertest 打真实 HTTP），覆盖 401/404/400/403 越权防护、名称真实落库、`chat.renamed` 广播、群聊同名可改、空白裁剪、60 字符边界。

### 版本治理

- 版本统一为 **2.0.25**（`package.json` / `package-lock.json` / `version.txt` 三处对齐）；修正功能注释中误写的 `v2.1.5` 版本口径漂移。
- 测试总数 90 → **100**，CI 注释同步更新。

## [2.0.24] - 2026-09-23

### 新功能：灵犀 MVP 市场闭环

- **MVP 服务层**（`src/core/mvp-market/service.ts`，约 1000 行）：任务 → 报价 → 合同 → 交付 → 验收 → 评价 → 争议 → 结算 → 通知 → 审计日志全链路状态机，26 个业务方法。
- **MVP 路由层**（`src/routes/mvp-market.ts`，346 行）：26 个端点，挂载于 `/api/mvp`（`index.ts`），传入 `requireAuth`/`optAuth`/`adminAuth` 权限中间件。
- **智能体能力**：创建智能体、配置技能、设置预算（`setAgentBudget`）、生成任务建议（`generateTaskSuggestions`）。
- **数据库**：11 张 MVP 表迁移；账本无漂移校验。
- **测试**：新增 `src/tests/mvp-market.test.ts`（59 例）+ `src/tests/mvp-initdb.test.ts`（3 例，走真实 `initDB()` 迁移链验证 11 张表真能建出来）。
- **CI**：ts-engine job 接入 Vitest suite 步骤，闭环测试在 push/PR 自动跑。

### 修复

- **CI YAML 损坏**（commit `2cd5245`）：历史 commit `8038d5c` 用 PowerShell 处理 BOM 时把 `ci.yml` 里 BOM gate 的中文注释写成 GBK 乱码，并吞掉第三行换行符，导致 `run: |` 挤进注释行、整个 workflow 无法解析。已从 `1b915e1` 提取正确原文做字节级恢复（保持 CRLF、无 BOM）。
- 清理误提交的 0 字节垃圾文件 `{const` 与 `m[1].toUpperCase()+'`。

### 版本治理

- 版本统一为 **2.0.24**（`package.json` / `package-lock.json` / `version.txt`）。

## [2.0.23] - 2026-09-22

### 修复（自 v2.0.22 tag 以来 7 个 commit 的累积变更）

- **collab 黑洞修复**（hub.ts + subagent-manager.ts）：collabSpeak 新增 Promise.race 硬超时兜底，消除 L5-005 永久卡 running；OpenAI client 补齐 timeout:120000 + maxRetries:1
- **bench SUMMARY 汇总修复**（ws-adapter.cjs）：manual 题不再被跳过统计；NaN% 改为 -；残缺 JSON 容错；新增 --summarize 离线重算入口
- **打包器修复**（pack-release.ps1）：SW 缓存门禁改为正则，修复打包永久失败；排除测试数据目录
- **版本治理**：.gitignore 清理；新增诊断技能文件

### 版本对齐

- package.json / version.txt / CHANGELOG.md 统一 2.0.23
- Git tag v2.0.23 指向 HEAD

## [2.0.22] - 2026-09-22

### 工具层 & 评测度量修复（解锁 L4/L5 重跑）
- **web_fetch 大页面截断修复**（`src/tools/builtin.ts`）：新增 `offset` 分段读取，返回 `total_chars`/`truncated`/`next_offset`；HTML 正文抽取（去 nav/header/footer/aside/form/script/style，优先 `<article>/<main>`）；错误分类 `http_403`/`http_429`/`http_5xx`/`timeout`/`too_large`/`network` 并标注 `retryable`。不再仅靠加大预算绕过
- **多 Agent 事件回传修复（G6 steps=0 根因）**：`SubAgentManager` 新增全局进度回调 `setProgressHandler`，`index.ts` 将其接到 WebSocket `broadcast`，发出 `agent.tool.call`。子代理内部工具调用不再丢失，bench 步数/工具调用统计恢复真实（详见 `bench/L5-STEPS0-ROOTCAUSE.md`）
- **bench 适配器度量自检**（`ws-adapter.cjs` 对「steps=0 但输出含工具痕迹」的记录打 `metricSuspect` 标记，SUMMARY 追加告警行）
- **修复违规扫描漏报**：`ws-adapter.cjs` 的 `scanViolations` 转义被写坏，导致含正则特殊字符的违规片段永不命中，已修正

### 版本治理
- `/api/health` 的 `version` 改为运行时读取 `package.json`（回退 `version.txt`），消除硬编码漂移
- 版本统一至 **2.0.22**（`package.json` / `package-lock.json` / `version.txt`）
- **打包脚本版本动态化**：`scripts/pack-release.ps1` 原本硬编码 `2.0.20`（升版后必 FAIL），改为从 `package.json` 读取；打包时写入 `BUILD-INFO.json`（version/commit/buildTime）并加一致性断言
- **部署后 SHA 校验**：新增 `scripts/verify-deploy.cjs`（`npm run verify:deploy`），比对线上 `/api/health` 的 version/commit 与代码，漂移则 exit 1

## [2.0.21] - 2026-09-21

### 版本治理 + 可观测性补齐
- `/api/health` 新增 `commit`（短 SHA）与 `buildTime` 字段，运行时可直接比对线上实例与代码版本，消除「代码态 ≠ 运行态」盲区（`index.ts`）
- 版本号统一至 **2.0.21**：`package.json` / `package-lock.json` / `version.txt` 三处对齐（此前 package-lock 滞后）
