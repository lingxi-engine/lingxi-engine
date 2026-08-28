# 模块文档：钱包、积分与 AI 员工市场（doc-wallet-market）

> 覆盖：`src/storage/db.ts`（钱包/积分/雇佣部分）、`src/routes/market.ts`、
> `src/routes/misc.ts`（钱包端点）、`src/payments/provider.ts`
> 对应代码量：~2,500 行 ｜ 更新：2026-08-29

---

## 1. 模块职责

平台结算层：积分体系 + 双币钱包（USD/CNY）+ AI 员工市场（发布/雇佣/解雇）
+ 支付通道适配。**这是平台的钱袋子，改一行都要跑完整回归清单。**

## 2. 两套账本（别搞混）

| 体系 | 函数族 | 用途 |
|------|--------|------|
| **积分 credits** | `getUserCredits / addCredits / spendCredits / getCreditHistory` | 雇佣结算、平台内消费 |
| **钱包 wallet** | `ensureWallet / getWallet / addWalletBalance / spendWalletBalance / listWalletTx` | USD/CNY 充值余额 |

- 汇率（官网写死）：**1 USD ≈ 100 积分，1 CNY ≈ 14 积分**
- 钱包字段：`balanceUsd / balanceCny / frozenUsd / frozenCny`（有冻结金额概念）
- 流水：`_walletTx()` 记录每笔变动（type/reason/balanceAfter），对账靠它

## 3. 市场数据模型

- 表：`agent_market`（id 格式 `ml-时间戳36进制`，status='active' 上架）
- 列表排序：`rating DESC, hire_count DESC`
- **所有权校验**：publish 只能发布自己的 Agent（agents.user_id === publisher_id），
  unpublish 只能下架自己的商品——这两个校验是 Bug #14/#15 修的，**别删**

## 4. 雇佣流程（hire）

```
买家雇佣 → 校验买家积分（Bug #11）
  → spendCredits 扣买家（Bug #12）
  → createHire 建雇佣记录
  → createChat + addParticipant 建买卖家聊天通道（Bug #13）
卖家侧：listHiresBySeller 看订单，fireHire 解雇
```

- 雇佣记录查询：`getHire / listHiresByBuyer / listHiresBySeller`
- ⚠️ 扣费与建单目前**不是事务**：spendCredits 成功但 createHire 失败时
  钱已扣单没建。改造时优先补事务边界（见坑位记录）

## 5. 支付通道（payments/provider.ts）

```typescript
type PaymentChannel = 'stripe' | 'alipay' | 'wechat' | 'internal';
getPaymentProvider(channel) // 工厂，默认 internal
isPaymentLive()             // 是否真实支付（false = 内部模拟）
```

- 当前默认 `internal`（内部记账，无真实资金流）
- 接 Stripe/支付宝/微信时实现 `PaymentProvider` 接口（PaymentIntent /
  PaymentResult / RefundResult 三接口），**别绕过 provider 直接改余额**

## 6. 市场四种商品类型

前端支持：🤖 AI员工 / 🎵 音乐成品 / 🎬 视频成品 / 🛡️ 漏洞悬赏。
后端 agent_market 表目前以 Agent 为主，其他类型走前端展示层映射——
改后端表结构时四类都要照顾。

---

## 回归测试清单（改本模块必跑，一条不许跳）

- [ ] 充值（internal 渠道）→ 余额增加，walletTx 有记录
- [ ] 雇佣 AI 员工 → 买家积分扣减正确 + 卖家到账正确 + hire 记录创建
- [ ] **积分不足雇佣 → 被拒且不产生半截数据**（Bug #11 回归）
- [ ] 雇佣成功 → 买卖家聊天通道自动建立（Bug #13 回归）
- [ ] 积分明细：支出/收入两条记录金额对称
- [ ] 发布商品：非本人 Agent → 403（Bug #14 回归）
- [ ] 下架/编辑/删除：只能操作自己的商品（Bug #15 回归）
- [ ] 市场列表按 rating + hire_count 排序正确
- [ ] 解雇（fireHire）后雇佣状态正确、通道处理正确
- [ ] 并发场景：同一买家同时雇佣两次不重复扣/漏扣
- [ ] `npm run typecheck` 绿

## 坑位记录

### 2026-08-13 市场五连修（Bug #11~15）
- 现象：雇佣不扣费、无雇佣记录、无聊天通道、可发布他人 Agent、无法下架
- 根因：市场路由初版没接结算与所有权校验
- 修复：见 market.ts 文件头注释，全部在 createMarketRoutes 内
- 教训：**市场任何写操作必须带所有权校验 + 余额校验，缺一不可**

### 2026-08-27（建档）扣费与建单非事务
- 现状：spendCredits 与 createHire 是两步，中间失败会扣了钱没单
- 待办：迁移到事务式（sql.js 内存库可先做"先建单后扣费 + 失败回滚"）
- 影响面：改这里必须同步检查 wallet 的 addWalletBalance/spendWalletBalance
  是否有同样的两步问题