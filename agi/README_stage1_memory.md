# 阶段1·记忆蒸馏 落地总结

对应 AGI 进化路线图【阶段1·让它记住】：三层记忆 + 经验蒸馏 → 从零开始、越用越聪明。

## 落地时间
2026-08-23 完成，验证 17/17 全部通过。
（阶段1闭环：讨论自动沉淀经验，另 9/9 通过）

## 新增文件
| 文件 | 作用 |
|---|---|
| `lingxi_engine/memory.py` | 三层记忆容器：短期（会话内）/ 长期（跨会话持久化）/ 经验卡片 |
| `lingxi_engine/distill.py` | 经验卡片蒸馏器：从讨论/反思记录中抽取可复用经验 |
| `lingxi_engine/tests/verify_memory_distill.py` | 阶段1正式验证脚本（17 项断言） |
| `lingxi_engine/tests/verify_stage1_loop.py` | 阶段1闭环验证脚本（9 项断言：讨论自动沉淀） |

## 修改文件
| 文件 | 改动 |
|---|---|
| `lingxi_engine/__init__.py` | 导出 `Memory`、`Distiller`、`CARD_TYPES`，版本升到 0.2.0 |
| `lingxi_engine/config.py` | 新增 `memory_data_dir`、`distill_auto_store`、`memory_top_k` 配置（支持 `LINGXI_MEMORY_DIR` 环境变量覆盖） |
| `lingxi_engine/role_discussion.py` | 讨论结束后自动调用 `Distiller.distill_and_store()` 把发言沉淀为经验卡片 |

## 三层记忆设计
- **短期记忆**：当前会话内上下文，会话结束 `clear_short()` 清空
- **长期记忆**：跨会话持久化到 `data/long_term.json`，记录关键事实与偏好
- **经验卡片**：由 distill 蒸馏出的可复用经验，持久化到 `data/cards.json`，带来源与类型

## 记忆衰减与检索
- 指数衰减：半衰期 1 天，越旧权重越低，避免上下文无限膨胀
- 加权检索：相关度 0.7 + 新鲜度 0.3，支持按层过滤、top_k 排序
- `context_block()` 一键生成可直接注入 prompt 的上下文文本

## 经验蒸馏
- **启发式蒸馏**（零依赖）：按触发词（不要/应该/注意/用户偏好/教训/坑…）抽取经验句子，自动分类为 教训/偏好/事实/方法
- **LLM 蒸馏**（可选）：注入 `model.invoke` 后走结构化 JSON 蒸馏，质量更高
- **自动沉淀**：`distill_and_store()` 一次调用完成"蒸馏→写入记忆"

## 阶段1闭环（讨论自动沉淀）
`RoleDiscussion.run_discussion()` 在讨论结束后，若开启 `distill_auto_store`，
自动把全部发言喂给 `Distiller.distill_and_store()` 沉淀为经验卡片。
这样每次多轮讨论都会留下可复用的经验，真正实现"越用越聪明"。

## 验证结果
```
阶段1记忆蒸馏：17 通过，0 失败
阶段1闭环沉淀： 9 通过，0 失败
```
覆盖：三层写入、持久化、关键词检索、零时差/一天后衰减、短期清空、蒸馏抽取、
无触发词过滤、来源标记、类型分类、自动沉淀、统计、讨论后自动沉淀、开关语义。

## 与阶段0/2的衔接
- 阶段0（多轮讨论+角色+收敛+反思）已在 `orchestrator.py` / `roles.py` / `role_discussion.py` 落地
- 阶段1 新增的记忆与蒸馏，可在 Agent 反思后调用 `Distiller.distill_and_store()` 把讨论沉淀为经验，实现真正的"越用越聪明"
- 阶段2（元认知）在记忆基础上做"知道自己知道什么"的能力评估与动态资源分配
