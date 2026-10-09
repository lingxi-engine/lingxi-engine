# 孤立模块详细功能报告（只读审计，未改动）

> 审计时间：2026-10-09
> 范围：4 个全项目 0 引用的孤立模块 —— 详细功能 + 隐身根因 + 修复建议
> 原则：**只检查，不改动**

---

## 一、team-manager.ts（160 行）— 团队协作

### 功能
多 AI 团队协作 + DB 持久化。核心是「把多个 AI 组成一个团队，分配角色，协同完成任务」。

| 方法 | 作用 |
|---|---|
| `create(name, desc, ownerId, chatId?)` | 创建团队，**自动在 DB 建群聊**（chats 表）+ 添加 owner 为参与者 |
| `addMember(teamId, agentId, role, displayName)` | 加成员（leader/coder/reviewer/writer），同步到 team_members 表 + 群聊参与者 |
| `removeMember` / `archive` / `delete` | 移除/归档/删除团队 |
| `dispatchTask(teamId, task, targetRole?)` | **按角色派发任务**（如只派给 coder） |
| `findByChatId` / `getChatId` | 团队 ↔ 群聊互查 |
| `list(ownerId?)` | 列出团队 |

### 持久化
- `team_groups` 表（db.ts:589）+ `team_members` 表（db.ts:598）+ 索引（db.ts:606）
- 用户删除时级联清理（db.ts:1949-1950）
- **表结构完整，代码完整，但表是空的**（因为类从未被实例化）

### 隐身根因
`TeamManager` 类完整、DB 表完整，但 `index.ts` **从未 import、从未 `new TeamManager()`、从未挂载 REST 路由**。属于「写完最后一步没接线」。

### 修复建议（P1）
1. `index.ts` 顶部 import TeamManager
2. 实例化 `const teamManager = new TeamManager()`
3. 挂载 `/api/teams` CRUD 路由（create/list/get/addMember/remove/dispatch/archive/delete）
4. 前端加团队面板入口

---

## 二、webhook-scheduler.ts（完整版）— Webhook 触发器

### 功能
对齐 OpenClaw Inbound Webhooks：让外部系统（GitHub、CI、监控告警、第三方服务）**主动唤醒灵犀执行任务**。

| 方法 | 作用 |
|---|---|
| `trigger(hookId, token, body)` | 外部调用入口：验证 token → 执行 dispatch（投递给 agent） |
| `createHook({name, promptTemplate, chatId, agentId, enabled})` | 创建 webhook，**自动生成 16 字节 secret** |
| `removeHook` / `setEnabled` / `getHook` / `listHooks` | 管理 |
| `start()` | 从 `data/webhooks.json` 恢复持久化数据 |

### 设计亮点
- 每个 webhook 有 secret token，调用方带 token 才能触发（防滥用）
- 触发后走与 cron 相同的 payload 通道（agentMessage / systemEvent / toolCall）
- 支持 promptTemplate（`{payload}` 占位符替换为 webhook body）
- 可选 IP 白名单
- 持久化到磁盘（webhooks.json）

### 隐身根因
与 `index.ts:2500-2520` 的**内联版并存**。内联版只有 2 个端点（trigger + jobs），无持久化、无 CRUD、无 secret 机制。独立版是「更完整的替代实现」，但 `registerWebhookRoutes` 从未被调用。

### 修复建议（P1，二选一）
- **方案 A（推荐）**：删内联版，import 并调用 `registerWebhookRoutes(app, scheduler, requireAuth)` —— 一步到位获得完整功能
- **方案 B**：保留内联版，把独立版的持久化 + CRUD 合并进去

---

## 三、auth-main.ts（巨石拆分版）— 认证路由

### 功能
从 index.ts 巨石（L595-913）**逐行保真抽取**的 16 个认证端点：

| 端点 | 作用 |
|---|---|
| `/api/auth/register` | 注册（邮箱+密码+数字ID+邀请码+自动建灵犀） |
| `/api/auth/verify-email` | 邮箱验证 |
| `/api/auth/login` / `login-by-id` | 登录（邮箱 / 数字ID） |
| `/api/auth/forgot-password` / `reset` | 忘记密码（防枚举，总是 200） |
| `/api/auth/refresh` / `logout` / `me` | token 刷新 / 登出 / 当前用户 |
| `/api/auth/send-code` / `register-with-email` | 验证码 / 旧版注册 |
| `/api/user/me` | 兼容别名 |
| `/api/admin/invite-codes` | 邀请码管理（adminAuth） |

