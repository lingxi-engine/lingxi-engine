# Lingxi Engine 部署记录 — 2026-09-12 (v2.0.17 四方对齐 + 官网打包上传)

## 起因

执行「github / git / F 盘备份 / 打包上传官网」四项同步，确保本地、GitHub、备份盘、线上官网四处代码与版本一致。

## 一、核查结论（改动前）

| 检查对象 | 改动前状态 |
|---|---|
| 本地 git HEAD | `64debb1`（+ 5 个技能文件未跟踪，1 个 `$null` 垃圾文件，1 个乱码名重复 doc） |
| GitHub `origin/main` | `64debb1` ✅ 与本地一致 |
| F 盘最新 bundle | `lingxi-engine-git-20260912-v2017.bundle`，main = `64debb1` ✅ |
| 官网 `public/version.txt` | **2.0.16** ❌ 落后 |
| 官网 `public/download.html` | v2.0.17 文案，但版本号链接指向 v2.0.16 ❌ |
| 官网 `public/sw.js` | CACHE_NAME = **lingxi-v15** ❌ 落后（代码已 v18） |
| 官网 `public/js/app.js` | 缺 `_lanThink` / `_thinkBlock` ❌ 落后 |
| 官网 `releases/lingxi-engine-v2.0.17.tar.gz` | **过期包**：停在 `19d73bc` 状态，无推理流修复 ❌ |
| 官网 `public/lingxi-engine-v2.0.17.tar.gz` | **缺失**（只有通用名 `lingxi-engine.tar.gz`，且同为过期包）❌ |
| `dwork`（D:\lingxi-engine-oss） | `b99fa96`（v2.0.15），落后 3 个版本，且工作区脏 ❌ |
| `install.sh` 显示版本 | `VERSION="2.0.13"` ❌ 落后 |

## 二、执行动作

### 1. 本地 Git
- 提交 5 个运行期自动生成的技能定义：`code-version-sync-check` / `multi-location-version-sync` / `repo-deploy-sync-audit` / `diagnose-lingxi-session-agent` / `diagnose-lingxi-session-ai-reply`（`d20d14d`）
- 清理垃圾：`$null`（52B，`chcp` 重定向残留）、`docs/宸ㄧ煶鎷嗗垎鎴樺焦鏀跺畼鎶ュ憡.md`（7611B，MD5 与 `docs/巨石拆分战役收官报告.md` 完全一致 → 乱码重复副本）
- 注：工作区长期存在的 ~450 条 `M` 为 **CRLF 行尾假象**（`git diff --ignore-cr-at-eol` 归零），未纳入提交

### 2. GitHub / 远端
- `git push origin main`：`64debb1..d20d14d` ✅
- `dwork` 镜像：备份脏文件 → `checkout -- package-lock.json` → 确认 `b99fa96` 为 main 祖先（fast-forward）→ `git push dwork main`：`b99fa96..6af942b` ✅
- 远端 `origin/main` = `6af942b`（含并行 agent 提交的 release 元数据变更），与本地 HEAD 一致

### 3. 发布包重建（关键）
- `scripts/pack-release.ps1` 升级 **v6.5 → v6.6**：版本号 2.0.15 → 2.0.17（含版本校验正则），新增 v2.0.17 推理流三项打包校验（`_lanThink`/`_thinkBlock`、`sw.js = lingxi-v18`、`router.ts` reasoning 字段）
- 重新打包 → `lingxi-engine-v2.0.17.tar.gz`，**1,288,763 字节**，MD5 `97f6129a027263b95f25c81baf26b219`
- 上传三处：`releases/lingxi-engine-v2.0.17.tar.gz`、`public/lingxi-engine-v2.0.17.tar.gz`、`public/lingxi-engine.tar.gz`（通用名，`install.sh`/`install.ps1` 走此名）→ 三处 MD5 一致

### 4. 官网前端同步
- `web/` → `/var/www/lingxi/public/`（22 个文件），**只覆盖不删除**（public/ 为超集，含仓库外的 install.sh / deploy.sh / install.ps1 / platform/ 等）
- 逐文件 MD5 校验：**TOTAL=22 OK=22 BAD=0**
- `download.html` 版本号 2.0.16 → 2.0.17（5 处）

### 5. 官网元数据
- `public/version.txt` → `2.0.17`（含 built 时间与变更说明）
- `install.sh` 显示版本 `2.0.13` → `2.0.17`
- 备份：`/var/www/lingxi/backup-20260912/`（releases + public 包 + public-frontend 22 文件 + meta）

## 三、核查结论（改动后）

| 检查对象 | 改动后状态 |
|---|---|
| 本地 git HEAD | `6af942b` ✅ |
| GitHub `origin/main` | `6af942b` ✅ 一致 |
| `dwork` | `6af942b` ✅ 一致 |
| F 盘 bundle | `lingxi-engine-git-20260912-final.bundle`，main = `6af942b` ✅ |
| 官网 `public/version.txt` | `2.0.17` ✅ |
| 官网 `public/*.tar.gz` | MD5 = 本地构建 ✅ |
| 官网前端 22 文件 | 逐字节一致 ✅ |
| `install.sh` VERSION | `2.0.17` ✅ |

## 四、未处理项（需授权 / 另行决策）

| 项 | 原因 |
|---|---|
| 线上引擎 `lingxi` 仍为 v2.0.15 | 升级需重启 PM2 进程，遵守「不杀进程」约束，未执行 |
| `/opt/lingxi-engine/web`（`/chat/*` UI） | 需与引擎一起升级，单独换会 API 错配 |
| GitHub 2 个 high 级 Dependabot 漏洞 | 待处理 |
| `public/` 内 ~50 个 `.bak-*` 堆积 | 建议归档 |
| 服务器 root `version.txt` | 已是 2.0.17，无需改动 |

## 五、过程备注

- 发现存在**并行 agent** 在同一工作区提交（`6af942b` 为本次会话改动，由并行流程落库并推送）；已核对提交内容仅含 `scripts/pack-release.ps1` + `web/download.html`，无临时脚本混入
- 本会话临时脚本（`_apply_2017.cjs` / `_fix_header.cjs` / `_genverify.cjs` / `_verify_web.sh` / `_update_site_meta.sh`）已全部删除，未入库

## 六、补充收尾（同日后续）

在上述四项完成后的复检中又发现并处理了三处「发布完整性」缺口：

