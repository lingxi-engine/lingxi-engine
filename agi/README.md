# 灵犀引擎 · 多模型协作讨论框架

一个基于 Python 的多模型协作讨论引擎，让多个大模型围绕一个话题**真正地多轮讨论**，通过角色差异化、收敛检测、反思机制、记忆系统与元认知调度，形成有价值的观点碰撞与收敛结论。

## 核心能力

| 能力 | 说明 | 开关/配置 |
|---|---|---|
| **真正的多轮讨论** | 外层轮次、内层模型，每个模型每轮都能看到前面所有发言 | `max_rounds`（默认 3，可用环境变量 `LINGXI_MAX_ROUNDS` 覆盖） |
| **角色差异化** | 为每个模型分配质疑者/建设者/总结者角色并注入系统指令，形成观点碰撞 | `roles.py` 的 `ROLES` / `assign_roles()` |
| **收敛检测** | 分歧信号拦截 + 双通道判定（difflib 相似度硬判定 + 总结者软兜底），达到共识阈值提前终止 | `enable_consensus`（默认开）、`consensus_threshold`（默认 0.8） |
| **反思机制** | 模型看到自己上轮发言 + 其他模型回复，输出【修订】或【补充】 | `enable_reflection`（默认开） |
| **投票机制** | 从候选项中选最认可方案 | `enable_voting`（默认开） |
| **记忆系统（阶段1）** | 三层记忆：短期 / 长期 / 经验卡片，带衰减、检索、持久化 | `enable_memory`、`memory_data_dir` |
| **经验蒸馏（阶段1）** | 讨论结束后自动把发言沉淀为经验卡片写入记忆，实现"越用越聪明" | `distill_auto_store`（默认开） |
| **元认知调度（阶段2）** | 按任务难度动态分配轮次 / 反思 / 记忆检索力度，主动调度而非被动轮询 | `enable_metacognition`、`max_rounds_cap` |

## 快速开始

```python
from lingxi_engine import LingXiCore, RoleDiscussion, Memory, Metacognition

# 方式一：使用基础编排器 Orchestrator
core = LingXiCore()
core.register_model('m1', model1)   # 传入实现了 invoke() 的模型
core.register_model('m2', model2)
core.register_model('m3', model3)

# 方式二：使用角色化编排器 RoleDiscussion（自动分配质疑者/建设者/总结者）
mem = Memory(data_dir='data')       # 阶段1：记忆系统
disc = RoleDiscussion(core, config={'memory': mem})
results = disc.run_discussion('如何设计一个更好的推荐系统？')

# 方式三：阶段2 · 元认知动态调度（按任务难度分配资源）
meta = Metacognition()
plan = disc.plan_resources('如何设计一个分布式系统架构？')
# plan 里带 evaluation（难度分）和 allocation（轮次/反思/记忆力度）
results = disc.run_discussion('如何设计一个分布式系统架构？', plan=plan)
```

## 元认知调度（阶段2）

`Metacognition` 让引擎"知道自己"——评估任务难度，动态分配计算资源：

**难度评估**：从 复杂度 / 歧义度 / 风险度 三个维度打分，合成综合难度分（0~1），映射到 简单/中等/复杂/极难 四档。采用"凸组合修正"避免单维度高分被其他维度稀释。

```python
meta = Metacognition()
ev = meta.evaluate('在生产环境删除数据库并重置用户数据')
# {'complexity': ..., 'ambiguity': ..., 'risk': 1.0, 'difficulty': ..., 'level': '极难'}
```

**动态分配**：按难度档位决定资源投入，高风险任务强制反思并提高轮次。

| 难度档 | 轮次 | 反思 | 记忆检索力度 | 理由 |
|---|---|---|---|---|
| 简单 | 1 | 关 | 低（2） | 单轮即可，避免过度计算 |
| 中等 | 2 | 开 | 中（4） | 适度检索历史经验 |
| 复杂 | 4 | 开 | 高（6） | 多轮碰撞 + 反思 |
| 极难 | 5 | 开 | 很高（8） | 全力调度 |

**自我状态监控**：`monitor()` 评估上下文占用、可用模型数、记忆规模，输出健康度与告警。

```python
status = meta.monitor(context_length=5000, token_budget=8000, available_models=3,
                      memory_stats={'short':5,'long':10,'cards':8})
# {'health': 0.9, 'status': '健康', 'warnings': [...]}
```

## 记忆系统（阶段1）

三层记忆，带时间衰减与持久化：

- **短期记忆**：当前会话上下文，会话结束清空
- **长期记忆**：跨会话持久化（JSON 落盘），记录关键事实与偏好
- **经验卡片**：由蒸馏器沉淀的可复用经验，带来源与置信度，含相似度去重与数量上限（默认 500 张）
- **可靠性保障**：持久化采用"临时文件 + os.replace 原子替换"，进程崩溃不会留下半截 JSON；加载遇到坏文件时先备份为 `.corrupt` 再重建，绝不静默清空数据

```python
mem = Memory(data_dir='data')
mem.remember_long('用户偏好简洁的回答')
hits = mem.search('偏好', top_k=5)          # 相关度 + 新鲜度加权
block = mem.context_block('偏好')           # 生成可直接拼进 prompt 的上下文
```

**经验蒸馏**：讨论结束后自动把发言沉淀为经验卡片，写入记忆，实现"越用越聪明"。

```python
from lingxi_engine import Distiller
d = Distiller(store=mem)
cards = d.distill_and_store(['建议先立评测体系再补功能'], source='讨论:进化路径')
```

## 配置方法