### 设计
- 依赖注入：`db / manager / defaultModel / requireAuth / broadcast` 由宿主传入
- 安全网：`tests/baseline/routes-baseline.json` 路由快照 + tsc 全量类型检查
- 含 P0-4 修复：验证码尝试次数限制（5 分钟最多 10 次，防暴力枚举）

### 隐身根因
这是「巨石拆分迁移 批次 1/N」的**中间状态**：代码拆出来了，但 `index.ts` 没调用 `registerAuthRoutes`，内联版还在干活。拆了没接。


### 端点对照（auth-main.ts vs index.ts 内联版）

| auth-main.ts（拆分版，16 个） | index.ts 内联版（15 个） |
|---|---|
| POST /api/auth/register | ✅ 同 |
| GET /api/auth/verify-email | ✅ 同 |
| POST /api/auth/login | ✅ 同 |
| POST /api/auth/login-by-id | ✅ 同 |
| POST /api/auth/forgot-password | ✅ 同 |
| POST /api/auth/reset-password | ✅ 同 |
| POST /api/auth/refresh | ✅ 同 |
| POST /api/auth/logout | ✅ 同 |
| GET /api/auth/me | ✅ 同 |
| GET /api/user/me | ✅ 同 |
| POST /api/admin/invite-codes | ✅ 同 |
| GET /api/admin/invite-codes | ✅ 同 |
| POST /api/auth/send-code | ✅ 同 |
| POST /api/auth/register-with-email | ✅ 同 |
| POST /api/users/register | ✅ 同 |
| **GET /api/admin/dashboard** | ❌ 内联版无 |
| **GET /api/admin/usage** | ❌ 内联版无 |
| ❌ 无 | **GET /api/users** |
| ❌ 无 | **GET /api/users/by-id** |
| ❌ 无 | **GET /api/users/search** |

**结论**：auth-main 不是完整抽取，而是**选择性迁移**——多了 admin dashboard/usage 2 个端点，少了 users 列表 3 个端点。直接替换会丢功能，需合并后再迁移。

### 修复建议（P1）
- **完成迁移**：删 index.ts 内联认证块 → `import { registerAuthRoutes }` → 调用（注入依赖）
- 风险：需用 routes-baseline.json 快照验证 16 个端点行为一致
- 或暂时标注为「待迁移参考」，不急于接

---

## 四、mesh-platform.ts（平台信令服务器）

### 功能
**独立部署的中继服务器**（非主引擎一部分），部署在阿里云，端口 3001。

| 端点 | 作用 |
|---|---|
| `POST /api/instances/heartbeat` | 实例心跳注册（Bearer MESH_TOKEN 鉴权） |
| `GET /api/instances/list` | 在线实例列表 |
| `GET /api/users/search?q=` | 用户搜索（按 numericId 或 displayName） |
| `POST /api/users/register` | 注册本机用户到平台 |

### WebSocket mesh（`/mesh` 路径）
- 握手认证：`msg.type === 'auth'` + `msg.token === MESH_TOKEN`
- 认证后标记实例 online，维护连接池
- **转发 peer 消息**：`msg.toInstance` 指定目标实例，不在线则返回错误
- **广播**：无 toInstance 时广播给所有其他在线实例
- 心跳自动刷新，断开标记 offline

### 隐身根因
**不是 bug，是架构设计**：这是独立部署的服务端，需要单独 `node src/mesh-platform.js` 启动。主引擎用的是**客户端** `instance-mesh.ts`（`startInstanceMesh` 等，index.ts:93 已 import）。服务端版从未在主引擎里启动，因为它不该在主引擎里启动。

### 修复建议（P2）
- 不需要挂载到 index.ts
- 建议：标注文件头「独立部署脚本」，并加到 `package.json` scripts：`"mesh-platform": "node dist/mesh-platform.js"`
- 或单独部署文档说明

---

## 总结：4 个模块的隐身性质

| 模块 | 性质 | 修复难度 | 优先级 |
|---|---|---|---|
| team-manager | 写完没接线（类+表都完整） | 低（import+实例化+路由） | P1 |
| webhook-scheduler | 与内联版重复，独立版更完整 | 低（删内联版，挂独立版） | P1 |
| auth-main | 巨石拆分中途，拆了没接 | 中（需快照验证） | P1 |
| mesh-platform | 独立部署服务，非主引擎部分 | 无需修（标注即可） | P2 |

**共同根因**：都是「开发中断在最后一步」—— 代码写完了，但接线/挂载/部署的最后一步没做。不是被故意删除，也不是平台功能。

**与平台功能的区别**：market/admin 等是「故意去掉的平台功能」（前端残留导致 404）；这 4 个是「写完没接线的半成品」，代码本身是完整可用的。
