# 部署记录 · 2026-09-22 · 公开下载源升级到 v2.0.22

## 背景
用户问：能否用 `irm http://47.93.157.83:8080/install.ps1 | iex` 从新部署拿到最新版。
排查发现：**该一键脚本当时拿到的是 2.0.20（比本地 2.0.22 更旧）**，属于降级。

## 根因
- 服务器下载源 `/var/www/lingxi/public/lingxi-engine.tar.gz` 停留在 **2.0.20**
- 官网下载页 `/var/www/lingxi/public/download.html` 标题/按钮/链接均写死 **v2.0.20**
- `public/install.sh` 的 `VERSION="2.0.20"`
- `public/version.txt` 描述 `2.0.20`
- `/var/www/lingxi/releases/` 最新只到 v2.0.17

## 本次动作（全部有工具返回为证）
1. 修复打包器 `scripts/pack-release.ps1`：排除正则补 `^data-`、`^_`、`^fo_main\.txt$`，堵住测试数据泄漏（提交 `6bef358`，已 push）。
2. 用官方打包器产出干净包 `lingxi-engine-v2.0.22.tar.gz`：
   - 830 项、顶层仅 `lingxi-engine/`、零 `.env`/`data-*`/`_*` 泄漏
   - `BUILD-INFO.json` = version 2.0.22 / commit 1dbeeaa / builder pack-release.ps1
   - SHA256 `D91E04E6D6C4EEAAB25A1BF7F090879AD6598FF232BF2883B62BCBFFB86C828A`
   - 备份：`D:\lingxi-engine-v2.0.22.tar.gz`、`F:\lingxi-engine-v2.0.22.tar.gz`
3. 上传并三处覆盖（旧文件已 `.bak-20260922-v2022` 备份）：
   - `/var/www/lingxi/public/lingxi-engine.tar.gz`（通用名，install.ps1 引用）
   - `/var/www/lingxi/public/lingxi-engine-v2.0.22.tar.gz`
   - `/var/www/lingxi/releases/lingxi-engine-v2.0.22.tar.gz`
   - 三处 md5 一致 = `7348fe516c6e2e74e2e284cbd0d12599`
4. 官网下载页升级：用本地 `web/download.html`(v2.0.22) 覆盖 `public/download.html`（旧版备份 `.bak-20260922-v2020`），5 处版本号 + 下载链接全部 → v2.0.22。
5. `public/install.sh` VERSION → 2.0.22；`public/version.txt` → 2.0.22。

## 验证（公网实测）
- `GET /public/lingxi-engine.tar.gz` → md5 `7348fe51…`，包内 `version.txt=2.0.22` ✅
- `GET /download.html` → 全 v2.0.22，下载链接 `/public/lingxi-engine-v2.0.22.tar.gz` ✅
- `GET /install.sh` → `VERSION="2.0.22"` ✅
- `GET /install.ps1` → 引用通用名 tarball（现为 2.0.22）✅

## 结论 / 提醒
- 一键脚本**现在**能装到 2.0.22；**但不要在本机执行**：install.ps1 会
  (a) 覆盖 `%USERPROFILE%\lingxi-engine`（= 本仓库），(b) 杀掉所有命令行含 `lingxi-engine` 的 node 进程（含 3456 主实例与 bench），
  (c) 强制写 `data\sandbox-config.json={"enabled":false}` 关闭沙箱。本机代码已是 2.0.22，无需重装，只需重启 3456。

## 遗留（下一阶段）
- `/opt/lingxi-engine`（线上引擎）仍为 **2.0.17**，pm2 `lingxi` 已跑 9 天，未重启。
- `index.ts:744` 的 `/api/health` 版本号优先取 `process.env.npm_package_version` → 子进程会继承父进程旧值，导致 2.0.22 代码报 2.0.20（commit 正确）。建议改为优先读 `BUILD-INFO.json`/`package.json`。
- L4 夹具被 L4-002「删空 bench/data」破坏，需每题隔离/自动恢复。