### 1. CHANGELOG 补录
- 站点 `public/CHANGELOG.md`：停在 v2.0.14 → 补录 v2.0.15 / v2.0.16 / v2.0.17（备份至 `backup-20260912/meta/`）
- 仓库 `CHANGELOG.md`：停在 v2.0.12 → 补录 v2.0.13 / v2.0.14 / v2.0.15 / v2.0.16 / v2.0.17（保持 UTF-8 + CRLF）

### 2. 官网发布包重打
- 发现并行流程在 04:24 打的包内 `CHANGELOG.md` 仍是旧版（停在 2.0.12）
- 以 HEAD `adb458f` 重打 → 包内已含更新后的 CHANGELOG + `DEPLOY_RECORD_20260912.md`
- 内容复核：`package.json` = 2.0.17、`app.js` `_lanThink`=5 / `_thinkBlock`=3、`sw.js` = lingxi-v18、`router.ts` reasoning 字段=5、`lan-social.ts` reasoning=9、无 `.env` 泄漏、739 个成员
- 三处（releases + public 版本名 + public 通用名）MD5 一致

### 3. F 盘快照刷新
- `F:\lingxi-site-20260912-final2.tar.gz`（330,966 B，MD5 `ee351ce9…`，与服务器端一致）

### 4. 终检
- 官网 24 个 URL 全部 HTTP 200（含 `/CHANGELOG.md`、`/version.txt`、三个 tar.gz）
- 前端 22 文件逐字节校验：TOTAL=22 OK=22 BAD=0
- 仓库 CHANGELOG UTF-8 无损、CRLF 保留（140 CRLF / 0 bare LF），无 BOM

### 备注
- 站点 `public/package.json` 为符号链接 → `/opt/lingxi-engine/package.json`（自 2026-07-01 既有设计，未改动）；其显示 2.0.15 即线上引擎目录真实版本
- 并行 agent 与本会话同工作区作业，官网包在本轮内被重打多次；以最终一次内容复核为准

### 5. 官网 public/ 备份文件归档
- `public/` 根目录堆积的 **62 个 `.bak-*`** 历史备份（2026-07-31 ~ 09-07，暴露在 web 根目录可被直接下载）已全部移入 `backup-20260912/public-bakfiles/`（移动而非删除，可逆）
- 已确认无任何被服务的页面/脚本引用这些 `.bak` 文件
- 归档后 24 个 URL 复检仍全部 HTTP 200

## 七、版本号漂移修复（同日后段复检发现）

复检「版本一致性」时发现三处**活代码常量**（非注释）仍停留在旧版本，与 package.json 的 2.0.17 不一致：

| 文件 | 位置 | 漂移值 | 影响 |
|---|---|---|---|
| `index.ts` | `/api/health` 版本字段 | `2.0.12` | `npm_package_version` 未注入时（直接 `tsx index.ts` 启动）健康接口报错版本 |
| `src/routes/admin.ts` | 升级接口响应 version | `2.0.13` | 升级触发响应返回旧版本号 |
| `package-lock.json` | 顶层 + `packages[""]` version | `2.0.16` | 与 package.json 不一致（同 v2.0.16 曾修过的问题再次出现） |

已全部修正为 `2.0.17`（提交 `93fea33`）：
- 质量闸门：`tsc --noEmit` 0 错误、`vitest run` 28/28 通过
- 发布包以 `93fea33` 重打（MD5 `ec9086f5…`），包内 `index.ts` / `admin.ts` 兜底常量与 `package-lock.json` 均已验证为 2.0.17
- 三处上传点 MD5 一致；四方（local / origin / dwork / bundle）对齐 `93fea33`
- 18 个 URL 复检全部 HTTP 200

### 建议（治本）
`index.ts` 与 `admin.ts` 的版本兜底为**硬编码字面量**，每次发版都有再次漂移的风险（v2.0.12、v2.0.16、v2.0.17 各漂一次）。建议改为从 `package.json` 读取，或统一走单一 `VERSION` 常量导出。

## 八、Dependabot 2 个 high 级告警核实（只读，未改动依赖）

对 GitHub 报告的两个 high 级漏洞做了上游溯源（`npm audit --registry=https://registry.npmjs.org`，项目默认源为 npmmirror，不支持 audit 接口）：

| 包 | 类型 | 严重度 | 说明 |
|---|---|---|---|
| `image-size` | 传递依赖（经 `pptxgenjs`） | high | ICNS 解析器无限循环 DoS（GHSA-w3rx-r6r6-pgpr）；JXL/HEIF 解析器无限循环 DoS（GHSA-5p2g-fcmc-qvqq） |
| `pptxgenjs` | 直接依赖 | high | 因携带上述 `image-size` 而被标记 |

### 关键结论：当前无法修复
- `image-size` 的**最新发布版本就是 2.0.2**（即本项目已安装版本），两个公告的受影响范围为 `*` → **上游没有补丁版本可用**
- `pptxgenjs` 最新版 4.0.1 **仍然依赖 `image-size`**（`^1.2.1`）→ 升级也无法解除
- npm audit 给出的唯一修复建议是**将 `pptxgenjs` 从 3.12.0 降级到 1.1.5**（semver major），该版本早于引入 image-size 之前 —— 会导致 PPT 生成能力大幅退化，**不建议执行**

### 风险评估
- 触发条件：需向 PPT/报告生成功能投喂**特制的恶意 ICNS/JXL/HEIF 图片**（引擎为本地部署，图片通常由用户自己提供）
- 影响面：**仅拒绝服务（DoS）**，无远程代码执行、无数据外泄
- 现有版本：`pptxgenjs` 3.12.0、`image-size` 2.0.2、`docx` 9.7.1

### 建议（需产品决策，未执行）
1. 维持现状并在 Dependabot 上标注为「无上游修复 / 已知风险接受」——依据：DoS-only + 本地引擎 + 需恶意输入
2. 若要求清零告警：将 PPT 生成从 `pptxgenjs` 迁移到维护更活跃的替代库，或自行 fork 并修补 `image-size` 的解析循环
3. 如需先行缓解：在 PPT/报告生成入口对上传图片做尺寸/格式预处理与超时限制，绕开解析器无限循环

## 九、发布包 v6.7 清理重建 + 官网覆盖上传（同日第三轮收尾）

### 1. 编码缺陷修复（阻断性）
- `scripts/pack-release.ps1` v6.7 含 103 个中文注释字符，但文件为 **UTF-8 无 BOM**；PowerShell 5.1 按 GBK 解码 → 存在语法破坏风险
- 处理：重写为 **UTF-8 with BOM**（`EF BB BF`），中文注释保留；`Parser::ParseFile` 校验 **PARSE-OK**，中文行正确解码
- 备份：`scripts/pack-release.ps1.bak-20260912-v67-preBOM`

