# AI 员工市场功能现状分析与增强计划

- **编写日期**：2026-08-14
- **目标版本**：v2.0.12+
- **范围**：发布/雇佣/解雇/下架/编辑/删除/重新上架/评价

---

## 一、功能现状总览

| 功能 | 后端（index.ts） | 后端（src/routes/market.ts） | 前端（market.js） | 前端（app.js） | 状态 |
|------|:---:|:---:|:---:|:---:|------|
| 市场列表 | ✅ | ✅ | ✅ | ✅ | **可用** |
| 发布员工 | ✅ | ✅ | ✅ | ✅ | **可用** |
| 雇佣员工 | ✅ | ✅ | ✅ | ✅ | **可用** |
| 我的员工 | ✅ | — | ✅ | ❌ | **可用**（仅 market.html） |
| 解雇员工 | ✅ | — | ✅ | ❌ | **可用**（仅 market.html） |
| 我的发布列表 | ✅ | — | ✅（无操作按钮） | ❌ | **半可用**（能看不能管理） |
| 下架/取消发布 | ❌ | ✅（已实现） | ❌ | ❌ | **死代码** |
| 编辑发布 | ❌ | ✅（已实现） | ❌ | ❌ | **死代码** |
| 删除发布 | ❌ | ✅（已实现） | ❌ | ❌ | **死代码** |
| 重新上架 | ❌ | ❌ | ❌ | ❌ | **完全缺失** |
| 评价雇佣 | ❌ | ✅（已实现） | ❌ | ❌ | **死代码** |

---

## 二、核心问题

### 2.1 后端路由未挂载（死代码）

`src/routes/market.ts` 中已实现了完整的下架/编辑/删除/评价功能（Bug #15 修复），但 **`index.ts` 从未 import 或 mount 这个路由模块**。

```
src/routes/market.ts → createMarketRoutes() 函数导出
index.ts → 没有 import，没有 app.use('/api', createMarketRoutes(...))
```

**影响**：`/api/market/unpublish`、`PUT /api/market/:id`、`DELETE /api/market/:id`、`/api/market/rate` 全部 404。

### 2.2 前端"我的发布"无管理操作

`web/js/market.js` 的 `loadMyListings()` 只渲染卡片展示信息，没有：
- 下架按钮
- 删除按钮
- 编辑按钮
- 重新上架按钮（如果已下架）

### 2.3 主页面（app.js）功能缺失

主聊天页 `web/js/app.js` 的市场面板只有"发布"和"雇佣"，没有员工管理入口（解雇、我的发布等）。

### 2.4 缺少"重新上架"

后端 unpublish 将 status 设为 `'paused'`，但没有对应的 republish 端点将其改回 `'active'`。

---

## 三、修复与增强方案

### 3.1 挂载 market 路由（P0 - 立即修复）

在 `index.ts` 中挂载 `src/routes/market.ts`，激活下架/编辑/删除/评价端点。

**改动**：`index.ts` 顶部添加 import，服务初始化处 mount。

**注意**：`src/routes/market.ts` 与 `index.ts` 中已有部分重复路由（list/publish/hire），挂载时需避免冲突——方案是只挂载 index.ts 中缺失的端点（unpublish/edit/delete/rate），或重构 market.ts 只导出缺失部分。

### 3.2 前端"我的发布"添加管理按钮（P1）

修改 `web/js/market.js` 的 `loadMyListings()`：

```
每个卡片添加操作区：
- status='active' → [下架] [编辑] [删除]
- status='paused' → [重新上架] [编辑] [删除]
```

新增函数：
- `unpublishListing(listingId)` → POST /api/market/unpublish
- `republishListing(listingId)` → POST /api/market/republish（需新增后端）
- `editListing(listingId)` → 弹出编辑表单 → PUT /api/market/:id
- `deleteListing(listingId)` → 确认后 DELETE /api/market/:id

### 3.3 后端新增"重新上架"端点（P1）

```typescript
// POST /api/market/republish
// body: { listingId, userId }
// 校验 publisher_id → UPDATE status = 'active'
```

### 3.4 前端评价功能（P2）

在"我的员工"列表（已解雇/已完成）添加"评价"按钮，调用 `/api/market/rate`。

### 3.5 主页面集成员工管理入口（P2，可选）

`web/js/app.js` 的市场面板添加"我的员工"/"我的发布" tab 或链接跳转到 market.html。

---

## 四、实施优先级

| 阶段 | 任务 | 复杂度 | 影响面 |
|------|------|--------|--------|
| P0 | 挂载 market.ts 路由到 index.ts | 低 | 激活 4 个已有端点 |
| P0-b | 修复 B1~B3（最低价校验/价格校验/禁止自雇） | 低 | index.ts publish+hire |
| P1-a | 前端 loadMyListings 添加下架/删除/编辑按钮 | 中 | market.js |
| P1-b | 后端新增 republish 端点 | 低 | index.ts 或 market.ts |
| P1-c | 前端编辑弹窗 | 中 | market.js + market.html |
| P1-d | 自定义时长（表结构+publish+hire+过期检查+前端显示） | 中高 | db.ts + index.ts + 前端 |
| P2-a | 评价功能前端 + rating 回写 | 中 | market.js |
| P2-b | app.js 集成入口 | 低 | app.js |
| P2-c | 我的订单接口与页面（B4） | 中 | index.ts + 前端 |
| P3 | 需求广场（发布需求单，远期） | 高 | 新表+新路由+新页面 |

