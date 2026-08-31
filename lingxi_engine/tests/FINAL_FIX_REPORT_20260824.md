# 灵犀引擎代码审查修复 · 最终报告

日期：2026-08-24　范围：`lingxi_engine/` 全部 12 个模块

## 一、修复问题总数：12（P0×1、P1×3、P2×5、P3×3）

| # | 级别 | 问题 | 修复方式 | 落点文件 |
|---|------|------|----------|----------|
| 1 | P0 | 沙盒白名单形同虚设（shell=True + python/node 放行 = 任意代码执行；前缀匹配放行 git push --force） | 移除 shell=True，shlex.split 后列表执行；白名单砍到 echo/dir/ls/cat/type/pwd/find/where/which/ping，首 token 精确匹配；python/node 删除；内建命令原生实现零注入面；参数级黑名单补 -delete/-exec 等 find 危险标志 | sandbox.py |
| 2 | P1 | 记忆非原子写 + 坏文件静默清空 | temp file + fsync + os.replace 原子替换；加载失败先备份 .corrupt 再重建，绝不静默丢数据 | memory.py |
| 3 | P1 | core.running 异常时永久卡 True；history 无限增长 | try/finally 复位 running；_MAX_HISTORY=1000 裁剪最旧记录 | core.py |
| 4 | P1 | run_with_feedback 伪闭环（建议从未执行） | 真闭环：模型下一步建议实际执行进沙盒，新结果刷新反馈进入下一轮调整，adjustments 记录每步 response/action/execution | role_discussion.py |
| 5 | P2 | 收敛检测只看相邻对 | 抽成共享模块 consensus.py：全配对相似度取最小值硬判定 + 总结者软兜底双通道 | consensus.py（新增），orchestrator.py / role_discussion.py 委托 |
| 6 | P2 | has_divergence 否定语句误判（"不存在分歧"被拦收敛） | endpos 锚定否定豁免正则，否定词须紧邻关键词（最多隔"的/地"），规避字符重叠与远距误伤 | roles.py |
| 7 | P2 | memory_top_k 实例级污染 | run_discussion 内改用局部变量 mem_top_k 传参 | role_discussion.py |
| 8 | P2 | Agent.vote 固定返回第一项（假投票） | 真实投票：编号候选项交模型评估、正则解析编号、失败降级 None 弃权；collect_votes 多人汇总 winner/tally/ballots；orchestrator 与 role_discussion 接线 enable_voting | agent.py, orchestrator.py, role_discussion.py |
| 9 | P2 | _llm_evaluate 死代码；plan() 未调 monitor() | evaluate() 优先走 LLM 评估并归一化字段，解析失败降级启发式；plan() 返回值挂 monitor 字段 | metacognition.py |
| 10 | P3 | 收敛检测双份拷贝行为漂移 | 统一委托 consensus.py 单一实现，两编排器语义一致 | orchestrator.py, role_discussion.py |
| 11 | P3 | 经验卡片无限膨胀 | Memory.add_card 相似度去重（SequenceMatcher≥0.9 跳过）+ MAX_CARDS=500 上限保留最新；Distiller 单次 max_cards=20 截断 | memory.py, distill.py |
| 12 | P3 | 回归套件漏 stage3；_COMPLEXITY_SIGNALS 重复项 + hits/5 魔法数 | run_all.py 补入 stage3_sandbox 及 config 开关验证；信号表去重；_SIGNAL_SATURATION=5 具名常量 | tests/run_all.py, metacognition.py |

## 二、修改文件清单

核心模块（9）：sandbox.py、memory.py、core.py、role_discussion.py、orchestrator.py、consensus.py（新增共享模块）、roles.py、agent.py、metacognition.py、distill.py
测试（6）：tests/run_all.py、tests/verify_stage3_sandbox.py、tests/verify_config_switches.py、tests/verify_config_wiring.py、tests/verify_roles_divergence.py、tests/_run_root_verify.py

## 三、最终验证结果（全部通过）

- 语法编译：lingxi_engine 全部 30 个 .py 编译通过
- 包内回归 run_all.py：**7 套全绿，ALL_OK=True**
  - stage1_memory 17 通过｜stage1_loop 9｜stage2_meta 38｜stage3_sandbox 30｜config_switches 8/8｜config_wiring 16/16｜roles_divergence 15
- 根目录旧验收 _run_root_verify.py：**8 套全绿，ROOT_OK=True**
  - lingxi、consensus(22)、roles、reflect、role_reflect、run_discussion、multi_round_consensus、role_discussion(15)
  - 其中 verify_roles.py 覆盖重写后的 has_divergence 行为断言——上一轮遗漏的复跑已补上

## 四、剩余未解决问题

无 P0/P1/P2/P3 遗留。已知限制（有意为之，非缺陷）：
1. 分歧检测否定豁免仅支持中文否定词，英文 don't/isn't 不识别（代码内有注释声明）
2. difflib 相似度对中文长文本仍偏高，0.8 阈值偏宽松——已有总结者软兜底通道补偿，如需更严可调低 consensus_threshold

## 五、后续改进建议

1. **沙盒再加固**：当前白名单含 find/ping 外部程序，若要上线生产，建议迁到容器/作业队列级隔离（进程级沙盒只是缓解不是隔离）
2. **记忆并发锁**：多线程同时 remember_long 时 os.replace 原子但读改写非互斥，可加 threading.Lock
3. **相似度升级**：difflib 可换 embedding 余弦相似度，中文判定会更准
4. **CI 化**：把 run_all.py + _run_root_verify.py 挂到提交钩子，防止回归套件再次漏跑