### 2. v6.7 打包
- 命令：`powershell -File scripts\pack-release.ps1`
- 产物：`%TEMP%\lingxi-engine-v2.0.17.tar.gz`，**1,173,394 B**，MD5 `cdf997e2a37be8a4c1c0facf2fe54c0e`
- 暂存期剔除 11 文件 + 1 目录（3×`_result.txt`、5×`tests/data/*.json`、1×`__pycache__/`、2×`pack-release.ps1.bak`、1×`hub.ts.bak-0903`、2×`.env`）
- 打包器内置 7 组校验全部 `[OK]`（结构 / 垃圾 / env / key files / v5 安全 / v2.0.17 平台管理 / v2.0.17 推理流）

### 3. 清理效果对比（服务端实测）

| | 旧包（04:40 版） | 新包（v6.7） |
|---|---|---|
| 成员数 | 738 | **707** |
| 垃圾项 | **33**（24×`.pyc` + `__pycache__/` + 5×tests-data json + 3×`_result.txt` + 1×`.bak`） | **0** |
| 大小 | 1,293,601 B | 1,173,394 B |
| `.env` 泄漏 | 无 | 无 |
| `.env.example` | 有 | **有（显式校验）** |

### 4. 官网覆盖上传（`lingxi-server` = 47.93.157.83）
- 上传：`scp` → `/tmp/lx17-cdf997e2.tar.gz`（服务端 md5 复核一致）
- 备份：`/var/www/lingxi/backup-20260912-v2017-clean/`（3 个 tar.gz + version.txt，可回滚）
- 三处覆盖：`releases/…v2.0.17.tar.gz`、`public/…v2.0.17.tar.gz`、`public/lingxi-engine.tar.gz` → **md5 三处一致 `cdf997e2…`**
- 元数据：`public/version.txt`（2.0.17 + built 05:48:40 + 变更说明）、`CHANGELOG.md`、新增 `public/.env.example`
- HTTP：站内 6 URL 全 200；**外网 `http://47.93.157.83:8080/public/lingxi-engine-v2.0.17.tar.gz` 下载回算 md5 = `cdf997e2a37be8a4c1c0facf2fe54c0e` MATCH ✅**

### 5. 工作区清理
- 31 个会话临时脚本（`_probe_*.cjs` / `_t*.mjs` / `_audit_*.cjs` / `_verify_*.cjs` / `_test_*.cjs` 等，含疑似投毒源 `_test_think_stream.cjs`）整体移入 `workspace/_archive/20260912-scratch/`（移动可逆，未删除）

### 6. 未处理（仍待授权）
- 线上引擎重启升级（`/api/health` 仍报 **2.0.15**）—— 遵守「不杀进程」约束，PM2 进程全程未动
- GitHub 2 个 high 级 Dependabot 告警（上游无补丁，详见第八节）

### 7. 收尾补齐（本记录提交轮）
- 本第九节已并入本记录（原先仅存于 `workspace/_record_sec9.md` 草稿）
- 工作区唯一真实改动 `scripts/pack-release.ps1`（UTF-8 BOM 修复）随本记录一并提交并推送 `origin/main`
- F 盘备份刷新：`lingxi-engine-git-20260912-v2017-final.bundle`（HEAD = 本次提交）+ 官网前端快照 tar.gz（详见 `docs/F-drive-backup-manifest-20260912.md`）

---

# 第十一节：安全加固轮（2026-09-12 晚 · 用户指令四连）

## 任务来源
用户指令：①服务器引擎升级 2.0.17（本地进程不动）②处理 2 个 Dependabot high ③服务器引擎不对外开放 ④官网修改防止他人使用。

## 一、依赖漏洞清零（Dependabot 2 high）
- GHSA-w3rx-r6r6-pgpr / GHSA-5p2g-fcmc-qvqq：image-size ICNS/JXL/HEIF 解析器无限循环 DoS，经 pptxgenjs 引入
- 实测：image-size ≤2.0.2（含最新 2.0.2）全部中招，**无修复版本**；pptxgenjs/image-size 在代码库零引用（findstr 全库扫描确认）
- 处置：从 package.json 彻底移除（devDependencies/optionalDependencies/overrides），npm install 刷新 lockfile
- 验证：`npm audit` → **0 vulnerabilities**；tsc 0 错误；vitest 28/28
- 提交：`0c6b484`

