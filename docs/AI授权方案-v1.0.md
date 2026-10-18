
---

# 附：全量落地结果（2026-10-18 晚，生产已开启）

## 一句话结论

**「加好友 ≠ 能用对方 AI」已在生产生效**（`FEATURE_AGENT_GRANTS=on`）。三处后端拦截 + 聊天界面锁与审批卡片全部上线，生产环境 12/12 接口用例、UI 全链路实测通过。

---

## 一、生产当前状态

| 项 | 值 |
|---|---|
| 开关 | `FEATURE_AGENT_GRANTS=on` |
| 服务 | `pm2 lingxi-engine`，`health=200` |
| 启动日志 | `[grants] schema ready, feature=on` + `legacy participants migrated: 16` |
| 存量兼容 | 16 条已入群的 AI 自动补 7 天授权（不静默断人） |
| 真实页面 | `https://www.lingxi-engine.com/app/grants.html` 200 |
| 演示页 | `https://www.lingxi-engine.com/demo/ai-grant.html` 200 |

---

## 二、这一轮新增（界面接入）

| 功能 | 位置 | 行为 |
|---|---|---|
| 成员面板锁 | `loadAvailableMembers()` | 好友的 AI 显示 `🔒 未授权` / `⏳ 等待同意` / `✅ 已授权`，未授权时复选框 **disabled**，旁挂「申请授权」 |
| 申请弹窗 | `applyAgentGrant()` | 选范围（本群 / 仅私聊）+ 有效期（2h/24h/7d/长期）+ 附言 |
| 审批卡片 | `renderRequests()` | 好友面板顶部出现「XX 想用你的 AI」，含范围、有效期、附言，**同意 / 拒绝** |
| 红点 | `requestNotifyCount` | 授权申请计入未读数 |
| 实时推送 | WS | `agent_grant.request / decided / revoked / blocked` 四种事件 |
| 定向推送 | `sendToUser()` | 授权通知只发给当事人，不再全局广播 |
| 批量状态接口 | `POST /api/agent-grants/status` | 成员面板一次拿全量状态（≤500 个 AI） |

## 三、修掉的一个隐蔽坑

`api()` 首包不带 `Authorization`，本地免登录模式下会被当成 `admin` 虚拟身份 → 授权归属校验误判为「只能向好友申请使用其 AI」。

修法：新增 `grantApi()`，**始终**携带 Bearer token，授权相关 4 处调用全部换成它。这个坑只在浏览器里出现，Node 直连测不出来——是 UI E2E 抓到的。

## 四、实测结果

### 生产接口链路（`verify-final-grants.mjs`，跑在 `https://www.lingxi-engine.com`）

| # | 用例 | 结果 |
|---|---|---|
| 1 | 默认未授权 → locked | PASS |
| 2 | 申请创建 201 | PASS |
| 3 | 待审 → pending（仍不可用） | PASS |
| 4 | 非主人审批 → 403 | PASS |
| 5 | 主人同意 → accepted | PASS |
| 6 | 本群已授权 → granted | PASS |
| 7 | 他群仍锁定 → out_of_scope | PASS |
| 8 | 授权后可入群 200 | PASS |
| 9 | 未授权群入群 403 | PASS |
| 10 | 撤销 200 | PASS |
| 11 | 撤销后锁定 | PASS |
| 12 | 审计流水 apply/accept/revoke | PASS |

### 生产 UI 全链路（`verify-ui-full2.mjs`，Puppeteer 跑真实官网）

```
[3] UI 提交申请: SUBMITTED
[4] 主人收件箱: 0 -> 1 | 借用B 想用 主人A的灵犀引擎 范围=group
[5] 审批面板: 🤖借用B 想用你的 AI  范围：群「chat-10215-10216」· 有效期：至 2026/10/19 23:07  附言：借用一下你的 AI，用完就还～  同意 拒绝
[6] 点击同意: true
[7] 已授权列表: 1 accepted
[10] 撤销: 200
[11] 撤销后状态: locked
ERRORS=0
```

### 其它

- 单元测试 9/9（撤销、过期、范围、开关、旁路）
- 全量回归 `vitest run`：**125/125 PASS**
- `tsc --noEmit`：本地与生产，改动文件 0 error
- 批量状态接口专测：**10/10 PASS**

## 五、回滚方式（一条命令）

```bash
ssh lingxi-server
sudo sed -i 's/^FEATURE_AGENT_GRANTS=on/FEATURE_AGENT_GRANTS=off/' /opt/lingxi-engine/.env
sudo pm2 restart lingxi-engine --update-env
```

改完立即回到旧行为（好友 AI 可直接用），代码无需回退。文件级备份：
- `/opt/lingxi-engine/index.ts.bak-grants-*`、`.bak2-*`
- `/opt/lingxi-engine/src/routes/agent-grants.ts.bak2`
- `/opt/lingxi-engine/src/routes/friends-chats.ts.bak-grants`
- `/opt/lingxi-engine/src/core/ws-handler.ts.bak-grants`
- `/opt/lingxi-engine/web/js/app.js.bak-grants`
- `/opt/lingxi-engine/.env.bak-grants`

## 六、验收清单（全部已勾）

- [x] 加好友后，对方 AI 显示 🔒 未授权，无法勾选加入
- [x] 点击「申请授权」可填范围/有效期/附言，申请直达主人
- [x] 主人好友面板出现审批卡片，可同意/拒绝
- [x] 同意后对方状态变 ✅，可加入群并调用
- [x] 范围外（其他群）仍被 403 拦截
- [x] 撤销后立即失效，且被踢出相关群
- [x] 过期自动失效
- [x] 审计流水可查
- [x] 存量 16 条历史授权自动兼容
- [x] 一键回滚可用
