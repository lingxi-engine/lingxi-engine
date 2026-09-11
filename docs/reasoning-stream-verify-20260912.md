# 推理过程显示（reasoning stream）修复核查记录

- 核查时间：2026-09-12 03:2x~03:5x (+0800)
- 核查对象：提交 `97d22c5`（fix(reasoning): 兼容 Ollama reasoning 字段名，流式推理显示打通）
- 结论：**修复方向正确、主链路实测已通**；另发现并补上 **4 处遗漏**

## 1. 修复是否必要：是（已实测）

直接探测 Ollama OpenAI 兼容层（`POST localhost:11434/v1/chat/completions`, `glm-5.2:cloud`, stream=true）：

| 字段 | 出现次数 |
|---|---|
| `reasoning` | **206** |
| `reasoning_content` | **0** |
| `thinking` | 0 |

→ Ollama 兼容层只吐 `reasoning`；旧代码只读 `reasoning_content`，因此本地/云 Ollama 模型的推理过程**永远取不到**。修复本质是把读取统一为 `reasoning_content ?? reasoning`，方向正确。

## 2. 主链路是不是真的通了：是（端到端实测）

`node workspace/_test_think_stream.cjs`（WS 订阅真实会话）：

```
user.online 1 | subscribed 1 | message.new 1 | agent.streaming.start 1
agent.streaming.heartbeat 16 | agent.streaming.think 9
tool.call 18 | tool.result 18
```

→ `agent.streaming.think` 有事件、有内容，前端 `web/js/app.js:749` 分支正常追加并渲染。
另经代码核对，router 的**流式与回退**两条路径均已双字段读取（`router.ts:602-604` 流式、`router.ts:630-632` 非流式回退）。

## 3. 发现的四处遗漏（已修）

### 3.1 `src/core/critic.ts:256` —— 上一版漏改
```
- ...message?.content || ...message?.reasoning_content || ''
+ ...message?.content || ...message?.reasoning_content || ...message?.reasoning || ''
```
提交 `4cfa044`。全库复查：`reasoning_content` 读取点当时共 11 处，`97d22c5` 只改了 9 处。

### 3.2 LAN 联机链路 —— 服务端 + 前端双端都缺
- `src/net/lan-social.ts:926`：`generateReply(...)` 第 5 参 `onThink` 原为 `undefined` → 局域网 Agent 回复不推推理
- `web/js/app.js:4619 / 4643`：LAN 打字气泡没有 `.msg-think` 区，`handleLanMessage` 也没有 `agent.streaming.think` 分支

已补：服务端广播 `agent.streaming.think`；前端新增 think 区 + `lanStreamingThink()` + 事件分支。提交 `751f367`。

### 3.3 Service Worker 缓存版本未 bump —— 修复到不了用户
- `web/sw.js` 的 `CACHE_NAME` 停在 `lingxi-v15`，而 `STATIC_ASSETS` 含 `/js/app.js`
- 本次改了 app.js（LAN think），不 bump 缓存 → 装了 PWA 的用户持续命中旧 JS，**前端修复等于白改**
- 已 bump `lingxi-v15 → lingxi-v16` 并更新注释。提交 `aea0ea1`

### 3.4 `agent.task` 多步任务流程 —— 推理被静默丢弃
- `src/core/ws-handler.ts:325`：`agent.task`（Orchestrator + DAG）调用 `generateReply` 时第 5 参 `onThink` 原为 `undefined`
- 此前端已广播 `agent.streaming.start`（`ws-handler.ts:177`），前端 `app.js:1144/1148` 会创建 `.msg-think` 区并挂到 `streamingMsgs`
- 而 `97d22c5` 恰好改了 `executor.ts`（工具循环）的推理读取——任务模式正是走工具循环，**推理算出来了却没地方去**
- 已接上 think 广播，与主聊天路径行为一致。提交 `0a80325`

## 4. 前端副本核查：修复打在了正确副本上

仓库里存在**两份** `app.js`：根 `web/js/app.js` 与 `src/web/js/app.js`。经核实：