配置优先级：**环境变量 > 传入的 overrides > DEFAULT_CONFIG**（见 `config.py` 的 `get_config()`）。

```python
disc = RoleDiscussion(core, config={
    'max_rounds': 5,
    'consensus_threshold': 0.85,
    'enable_consensus': True,     # 收敛检测独立于投票开关
    'enable_reflection': True,
    'enable_memory': True,
    'memory_top_k': 5,            # 记忆检索注入条数
    'enable_metacognition': True, # 元认知调度开关
    'max_rounds_cap': 5,          # 动态分配轮次上限
})
```

### 关键配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `max_rounds` | 3 | 最大讨论轮数 |
| `consensus_threshold` | 0.8 | 收敛判定阈值（同轮全部回复的全配对相似度最小值） |
| `enable_consensus` | True | 收敛检测独立开关，关闭则跑满全部轮次 |
| `enable_reflection` | True | 反思机制开关 |
| `enable_voting` | True | 投票机制开关 |
| `enable_memory` | True | 记忆系统开关 |
| `memory_window` | 10 | 记忆窗口大小 |
| `memory_data_dir` | `data` | 记忆持久化目录 |
| `memory_top_k` | 5 | 记忆检索注入上下文的条数 |
| `distill_auto_store` | True | 讨论后自动蒸馏沉淀经验卡片 |
| `enable_metacognition` | True | 元认知调度开关 |
| `max_rounds_cap` | 5 | 动态分配轮次上限 |
| `temperature` | 0.7 | 采样温度 |

> **注意**：收敛检测（`enable_consensus`）是独立机制，**不依赖**投票开关（`enable_voting`）。即使 `enable_voting=False`，只要 `enable_consensus=True`，检测到共识仍会提前终止多轮循环。

## 角色机制

角色定义在 `roles.py`：

- **质疑者**：挑战其他模型的论点，找逻辑漏洞、事实错误和盲区
- **建设者**：提出具体可行的方案、补充论据和实现细节
- **总结者**：归纳各方观点，识别共识与分歧，推动收敛

`assign_roles(model_names)` 按注册顺序轮流分配，保证每个角色都有模型承担。角色指令在构造上下文时通过 `get_role_instruction()` 注入。

## 收敛检测（分歧信号拦截 + 双通道）

`_check_consensus()` 采用"分歧信号拦截 + 双通道"设计：

0. **分歧信号拦截（优先级最高）**：调用 `roles.py` 的 `has_divergence()`，若同轮发言中出现"反对/不同意/有异议"等信号，说明仍存在实质分歧，直接判定未收敛，让讨论继续多轮进行。否定语境自动豁免："没有反对意见""不存在分歧"这类表述不算分歧。**这避免了把"句式相似但观点相反"误判为达成共识。**
1. **文本相似度硬判定**：用 `difflib` 计算【全配对】相似度并取最小值——只有任意两条发言都超过阈值才判定收敛。（旧实现只看相邻对，A≈B、B≈C 不代表 A≈C，存在漏判）
2. **总结者软兜底**：当相似度未全达硬阈值、但存在明显趋同倾向时，调用配置的"总结者"模型做一次明确判定，避免漏判也避免误判。

> 收敛检测的完整实现集中在共享模块 `consensus.py`，两个编排器（Orchestrator / RoleDiscussion）委托同一实现，杜绝行为漂移。

## 文件结构

```
lingxi_engine/
├── core.py               # 核心：模型/工具注册、任务编排
├── orchestrator.py       # 基础编排器：多轮 + 反思 + 分歧拦截 + 双通道收敛检测
├── role_discussion.py    # 角色化编排器：独立、抗覆盖（含记忆注入 + 蒸馏闭环）
├── roles.py              # 角色集合、分配、指令注入、分歧信号检测
├── consensus.py          # 共享收敛检测：分歧拦截(含否定豁免) + 全配对相似度 + 总结者软兜底
├── sandbox.py            # 阶段3：受限沙盒执行（白名单+无shell+参数级黑名单）+ 环境反馈闭环
├── agent.py              # Agent：think/reflect/vote/remember
├── memory.py             # 阶段1：三层记忆（短期/长期/经验卡片）+ 衰减检索
├── distill.py            # 阶段1：经验卡片蒸馏器
├── metacognition.py      # 阶段2：元认知控制器 + 动态资源分配 + 状态监控
├── models.py             # 模型注册表
├── tools.py              # 工具系统
├── config.py             # 配置：DEFAULT_CONFIG + get_config()
├── prompts/              # 提示词文档（orchestrator/discuss/collaboration/system）
└── __init__.py           # 包入口
```

## 验收测试

```bash
python tests/verify_consensus.py         # 收敛检测专项，22 断言
python tests/verify_role_discussion.py   # 角色讨论专项，15 断言
python tests/verify_memory_distill.py    # 阶段1 记忆+蒸馏专项，17 断言
python tests/verify_stage1_loop.py       # 阶段1 讨论自动沉淀闭环，9 断言
python tests/verify_metacognition.py     # 阶段2 元认知+动态调度专项，38 断言
python tests/verify_stage3_sandbox.py    # 阶段3 沙盒+环境反馈闭环专项，30 断言

# 一键全量回归（推荐，结果写入 lingxi_engine/tests/run_all_result.txt）
python lingxi_engine/tests/run_all.py
```

全部通过即表示多轮讨论、收敛检测、角色差异化、反思机制、记忆系统、经验蒸馏、元认知调度在 `max_rounds > 1` 时正常工作，且讨论既能真正多轮进行、又能达成收敛、还能按难度动态调度资源、并在结束后沉淀经验。
