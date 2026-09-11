# 推理过程显示（reasoning stream）修复核查记录

- 核查时间：2026-09-12 03:2x~04:0x (+0800)
- 核查对象：提交 `97d22c5`（fix(reasoning): 兼容 Ollama reasoning 字段名，流式推理显示打通）
- 结论：**修复方向正确、主链路实测已通**；另发现并补上 **9 处遗漏/缺陷**（8 处为修复/补全，1 处为既有数据兼容）

## 1. 修复是否必要：是（已实测）

直接探测 Ollama OpenAI 兼容层（`POST localhost:11434/v1/chat/completions`, `glm-5.2:cloud`, stream=true）：

| 字段 | 出现次数 |
|---|---|
| `reasoning` | **206** |
| `reasoning_content` | **0** |
| `thinking` | 0 |

→ Ollama 兼容层只吐 `reasoning`；旧代码只读 `reasoning_content`，因此本地/云 Ollama 模型的推理过程**永远取不到**。修复本质是把读取统一为 `reasoning_content ?? reasoning`，方向正确。

## 2. 主链路是不是真的通了：是（端到端实测）

`node workspace/_test_think_stream.cjs`（WS 订阅真实会话），两轮：

```
第1轮： agent.streaming.think 9 | tool.call 18 | message.new 1
回归轮：agent.streaming.think 3 | agent.streaming.chunk 47 | agent.streaming.end 1
```

→ `agent.streaming.think` 有事件、有内容，前端 `app.js:749` 分支正常追加并渲染。
router 的**流式与回退**两条路径均已双字段读取（`router.ts:602` 流式、`573/632` 回退）。

## 3. 发现的九处遗漏/缺陷（均已处理）

### 3.1 `src/core/critic.ts:256` —— 上一版漏改
把 `reasoning_content` 补为 `reasoning_content ?? reasoning`。提交 `4cfa044`。
全库复查：`reasoning_content` 读取点当时共 11 处，`97d22c5` 只改了 9 处。

### 3.2 LAN 联机链路 —— 服务端 + 前端双端都缺
- `src/net/lan-social.ts:926`：`generateReply` 第 5 参 `onThink` 原为 `undefined`
- `web/js/app.js:4619 / 4643`：LAN 气泡无 `.msg-think` 区，无 `agent.streaming.think` 分支
已补双端。提交 `751f367`。

### 3.3 Service Worker 缓存版本未 bump —— 修复到不了用户
`web/sw.js` 的 `CACHE_NAME` 停在 `lingxi-v15`，而 `STATIC_ASSETS` 含 `/js/app.js`。已 bump `v15 → v16`。提交 `aea0ea1`。

### 3.4 `agent.task` 多步任务流程 —— 推理被静默丢弃
`src/core/ws-handler.ts:325` 的 `onThink` 原为 `undefined`；而该路径已广播 `agent.streaming.start`（`ws-handler.ts:177`），前端会建 `.msg-think` 区。已接上广播。提交 `0a80325`。

### 3.5 `router.ts` 无工具非流式分支 —— 完全没读推理
`router.ts` 只有 3 处 `reasoning` 提取点（工具循环回退×2、流式×1），遗漏了「**没有工具 + 非流式**：普通聊天」这一分支——该分支连推理字段都不读。已补上提取。提交 `50194cf`。

### 3.6 推理过程**不落库** —— 刷新即丢失（最大的功能缺口）
- 现象：推理只在流式过程中可见，`message.new` 替换/复用气泡时尚在，但**刷新页面或被其他会话成员查看时消失**（`router.ts` 原先只持久化 `content`）
- 现有 **messages 表已含 `metadata` JSON 列**，无需 schema 迁移
- 已实现：router 累积 `thinkAccum` → 落库 `metadata:{reasoning}`；前端 `app.js` 历史加载透传 `metadata` 并在 `appendMessage` 渲染折叠式 `.msg-think`（默认 3em、点击展开，复用 `t('chat.expandThink')`）
- **既有数据兼容（重要）**：DB 中已有 **41 条**消息的 `metadata` 使用键 **`reasoning_content`**（非 `reasoning`）。故前端采用**双键读取** `metadata.reasoning || metadata.reasoning_content` —— 老记录与新记录都能显示
- 提交 `50194cf`

### 3.7 Service Worker 缓存再次失效 —— 持久化前端到不了用户（与 3.3 同类）
- `50194cf` 又改了 `web/js/app.js`（新增持久化渲染），但 `CACHE_NAME` 仍是 `v16`
- 已缓存 v16 的 PWA 用户会持续命中旧 app.js，**持久化渲染看不到**
- 已再次 bump `lingxi-v16 → lingxi-v17` 并更新注释。提交 `50e4eb2`
- 教训：`sw.js` 的缓存版本必须与 `app.js` 的每次改动绑定递增，否则前端修复静默失效

### 3.8 LAN 推理不持久化（本机侧）—— 原「已知限制」已解决
- 根因：`lan-social.ts` 的 `latestAgentMessage` 只回读 `{id, content, timestamp}`，**丢弃 metadata**；最终 `message.new` 广播不含 reasoning
- 前端 `handleLanMessage` 在 `message.new` 时**删除流式气泡再重建**，故流式期间的推理随气泡一起消失
- 已修：`latestAgentMessage` 回读 `metadata.reasoning`（双键）；本机 `message.new` 广播带 `reasoning`；前端 `lanAppendMessage` 渲染折叠式 `.msg-think`；`lanLoadHistory` 透传 `metadata`

