# 推理过程显示（reasoning stream）修复核查记录

- 核查时间：2026-09-12 03:2x (+0800)
- 核查对象：提交 `97d22c5`（fix(reasoning): 兼容 Ollama reasoning 字段名，流式推理显示打通）
- 结论：**修复方向正确、主链路实测已通**；另发现并补上 **2 处遗漏**（`4cfa044`、`751f367`）

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

## 3. 发现的两处遗漏（已修）

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

## 4. 已知限制（未修，需评估）

LAN 模式下推理区**仅在生成过程中可见**：`lan-social.ts:942` 发 `agent.streaming.end` 后随即 `message.new`（951 行）用权威消息替换气泡，而最终消息不含推理内容。要让推理在 LAN 里常驻，需要把 reasoning 一并持久化进消息（改动面较大）。

另：`web/js/app.js` 主链路（本地 WS）气泡的推理区会在 `streaming.end` 时折叠为 3em、点击展开，行为正常。

## 5. 生效状态

- 运行中引擎：PID 30728，启动于 2026-09-12 03:19:54
- 因此 **router/executor 的推理修复已生效**（文件改于 03:14:45~03:15:01）
- `4cfa044`(critic) 与 `751f367`(LAN) **需重启引擎才生效**（本次按约定未重启，未杀进程）
- `/api/health` 报 `2.0.16` 是启动时读取 `package.json` 的缓存值，非故障

## 6. 质量闸门

- `npx tsc --noEmit -p tsconfig.json`：0 行输出，exit 0
- `node --check web/js/app.js`：通过
- 行尾：改动文件 CRLF/LF 计数一致，未被破坏
- GitHub：`HEAD == origin/main == 751f367`，ahead = 0