---

## 五、计费与商业规则（用户已确认 2026-08-14）

### 5.1 现状（代码实际行为）

| 项目 | 现状 |
|------|------|
| 雇佣时长 | ❌ 无时限，一次性买断，直到手动解雇 |
| 计费方式 | 一次性扣全款（`price` 积分/次），无按时计费 |
| 发布费用 | 免费，不扣积分 |
| 平台抽成 | ✅ 10%（卖方到账 `Math.floor(price*0.9)`），抽成部分蒸发（不进任何账户） |

### 5.2 目标规则（用户决策）

1. **时长与价格由发布者自定义**：发布时设置「价格 + 时长 + 单位」，如 `30积分/2小时`、`100积分/1天`；也可选 `0=永久买断`（兼容现状）
2. **发布保持免费**
3. **抽成保持蒸发**（通缩模型，不建平台账户）
4. **需求单**：发布需求的人自己定义需求内容、预算、时长（需求广场，远期功能）

### 5.3 自定义时长的实现方案

**数据库**（`db.ts` 表结构 ALTER 增列，不重建表）：
- `agent_market` 增加：`duration INTEGER DEFAULT 0`（0=永久）、`duration_unit TEXT DEFAULT 'permanent'`（minute|hour|day|permanent）
- `hires` 增加：`expires_at INTEGER`（到期时间戳，0/NULL=永久）

**后端**：
- `POST /api/market/publish`：新增 `duration`/`durationUnit` 参数
- `POST /api/market/hire`：计算 `expires_at = Date.now() + duration×单位毫秒`，写入 hires
- `GET /api/employees`：惰性过期检查——`expires_at > 0 && expires_at < now` 的记录标记 `expired`（UPDATE status），前端显示"已到期"
- 到期后工作群保留聊天记录，agent 移出群（复用 fire 逻辑，status='expired' 而非 'fired'）

**前端**：
- 发布表单：价格输入旁加「时长 + 单位」选择（永久/X分钟/X小时/X天）
- 市场卡片：显示 `🪙 30积分 / 2小时` 或 `🪙 100积分 / 永久`

---

## 六、新发现的Bug与风险（2026-08-14 排查）

| # | 问题 | 严重度 | 建议 |
|---|------|--------|------|
| B1 | **取整陷阱**：`Math.floor(price*0.9)`，价格 1~9 积分时卖方到账 0 | 高 | 发布时限制最低价 ≥ 10 积分 |
| B2 | **发布无校验**：price 可填 0、负数、超大值 | 中 | publish 端点加上下限校验（如 0≤price≤100000） |
| B3 | **可自雇**：未校验 `buyerId ≠ publisher_id`，自己雇自己白损 10% | 中 | hire 端点加校验，返回 400 |
| B4 | **无订单查询**：`market_orders` 只写入，无"我的订单"接口/页面 | 中 | 新增 GET /api/market/my-orders |
| B5 | **无托管/争议**：付款直接到卖方，`disputed` 状态字段无逻辑 | 低（暂不做） | 远期引入托管结算 |
| B6 | **rating 只读**：`agent_market.rating` 无写入路径（rate 端点是死代码） | 中 | 随 P0 挂载 rate 端点后回写 rating |

---

## 七、注意事项

1. **最小化变更原则**：index.ts 已有 market 相关路由（list/publish/hire/employees/fire/my-listings），挂载 market.ts 时避免路由重复注册。建议：从 market.ts 中提取 index.ts 缺失的 4 个端点（unpublish/edit/delete/rate），单独挂载或合并进 index.ts。
2. **权限校验**：所有操作必须校验 `publisher_id === userId`（已在 market.ts 中实现）。
3. **积分退款**：当前解雇不退还积分；到期自动结束同样不退款（用户未要求按比例退还，暂不做）。
4. **market.html 与 index.html 的关系**：market.html 是独立页面，index.html 是主页面内嵌市场面板。两者共用部分 API 但前端代码独立。

---

## 八、验收标准

- [ ] 发布后可在"我的发布"看到，状态为"上架中"
- [ ] 点击"下架"后市场列表不再显示该员工
- [ ] 下架后可"重新上架"，恢复市场可见
- [ ] 可编辑已发布的员工信息（标题/描述/价格/标签）
- [ ] 可删除已发布的员工（需二次确认）
- [ ] 雇佣后在"我的员工"可见，可进入工作群聊天
- [ ] 解雇后员工状态变为"已解雇"，工作群入口消失
- [ ] 解雇/完成后可评价（星级+文字）
- [ ] 发布时可设置「价格+时长+单位」，市场卡片正确显示（如 30积分/2小时）
- [ ] 雇佣时长按发布者设定生效，到期后雇佣状态自动变为"已到期"，agent移出工作群
- [ ] 永久买断（时长=0）的雇佣不受过期检查影响
- [ ] 发布价格低于 10 积分时被拒绝（提示最低价）
- [ ] 不能雇佣自己发布的员工（返回明确错误）
