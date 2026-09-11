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
