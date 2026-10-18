# 官网回归验证（deploy/verify）

每次部署完官网，跑这一条就够，不用人眼一个个点：

```bash
node deploy/verify/e2e.mjs
```

退出码 `0` = 全通过，`1` = 有失败项（会打印失败清单，可直接用于 CI / 发布流水线闸门）。

## 覆盖范围（48 项）

| 段 | 验什么 |
|---|---|
| 1. 静态路由 | 26 个关键路径必须 200（首页 / 聊天 / 手机端 / 注册 / 登录 / 下载 / 隐私条款 / robots / sitemap / PWA 资源 / 下载包 / 健康检查） |
| 2. 服务健康 | `/api/health` 的 `ok` / `db` / `version` |
| 3. 注册登录 | 真实注册（自动签发 token + 自动创建 Agent）、真实登录、**错误密码必须 401** |
| 4. 会话隔离 | 注册后自动有默认会话；**越权读他人会话必须 403/404** |
| 5. 聊天全链路 | WebSocket 连接 → `subscribe` → 发消息 → `streaming.start` → 分片 → `streaming.end`，回复内容非空 |
| 6. PWA 一致性 | 解析 `sw.js` 的 `OFFLINE_URLS` 与 `manifest.json` 的 `icons`，逐项实测必须 200（防止再出现 `cache.addAll` 因 404 整体失败） |
| 7. 下载包完整性 | 下载 `lingxi-engine.tar.gz`，实测体积与 SHA256 必须和 `public/version.txt` 声明逐字节一致 |

## 用法

```bash
# 验证线上（默认）
node deploy/verify/e2e.mjs

# 验证本机 / 预发
node deploy/verify/e2e.mjs http://127.0.0.1:3456

# 跳过注册（用已有账号，避免产生测试用户）
node deploy/verify/e2e.mjs https://www.lingxi-engine.com --no-register
```

> ⚠️ 默认会**真实注册一个新账号**（`e2e-<时间戳>@example.com`）。线上跑完如需清理，见下方 SQL。

## 辅助脚本（Windows PowerShell）

| 脚本 | 用途 |
|---|---|
| `check-urls.ps1` | 纯 URL 状态码巡检，输出 PASS/FAIL 表 |
| `check-links.ps1` | 抓 `download.html` 里所有 `href` 并逐个验证是否真实存在；顺带打印 robots / sitemap |
| `check-chat-auth.ps1` | 静态扫描 `web/js/app.js` 的鉴权入口（login/register/authToken） |
| `check-chat-dom.ps1` | 拉线上 `/chat/`，确认登录弹窗 DOM（`authUsername` 等）确实存在 |

## 清理测试账号

```sql
-- 在服务器 /opt/lingxi-engine/data/main.db 上执行
DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'e2e-%@example.com' OR email LIKE 'probe%');
DELETE FROM users WHERE email LIKE 'e2e-%@example.com' OR email LIKE 'probe%';
```