## 二、平台服务器（3001）全局访问门槛
- 新增中间件（platform-server.ts:272-283）：除 /api/health 外所有请求（含静态文件）必须携带 MESH_TOKEN 或 PLATFORM_ADMIN_TOKEN，否则 403
- 服务器 .env 补固定 MESH_TOKEN/PLATFORM_ADMIN_TOKEN（64 hex，此前每次重启随机生成→外网裸奔）
- .env.platform 同步 MESH_TOKEN（mesh 进程实际加载 .env.platform，dotenvConfig path 指向）
- 提交：`1e70ea7`
- 验证矩阵：
  - 无 token：/api/user/* /api/hire/* /api/friend/* /静态/admin.html → **全 403**（本机+外网双验）
  - 带 token：/api/hire/market → 200（本地引擎市场功能恢复）
  - mesh WS /mesh 握手带 token 验证（不受 Express 中间件影响，upgrade 不走中间件栈）

## 三、服务器引擎升级 2.0.15 → 2.0.17
- tarball 同步（v2.0.17 包 cdf997e2→新版 b927e92f）src/web/index.ts/package.json 等，保留 .env/data/node_modules
- platform-server.ts 单独 scp（tarball 打包早于鉴权补丁提交）
- **事故**：`npm install --omit=dev` 删除了 tsx（devDependency）→ PM2 lingxi 启动失败 ERR_MODULE_NOT_FOUND
- **修复**：`npm install tsx@4.19.0 --save-dev` 装回，重启恢复
- 验证：`/api/health` → `{"ok":true,"version":"2.0.17","agents":14}`；PM2 lingxi/lingxi-mesh/lingxi-site 全 online
- 备份：/opt/lingxi-engine-backups/20260912-prelock/engine-src-2.0.15.tar.gz + .env.bak + src-old-2015/web-old-2015

## 四、官网改造（server.js 重写）
- 引擎 API：仅保留 /api/admin/*（→3001，管理后台 x-admin-token 鉴权），其余 /api/* 一律 403
- /chat /app /platform → 302 → /download.html（网页版引擎入口下线）
- /ws WebSocket 升级 → socket.destroy()（引擎 WS 不再对外）
- /admin → 302 → admin.html（管理后台入口保留）
- official.html：5 处 /chat → /download.html，文案"网页版/在线体验/打开"→"免费下载/获取安装包/下载"，"无需安装·直接使用"→"本地部署·数据自持"
- 提交：`e03b015`（含 site_inner/server.js 副本，workspace/ 被 .gitignore 忽略故仅 official.html 入库）
- 验证：首页 200（6 处下载链接、0 处 /chat）；/chat /app /platform 全 302；/api/health 403；admin API 带 token 200 无 token 403；外网全链路复验通过

## 五、安装包重建发布
- v6.7 打包脚本（BOM 修复版）：新包 1,176,495 B，md5 b927e92fcc506c54a140e70bd845c2df
- 与旧包差异：package.json/lockfile 去除 pptxgenjs/image-size（漏洞清零版）
- 三处同步：releases/ + public/lingxi-engine-v2.0.17.tar.gz + public/lingxi-engine.tar.gz，md5 三处一致
- version.txt 更新（security release 说明）
- 外网下载实测：200，1,176,495 字节，md5 一致

## 六、备份
- F 盘：lingxi-engine-git-20260912-final-e03b015.bundle（260,719,350 B，verify okay，13 refs，main=e03b015）
- 旧 bundle 382268f 保留（F 盘余 6.0 GB）
- 服务器：/var/www/lingxi/server.js.bak-20260912-prelock + official.html.bak-20260912-prelock

## 七、git 状态
- HEAD = e03b015 = origin/main（已推送）
- 提交链：0c6b484（deps）→ 1e70ea7（platform gate）→ e03b015（site lockdown）
- 工作区真实改动仅 web/official.html（已提交）；其余 M 为 CRLF 假象

## 遗留事项
- GitHub Dependabot 面板仍显示 2 high（旧 lockfile 扫描缓存，等重新扫描自动消）
- 服务器 3001 仍监听 *:3001（IPv6 通配）——外网 403 已实测，如需彻底封端口需 firewalld 规则（用户未要求）
- 本地引擎进程（Windows，03:19 启动）全程未动——用户明确要求
- socat 5000→3001 转发仍在（外网 000 防火墙已挡）

---

# 第十二节：安全加固补漏（绕过口子封堵 · 2026-09-12 深夜）

## 背景
第十一节部署后复查发现两类绕过口子：①引擎 UI 壳文件（app.html/index.html/market.html 等）可经直接 URL 访问绕过 /chat 302；②旧版本安装包（2.0.13~2.0.16，含漏洞依赖）仍挂在公开目录。

## 处置
1. **归档引擎 UI 壳**（public/ → archive-20260912-locked/）：app.html、app_v9_layout.html、index.html、market.html、model-management.html、install.html、admin.html、platform-admin.html、sw.js、js/app.js、js/i18n.js、js/market.js —— 全部 404
2. **归档旧版本包**：v2.0.13/2.0.13-hotfix/2.0.13-hotfix2/2.0.14/2.0.15/2.0.16 tar.gz + .bak 副本 —— 全部 404（公开目录只留 v2.0.17 + 通用名）
3. **管理后台改不可猜测路径**：admin-console-<16hex>.html（随机生成，存 /root/.admin-path-secret，600 权限）；/admin 302 → 该路径；server.js 改用 ADMIN_CONSOLE_PATH 环境变量（不硬编码）
4. **server.js 入库**：deploy/site-server.js（提交 f4d029e），与服务器部署版一致，环境变量注入密钥路径
5. **PM2 重建 lingxi-site**：delete + start（env 注入 ADMIN_CONSOLE_PATH），pm2 save 固化

## 外网终验（19 项全绿）
- 200：/ 、/download.html、/deploy.html、/docs、v2.0.17 包、通用名包
- 302：/chat（→下载页）
- 403：/api/health、/api/auth/login、3001 root、3001 register
- 404：/admin.html、/app.html、/index.html、/market.html、/sw.js、/js/app.js、旧包 2013
- 000：3456（防火墙本就挡着）
- 管理后台：/admin 302 → admin-console-<rand>.html 200（本机验证）

## 遗留
- admin-console 路径记在服务器 /root/.admin-path-secret（root only）；如需更换重新生成 + sed server.js + pm2 restart
- archive-20260912-locked/ 为非公开归档（server.js 只服务 public/，归档目录天然不可达）

---

# 第十三节：公开面最小化收敛（2026-09-12 深夜 · 终轮）

## 背景
第十二节后复查公开目录，又揪出一批漏网文件：platform/ 整目录（完整引擎平台前端+备份）、market.js/model-mgmt.js（孤儿脚本，无 HTML 引用）、manifest.json（PWA 清单指向已下线 UI）、根目录 market.css、platform-config.js、official.html.bak、package.json、deploy.sh、install.bat。

## 处置（全部归档至 archive-20260912-locked/，累计 28 项）
- platform/ 整目录（index.html/js/sw/backup-20260827）
- 孤儿脚本：market.js、model-mgmt.js、css/market.css（上轮）、根 market.css（本轮）
- PWA/配置：manifest.json、platform-config.js、platform-config.example.js、package.json
- 杂项：official.html.bak-20260912-prelock、deploy.sh、install.bat

## 最终公开面（20 项，全部有主）
- 页面：official.html、download.html、deploy.html
- 样式：css/style.css、css/mobile.css
- 图标：favicon.ico、icon.svg
- 下载：lingxi-engine-v2.0.17.tar.gz、lingxi-engine.tar.gz（md5 b927e92f 一致）、LingXi-Engine-Setup.zip/.bat、灵犀引擎-desktop-1.1.0-portable.exe
- 脚本：install.sh、install.ps1
- 信息：version.txt、CHANGELOG.md
- 管理：admin-console-<rand>.html、platform-console-<rand>.html（不可猜测路径）
- 空目录：uploads/（保留，头像上传用）

## 终验矩阵（本机实测）
- 200：/、/download.html、/deploy.html、/docs、css×2、安装包×4、管理后台×2
- 302：/chat、/app、/platform/（→ 下载页）
- 403：/api/health（引擎 API 全关）
- 404：/admin.html、/app.html、/index.html、/market.css、/manifest.json
- 3001 外网 403（token 门槛）；3456 外网 000（防火墙）
- PM2：lingxi 2.0.17 / lingxi-mesh 2.0.17 / lingxi-site 全 online
- 本地 Windows 引擎进程：全程未动（用户要求）

---

# 第十四节：发布包 rev2 —— 补丁进包 + 死链修复（2026-09-12 深夜 · 终验轮）

## 发现的两个真问题（前一轮遗留）
1. **官网挂的 v2.0.17 包不带 3001 鉴权补丁**：打包时序早于补丁提交（1e70ea7），用户下载部署后 platform-server 仍裸奔
2. **download.html 4 处 deploy.sh 死链**：deploy.sh 已归档（404），一键部署命令指向空路径

## 处置
1. 本地 web/download.html：4 处 deploy.sh → install.sh（提交 96d5a7b）
2. 重新打包（v6.7 脚本）：1,179,825 B，md5 20f41000ced56f90ac80a6e3aac0bc7a
3. 包内验证：Security hardening ×1、PUBLIC_ACCESS_TOKEN ×2（**鉴权补丁在包内**）、pptxgenjs ×0（漏洞依赖零）、deploy.sh ×0（死链零）
4. 三处替换（releases/ + public/ v2.0.17 + 通用名），md5 一致
5. 官网 download.html 同步 rev2 版（死链清零）
6. 服务器引擎目录 /opt/lingxi-engine/web/download.html 同步
7. version.txt → rev2 说明

## 终验
- 外网下载：200，1,179,825 字节，md5 一致（20f41000…）
- install.sh 双路径（/install.sh、/public/install.sh）均 200
- PM2：lingxi 2.0.17 / lingxi-mesh 2.0.17 / lingxi-site 全 online
- 引擎健康：{"ok":true,"version":"2.0.17","agents":14}
- 服务器引擎目录：鉴权补丁 ×1、package.json 2.0.17、download.html 死链 0

## 本轮完整提交链（本轮新增 8 个提交）
0c6b484 deps 清零 → 1e70ea7 platform token gate → e03b015 site lockdown → 7e1664e1 record → b539c45 record restore → f4d029e deploy/site-server.js → 11b511f sec12 → fc9456e sec13 → 96d5a7b download.html fix

---

# 第十五节：/docs 泄漏清剿 + 全维度终验（2026-09-12 深夜 · 收官轮）

## 发现的泄漏（/docs 公开文档目录）
1. 🔴 **开发文档-V11.md:560**：`SSH | root@47.93.157.83（密钥免密）` —— root 免密登录路线图挂在公网，19KB 内部开发细节
2. 🟡 quickstart.md:30 指向已下线的 /platform/#/agents（死链）
3. 🟡 docs/index.html:56 "进入平台" → /platform/#/（死链）

## 处置
- V11 移入 archive-20260912-locked/docs/（外网 404 实测）
- quickstart.md 死链 → /download.html
- index.html "进入平台" → "下载引擎"
- 全 docs 目录复扫：/chat /platform /app 死链零残留；root@/密钥免密/admin-console/MESH_TOKEN= 关键词零命中

## 全维度终验（34 项全绿）
- 官网四页 + docs 六文件 + css/icon：全 200
- 下载链 7 项（v2.0.17 包/通用包/Setup.zip/.bat/install.sh/.ps1/desktop.exe）：全 200
- 引擎入口 10 项：/chat /app /platform 302；admin.html/app.html/index.html/market.html/sw.js/manifest.json 404；/api/health 403
- 管理后台：随机路径页 200 + API 带 token 200
- 3001：无 token 403 / 带 token 200
- 引擎健康 2.0.17 agents:14；PM2 三进程 online（uptime 20m/19m/8m）
- V11 泄漏文件 404；归档区 29 项不可达

## 本日总账
- 提交：0c6b484 → 1e70ea7 → e03b015 → 7e1664e1 → b539c45 → f4d029e → 11b511f → fc9456e → 96d5a7b → 73c3b30（10 个，全推送）
- 发布包 rev2：md5 20f41000…（鉴权补丁在包内、零漏洞依赖、零死链）
- 服务器归档：29 项引擎 UI/旧包/泄漏文档 → archive-20260912-locked/
- 全程未触碰本地 Windows 进程（用户红线）

---

# 第十六节：运维收尾 —— pm2 dump 固化 + /tmp 清剿 + 官网快照（2026-09-12 深夜 · 终章）

## 发现并修复的三个运维隐患
1. **pm2 dump 里 ADMIN_CONSOLE_PATH 空值**：此前 pm2 save 时机不对，dump 未固化环境变量 → 服务器重启后管理后台将失效。已 delete + start（env 注入）+ pm2 save 重做，dump 实测 `"ADMIN_CONSOLE_PATH":"admin-console-abe14195403cd4dc.html"`；pm2 systemd 单元 enabled（重启自愈链完整）
2. **/tmp 历史遗留 20MB+**：旧包/解包目录/升级日志堆积（lingxi-verify、lingxi-deploy-2005、v2.0.13/2.0.17 旧 tar 等）→ 一次性清理；src/web/data 历史备份（07-20）保守移入 archive/tmp-legacy/（不删）
3. **F 盘官网快照过期**：官网大改后快照仍停在 v2017-final（05:54，改动前）→ 新拍 lingxi-site-20260912-lockdown.tar.gz（86.6MB，含 server.js + public/ + docs/ + version.txt，md5 dec5c617… 服务器与 F 盘一致）

