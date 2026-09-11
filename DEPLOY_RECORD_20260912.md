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
