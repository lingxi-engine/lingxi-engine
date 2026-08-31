# 修复验证报告（step-4 复验轮）— 2026-08-24

## 验证范围

对 step-4 声称的修复（13 项审查问题 + 第二轮收尾）做独立验证：
不信任包内测试结论，逐文件读源码核验 + 独立冒烟/对抗测试 + 静态分析。

## 一、源码逐行核验结果（13/13 项确认落地）

| # | 审查项 | 级别 | 核验结论 |
|---|---|---|---|
| 1 | 沙盒 shell=True + 解释器白名单 | P0 | ✅ `shell=False`、`shlex.split` 列表执行；白名单无 python/node/powershell；内建命令 Python 原生实现 |
| 2 | 白名单前缀匹配（git push --force 放行） | P0 | ✅ 首 token 精确匹配；`--force`/`-rf`/`find -delete` 参数级黑名单纵深拦截 |
| 3 | 记忆非原子写 + 坏文件静默清空 | P1 | ✅ `_atomic_write`（tmp+fsync+os.replace）；坏文件备份为 `.corrupt` 后重建 |
| 4 | `core.running` 异常不复位 / history 泄漏 | P1 | ✅ try/finally；`_MAX_HISTORY=1000` 裁剪 |
| 5 | `run_with_feedback` 伪闭环 | P1 | ✅ 模型建议实际执行，`adjustments[i]` 含 action+execution，反馈刷新 |
| 6 | 收敛检测只看相邻对 | P2 | ✅ `consensus.pairwise_similarity_scores` 全配对取最小值 |
| 7 | 分歧词否定豁免失效 | P2 | ✅ 已修（见"三"：本轮复验又发现残留缺陷并二次修复） |
| 8 | `memory_top_k` 实例污染 | P2 | ✅ 局部变量 `mem_top_k` |
| 9 | 投票伪造 | P2 | ✅ `Agent.vote` 真实调用模型解析编号，失败弃权；`collect_votes` 结构化计票 |
| 10 | LLM 评估死代码 / plan 未调 monitor | P2 | ✅ `evaluate()` 接入 `_llm_evaluate`（含降级）；`plan()` 返回值含 `monitor` 字段 |
| 11 | 收敛检测双份拷贝 | P3 | ✅ 共享模块 `consensus.py`，两个编排器均委托 |
| 12 | 经验卡片爆炸 | P3 | ✅ 触发词收窄 + SequenceMatcher≥0.9 相似度去重 + MAX_CARDS=500 上限 |
| 13 | stage3 不在回归 / _COMPLEXITY_SIGNALS 重复 | P3 | ✅ run_all.py 纳入 stage3；信号表已去重；`hits/5` 提为 `_SIGNAL_SATURATION` |

配置接线核验：`sandbox_allow` 键已在 config.py 与 Sandbox 中接通；
`enable_sandbox=False` 时 `run_with_feedback` 明确报错而非静默降级。

## 二、独立测试执行（本轮新增）

### 对抗性沙盒测试（10 种攻击全部拦截）
```
python -c "import shutil; shutil.rmtree(...)"   -> BLOCKED
python3 --version                               -> BLOCKED
node -e "require(fs).unlinkSync(x)"             -> BLOCKED
git push --force origin main                    -> BLOCKED
rm -rf /                                        -> BLOCKED
del /f /s q                                     -> BLOCKED
find . -name *.tmp -delete                      -> BLOCKED
find . -exec rm {} ;                            -> BLOCKED
powershell Remove-Item -Recurse                 -> BLOCKED
echo hello && rm -rf data                       -> BLOCKED (元字符惰性化)
leaks = 0
```

### 行为验证
- 记忆原子写持久化重载 ✓；坏文件备份 `.corrupt` ✓（绝不静默清空）
- 相似卡片去重 ✓（完全重复跳过；相似度 <0.9 的按设计保留）
- 元认知 `plan()` 含 monitor ✓；`max_rounds_cap=2` 时极难任务 rounds≤2 ✓
- plan 应用后实例 `memory_top_k` 不被污染 ✓
- `core.running` 异常后复位 ✓；history 裁剪至 1000 ✓
- 多轮讨论收敛提前终止 ✓；真实投票产出 winner ✓
- 角色分配轮转正确 ✓

## 三、⚠️ 本轮发现并修复的新缺陷（1 个）

**P1｜`roles.has_divergence` 否定豁免对共享字符场景失效**

- 现象：审查报告引用的原例 `"我不存在分歧的看法"` 仍被误判为分歧。
- 根因：旧豁免逻辑检查关键词**前方窗口**是否含否定词，但 `"不存在"`
  与关键词 `"存在分歧"` **共享字符重叠**——重叠部分永远进不了前方窗口。
  另有反向漏洞：6 字符宽窗导致 `"毫无根据的存在分歧"` 被 `"无"` 误豁免。
- 为何漏网：包内 6 套测试**没有任何用例覆盖 has_divergence**。
- 修复：改为 endpos 锚定正则 `(?:并非|不是|没有|毫无|不存在|不|无|非)(?:的|地)?$`，
  要求否定词紧邻关键词（最多隔一个助词），天然规避字符重叠与远距误伤。
  注意 `"不存在"` 必须排在单字 `"不"` 前（`"目前不存在反对的声音"` 场景）。
- 补救：新增 `verify_roles_divergence.py` 回归（15 用例），挂入 run_all.py。

## 四、静态分析

- 工具：pyflakes 3.4.0（环境无 pylint/mypy）
- 初次扫描：9 条未使用导入（均为历轮重构遗留，非逻辑错误）
- 处理：清理包内全部 3 个文件的遗留导入（consensus.py /
  orchestrator.py / role_discussion.py）；临时脚本归档至 `_archive/`
- 终扫：**包内 py 文件 pyflakes 全干净（EXIT: 0）**
- 测试脚本中保留 3 条 unused-import 提示（归档件，不影响包质量）

## 五、最终回归（收尾改动后全量重跑）

| 套件 | 结果 |
|---|---|
| stage1_memory | PASS（17 项） |
| stage1_loop | PASS（9 项） |
| stage2_meta | PASS（38 项） |
| stage3_sandbox | PASS（30 项） |
| config_switches | PASS（8 项） |
| config_wiring | PASS（16 项） |
| roles_divergence（新增） | PASS（15 项） |
| **合计** | **133 项全绿，ALL_OK=True** |
| 包内 py_compile | 全部通过 |
| 包内 pyflakes | 0 告警 |

## 六、已知限制（非缺陷，记录备查）

1. 英文否定（don't/isn't）不在豁免范围内——英文分歧词命中即拦，
   宁可多讨论一轮也不误报收敛，方向安全。
2. `difflib.SequenceMatcher` 对中文长文本相似度天然偏高，
   consensus_threshold=0.8 在超长同构回复下仍可能偏松——
   有总结者软兜底通道兜底，风险可控。
3. 沙盒白名单中的外部命令（find/where/which/ping）依赖系统 PATH 存在性，
   缺失时返回明确错误而非崩溃。

## 结论

13 项历史修复**全部真实落地且经独立对抗验证**。本轮新发现 1 个 P1
残留缺陷（分歧豁免共享字符场景），已修复并补齐此前缺失的回归覆盖。
引擎当前状态：133 项回归全绿、静态分析零告警、沙盒经 10 种攻击向量
实测零泄漏。可以承接真实任务流。