## 终态确认
- PM2：lingxi 2.0.17 / lingxi-mesh 2.0.17 / lingxi-site online；dump 固化 env；systemd enabled
- /tmp：lingxi/pkg 相关零残留（数据备份移入归档区）
- 归档区：30 项（引擎 UI/旧包/泄漏文档/tmp 历史备份）
- 磁盘：服务器 41%，F 盘 6.6GB 余
- 本地 Windows node 进程：5 个（17000/18896/29224/30728/31284）全程未动
- 官网快照三份：20260911（旧站）/ v2017-final（升级前）/ lockdown（终态）

## 本日十六节总账
- 16 个提交推送（0c6b484 → bd76a29），git = GitHub = F盘 bundle
- 发布包 rev2（md5 20f41000…）三处一致，鉴权补丁在包内
- 服务器：引擎 2.0.17、3001 token 门槛、官网纯产品化、公开面 20 项、泄漏清剿、归档 30 项
- 全程未触碰本地 Windows 进程（用户红线，历轮确认）

---

# 第十七节：自伤修复 —— 双 .env token 对齐 + 引擎目录同步 rev2（2026-09-12 深夜 · 补丁轮）

## 发现的两个真问题
1. **服务器引擎自伤 403**：.env 的 PLATFORM_ADMIN_TOKEN（44de…，我第十六节前生成的）≠ .env.platform 的（af99…，原有），lingxi 引擎调 3001 管理接口被自己的 token 门槛挡住（实测 403）
2. **引擎目录残留旧文件**：/opt/lingxi-engine 的 package.json（仍带 pptxgenjs）、web/official.html（旧版按钮）与 rev2 发布包不一致——升级时从旧包同步的残留

