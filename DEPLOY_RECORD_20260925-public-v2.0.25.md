# 部署记录：v2.0.25 发布到官网服务器

- 日期：2026-09-25
- 执行人：AI 助手（本地研发总智能体）
- 本地 HEAD：`64658e7`（fix(deploy): install scripts now tracked in site/ with dynamic version）
- 本地版本：`2.0.25`
- 目标服务器：`47.93.157.83`（SSH 别名 `lingxi-server`，用户 `root`，密钥 `~/.ssh/lingxi_deploy`）
- 服务根目录：`/var/www/lingxi`，公开目录：`/var/www/lingxi/public`
- 端口：8080（由 `/var/www/lingxi/server.js` 提供，nginx 仅监听 80）

## 背景

此前官网长期停留在 v2.0.23，导致 `curl install.sh | bash` 装出来的引擎缺少「会话重命名」修复。
根因：本地 `pack-release.ps1` 只负责打包，**没有发布脚本**，`public/` 靠手工传输，版本脱节。

## 本批次上传的文件

| 文件 | 大小 | 说明 |
|---|---|---|
| `public/lingxi-engine.tar.gz` | 1,213,383 B | 主下载入口（install.sh 默认拉取） |
| `public/lingxi-engine-v2.0.25.tar.gz` | 1,213,383 B | 带版本号的归档副本 |
| `public/version.txt` | — | 版本清单，install.sh 动态读取 |
| `public/install.sh` | — | 改为动态读版本，不再硬编码 |
| `public/install.ps1` | — | Windows 安装脚本同步 |

SHA256（本地与服务器一致）：
```
db31f21d88d55141022c0f54b6f37d22628fe32b8f303111e730705ae88d6c0f
```

## 执行步骤

1. SSH 连通性测试通过（首次超时后重试成功）。
2. 备份线上旧文件到 `/var/www/lingxi/public/.bak-20260925/`（install.sh / install.ps1 / version.txt / lingxi-engine.tar.gz / lingxi-engine-v2.0.23.tar.gz），可回滚。
3. scp 上传 4 个文件到 `public/`。
4. 服务器端 `sha256sum` 校验：两个 tarball 哈希均与本地 `version.txt` 记录一致。
5. 同步根目录死副本：`/var/www/lingxi/version.txt`（原为 2.0.23）与 `/var/www/lingxi/install.ps1`（原为 9/6 旧版），旧文件已备份为 `version.txt.bak-20260925-v2023`。
   - 说明：`server.js` 第 231 行兜底静态文件统一从 `public/` 读取，根目录副本不影响服务，仅消除误导。
6. 归档 `releases/lingxi-engine-v2.0.25.tar.gz`。
7. HTTP 出口验证：
   - `http://47.93.157.83:8080/version.txt` → 2.0.25 ✅
   - `http://47.93.157.83:8080/public/version.txt` → 2.0.25 ✅
   - `http://47.93.157.83:8080/public/lingxi-engine.tar.gz` → 200 ✅
8. 端到端验证：从服务器下载 tarball，本地 SHA256 一致；解压后 `version.txt` = 2.0.25；关键文件齐全（`index.ts`、`src/core/mvp-market/service.ts`、`src/routes/mvp-market.ts`、`src/routes/friends-chats.ts`、`web/js/app.js`、`web/js/i18n.js`）。
9. 功能确认（包内）：
   - `index.ts` 含 `registerFriendsChatsRoutes(app, { db, requireAuth, broadcast })` —— 修复「路由从未注册」导致线上 404 的根因。
   - `app.js` 含 `renameChat()`、✏️ 按钮、`newChat()` 命名 prompt。
   - `i18n.js` 含 7 语言重命名文案。

## 回滚方式

```bash
ssh lingxi-server "cd /var/www/lingxi/public && cp -p .bak-20260925/install.sh .bak-20260925/install.ps1 .bak-20260925/version.txt .bak-20260925/lingxi-engine.tar.gz . && echo ROLLED_BACK"
```

## 遗留事项

- 未重启服务器上的引擎服务（本次仅更新静态发布文件，未触碰运行中进程）。
- `releases/` 目录缺 v2.0.18–v2.0.21，属历史遗留，不影响本次发布。
- 后续发布应使用 `scripts/publish-site.ps1`，避免再次手工传输导致版本漂移。
