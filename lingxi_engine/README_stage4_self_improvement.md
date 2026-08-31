# 阶段4 · 受限自改进（A1-A9）落地报告

> 对应《头脑风暴_阶段3_汇总_AGI进化方案.md》行动项清单 A1-A9。
> 状态：**全部落地 ✅**（2026-08-25）

---

## 一、总览

| 行动项 | 名称 | 状态 | 落地文件 | 验证 |
|---|---|---|---|---|
| A1 | 澄清器接线 | ✅ 已确认生效 | `src/core/clarifier.ts` + `router.ts` | 硬拦截(<60) + 软提示(<75) 双阈值已接线 |
| A2 | 评测消费端（错题本） | ✅ | `mistakes.py` | 34 条错题入册，`mistake_book.json` 落盘 |
| A3 | 自博弈对练（左右互搏） | ✅ | `role_discussion.py::run_selfplay()` | verify_selfplay 16/16 |
| A4 | 断言级置信度 + 事实溯源 | ✅ | `metacognition.py::assess_confidence/trace_source` | verify_metacognition 38/38 |
| A5 | 世界模型（因果模拟器） | ✅ | `world_model.py` | 真实沙盒对账 match_rate=1.0 |
| A6 | 好奇探索器 | ✅ | `curiosity.py` | 真实选题 + 预算控制 |
| A7 | 离线做梦 | ✅ | `dream.py` | 真实素材重放 + 变异入队 |
| A8 | 多模型议会 | ✅ | `parliament.py` | 提案→辩论→表决→决议闭环 |
| A9 | 宪法护栏 | ✅ | `constitution.py` | 分级/拦截/快照/回滚预案 |

**验证汇总：**
- 阶段4专项：`verify_stage4.py` → **37/37 PASS，ALL_OK=True**
- 阶段4端到端（真实数据联动）：`stage4_e2e.py` → **15/15 PASS，ALL_OK=True**
- 全量回归：`run_all.py` → **8 脚本全 PASS，152 断言全绿，ALL_OK=True**

---

## 二、各行动项实现要点

### A1 澄清器接线（TS 侧）
- `router.ts:275` generateReply 流程中 Clarifier.evaluate() 已接线
- score < 60（CLARIFY_HARD_THRESHOLD）→ 硬拦截直接追问
- score < 75（CLARIFY_SOFT_THRESHOLD）→ 注入 system prompt 软提示
- ⚠️ 观察项：澄清触发率仅 console.log，无结构化计数器（不阻塞，后续可加）

### A2 错题本（mistakes.py）
- 读取 `evaluation-records.json`（34 条低分 <60，均分 26.2）
- 错误类型 Top：instruction(34) / relevance(31) / vagueness(26) / logic(21)
- 产出：`seed_samples()`（A3 种子）、`context_block()`（上下文注入）、`top_issue_types()`（A6 选题）、`save()` → `mistake_book.json`

### A3 自博弈对练（role_discussion.py）
- `run_selfplay()`：错题重答 → 批评 → 修正 × selfplay_max_rounds
- 批评者优先"质疑者"角色；启发式评分（fix 关键词吸收 + 反思 + 长度惩罚）
- 落盘 `selfplay_records.json`，可选蒸馏沉淀

### A4 置信度 + 溯源（metacognition.py）
- `assess_confidence()`：断言切分 → {来源/验证状态/置信度} → 低置信度触发查证
- `trace_source()`：内联引用核验 / 沙盒验证建议 / 记忆卡片对照

### A5 世界模型（world_model.py）
- `predict()`：LLM 优先，启发式兜底（按命令类型 + 路径/危险词特征）
- `run_experiment()`：预测 → 沙盒真实执行 → 对账 → 落盘 `causal_pairs.json`
- `counterfactuals()`：反事实样本（预测≠实际），喂给 A7 做梦
- 真实实验：echo/dir/pwd 3/3 成功，match_rate=1.0

### A6 好奇探索器（curiosity.py）
- `select_topics()`：低置信度断言(priority 1) > 高频错误类型(2) > 默认(3)
- `explore()`：预算内（curiosity_budget）沙盒实验 → findings → 落盘 `curiosity_log.json`
- 真实选题：instruction / relevance / vagueness

### A7 离线做梦（dream.py）
- `dream()`：取材（错题本/自博弈/反事实/记忆卡片/探索发现）→ 重放 → 变异重组 → 假设入队
- `mutate()`：关键词替换 / 模板拼接 / 两两组合
- 队列落盘 `dream_queue.json`；`consume_queue()`/`mark_result()` 供 A6 消费验证
- 真实素材：错题本 10 + 记忆卡片 2 + 探索发现 4

### A8 多模型议会（parliament.py）
- `convene()`：提案（propose_motions）→ 辩论（debate，收敛检测提前闭会）→ 记名表决（vote）→ 决议
- 通过线：支持票过半且支持>反对；落盘 `parliament_records.json`
- 与 RoleDiscussion 关系：讨论是"分工碰撞"，议会的表决是"决策审计"

### A9 宪法护栏（constitution.py）
- `classify()`：read / write / exec 三级
- `guard()`：风险词硬拦截 + 允许清单 + read 默认放行；`enable_constitution=False` 显式关闸
- `snapshot()`/`diff_since()`/`rollback_plan()`：自改进前留底，出问题按指纹定位 + git 恢复
- 落盘 `constitution_snapshot.json`

---

## 三、数据产物（workspace/data/）

| 文件 | 来源 | 说明 |
|---|---|---|
| `mistake_book.json` | A2 | 错题本（34 条低分记录 + 统计） |
| `selfplay_records.json` | A3 | 自博弈对练记录 |
| `causal_pairs.json` | A5 | 世界模型因果对账对 |
| `curiosity_log.json` | A6 | 好奇探索日志 |
| `dream_queue.json` | A7 | 做梦假设队列（pending/verified/falsified） |
| `parliament_records.json` | A8 | 议会决议记录 |
| `constitution_snapshot.json` | A9 | 宪法快照（配置 + 文件指纹） |
| `cards.json` / `long_term.json` | 阶段1 | 记忆卡片 / 长期记忆 |

---

## 四、链路关系（A1-A9 怎么串起来的）

```
评测记录(evaluation-records.json)
   │ A2 错题本 ──► A3 自博弈(seed_samples) ──► 蒸馏沉淀记忆
   │              │
   │              ▼
A4 置信度/溯源 ◄── A5 世界模型(对账) ◄── 沙盒真实执行
   │              │ counterfactuals
   ▼              ▼
A6 好奇探索器 ◄── A7 离线做梦(假设队列) ◄── 重放错题/反事实/记忆
   │                 ▲
   └── 探索发现 ──────┘
A8 多模型议会：对重大方向（如"要不要上世界模型"）辩论表决
A9 宪法护栏：以上所有"自改进动作"过闸门 + 快照留底 + 回滚预案
```

**闭环语义**：考砸(A2) → 补课(A3) → 自我评估(A4) → 世界对账(A5) → 好奇探索(A6) → 离线消化(A7) → 集体决策(A8) → 全程受宪法约束(A9)。引擎的自我进化从"发散想法"变成了"有护栏的闭环机制"。

---

## 五、后续建议（非阻塞）

1. A1 结构化澄清计数器（补观察项）
2. 真实异构模型接入 Parliament（当前用 FakeModel 验证流程）
3. A7 假设队列接入 A6 自动消费验证（目前 API 已通，未挂定时任务）
4. A5 世界模型可扩展预测维度（stdout 内容级预测，目前 ok/exit_code 级）
5. 版本号已升至 0.5.0（`__init__.py`）