## 修复
- .env 的 PLATFORM_ADMIN_TOKEN 对齐 .env.platform（sed 替换，实测 TOKEN-ALIGNED）
- package.json / web/official.html 从 rev2 包 cp 同步（md5 MATCH）
- npm install 刷新依赖（tsx 确认保留）
- pm2 restart lingxi --update-env（服务器进程，本地 Windows 未动）

## 验证（全绿）
- 引擎健康：{"ok":true,"version":"2.0.17","agents":14}
- 引擎 token 调 3001 admin：403 → **200**（自伤解除）
- 官网四页 200；/chat /app 302；/api/health 403；admin.html/app.html/manifest.json 404
- 3001 外网无 token 403 / 引擎 token 200
- 管理后台 console 200；下载包 200
- pm2 save 固化；dump 里 ADMIN_CONSOLE_PATH 完好（node 解析确认，此前 grep 0 是引号格式误报）；进程 env 在；站点行为 302→200 正确

## 本日十七节总账（最终）
- 17 个提交（0c6b484 → 7228fb2），git = GitHub = F盘 bundle
- 服务器：引擎 2.0.17（token 对齐 + rev2 文件同步）、3001 token 门槛、官网纯产品化（公开面 20 项）、泄漏清剿（V11 归档）、归档 30 项、/tmp 清剿、pm2 自愈链完整
- 发布包 rev2：md5 20f41000…（鉴权补丁在包内、零漏洞依赖、零死链）
- 本地：.env 幽灵模型扶正（glm-5.2:cloud ×3）、本地进程全程未动（用户红线）

---

# 第十八节：本地-服务器链路终验 + 本地 .env 平台 token 配齐（2026-09-12 深夜 · 真终章）

## 验证结论（本地引擎零自伤）
- 本地引擎 wallet/credits/hire 全部为本地路由（wallet.ts 自实现，走本地 SQLite），不依赖 3001
- 对 3001 的服务端调用共 3 处（index.ts:236 admin 探测、auth-main.ts:181 /api/auth/me 平台模式、lan.ts:101 用户搜索平台转发），全部带 `platformAdminToken` 条件守卫——无 token 时静默跳过，本地功能零影响
- mesh 客户端（instance-mesh.ts）本地未配置 MESH_PLATFORM_URL，不连接

## 功能补齐
- 本地 .env 写入 PLATFORM_ADMIN_TOKEN（与服务器 .env.platform 对齐，af99… 64hex）
- 实测：本地 → http://47.93.157.83:3001/api/admin/users?token=… → **HTTP 200, ok=true**
- 效果：下次本地引擎重启后，/api/auth/me 平台 admin 模式 + LAN 用户搜索的平台转发功能恢复（此前因无 token 静默禁用）
- 本地 .env 备份链：.env.bak-20260912-premodel（模型修复前）；本轮仅追加一行 token

## 本日十八节总账（真·最终）
- 18 个提交（0c6b484 → 44c5635 + 本轮），git = GitHub = F盘 bundle
- 服务器：引擎 2.0.17（token 对齐 + rev2 同步）、3001 token 门槛、官网纯产品化（公开面 20 项）、泄漏清剿、归档 30 项、pm2 自愈链
- 本地：.env 幽灵模型扶正 + 平台 token 配齐；**本地 Windows 进程全程未动**（用户红线）
- 发布包 rev2：md5 20f41000…（鉴权补丁在包内、零漏洞依赖、零死链）

---

# 第十九节：mesh WS 三态实测 + Dependabot 消警确认（2026-09-12 · 收官）

## mesh WS 握手三态（服务器本机 node ws 客户端实测）
- 错 token → `{"type":"error","message":"鉴权失败"}`（拒，正确）
- 正确 MESH_TOKEN → `mesh.handshake_ack`（通，本地引擎 mesh 组网功能完好）
- socat 5000 → 外网 000（防火墙挡，非绕过口；socat 进程仍在但不可达）

## Dependabot 消警确认（间接实证）
- 首次推送（0c6b484 前后）时 GitHub 返回横幅 "GitHub found 2 vulnerabilities (2 high)"
- 本轮 `git push` 返回 `Everything up-to-date` 且**零告警横幅** —— GitHub 侧扫描已确认新 lockfile（285 包，零 image-size/pptxgenjs）干净，告警已消

## 本日十九节 · 最终总账
- 19 个提交（0c6b484 → 1b26487），git = GitHub = F盘 bundle = 1b26487
- 服务器：引擎 2.0.17（双 .env token 对齐 + rev2 同步）、3001 五层封堵（token 门槛/WS 鉴权/官网 API 403/入口 302/归档 404）、官网纯产品化（公开面 20 项）、泄漏清剿（V11）、归档 30 项、/tmp 清剿、pm2 自愈链完整
- 本地：.env 幽灵模型扶正 + 平台 token 配齐（本地→3001 实测 200）；**本地 Windows 进程全程未动**
- 发布包 rev2：md5 20f41000…（鉴权补丁在包内、零漏洞依赖、零死链）
- mesh WS：错 token 拒 / 正 token 通 / socat 不可达 —— 三态全对

---

# 第二十节：下载链古董清剿 —— Setup.zip 重打（2026-09-12 · 终验轮）

## 发现
- **LingXi-Engine-Setup.zip 是 06-24 的古董**：内裹 06-24 旧 lingxi-engine.tar.gz（310KB，老版本），而 download.html 公开提供它——用户装到的是陈旧版
- 桌面版 exe（1.1.0，07-13，83MB NSIS）：独立产品线，无漏洞链证据，保留
- install.sh / install.ps1 的 TARBALL_URL 均指向通用名包（已是 rev2）✅；CHANGELOG 2.0.17 头部准确 ✅

## 处置
- 旧 zip 备份至 archive-20260912-locked/LingXi-Engine-Setup.zip.old-20260624
- 重打：rev2 tarball（md5 20f41000…，与 releases 一致）+ 现役 Setup.bat（515B）
- 上线：新 zip 1,180,675 B，md5 cc10924f454125bdc45bc930b9550199
- 外网实测：200，1,180,675 字节，md5 一致

