
---

# 附：全量落地结果（2026-10-18 23:10，生产已开启并实测）

## 一句话结论

**「加好友 ≠ 能用对方 AI」已在生产生效。** 后端三处拦截 + 聊天界面锁与审批卡片全部上线；生产环境 12/12 接口用例、UI 全链路、成员面板行级检查全部通过，且**没有误伤用户自己/共享的 AI**。

---

## 一、生产状态

| 项 | 值 |
|---|---|
| 开关 | `FEATURE_AGENT_GRANTS=on` |
| 服务 | `pm2 lingxi-engine` · `health=200` |
| 启动日志 | `[grants] schema ready, feature=on` · `legacy participants migrated: 16` |
| 真实页面 | `/app/grants.html` 200 · `/demo/ai-grant.html` 200 |
| 存量兼容 | 16 条已入群 AI 自动补 7 天授权 |

---

## 二、界面（这一轮新增）

| 功能 | 位置 | 效果 |
|---|---|---|
| 成员面板锁 | `loadAvailableMembers()` | 好友的 AI：`🔒 未授权` + 「申请授权」+ 复选框 **disabled** |
| | | 自己/共享的 AI：`可直接用`，复选框正常 |
| 申请弹窗 | `applyAgentGrant()` | 范围（本群/仅私聊）+ 有效期（2h/24h/7d/长期）+ 附言 |
| 审批卡片 | `renderRequests()` | 好友面板顶部「XX 想用你的 AI」+ 范围/有效期/附言 + 同意/拒绝 |
| 红点 | `requestNotifyCount` | 授权申请计入未读数 |
| 实时推送 | WS | `agent_grant.request / decided / revoked / blocked` |
| 定向推送 | `sendToUser()` | 只发当事人，不全局广播 |
| 批量状态接口 | `POST /api/agent-grants/status` | 一次拿全量状态（≤500） |

---

## 三、决定性修复（否则会被用户骂死）

**问题**：第一版强制所有 Agent 都要授权，结果连用户自己/本机共享的 `AI助手` 都被 403 拦掉 —— 聊天直接废了。

**修法**：把强制范围收敛到「**好友的 AI**」，正好对应需求原话「加好友后默认没有授权」：

| 情形 | 判定 | 状态 |
|---|---|---|
| 自己的 AI（含 `users.agent_id` 绑定、numeric_id 别名） | `owner` | 我的 |
| 本机/共享 Agent（不属于任何好友） | `not_friend_agent` | 可直接用 |
| **好友的 AI，无授权** | `no_grant` | 🔒 未授权 |
| **好友的 AI，申请中** | `pending_approval` | ⏳ 等待同意 |
| **好友的 AI，已同意** | `granted` | ✅ 已授权 |

另一个隐蔽坑：`api()` 首包不带 `Authorization`，本地免登录模式下会被当成 admin 虚拟身份，导致「只能向好友申请使用其 AI」误判。已新增 `grantApi()` 始终带 token。这个坑只有浏览器 E2E 能抓到，Node 直连测不出来。

---

## 四、生产实测结果

### 接口链路（`verify-final-grants.mjs` → `https://www.lingxi-engine.com`）

12/12 PASS：默认未授权 locked → 申请 201 → 待审 pending → 非主人审批 403 → 主人同意 accepted → 本群 granted → 他群 out_of_scope → 授权后可入群 200 → 未授权群 403 → 撤销 200 → 撤销后 locked → 审计流水 apply/accept/revoke。

### UI 全链路（`verify-ui-full2.mjs`，Puppeteer 打真实官网）

```
UI 提交申请: SUBMITTED
主人收件箱: 0 -> 1 | 借用B 想用 主人A的灵犀引擎 范围=group
点击同意: true
已授权列表: 1 accepted
撤销: 200
撤销后状态: locked
ERRORS=0
```

### 成员面板行级检查（生产真实数据，70 行）

```
好友的 AI  → 🤖 主人A的灵犀引擎  🔒 未授权  申请授权  [checkbox disabled=true]
共享的 AI  → 🤖 AI助手           可直接用           [checkbox disabled=false]
```

### 回归

- 自己的/共享 AI 加群：**200 ok**（不再误拦）
- 单元测试：**12/12**（原 9 + 好友范围 3）
- 全量 `vitest run`：**128/128 PASS**
- `tsc --noEmit`：本地与生产，改动文件 0 error

---

## 五、回滚（一条命令）

```bash
ssh lingxi-server
sudo sed -i 's/^FEATURE_AGENT_GRANTS=on/FEATURE_AGENT_GRANTS=off/' /opt/lingxi-engine/.env
sudo pm2 restart lingxi-engine --update-env
```

文件备份：`index.ts.bak-grants-*` / `.bak2-*`、`agent-grants.ts.bak2`、`friends-chats.ts.bak-grants`、`ws-handler.ts.bak-grants`、`web/js/app.js.bak-grants`、`.env.bak-grants`

---

## 六、验收清单（全部达成）

- [x] 加好友后对方 AI 显示 🔒，复选框禁用，无法直接加入
- [x] 「申请授权」可填范围/有效期/附言
- [x] 主人好友面板出现审批卡片，可同意/拒绝
- [x] 同意后变 ✅ 可加入群
- [x] 范围外（其他群）仍 403
- [x] 撤销后立即失效并被踢出群
- [x] 过期自动失效
- [x] 审计流水可查
- [x] 存量 16 条自动兼容
- [x] 自己/共享 AI 不受影响
- [x] 一键回滚可用
