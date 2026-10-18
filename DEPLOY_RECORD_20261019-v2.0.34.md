# 部署记录 · v2.0.34（AI 授权 v1.2）

- 时间：2026-10-19 02:45 ~ 03:10（Asia/Shanghai）
- 环境：腾讯云香港 `43.161.224.64` · `/opt/lingxi-engine` · PM2 `lingxi-engine`
- 域名：https://www.lingxi-engine.com
- 版本：2.0.33 → **2.0.34**

---

## 一、本次上线内容

### 1. 后端（`src/routes/agent-grants.ts`）

| 能力 | 接口 |
|---|---|
| 主人一键授权整群（幂等，已存在自动续期/改范围） | `POST /api/agent-grants/bulk` |
| 收件箱批量同意/拒绝（单次上限 200） | `PATCH /api/agent-grants/batch-decide` |
| 过期授权一条恢复 | `POST /api/agent-grants/:id/renew` |
| 24h 内到期清单（主人/借用方分组，含 hoursLeft） | `GET /api/agent-grants/expiring` |
| 群内「成员 × 智能体」授权矩阵 | `GET /api/agent-grants/chat/:chatId` |
| 按能力（工具）细分授权 | `agent_grants.skills` + `POST /api/agent-grants/check-tool` |

**到期提醒**：`startGrantReminders(30min)`，到期前 24h 推送 `agent_grant.expiring`，主人与借用方各一条，`reminded_at` 去重，续期后清零可再提醒。

**修复**：`available` 取授权原为 `ORDER BY created_at DESC LIMIT 1`，会拿到其他群的授权导致「显示已授权但实际 403」；改为优先匹配当前 `chatId`。

### 2. 安全修复回收（生产侧改动回灌 git）

生产服务器上曾直接改过两处，但从未入库，导致 git/本地版本落后：

1. `canUseAgent`：**非好友默认拒绝**，唯一例外是该 AI 本来就在此群（`already_participant`）。
2. 新增 `grantDeniedMessage()`，把 `reason` 翻译成用户可读文案；`friends-chats` 的 403 改用它。

本次已合并回仓库，并补测试（陌生人拒绝 / 已在群放行 / 文案可读）。

### 3. 前端

- `web/app/grants.html` 重写：四个 Tab（待我审批 / 我给出的 / 好友的 AI / 批量授权），到期横幅、多选批量审批、能力勾选、续期按钮、20s 自动刷新。
- `web/js/app.js`：好友面板到期横幅、多选批量审批、申请弹窗能力勾选；申请范围改为下拉选群（不再手填群 ID）。
- `web/chat/index.html`：`app.js` 版本号 `20261018a`，避免旧缓存。
- `web/download.html`：APK v1.2.0，`/lingxi-app.apk`，新增浏览器直开 `/app/`。

---

## 二、部署步骤（实际执行）

```bash
# 1) 备份线上文件
/opt/backup-lx134-20261019-024502/   # 部署前
/opt/backup-lx134b-20261019-024728/  # 回滚后再部署前

# 2) 安装（scp 到 /tmp/lx134 后 sudo cp）
index.ts, package.json, version.txt, BUILD-INFO.json
src/routes/agent-grants.ts, src/routes/friends-chats.ts
web/app/grants.html, web/js/app.js, web/chat/index.html,
web/download.html, web/mobile.html, docs/AI授权方案-v1.2.md

# 3) 重启（必须走 PM2，禁止手工 kill）
sudo pm2 restart lingxi-engine
```

---

## 三、事故与回滚（重要）

首次部署只上传了 `agent-grants.ts` 新版本 + `index.ts` 新版本，但**线上 `friends-chats.ts` 依赖 `grantDeniedMessage`**，该导出在新版 `agent-grants.ts` 中不存在 → `SyntaxError` → 进程崩溃 → 全站 **502**。

处理：

1. 立即从 `/opt/backup-lx134-20261019-024502/` 回滚 `agent-grants.ts`；
2. 发现 `index.ts` 新版仍引用 `startGrantReminders`（旧文件没有），继续回滚 `index.ts`；
3. 服务恢复（`/api/health` 200，3456 端口监听）；
4. 把线上独有的两处安全修复合并进新版文件，`friends-chats.ts` 同步更新，三份文件成套上传；
5. 再次重启 → 正常。

**结论**：跨文件存在导出依赖时，必须成套部署；单文件灰度会导致 ES module 链接期崩溃（不是运行时错误，无法被 try/catch 兜住）。

---

## 四、上线后验证

### 站点可达性（16 项）

`/` `/chat/` `/m/` `/app/` `/app/grants.html` `/js/app.js?v=20261018a` `/download.html`
`/demo/ai-grant.html` `/demo/mobile-grant.html` `/privacy.html` `/terms.html` `/robots.txt`
`/sw.js` `/manifest.json` `/api/health` → 全部 **200**
`/api/agent-grants/inbox` 未登录 → **401**（正确）

### 生产端到端（真实账号，19 项全通过）

| # | 用例 | 结果 |
|---|---|---|
| 1 | 注册即自带 AI（auto_default） | PASS |
| 2 | 好友申请 / 对方同意 | PASS |
| 3 | 借用方发起申请（带技能白名单） | PASS |
| 4 | 待审批时调用被拦（pending_approval） | PASS |
| 5 | 主人收件箱可见，技能字段随申请带入 | PASS |
| 6 | 批量同意 | PASS |
| 7 | 白名单内工具放行 | PASS |
| 8 | 白名单外工具拦截（tool_not_granted） | PASS |
| 9 | 跨群不放行 | PASS |
| 10 | `/expiring` 可用 | PASS |
| 11 | 续期 | PASS |
| 12 | 群授权矩阵 | PASS |
| 13 | 批量授权全群 | PASS |
| 14 | 撤销 | PASS |
| 15 | 撤销后立即失效 | PASS |
| 16 | 陌生人被拒（not_friend_agent） | PASS |
| 17 | 未登录 401 | PASS |

### 本地

- `tsc --noEmit` → 0 error
- `vitest run` → **154 / 154 PASS**（10 个文件）
- `node --check` 前端两文件 → OK

---

## 五、遗留与建议

1. **限流键在反向代理下退化为全站共享**
   `src/middleware/rate-limit.ts` 的 key 是 `req.ip:req.path`，而 `TRUST_PROXY` 默认 false，nginx 后所有请求的 `req.ip` 都是 `127.0.0.1`。
   后果：`/api/auth/register` 的「5 次/分钟」实际上是**全站 5 次/分钟**，一次并发注册高峰就会误伤所有人。
   建议：设 `TRUST_PROXY=true`（nginx 已正确设置 `X-Forwarded-For`），或改用 nginx `real_ip` 模块；同时注意 P0 XFF 伪造修复的上下文。

2. **存量老群授权**：早期迁移只补给第一个非主人成员，历史数据需主人用「批量授权」补。

3. **域名 2026-10-24 到期**，需在腾讯云后台续费。

---

## 六、回滚方式

```bash
sudo -n cp -a /opt/backup-lx134b-20261019-024728/* /opt/lingxi-engine/   # 按需覆盖对应文件
sudo pm2 restart lingxi-engine
```

`FEATURE_AGENT_GRANTS=off` 可一键关闭授权强制（回退到旧行为），无需回滚代码。