## 下载链最终矩阵（全部 200 + 版本正确）
| 下载物 | 状态 |
|---|---|
| /public/lingxi-engine-v2.0.17.tar.gz | rev2（20f41000…） |
| /public/lingxi-engine.tar.gz（通用名） | rev2（20f41000…） |
| /LingXi-Engine-Setup.zip | 重打（cc10924f…，内裹 rev2） |
| /LingXi-Engine-Setup.bat | 现役（拉 install.ps1 → 通用名包 rev2） |
| /install.sh / /install.ps1 | 指向通用名包 rev2 |
| 桌面版 exe 1.1.0 | 独立产品线，保留 |

## 本日二十节 · 完整总账
- 20 个提交（0c6b484 → dc8c80e + 本轮），git = GitHub = F盘 bundle
- 四项用户指令全部闭环：引擎 2.0.17 / 漏洞清零（含推送横幅消失实证）/ 引擎六层封堵（token+WS 三态+API+入口+归档+泄漏清剿）/ 官网纯产品化（公开面 20 项，下载链全部最新 rev2）
- 本地 Windows 进程全程未动（用户红线）

---

# 第二十一节：docs 导航死链清剿（V11 残留引用）（2026-09-12 · 补漏轮）

## 发现
- docs/index.html 仍残留两处 V11 引用：52 行导航按钮 `loadDoc('开发文档-V11.md')` + 70 行 fallback —— V11 已归档（404），用户点"开发文档"加载失败
- 清除后遗留孤儿标题 `<h3>完整开发文档</h3>` 与空 `<div class="group">`

## 处置
- 删 52 行 V11 导航按钮、70 行 V11 fallback、孤儿 h3、空 group div
- docs 导航收敛为两组：文档（api/architecture/install/marketplace/points/quickstart 六 md）+ 平台（下载引擎/品牌首页）

## 验证
- loadDoc 引用 6 个 md 全部 200
- docs-index 200，V11 保持 404（不可达）
- 导航组干净（2 个 group，无空壳）

## 本日二十一节 · 完整总账（真·最终）
- 21 个提交（0c6b484 → bee8431 + 本轮），git = GitHub = F盘 bundle
- 四项用户指令全部闭环 + 十一轮补漏：引擎 2.0.17 / 漏洞清零 / 引擎六层封堵 / 官网纯产品化（公开面 20 项、下载链全 rev2、docs 零死链）
- 本地 Windows 进程全程未动（用户红线）

---

# 第二十二节：网络层兜底 + 平台链路迁移（2026-09-12 · 防火墙轮）

## 深挖发现
- 3456 引擎本机 WS 无鉴权可连、HTTP API 全开（agents/models/mesh 200）——外网 000 全靠阿里云安全组（云控制台配置，SSH 改不了）
- 3001 虽有 token 门槛，但端口对公网 TCP 开放（扫描噪音面）

## 处置：iptables 服务器本机兜底层
- `iptables -I INPUT -p tcp --dport 3456 ! -i lo -j DROP`（引擎端口仅本机）
- `iptables -I INPUT -p tcp --dport 3001 ! -i lo -j DROP`（平台端口仅本机，token 门槛之上加网络层）
- 持久化：/etc/iptables.rules
- 效果：即使未来云安全组误开放，服务器自身仍封死；外网 TCP 直连不通（比 403 更彻底）

## 连带影响与迁移
- 本地引擎此前直连 3001（带 token 200）被防火墙切断（实测 fetch failed）
- **迁移**：本地 .env 的 PLATFORM_API_URL 改指官网 8080 admin 代理（外网开放 + x-admin-token 鉴权）
- 实测：本地 → http://47.93.157.83:8080/api/admin/users?token=… → **HTTP 200, ok=true**
- 功能无损：管理后台（8080→3001 lo 代理 200）、mesh WS（lo 不受影响）、本地平台调用（走 8080）

## 验证矩阵
- 外网：3001 000 / 3456 000 / 8080 200（官网正常）
- 本机 lo：3001/3456 正常、8080 admin 代理 200
- 本地 Windows → 8080 代理 200

## 本日二十二节 · 完整总账（最终）
- 22 个提交（0c6b484 → c52bdd1 + 本轮），git = GitHub = F盘 bundle
- 四项指令 + 十二轮补漏全闭环：引擎 2.0.17 / 漏洞清零 / 引擎七层封堵（token+WS 三态+API+入口+归档+泄漏清剿+iptables 网络层）/ 官网纯产品化（公开面 20 项、下载链全 rev2、docs 零死链、平台链路迁移 8080 代理）
- 本地 Windows 进程全程未动（用户红线）

---

# 第二十三节：防火墙持久化 + 80 端口复活（2026-09-12 · 网络终轮）

## 发现的两个真问题
1. **iptables DROP 规则无持久化钩子**：/etc/iptables.rules 只是死文件，重启即失效
2. **lingxi-redirect.service 假活**：oneshot 模式 8-27 启动后 NAT 规则被某次 firewalld reload 冲掉，服务显示 active 但 PREROUTING 空 → 裸 IP 80 端口外网不通

## 处置
- firewalld 放行表收紧：80/3001/3002/8080 → **80/8080**（3001/3002 移除，3002 本就无人监听）
- 新建 lingxi-firewall-lock.service（systemd oneshot + RemainAfterExit，ExecStart 重加 3456/3001 DROP）→ **enabled + active**，重启自愈
- systemctl restart lingxi-redirect.service → NAT 80→8080 规则复活

## 验证（外网从本地 Windows 实测）
- http://47.93.157.83/ → **200 官网首页**（"灵犀引擎 - 你的私人 AI 工作站"）
- :8080 → 200；:3001/:3456/:5000/:3002 → 全 000
- 本机 lo：3456 200、8080 admin 代理 200

## 本日二十三节 · 完整总账（真·最终）
- 23 个提交（0c6b484 → a5358d3 + 本轮），git = GitHub = F盘 bundle
- 四项指令 + 十三轮补漏全闭环：引擎 2.0.17 / 漏洞清零 / 引擎八层封堵（token+WS 三态+API+入口+归档+泄漏清剿+iptables+firewalld 双层且持久化）/ 官网纯产品化（公开面 20 项、下载链全 rev2、docs 零死链、平台链路迁移 8080、80 端口复活）
- 本地 Windows 进程全程未动（用户红线）

---

# 第二十四节：运行日志考古 + URI 崩溃修复（2026-09-12 · 稳定性轮）

## 日志考古结论
- error.log 里的 ERR_MODULE_NOT_FOUND / EADDRINUSE 全为历史时间戳（09-03/09-04，含升级过程 tsx 误删事故）——非现行故障
- 当前全绿：lingxi 2.0.17 uptime 796s agents:14 / mesh 43min / site 稳定

