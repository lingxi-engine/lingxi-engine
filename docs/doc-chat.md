# 模块文档：会话与多 AI（doc-chat）

> 覆盖：`src/core/ws-handler.ts`、`src/core/router.ts`、`src/core/chat-modes.ts`、
> `src/core/debate.ts`、`src/core/session-manager.ts`、`src/ai/hub.ts`
> 对应代码量：~3,500 行 ｜ 更新：2026-08-29

---

## 1. 模块职责

聊天主链路：WS 消息接收 → 模式分发 → 模型调用 → 工具调用（沙箱内）→ 流式回包。
以及多 AI 协作的 7 种模式编排。

## 2. 核心文件

| 文件 | 职责 | 规模 |
|------|------|------|
| `src/core/ws-handler.ts` | WS 消息处理、订阅管理、processUserMessage | 34KB |
| `src/core/router.ts` | MessageRouter：模型路由与多 AI 编排 | **65KB ⚠️ 巨石** |
| `src/core/chat-modes.ts` | 7 种协作模式的分发逻辑 | 21KB |
| `src/core/debate.ts` | 辩论模式实现 | 6.8KB |
| `src/ai/hub.ts` | 所有模型调用的统一出口 | 29KB |
| `src/ai/provider-registry.ts` | 多供应商注册（DeepSeek/OpenAI/Ollama/自定义） | 11KB |
| `src/ai/custom-providers.ts` | 用户自定义模型接入 | 7KB |

## 3. 七种聊天模式（chat-modes.ts）

```typescript
type ChatMode = 'free' | 'route' | 'debate' | 'chain'
              | 'roundtable' | 'vote' | 'brainstorm';
```

| 模式 | 行为 | 分发函数 |
|------|------|---------|
| free | 自由协作，多模型并行回复 | dispatchByMode |
| route | 智能路由到最合适模型 | dispatchByMode |
| debate | 辩论 + 辩论总结 | dispatchDebateSummary |
| chain | 链式接力 | dispatchByMode |
| roundtable | 圆桌逐个发言 | dispatchRoundtableNext |
| vote | 投票 + 汇总 | dispatchVoteSummary |
| brainstorm | 头脑风暴接力 | dispatchBrainstormNext |

- 模式按 chatId 存取：`getChatMode` / `setChatMode`
- ⚠️ 前端界面目前只暴露 4 种（自由/路由/辩论/链式），后端已支持 7 种——
  改前端时注意别把 roundtable/vote/brainstorm 的后端逻辑当死代码删了

## 4. 消息处理链路

```
WS 消息 → handleWSMessage（ws-handler）
  → processUserMessage
      → MessageRouter（router.ts）选模型/编排
          → AIHub（ai/hub）实际调用模型
          → 工具调用：ToolRegistry.execute()
              （结果截断 4000 字符回填对话）
      → 流式回推 WS
```

- `wsSubscriptions` 管理 WS 订阅关系，改推送逻辑先看这里
- 多 AI 端点 `POST /api/multi-ai`（requireAuth）：勾选模型 + 模式 → 流式回复，
  前端显示 🔧 工具调用徽章

## 5. 沙箱与工具调用边界 ⚠️ 设计原则，不是 bug

- 工具执行走 `toolRegistry.execute()`，**白名单制**：只有 BUILTIN_TOOLS
  注册过的工具可被 AI 调用
- 多 AI 模式是放大器：一个有害工具调用会被多模型接力放大，所以沙箱
  **不该全放开**。分级放开思路：
  - 只读工具（搜索/读文件）可放宽
  - 写操作走 `core/approval.ts`（ApprovalManager 审批流）
  - 本地私有部署可由管理员放开；平台版保持收紧
- 相关文件：`core/sandbox.ts`、`core/docker-sandbox.ts`（Docker 隔离执行）

## 6. 会话与记忆

- `session-manager.ts`：会话生命周期
- `compaction.ts`：上下文压缩（长对话防爆 token）
- `context-roller.ts`：上下文滚动
- `memory-search / memory-reflector / memory-decay`：记忆三件套（检索/反思/衰减）
- `rag-engine.ts`：RAG 检索增强（15KB）

---

## 回归测试清单（改本模块必跑）

- [ ] 单模型对话：发送 → 流式回复完整 → 入库
- [ ] 7 种模式逐一切换：free/route/debate/chain/roundtable/vote/brainstorm 均能出回复
- [ ] 辩论模式：多模型发言 + 总结正常
- [ ] 工具调用：触发搜索/计算类工具，前端徽章显示，结果回填对话
- [ ] 未注册工具的调用被拒绝（沙箱白名单生效）
- [ ] 长对话触发 compaction 后上下文仍连贯
- [ ] WS 断线重连后订阅恢复（wsSubscriptions）
- [ ] 多 AI 端点未登录 → 401
- [ ] `npm run typecheck` 绿

## 坑位记录

### 2026-08-29（建档）工具结果截断 4000 字符
- 现象：工具返回长内容时多 AI 对话出现截断
- 现状：`/api/multi-ai` 内 toolRegistry.execute 结果截断 4000 字符回填
- 注意：调整截断阈值会直接影响 token 成本和上下文质量，改前先在
  doc-core.md 记录 ADR