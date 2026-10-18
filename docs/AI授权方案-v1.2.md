# AI 使用权授权方案 v1.2

> 目标：加好友 ≠ 能用对方的 AI。任何跨用户调用他人 AI 的行为，都必须经 AI 主人同意。
> 版本：v1.2 · 2026-10-18 · 引擎版本 2.0.34

---

## 一、核心规则

| 场景 | 是否允许 | 说明 |
|---|---|---|
| 用自己的 AI | ✅ 直接允许 | 通过 `users.agent_id` 绑定或 numeric_id 别名判定主人身份 |
| 用好友的 AI（已授权） | ✅ 允许 | 需存在 `accepted` 且在有效期内的授权 |
| 用好友的 AI（未授权） | 🔒 拦截 | 返回 `no_grant`，前端置灰 + 「申请授权」 |
| 陌生人用你的 AI | 🚫 拦截 | 唯一例外：该 AI 本来就在这个群里（避免打断存量群聊） |
| 平台公共 AI（如 AI助手） | ✅ 直接允许 | `status=shared`，无需授权 |

判定入口只有一个：`canUseAgent(agentId, granteeId, { chatId, tool })`。
所有聊天发送、拉成员、工具调用都必须过这一关。

---

## 二、数据模型

表 `agent_grants`：

| 字段 | 说明 |
|---|---|
| `id` | 授权 ID（`grant_xxx`） |
| `agent_id` | 被授权的 AI |
| `owner_id` | AI 主人（同意方） |
| `grantee_id` | 借用方 |
| `scope` | `group` / `friend` / `task` |
| `chat_id` | scope=group 时的群会话 ID（**授权只在该群生效**） |
| `task_id` | scope=task 时的任务 ID |
| `status` | `pending` / `accepted` / `rejected` / `revoked` / `expired` |
| `skills` | JSON 数组；空 = 全部能力 |
| `batch_id` | 批量授权批次（v1.2） |
| `reminded_at` | 到期提醒去重标记（v1.2） |
| `created_at` / `decided_at` / `expires_at` | 时间戳（毫秒） |

索引：`(agent_id, grantee_id, status)`、`(owner_id, status)`、`chat_id`。

---

## 三、角色与权限

| 操作 | 谁能做 |
|---|---|
| 发起申请 | 借用方本人 |
| 同意 / 拒绝 | 该 AI 主人（或 admin） |
| 批量授权 | 该 AI 主人（或 admin） |
| 撤销 | 授权给出的主人 |
| 续期 | 主人或借用方（借用方续期等于重新申请） |

---

## 四、接口清单

### 4.1 基础

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/agent-grants` | 发起申请（scope / chatId / ttlHours / note / skills） |
| GET | `/api/agent-grants/inbox` | 待我审批 |
| GET | `/api/agent-grants/outbox` | 我给出的（含 expired） |
| PATCH | `/api/agent-grants/:id` | `{action: accept\|reject\|revoke, ttlHours, skills}` |
| DELETE | `/api/agent-grants/:id` | 撤销 |
| GET | `/api/agent-grants/available?userId=&chatId=` | 可用成员（带 grantStatus） |
| POST | `/api/agent-grants/status` | 批量查状态（chatId + agentIds） |
| POST | `/api/agent-grants/check-tool` | 工具级放行判断（v1.2） |

### 4.2 v1.2 新增

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/agent-grants/bulk` | 主人批量授权。`{agentId, scope, chatId, ttlHours, skills}`，不传 `granteeIds` 即「该群全员」；已存在的自动续期/改范围 |
| PATCH | `/api/agent-grants/batch-decide` | 收件箱批量审批。`{action, ids[], ttlHours?, skills?}`，单次上限 200 |
| POST | `/api/agent-grants/:id/renew` | 续期。`{ttlHours}`，过期记录可一条恢复为 accepted |
| GET | `/api/agent-grants/expiring?withinHours=24` | 即将到期。返回 `asOwner[]` / `asGrantee[]`，含 `hoursLeft` |
| GET | `/api/agent-grants/chat/:chatId` | 群内「成员 × 智能体」授权矩阵 |

---

## 五、按能力（技能）细分授权

- `skills` 为空数组 → 不限制，全部工具可用。
- `skills = ["web_search","read_file"]` → 只有这两类工具放行，其余返回 `tool_not_granted`。
- 匹配顺序：先找「无限制」的授权，再找「包含目标工具」的授权。
- 工具名与 `src/tools/builtin.ts` 注册名一致，例如：
  `web_search` `scrape_url` `read_file` `write_file` `code_execute` `shell_exec`
  `generate_image` `delegate_task` `github_search` `patch_file` `list_dir`

