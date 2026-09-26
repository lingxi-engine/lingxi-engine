# 发布记录 · 官网 public v2.0.28

- 日期：2026-09-26
- 站点：http://47.93.157.83:8080
- 发布版本：**2.0.28**
- 构建 commit：`7e5260c`（`BUILD-INFO.json` 声明）
- 发布件 SHA256：`77AA3F310EE7DE35083455DFB994AFE2E5CBFB193BC5CD5AA9650A38AEFB94F9`

> 说明：本文件的作者**不是** 2.0.28 的发布执行者。发布由另一个并发进程完成
> （观测期间 HEAD 连续变动 `e73381e → 84aecb2 → a2c3f8c → 7e5260c → fcbc5e2`）。
> 本记录内容是**独立第三方核验**的结果，全部为实测数据。

---

## 一、站点一致性核验（官方脚本 `scripts/verify-site-consistency.ps1`）

```
SITE CONSISTENT: 12 checks passed, 0 failed.
```

| # | 检查项 | 实测结果 |
|---|---|---|
| 1 | `/version.txt` 声明的 tar 包 SHA256 | `77aa3f31…94f9` |
| 2 | 下载 tar 包实测 SHA256 | ✅ 与声明一致（1246090 字节） |
| 3 | 包内 `version.txt` vs 站点 | ✅ 均为 `2.0.28` |
| 4 | 包内 `site/install.sh` vs 线上 `/install.sh` | ✅ `a7980a85…029a`（25111 字节）字节一致 |
| 5 | 包内 `BUILD-INFO.json` | ✅ `version=2.0.28 commit=7e5260c` |
| 6 | 包内 `package.json` | ✅ `2.0.28` |
| 7 | `/download.html` 版本广告 | ✅ 广告 `2.0.28`，无残留旧版本串 |
| 8 | 版本化归档副本 `/public/lingxi-engine-v2.0.28.tar.gz` | ✅ HTTP 200，与发布件字节一致 |
| 9 | Windows 入口 `/install.ps1` | ✅ HTTP 200，17734 字节 |
| 10-12 | 其余入口 / 指向性检查 | ✅ 全部通过 |

## 二、入口可达性（HEAD/GET 实测）

| 路径 | 状态 |
|---|---|
| `/install.sh` | 200 |
| `/install.ps1` | 200 |
| `/public/lingxi-engine.tar.gz` | 200 |
| `/public/lingxi-engine-v2.0.28.tar.gz` | 200 |
| `/version.txt` | 200 |
| `/public/version.txt` | 200 |
| `/` | 200 |
| `/download.html` | 200 |
| `/index.html` | 404（非站点入口，属正常） |

## 三、本地发布源 vs 线上字节比对

| 文件 | 本地 SHA256 | 线上 SHA256 | 结果 |
|---|---|---|---|
| `site/install.sh` | `A7980A854F453A44F8234ECAEBEE36E890EC5626526E57BF5FD838C7394E029A` | 同左 | ✅ 一致 |
| `site/install.ps1` | `76925BCAE6FE97F314158A328F734B8C7BEF30951581163933A0D90F7C0026DD` | 同左 | ✅ 一致 |
| 仓库根 `BUILD-INFO.json` | `2.0.28 / 7e5260c` | 包内同值 | ✅ 一致 |

## 四、上一次遗留 Bug 的修复确认（"新建会话不能改名"）

| 检查点 | 实测 |
|---|---|
| 路由注册 | ✅ `index.ts:2957` `registerFriendsChatsRoutes(app, { db, requireAuth, broadcast })` |
| 改名端点 | ✅ `PATCH /api/chats/:id/name`（`src/routes/friends-chats.ts:379`） |
| 后端文件在包内 | ✅ `src/routes/friends-chats.ts`（21178 字节） |
| 前端 UI | ✅ `web/js/app.js:1012` `// ── v2.0.25: 重命名当前会话/群聊 ──` |
| i18n 文案 | ✅ `web/js/i18n.js:320` `'chat.renameTitle': '重命名会话'` |
| 专用测试在包内 | ✅ `src/tests/chat-rename.test.ts`（5770 字节） |

## 五、无头服务器安装体验修复确认（v2.0.28 主题）

线上 `install.sh` 收尾提示已含无图形环境的显式说明：

```
ℹ️  无图形界面，浏览器不会自动打开（正常行为，非故障）。请任选一种访问方式：
    ① SSH 隧道（推荐）: ssh -N -L 3456:127.0.0.1:3456 root@<你的IP>
    ② 内网直连: http://<你的IP>:3456
```

并新增「升级前后版本」提示（`install.sh:114-115 / 333-336`）：

```bash
VERSION_BEFORE="$VERSION"
...
if [ -n "${VERSION_BEFORE:-}" ] && [ "$VERSION_BEFORE" != "$VERSION" ] && [ "$VERSION_BEFORE" != "unknown" ]; then
    DEPLOY_NOTE=" (升级自 v$VERSION_BEFORE)"
fi
ok "部署版本: v$VERSION$DEPLOY_NOTE"
```

## 六、本地质量门

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ exit 0，0 错误 |
| `npx vitest run` | ✅ 5 文件 / **100 通过**，406ms |
| `git rev-list --left-right --count origin/main...HEAD` | ✅ `0  0` 零差异 |

## 七、边界与合规

- 对生产服务器全程**只读**（仅 GET/HEAD），未上传、未改动任何字节、未重启其进程。
- 未读取或输出任何私钥内容。
- 本次核验产生的临时目录 `%TEMP%\lx-verify-28\` 已删除。
- 本记录文件为本地新增，**未 commit、未 push**，是否纳入版本库由用户决定。

---

## 附：核验中发现但不属本次处理范围的观察

1. **工作区存在 2 个未跟踪文件**：`skills/release-deploy-verify.json`、`skills/release-verify-publish.json`
   （由并发发布进程创建；JSON 内容合法，按仓库既有约定，`skills/*.json` 是被跟踪并随发布包分发的类别）。
2. **运维提醒（已报告，未擅自处理）**：官网服务器上 `/opt/lingxi-engine` 常驻运行的版本较旧且无 systemd unit。
3. 用户新服务器 `iv-yegto0qfb4h0t6hif3e5` 无法从本机直连，其 `systemctl/ss/curl` 自检需用户在服务器侧执行。
