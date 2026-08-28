# 模块文档：AI 核心（doc-core）

> 覆盖：`src/core/` 全部 44 个模块 ｜ 对应代码量：~11,000 行
> 更新：2026-08-29 ｜ 本文档按子系统分组，改哪个子系统看哪节

---

## 1. 子系统地图

### 1.1 消息编排（聊天主链路，详见 doc-chat.md）
| 文件 | 职责 |
|------|------|
| router.ts (65KB⚠️) | MessageRouter：模型选择/多 AI 编排 |
| ws-handler.ts (34KB) | WS 消息入口、订阅、processUserMessage |
| chat-modes.ts | 7 种协作模式分发 |
| debate.ts | 辩论模式 |
| orchestrator.ts | 编排器 |

### 1.2 目标与自主行为（AGI 路线）
| 文件 | 职责 |
|------|------|
| goal-executor.ts (25KB) | 目标执行器：拆解→执行→汇报 |
| goal-tracker.ts | 目标追踪（含独立建表 initGoalTrackerTable） |
| task-store.ts | 任务存储 |
| thought-tree.ts | 思维树 |
| dreamer.ts | 离线"做梦"（自主思考） |
| dreamer 相关：outcome-tracker.ts | 执行结果追踪 |
| clarifier.ts | 模糊需求澄清 |
| critic.ts (12.7KB) | 自我批判 |
| evaluator.ts | 结果评估 |
| steer.ts | 运行中转向干预 |
| entity-extractor.ts | 实体抽取 |
| world-model.ts | 世界模型 |

### 1.3 记忆系统
| 文件 | 职责 |
|------|------|
| memory-search.ts | 记忆检索 |
| memory-reflector.ts | 记忆反思（沉淀） |
| memory-decay.ts | 记忆衰减 |
| rag-engine.ts (15KB) | RAG 检索增强 |
| compaction.ts | 上下文压缩 |
| context-roller.ts | 上下文滚动 |
| personality.ts | 人格设定 |

### 1.4 执行与安全
| 文件 | 职责 |
|------|------|
| sandbox.ts | 命令沙箱（本地） |
| docker-sandbox.ts (10.7KB) | Docker 隔离执行 |
| approval.ts (8.4KB) | ApprovalManager：写操作审批流 |
| watchdog.ts | 看门狗（卡死检测） |
| hooks.ts | 生命周期钩子 |
| plugin-manager.ts | 插件管理（plugins/ 下有另一份，⚠️ 双胞胎待合并） |

### 1.5 多实例与调度
| 文件 | 职责 |
|------|------|
| instance-mesh.ts | 多实例组网（peer 消息/任务） |
| cron-scheduler.ts (9.8KB) | 定时任务（createCronJob） |
| subagent-manager.ts (29.9KB) | 子代理（delegate_task 的后端） |
| team-manager.ts | 团队管理 |
| inbox.ts | 站内收件箱 |
| push.ts | Web Push 推送 |
| timezone.ts | 时区处理 |

### 1.6 基础设施
| 文件 | 职责 |
|------|------|
| logger.ts | 日志 |
| usage-tracker.ts | 用量统计（usage.json 1.3MB 就是它写的） |
| session-manager.ts | 会话管理 |
| search-providers.ts (13.3KB) | 搜索源（tools/ 下有近似副本 ⚠️） |
| types.ts | core 共享类型 |

## 2. 跨模块规则

1. **ESM 加载顺序敏感**：db.ts 必须最先加载（见 ARCHITECTURE §4），
   新增 core 模块顶层 import 时注意不要引入循环依赖
2. **子代理模式**：长任务走 subagent-manager 派生，不要在主消息循环里阻塞
3. **审批流**：任何写操作类工具（执行命令/改文件）接 approval.ts，
   不要绕过直接执行
4. **搜索源双胞胎**：core/search-providers.ts 与 tools/search-providers.ts
   并存，改搜索逻辑先确认 AI 聊天用的是哪份（setSearchManager 注入的是
   tools 版），core 版用途待查，**别只改一份**

## 3. 巨石拆分计划（按优先级）

1. router.ts（65KB）→ 拆 model-selector / multi-ai-orchestrator / prompt-builder
2. ws-handler.ts（34KB）→ 拆 ws-router / ws-push / message-pipeline
3. goal-executor.ts（25KB）→ 拆 goal-planner / goal-runner

拆法与根 index.ts 相同：每拆一个跑全量 typecheck + 冒烟，绿了再拆下一个。

---

## 回归测试清单（改 core 后必跑）

- [ ] 普通对话往返正常（最基础链路）
- [ ] 子代理任务派生/回收正常
- [ ] 定时任务触发一次成功
- [ ] 记忆检索：新对话能引用历史要点
- [ ] 长对话压缩后上下文连贯
- [ ] 审批流：写操作工具弹出审批，拒绝后不执行
- [ ] watchdog：人为挂起任务能被检测
- [ ] `npm run typecheck` 绿

## 坑位记录

### 2026-08-29（建档）双胞胎文件清单
- plugin-manager：core/ 与 plugins/ 各一份
- search-providers：core/ 与 tools/ 各一份
- 教训：**改这两个功能前先用 grep 确认 import 来源，防止改了没被引用的那份**