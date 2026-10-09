# 灵犀引擎「隐身功能」审计报告

**审计时间**：2026/10/9 20:54  
**审计范围**：src/（135 个 ts 文件）+ web/（前端 17 个文件）  
**审计原则**：只读，未做任何改动  
**审计方法**：静态引用分析（import 图 + 端点注册表 + 前端调用图谱 三方交叉）

---

## 一、结论速览

| 类别 | 数量 | 说明 |
|---|---|---|
| 🔴 完全孤立模块（代码存在但无任何引用） | 4 | team-manager、webhook-scheduler、auth-main、mesh-platform |
| 🟠 前端在调但后端未注册的端点 | 8 | 调用会 404，功能实际不可用 |
| 🟡 后端有但前端未调用的端点 | 70+ | 多数是「管理端/API 端/触发器」，属正常；少数是真隐身 |
| 🟢 正常工作的功能 | 绝大部分 | 聊天/群聊/好友/LAN/目标/RAG/工作流/子代理/语音/视觉等 |

---

## 二、4 个完全孤立模块（重点）

### 1. `src/core/team-manager.ts`（团队协作）— 🔴 死代码
- **内容**：完整的 TeamManager 类（创建团队/加成员/移除/任务分派），DB 持久化到 `team_groups` + `team_members` 表（表已在 db.ts 中建好）
- **引用情况**：全项目 0 引用（仅自身定义；db.ts 注释里提过 TeamManager 但不 import）
- **影响**：`/api/teams*` 端点 0 个，前端无团队功能入口
- **判断**：功能写完了但**从未挂载**，是「未完成的特性」不是「被故意去掉」

### 2. `src/core/webhook-scheduler.ts`（Webhook 触发器）— 🔴 死代码
- **内容**：完整的 WebhookScheduler + REST 路由（触发/创建/删除/启停），持久化到 `data/webhooks.json`
- **引用情况**：全项目 0 引用
- **影响**：`/api/webhooks` 管理端点不存在；但 index.ts:2500 有**另一套** webhook 实现（内联版，只做「触发已有 cron 任务」，无独立 webhook 管理）
- **判断**：存在**两套 webhook 设计**，内联版活着，独立版是死代码

### 3. `src/routes/auth-main.ts`（认证路由抽取版）— 🔴 死代码
- **内容**：从 index.ts 巨石抽取的 17 个认证端点（register/login/verify/forgot/reset/refresh/logout/me/invite-codes 等），依赖注入式
- **引用情况**：全项目 0 引用（`registerAuthRoutes` 仅自身定义）
- **影响**：无。相同端点已**内联在 index.ts:856-1122**（11 个 `/api/auth/*` + invite-codes），功能正常
- **判断**：巨石拆分的**半成品**——拆出来了但没接上，index.ts 里留的是原版内联代码

### 4. `src/mesh-platform.ts`（平台信令服务器）— 🔴 死代码
- **内容**：独立的 Express+WebSocket 信令服务（端口 3001），实例心跳/用户注册/消息中继
- **引用情况**：全项目 0 引用
- **影响**：无。index.ts 用的是**另一套** mesh 实现（`src/core/instance-mesh.ts`，客户端模式，连外部平台）
- **判断**：mesh-platform 是**服务端版**（部署在阿里云），instance-mesh 是**客户端版**（本机实例）。服务端版从未被启动——可能是有意留给平台部署的独立入口，也可能废弃

---

## 三、前端在调但后端未注册（会 404，实际不可用）

| 端点 | 调用方 | 影响 |
|---|---|---|
| `/api/admin/credits/grant` | platform-admin.html | 平台管理-积分发放不可用 |
| `/api/admin/instances` | platform-admin.html | 平台管理-实例列表不可用 |
| `/api/admin/orders` | platform-admin.html | 平台管理-订单不可用 |
| `/api/admin/users` | platform-admin.html | 平台管理-用户列表不可用（admin.html 用的是 `/api/admin/users/` 带斜杠版，那个存在） |
| `/api/market/hire` | app.js | AI 市场-雇佣不可用 |
| `/api/market/list` | app.js | AI 市场-列表不可用 |
| `/api/market/publish` | app.js | AI 市场-发布不可用 |
| `/api/profile/avatar` | app.js | 头像上传不可用（profile.ts 有 `POST /profile/avatar` 无 `/api` 前缀，前端调错路径） |

**注**：`/api/market/*` 和 `/api/admin/*` 属「平台功能」——用户说平台功能是故意去掉的，这 4 个 admin 端点 + 3 个 market 端点**符合「故意去掉」的描述**，但前端代码没同步删，导致点了会 404。

---

## 四、后端有但前端未调用（真隐身候选）

以下端点后端健全但前端无入口，用户无法触达：