| 事实 | 结论 |
|---|---|
| `index.ts:578` → `express.static(join(process.cwd(), 'web'))` | 主引擎服务根 `web/` |
| `src/mobile/index.ts:194` → `LINGXI_WEB_DIR | join(process.cwd(), 'web')` | 移动端同样服务根 `web/` |
| `src/platform-server.ts:679` → `WEB_DIR = join(process.cwd(), 'web')` | 平台端同样服务根 `web/` |
| 全库检索 `src/web` 引用 | **零引用** |
| `src/web/` 最后改动 | 2026-09-11 09:54（一次快照遗留） |
| `src/web/js/app.js` 中 `lanStreamingThink` | 0 处（缺本次 LAN 补丁） |

→ **`web/`（根）是三端唯一实际服务的副本**，本次 LAN 前端修复打在 `web/` 是正确的；`src/web/` 是与它分叉、无任何引用的**死副本**（技术债，建议清理或加同步校验，本身不影响推理修复的正确性）。

## 5. 前端渲染配套核查

| 项 | 位置 | 状态 |
|---|---|---|
| `agent.streaming.think` 分支（本地 WS） | `app.js:749` | 正常 |
| think 区创建 + `thinkEl` 挂载 | `app.js:1144 / 1148` | 正常 |
| 折叠/展开交互 | `app.js:763-781` | 生成中可见，`end` 时折叠为 3em、点击展开 |
| i18n `chat.expandThink` | `i18n.js` 7 种语言（302/1010/1718/2426/3134/3842/4550） | 齐全 |
| i18n `chat.thinking` | `i18n.js` 7 种语言（328/1036/1744/2452/3160/3868/4576） | 齐全 |

## 6. 已知限制（未修，需评估）

- **LAN 模式推理区仅在生成过程中可见**：`lan-social.ts:942` 发 `agent.streaming.end` 后随即 `message.new`（951 行）用权威消息替换气泡，而最终消息不含推理内容。常驻需把 reasoning 持久化进消息（改动面较大）。
- **`goal-executor.ts:375` 的 onThink 亦为 undefined**：该路径本就是非流式（onChunk 同为 undefined），且未广播 `agent.streaming.start`、前端无对应气泡，属设计如此，不视为缺陷。
- 同理 `channels/*`（discord / feishu / qqbot）为非流式渠道，无推理推送通道，符合预期。

## 7. 生效状态

- 运行中引擎：PID 30728，启动于 2026-09-12 03:19:54
- **前端修复已实时生效（无需重启）**：静态资源由 `express.static` 从磁盘即时读取。实测 `GET /js/app.js` 返回的正是更新后文件（md5 = 仓库一致、`lanStreamingThink` 2 处、`msg-think` 4 处），`GET /sw.js` 已为 `lingxi-v16`。用户强制刷新页面即可拿到 LAN 推理流。
- **后端修复需重启引擎**：`97d22c5`(router/executor) 的推理读取改动在进程启动时载入，`4cfa044`(critic)、`0a80325`(task) 同理（按约定未重启，未杀进程）
- `/api/health` 报 `2.0.16` 是启动时读取 `package.json` 的缓存值，非故障

## 8. 质量闸门

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 行输出，exit 0 |
| `node --check web/js/app.js` | 通过 |
| `npx vitest run` | **2 files / 28 tests 全通过** |
| 行尾 CRLF/LF | 改动文件计数一致，未破坏 |
| GitHub | `HEAD == origin/main == 0a80325`，ahead = 0 |
| F 盘 | `lingxi-engine-git-20260912-v2017.bundle`，verify = complete history |
| site_inner | 同步脚本 `-CheckOnly` = fully in sync，关键文件 md5 一致 |

## 9. 变更清单（本次核查新增提交）

| 提交 | 内容 |
|---|---|
| `4cfa044` | critic.revise 补 `reasoning` 兜底 |
| `751f367` | LAN 双端（lan-social.ts + app.js）推理流 |
| `aea0ea1` | sw.js 缓存 v15→v16 + 本核查记录 |
| `2006353` | 补记前端副本核查（web/ 为三端唯一服务副本） |
| `5ad98f2` | 实测前端修复已实时生效，仅后端待重启 |
| `0a80325` | agent.task 多步任务流程补上推理流 |