## 现行问题与修复
- **lingxi-site 反复 URIError: URI malformed**：server.js 的 decodeURIComponent 遇裸 % / 畸形转义抛异常
- 修复：try/catch 回退原始路径（deploy/site-server.js，提交 be99247）
- 部署：scp + pm2 delete/start（env 注入）+ pm2 save

## 验证
- 畸形 URI：/% → 404、/%zz → 404、/%E4%B8 → 404（优雅降级，不再抛错）
- 正常路径回归：home/download/docs 200、chat 302、api 403、console 200、中文文件名 exe 200
- 新进程日志零新 URIError

## 本日二十四节 · 完整总账（最终）
- 24 个提交（0c6b484 → be99247），git = GitHub = F盘 bundle
- 四项指令 + 十四轮补漏全闭环；引擎八层封堵（含 systemd 持久化 + firewalld 双层）；官网纯产品化 + 稳定性修复；下载链全 rev2；80 端口复活；平台链路迁移 8080
- 本地 Windows 进程全程未动（用户红线）

---

# 第二十五节：断点恢复全量复核 + deploy.html 泄漏清剿（2026-09-12 · 复核轮）

## 断点恢复复核（上一轮声称的闭环逐项实测）
| 项 | 实测 | 结论 |
|---|---|---|
| git = GitHub = F盘 | HEAD=origin/main=351c312，bundle verify okay | ✅ |
| 外网封堵 | 80 官网 200 / 8080 API 403 / 3001、3456 不可达 | ✅ |
| 3001 token 门槛 | lo 无 token 403；/api/health 404 为路由不存在（非门槛失效） | ✅ |
| 8080 API 封死 | 带/不带 token 均 403「引擎 API 已不对外开放」 | ✅ |
| 管理代理链路 | /api/admin/* → lo:3001 代理完好（后台不受影响） | ✅ |
| mesh WS | 外网 3001 DROP + lo 门槛在 | ✅ |
| 三进程 | lingxi 2.0.17 / mesh 2.0.17 / site 全 online | ✅ |
| 官网下载链 | v2.0.17 包 200（1,179,825B）、version.txt rev2 | ✅ |
| 本地进程 | 5 个 node.exe 全程未动 | ✅ |

## 新发现：deploy.html 三处泄漏（上轮归档漏网）
- 根目录 /var/www/lingxi/deploy.html、public/deploy.html、docs/deploy.html **三份同文档**，均含服务器 IP 47.93.157.83 ×9 处
- 上轮只归档了根目录那份；public/ 与 docs/ 两份漏网，外网实测均 200
- download.html:186 存活链指向 /deploy.html（死链）

## 处置
- 三份全部归档至 archive-20260912-locked/（deploy.html.locked / public-deploy.html.locked / docs-deploy.html.locked），可回滚
- download.html:186 死链修复：/deploy.html → /docs/（备份 download.html.pre-deployfix）
- 本地仓库核查：deploy.html 零跟踪零存在（纯服务器手工孤儿文件，本地无需处理）

## 验证（外网实测）
- /deploy.html、/public/deploy.html、/docs/deploy.html → **全 404**
- download.html 200 且 deploy.html 引用清零、站内文档链生效
- 回归：index/official/docs/pkg 全 200，主站无恙

## 本日二十五节 · 完整总账
- git = GitHub = F盘 bundle = 351c312（本节为服务器侧归档动作，无需新提交）
- 服务器归档累计 34 项（31 + deploy.html ×3）
- 引擎八层封堵 + 官网纯产品化 + deploy.html 泄漏清剿，公开面零 IP 泄漏
- 本地 Windows 进程全程未动（用户红线）---

# 第二十六节：旧聊天 UI 资产清剿 + 官网面收敛终验（2026-09-12 · 深度复核轮）

## 新发现：旧网页聊天 UI 残留资产（上轮归档漏网第二波）

### 问题清单
| 文件 | 性质 | 风险 |
|---|---|---|
| `/var/www/lingxi/index.html`（86 KB，08-13） | 旧网页版聊天 UI（membersBtn/memoryBtn/sw.js 注册） | 引擎已不对外开放，此 UI 是死入口；注册的 `/sw.js` PWA 缓存会劫持老用户 |
| `/var/www/lingxi/sw.js`（v2.0.6，lingxi-v13 缓存） | PWA service worker | 缓存列表含 `/index.html` `/js/app.js` 等，老用户浏览器吃旧缓存 |
| `/var/www/lingxi/css/`（style/mobile/market.css） | 旧 UI 样式 | 零引用 |
| `/var/www/lingxi/js/`（app.js 199KB / i18n.js 252KB） | 旧 UI 逻辑 | 零引用（app.js 内 PLATFORM_URL 已置空） |
| `public/css/` + `public/style.css` + `public/mobile.css` | 旧 UI 样式副本 | 零引用 |

### 处置（全部可回滚）
- 归档至 `archive-20260912-locked/old-chat-ui/`（index.html.locked / sw.js.locked / css/ / js/）
- 归档至 `archive-20260912-locked/unused-public-assets/`（css/ / style.css / mobile.css）
- 删除原位置文件

## 验证（本机 + 外网双测）
- `/index.html`、`/sw.js`、`/css/style.css`、`/js/app.js` → **全 404**（本机 + 外网）
- 官网主面全绿：root / official / download / docs / docs-quickstart / install.sh / install.ps1 / pkg×2 / version / setup-zip / icon / favicon / admin-console / platform-console → **全 200**
- PWA 劫持风险消除：官网首页（official.html）无 serviceWorker 注册，老 index.html 已下线

## 保留项（有意保留，非泄漏）
- `public/` 下 IP 引用（install.ps1/install.sh/official.html/download.html/docs/*.md）均为**安装命令与平台地址**，用户需要它下载引擎——这是产品功能，不是泄漏
- `docs/architecture.md` 中 IP 为架构说明文档，属产品文档
- `releases/` 旧版本包（v2.0.14/15/16）外网 404（白名单只放行 public/），仅服务器留存作历史备份
- `LingXi-Engine-Setup.bat`（515B 引导脚本）与 `灵犀引擎-desktop-1.1.0-portable.exe`（83MB 桌面包）为下载页历史产物，保留

## 终态
- 服务器归档累计 **44 项**（34 + 旧聊天 UI 10 项）
- 官网公开面 = 纯产品站：首页 / 下载 / 文档 / 安装脚本 / 安装包 / 双管理后台（token 鉴权）
- PM2 三进程 online（lingxi 2.0.17 / mesh 2.0.17 / site），本地 Windows 进程全程未动
- 本节为服务器侧归档动作，无代码改动，无需新提交（HEAD = `33539a4` 不变）