### 3.9 LAN 跨引擎同步与接收侧丢失推理
- `broadcastToGroup` 的 `group-message` payload 不含 `reasoning` → 其他成员引擎收不到
- `handleGroupMessage`（接收侧）落库与广播**均未带 reasoning**
- 已修：payload 带 `reasoning`；接收侧落库写 `metadata.reasoning` 并广播带 `reasoning`

## 4. 前端副本核查：修复打在了正确副本上

仓库里存在**两份** `app.js`：根 `web/js/app.js` 与 `src/web/js/app.js`。

| 事实 | 结论 |
|---|---|
| `index.ts:578` → `express.static(join(process.cwd(), 'web'))` | 主引擎服务根 `web/` |
| `src/mobile/index.ts:194` → `LINGXI_WEB_DIR | join(process.cwd(), 'web')` | 移动端同样服务根 `web/` |
| `src/platform-server.ts:679` → `WEB_DIR = join(process.cwd(), 'web')` | 平台端同样服务根 `web/` |
| 全库检索 `src/web` 引用 | **零引用** |
| `src/web/` 最后改动 | 2026-09-11 09:54（一次快照遗留） |

→ **`web/`（根）是三端唯一实际服务的副本**；`src/web/` 是无引用的**死副本**（技术债，建议清理）。

## 5. 前端渲染配套核查

| 项 | 位置 | 状态 |
|---|---|---|
| `agent.streaming.think` 分支（本地 WS） | `app.js:749` | 正常 |
| think 区创建 + `thinkEl` 挂载 | `app.js:1144 / 1148` | 正常 |
| 生成中可见 + `end` 折叠 3em + 点击展开 | `app.js:763-781` | 正常 |
| **刷新后可见（持久化）** | `app.js:1076-1084`（新增） | 本次新增 |
| i18n `chat.expandThink` / `chat.thinking` | `i18n.js` 各 7 种语言 | 齐全 |

## 6. 已知限制（未修，需评估）

- ~~LAN 模式推理区仅在生成过程中可见~~ → **已解决**（见 3.8 / 3.9）：LAN 推理现随气泡常驻、可折叠展开、刷新后由历史回读恢复、并跨引擎同步。
- **`goal-executor.ts:375` 的 onThink 为 undefined**：该路径本就非流式、未广播 `agent.streaming.start`、前端无对应气泡，属设计如此。
- **`channels/*`（discord / feishu / qqbot）**：非流式渠道，无推理推送通道，符合预期。

## 7. 生效状态

- 运行中引擎：PID 30728，启动于 2026-09-12 03:19:54
- **前端修复已实时生效（无需重启）**：静态资源由 `express.static` 从磁盘即时读取。实测 `GET /js/app.js` 返回更新后文件（md5 与仓库一致），`GET /sw.js` 已为 `lingxi-v16`。用户强制刷新即可。
- **后端修复需重启引擎**：`97d22c5`(router/executor)、`4cfa044`(critic)、`0a80325`(task)、`50194cf`(持久化) 均在进程启动时载入（按约定未重启，未杀进程）
- `/api/health` 报 `2.0.16` 是启动时读取 `package.json` 的缓存值，非故障

## 8. 质量闸门

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 行输出，exit 0 |
| `node --check web/js/app.js` | 通过 |
| `npx vitest run` | **2 files / 28 tests 全通过** |
| 双键解析单测（`_test_think_meta.cjs`） | **7/7 通过**（历史 `reasoning_content`、新 `reasoning`、对象直传、空值、非法 JSON） |
| 落库回读端到端（`_test_persist_roundtrip.cjs`，内存副本） | **PASS**（addMessage→`SELECT *`→前端解析，正文与推理均无损；真实 DB 未写入） |
| DB 只读核查（sql.js） | `messages` 含 `metadata` 列；2156 条消息中 41 条有 metadata，**均为 `reasoning_content` 键** |
| 行尾 CRLF/LF | 改动文件计数一致，未破坏 |
| GitHub | `HEAD == origin/main`，ahead = 0 |
| F 盘 | `lingxi-engine-git-20260912-v2017.bundle`，verify = complete history |
| site_inner | 同步脚本 `-CheckOnly` = fully in sync |

## 9. 变更清单（本次核查新增提交）

| 提交 | 内容 |
|---|---|
| `4cfa044` | critic.revise 补 `reasoning` 兜底 |
| `751f367` | LAN 双端（lan-social.ts + app.js）推理流 |
| `aea0ea1` | sw.js 缓存 v15→v16 + 核查记录 |
| `2006353` | 补记前端副本核查（web/ 为三端唯一服务副本） |
| `5ad98f2` | 实测前端修复已实时生效，仅后端待重启 |
| `0a80325` | agent.task 多步任务流程补上推理流 |
| `50194cf` | 推理持久化 + 无工具分支补读 + 双键兼容既有 41 条数据 |
| `50e4eb2` | sw.js 缓存 v16→v17（持久化前端生效） |
| `4d856bc` | LAN 推理持久化（本机+跨引擎+接收侧）+ sw 缓存 v17→v18 |