| 端点 | 功能 | 性质 |
|---|---|---|
| `/api/onboarding/status` | 首次配置向导状态 | 🟡 新功能，前端 onboarding.html 已存在但未接 |
| `/api/webhooks/trigger/:jobId` + `/api/webhooks/jobs` | Webhook 触发 cron | 🟡 新挂载，前端无管理面板 |
| `/api/browser/status` | 浏览器控制状态 | 🟡 工具已注册，前端无入口 |
| `/api/skills/*`（8 个端点） | 技能管理 | 🟡 前端技能面板走的是另一套（`/api/features`？需确认） |
| `/api/standing-orders/*` | 持久指令 | 🟡 后端健全，前端无入口 |
| `/api/hooks/*` | 钩子管理 | 🟡 后端健全，前端无入口 |
| `/api/push/*` | Web Push 推送 | 🟡 后端健全，前端无入口 |
| `/api/channels/*` | 渠道接入（Slack/微信/飞书/QQ/WhatsApp） | 🟡 后端健全，前端无入口 |
| `/api/telegram/status` | Telegram 状态 | 🟡 后端健全，前端无入口 |
| `/api/dev/*` | 开发模式 | 🟢 管理员功能，adminAuth 保护，正常 |
| `/api/custom-providers/*` | 自定义 provider | 🟡 后端健全，前端 model-mgmt 走 `/api/custom-providers` 存在但未在调用列表 |
| `/api/lan/peer/*`（LAN 点对点） | LAN 直连操作 | 🟡 后端健全，前端只用了基础 LAN 功能 |
| `/api/federation/*` | 联邦组网 | 🟡 后端健全，前端无入口 |

---

## 五、「自创建技能隐身」的根因（承接上一轮结论）

两套技能系统不互通：
- **auto-skill.ts** 写 `skills/<name>.json`（扁平文件，473 个，469 个 autoCreated）
- **skill-manager.ts** 只扫 `skills/<目录>/SKILL.md`（标准格式）
- 结果：`/api/skills` 列表只显示 2 个标准技能，473 个自创建技能对前端不可见

**这不是「功能被去掉」，是「两套格式不兼容」**。

---

## 六、修复建议（按优先级，未执行）

| 优先级 | 动作 | 工作量 |
|---|---|---|
| P0 | 前端把 `/api/profile/avatar` 改成 `/profile/avatar`（或后端加别名） | 1 行 |
| P1 | 决定 team-manager 去留：挂载 `/api/teams*` 或删除死代码 | 小 |
| P1 | 决定 webhook-scheduler 去留：与内联版二选一 | 中 |
| P1 | 决定 auth-main 去留：接入 registerAuthRoutes 替换 index.ts 内联块，或删除 | 中 |
| P2 | mesh-platform 标注用途（平台部署用？）或删除 | 小 |
| P2 | 统一技能格式（auto-skill 写 SKILL.md 或 SkillManager 兼容 JSON） | 中 |
| P3 | 给 webhook/standing-orders/hooks/push/channels 做前端管理面板 | 大 |
| P3 | 前端清理已故意去掉的平台功能调用（market/admin 404 端点） | 中 |

---

## 七、审计方法说明

1. **引用图分析**：全项目 grep 模块名/类名/函数名，区分「直接引用」「间接引用」「零引用」
2. **端点注册表**：扫描 index.ts + src/routes/*.ts 全部 `app./router.` 调用，得后端端点全集
3. **前端调用图谱**：扫描 web/ 全部 js/html 的 `/api/` 字符串，得前端实际需求
4. **三方交叉**：前端 ∩ 后端 = 正常工作；前端 - 后端 = 404；后端 - 前端 = 隐身候选

**本次审计未修改任何文件**（临时分析脚本已清理）。


---

## 八、补充核实（2026/10/9 晚，前端调用图谱精确版）

用更精确的正则（fetch/axios/.get/.post/url: 五种调用形态）重扫 web/ 全部文件，前端实际调用 **11 个唯一端点**：

| 端点 | 调用方 | 后端 | 状态 |
|---|---|---|---|
| /api/ai/config | model-mgmt.js | index.ts:1998,2016 | ✅ 正常 |
| /api/auth/me | app.js | auth-main 内联版 | ✅ 正常 |
| /api/health | download/install.html | index.ts:796 | ✅ 正常 |
| /api/market/list | app.js | 无 | ❌ 404（平台功能故意去掉） |
| /api/multi-ai | app.js | index.ts:2093 | ✅ 正常 |
| /api/profile/avatar | app.js | 仅 /profile/avatar（无前缀） | ❌ 路径不匹配 |
| /api/subagents | app.js | index.ts:2679 + routes/subagents.ts | ✅ 正常 |
| /api/upload | app.js | index.ts:1591 | ✅ 正常 |
| /api/version | app.js | index.ts:1656 | ✅ 正常 |
| /api/vision/analyze | app.js | index.ts:2945 | ✅ 正常 |

**结论修正**：报告第三节的 8 个 404 端点中，/api/upload、/api/subagents、/api/multi-ai、/api/ai/config、/api/version、/api/vision/analyze 这 6 个经核实**后端健全**（旧版粗略扫描误报）。真实 404 只有 2 类：
1. 平台功能（故意去掉）：/api/market/list（+ hire/publish 同理）
2. 真 bug：/api/profile/avatar 路径不匹配（1 行可修）
