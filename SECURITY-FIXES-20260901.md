# 开源前安全修复记录（2026-09-01）

## 修复范围
只动有问题的行，未触碰任何无关代码。备份目录（web_backup_v9、_restore 等）磁盘文件原样保留。

## 代码修复（15 个文件 + 6 个新增）
1. **硬编码服务器 IP `47.93.157.83`（原 14+ 处，全部清除）**
   - `src/auth/platform-bind.ts`、`src/routes/profile.ts`、`src/routes/admin.ts`：兜底值改为 `''`（纯本地模式），运行时读 `PLATFORM_URL` 环境变量
   - `src/core/instance-mesh.ts`、`src/platform-server.ts`：注释/兜底改为占位符
   - `web/js/app.js`、`src/web/js/app.js`（及 site_inner 镜像）：`window.LINGXI_PLATFORM_URL || ''`
   - `install.sh`×4、`deploy.sh`×2：`${LINGXI_BASE_URL:-http://localhost:8080}` 可配置
   - `install.ps1`×4、`install-server.ps1`×3：下载地址占位符
   - `deploy-aliyun.sh`×4：服务器 IP + 安全组 ID → 占位符
2. **弱 MESH_TOKEN 兜底**：`platform-server.ts` `lingxi-mesh-v2-secret` → `randomBytes(16)` 随机生成；4 份 install 脚本的 .env 模板同步改为 `change-me-to-a-strong-secret`
3. **4 份 `.env.example`**：2 份乱码+弱密钥的整份重写（英文注释），2 份去 IP；全部补 `PLATFORM_URL` 说明
4. **前端配置机制**：新增 `platform-config.js`（本地真实地址，gitignore 保护）+ `platform-config.example.js`（开源示例），3 处 `index.html` 已接线
5. 本地 `.env`×3 已补 `PLATFORM_URL`，现有平台连接不受影响

## Git 仓库清理（gitignore 管不住的已跟踪文件）
解除跟踪（磁盘保留）：`_archive/`（42 文件，含部署记录/旧脚本）、`data-smoke-b13b/main.db`（50MB 用户数据库）、
`workspace/backup-cleanup-20260728.zip`、`docs/dev/灵犀引擎接回云平台开发计划-v2.0.12.md`（含 IP）、
`*_cleanup-bak-*/`（12 文件）、`workspace/modify_docs.py`
`.gitignore` 新增：`platform-config.js`、`DEPLOY_RECORD_*.md`、`_archive/`、`data-smoke-b13b/`、`_cleanup-bak-*/`、`data-platform/`

## 验证结果
- `git grep`（已跟踪文件）：`47.93.157.83` / `lingxi-mesh-v2-secret` / `8f843aadb3` / `sg-2zehfur6` → **零命中**
- 磁盘活代码扫描：零残留
- `tsc`：22 个错误全部在 `force-complete-scheduler.ts`（8/26 遗留半成品，本次未触碰），本次修改文件零错误

## ⚠️ 开源前仍需人工处理
1. **轮换密钥**（已泄露于 .env 与 git 历史）：`PLATFORM_ADMIN_TOKEN`（最急）、`JWT_SECRET`、`ADMIN_TOKEN`、`DEEPSEEK_API_KEY`、`LAN_SECRET`、`MESH_TOKEN`
2. **git 历史仍含 IP 与 token**（提交 93ad2de/3a6d307/1ebc623/900f7df/a830c93 等）。开源若要保留历史，需 `git filter-repo` 清洗；更简单的方案：以当前清理后的工作区**新建孤儿分支或新仓库**作为开源起点
3. 打包用白名单拷贝，勿 `git add .`（根目录乱码 md、_tmp_*、data-platform/ 均不入库）

## 2026-09-01 发布目录准备与 git 初始化（续）

### release/ 目录（workspace\release，白名单构建产物）
- 由根目录 `build_release.ps1` 构建（site_inner 根布局，index.ts 为入口），构建时已含三重安全扫描与 gitignore/ci.yml 补丁
- 清理两批 smoke 测试运行时垃圾：node_modules、smoke-data（含 409KB main.db）、smoke.log、usage.json、data/、workspace/、lingxi_engine/__pycache__（23 个 .pyc）
- **终止残留进程**：凌晨 3:42 的 smoke 实例（PID 6188/4276，监听 4011）一直存活并持续写垃圾，已终止；主项目根目录的 5 个生产 node 进程未动
- 最终盘点：637 个跟踪文件，约 4.3MB

### git 仓库初始化（独立于旧历史）
- `git init` + `main` 分支，根提交 `174f175`（feat: LingXi Engine open-source initial release）
- 修复 `.gitignore` 误伤：`_*.py` 规则会匹配 `__init__.py`，已加 `!__init__.py` 豁免；新增 `__pycache__/`、`*.pyc` 排除
- 终验通过：无 .pyc/.env/.db/platform-config.js 入库；`git grep HEAD` 三项密钥扫描（IP / MESH 弱密钥 / ADMIN token）零命中；工作区干净

### 已验证就位
- LICENSE（MIT, 305B）、CHANGELOG.md、CONTRIBUTING.md、README.md、.env.example/.env.template
- ci.yml：Python 回归路径已改为 `lingxi_engine/tests`，失效的 failover 步骤已移除

### 待用户手动（按顺序）
1. 轮换服务器密钥（清单见上文"仍需人工处理"）
2. GitHub 新建 **Private** 仓库（建议名 `lingxi`，勿勾 README/.gitignore/license）
3. 本地生成 SSH key 并贴到 GitHub（Settings → SSH keys）；公钥非机密可手动贴，私钥永不外传
4. `cd workspace/release && git remote add origin git@github.com:<用户名>/<仓库名>.git && git push -u origin main`
5. GitHub 网页逐目录复查（重点 .env/db/备份）→ 确认后 Settings → Danger Zone → 转 Public
### 2026-09-01 本地全量验证（最终）
- 根提交 076b571（634 文件，单提交历史）
- tsc --noEmit --skipLibCheck：0 错误（与 CI 同命令）
- Python 回归 run_all.py：ALL_OK=True（12 套件 152 断言全过）
- ci.yml 因 GBK 乱码破坏 YAML 结构（name/run 挤行），已整体重写为纯 ASCII 并 amend
- 测试输出文件 run_all_result.txt 等 3 个解除跟踪并 gitignore（防工作区反复弄脏）
- 终验：工作区 CLEAN / 634 跟踪文件零垃圾 / HEAD 密钥三重扫描零命中 / __init__.py 在库