前端可选能力（8 项常用）：联网搜索 / 抓网页 / 读文件 / 写文件 / 跑代码 / 执行命令 / 画图 / 派子任务。

---

## 六、到期提醒

- 调度器每 **30 分钟**扫一次，重启立即扫一次（补发停机期间漏掉的）。
- 条件：`status=accepted` 且 `0 < expires_at - now <= 24h` 且 `reminded_at = 0`。
- 推送 `agent_grant.expiring`：**主人和借用方各一条**。
- 写入 `reminded_at` 去重，续期/改范围时清零，可再次提醒。
- 前端：授权中心顶部横幅 + 聊天页好友面板顶部横幅，均带「续 7 天」按钮。

---

## 七、前端

### 7.1 `/app/grants.html` — AI 授权中心

四个 Tab：

1. **📥 待我审批** — 多选 + 全选 + 批量同意/批量拒绝；每条显示范围、有效期、能力、附言
2. **📜 我给出的** — 技能 chip、续 7 天、撤销；过期项显示「续期」
3. **🤝 好友的 AI** — 锁状态一览 + 申请授权
4. **⚡ 批量授权** — 选 AI → 选群 → 有效期 → 能力 → 「立即授权全群」

申请弹窗（底部弹层，**不再用手填群 ID**）：
- 范围：某个群 / 仅私聊（群为下拉选择，自动列出我的会话）
- 有效期：2h / 24h / 7 天 / 长期
- 能力：8 个可点选项，不选 = 全部
- 底部实时预览一句话，提交前能看懂自己在申请什么

### 7.2 聊天页 `/chat/`

- 好友面板：好友的 AI 默认置灰 `disabled`，旁挂 🔒 未授权 + 「申请授权」
- 申请弹窗：范围 / 有效期 / 能力 / 附言
- 审批卡片：显示「谁 · 用哪个 AI · 范围 · 有效期 · 附言」+ 同意/拒绝
- 批量审批工具条 + 到期横幅
- WebSocket 事件：`agent_grant.requested` / `.decided` / `.expiring` / `.renewed`，走 `sendToUser` 定向推送

---

## 八、安全要点

1. **身份不得由请求体决定**：`granteeId` 一律取 JWT 持有者，忽略 body 伪造。
2. **撤销即时生效**：每次准入都实时查库，不做缓存。
3. **越权校验**：审批/批量/撤销都校验 `owner_id === me`。
4. **群范围隔离**：`chatId` 不匹配的授权不放行（v1.2 修复了 `ORDER BY created_at DESC LIMIT 1` 跨群误判）。
5. **陌生人策略**：非好友且 AI 不在该群 → 拒绝，提示「请先加对方为好友并申请授权」。

---

## 九、验证记录

| 项 | 结果 |
|---|---|
| `agent-grants.test.ts` | 9 / 9 PASS |
| `agent-grants-friend-scope.test.ts` | 3 / 3 PASS |
| `agent-grants-v12.test.ts` | 15 / 15 PASS |
| 全量 `vitest run` | **143 / 143 PASS**（10 个文件） |
| `tsc --noEmit` | 0 error |
| 生产接口链路（v1.1 上线时） | 22 / 22 PASS |
| 手机端 UI（iPhone 390×844） | 9 / 9 PASS，0 JS 报错 |

---

## 十、已知限制 / 后续

1. **存量群迁移是一次性的**：早期迁移只补给第一个非主人成员；v1.2 改为「该群所有好友成员各补一条」且幂等，但**已迁移过且被跳过的历史数据不会自动补**，需要重跑迁移或让主人用「批量授权」补。
2. 批量授权单次上限 500 人，批量审批上限 200 条。
3. 借用方「续期」目前等同重新申请，需主人再次同意（避免借用方无限自助延期）。
4. 能力白名单只做工具级粗粒度控制，参数级限制（如只读某目录）未实现。

---

## 十一、运维

```bash
# 功能开关（默认 on）
FEATURE_AGENT_GRANTS=on

# 重启（必须走 PM2，禁止手工 kill，否则会和 PM2 抢 3456 端口）
sudo pm2 restart lingxi-engine

# 查日志
sudo pm2 logs lingxi-engine --lines 100
```

建表语句在 `src/routes/agent-grants.ts` 的 `ensureSchema()`，启动时自动执行，含 `ALTER TABLE` 兜底加列（`skills` / `batch_id` / `reminded_at`）。
