# 配置
DEFAULT_CONFIG = {
    # 多轮讨论轮数：默认 3-5，可通过环境变量 LINGXI_MAX_ROUNDS 或 get_config() 覆盖
    'max_rounds': 3,
    # 收敛判定阈值：同轮相邻回复相似度达到该值视为观点趋同
    'consensus_threshold': 0.8,
    # 收敛检测独立开关：默认开启，检测到共识即提前终止多轮循环
    # （收敛检测不依赖 enable_voting，二者是独立的机制）
    'enable_consensus': True,
    # 反思 / 投票 / 记忆开关：默认开启，让讨论真正"动"起来。
    # enable_memory 控制是否把历史讨论注入上下文（False 时上下文只含话题）。
    'enable_reflection': True,
    # enable_voting：讨论结束后对最后一轮候选发言做真实投票（见 agent.collect_votes）
    'enable_voting': True,
    'enable_memory': True,
    # 历史注入窗口条数：只把最近 N 条历史拼进上下文（<=0 表示不限）
    'memory_window': 10,
    # --- 阶段1·记忆蒸馏相关配置 ---
    # 记忆持久化目录
    'memory_data_dir': 'data',
    # 蒸馏是否自动沉淀经验卡片
    'distill_auto_store': True,
    # 记忆检索时注入上下文的条数
    'memory_top_k': 5,
    # --- 阶段2·元认知动态资源分配相关配置 ---
    # 元认知控制器开关：默认开启，按任务难度动态分配轮次/反思/记忆力度
    'enable_metacognition': True,
    # 动态分配时轮次上限（防止过度计算）
    'max_rounds_cap': 5,
    # --- 阶段3·沙盒执行 + 环境反馈闭环相关配置 ---
    # 沙盒执行总开关：默认开启。False 时强制等效 sandbox_mode='off'
    # （兼容旧配置；新代码建议直接用 sandbox_mode）
    'enable_sandbox': True,
    # 沙盒模式开关（四档）：
    #   'strict'（默认）：安全优先，白名单仅无害查询命令（echo/dir/ls/cat 等）
    #   'open'：体验档，额外放行 python/node/git/pip/curl/ffmpeg 等常用工具，
    #           让模型能真正跑脚本验证方案（解释器=任意代码执行，仅在可信环境开启）
    #   'full'：全开放档，跳过白名单检查，任何命令放行；仅保留黑名单/超时/
    #           无 shell 兜底。能力与直接操作终端等同，仅在完全可信环境使用
    #   'off'：完全关闭，任何命令都拒绝
    # 可通过环境变量 LINGXI_SANDBOX_MODE 覆盖；非法值回落 strict
    'sandbox_mode': 'strict',
    # 沙盒命令超时（秒）
    'sandbox_timeout': 10,
    # 沙盒工作目录（None 表示继承当前目录）
    'sandbox_cwd': None,
    # 沙盒命令白名单（None 使用模式对应的内置白名单；显式传入列表则完全覆盖）
    'sandbox_allow': None,
    # --- 阶段4·受限自改进（头脑风暴 A1-A9 落地）相关配置 ---
    # A2 错题本：评测记录文件路径（TS 引擎 Evaluator 写入的 evaluation-records.json）
    'eval_records_path': None,
    # A2 错题本：低分阈值（score < 该值视为"考砸了"，进入错题本）
    'mistake_threshold': 60,
    # A3 自博弈：单轮对练的回合数上限（防止无限对练）
    'selfplay_max_rounds': 4,
    # A4 置信度：低置信度触发查证的阈值（0~1，越低越严格）
    'confidence_low_threshold': 0.5,
    # A5 世界模型：因果对账记录落盘文件（相对 memory_data_dir）
    'world_model_pairs_file': 'causal_pairs.json',
    # A6 好奇探索器：单次探索的沙盒命令预算上限（防预算失控）
    'curiosity_budget': 5,
    # A7 离线做梦：做梦产出假设的探索队列文件（相对 memory_data_dir）
    'dream_queue_file': 'dream_queue.json',
    # A8 多模型议会：单次议题辩论的轮数上限（防无限辩论）
    'parliament_max_rounds': 3,
    # A9 宪法护栏：自改进动作的护栏开关（默认开启，所有自改进必须过护栏）
    'enable_constitution': True,
    # A9 宪法护栏：允许清单（分级：read/write/exec → 动作名关键词）。
    # 动作命中清单才放行；write/exec 级不在清单需显式授权。None 用内置默认。
    'constitution_allowlist': None,
    # --- 20260825 新增：一键「一口气干完」模式（force_complete）---
    # 用户对执行类任务说「强制干完/一口气/别停/不要问」时，引擎不应中途停下询问。
    # 开启后 apply_force_complete() 会统一放宽四道"刹车"：
    #   1. enable_consensus → False（收敛检测不再提前 break 收工）
    #   2. max_rounds_cap → 20（轮次上限放宽，任务能跑完）
    #   3. sandbox_mode → open（strict 只放行查询命令，任务无法真正执行）
    #   4. constitution_allowlist → 宽松清单（write/exec 常用动作直接放行，
    #      但风险词硬拦截保留，安全底线不动）
    # 默认 False（保持原有严格行为）；可用环境变量 LINGXI_FORCE_COMPLETE 覆盖（0/1）。
    'force_complete': False,
    # --- 阶段5·Swarm 集群执行（Orchestrator-Worker）相关配置 ---
    # 并行子 Agent 数上限（防资源失控）
    'swarm_max_workers': 4,
    # token 总预算：None 不限；整数则超限熔断（抛 BudgetExceededError）
    'token_budget': None,
    # 断点续跑开关：任务状态周期性落盘 data/task_state，重启后可恢复
    'enable_checkpoint': True,
    # 执行/验收分离开关：验收模型与执行模型分离，防长任务作弊
    'enable_verifier': True,
    # 验收不通过时的最大整改次数
    'verify_max_retries': 2,
    # 指定规划/验收/执行/汇总模型名（None 自动选择）
    'planner_model': None,
    'verifier_model': None,
    'worker_model': None,
    'swarm_summary_model': None,
    # 检查点目录（相对工作目录；None 用默认 data/task_state）
    'task_state_dir': None,
}

# force_complete 模式下使用的宪法护栏宽松清单：
# write 级放行写文件/配置/报告/记忆等常规动作；exec 级放行脚本执行与命令运行。
# 风险词硬拦截（删除/覆盖/格式化/shutdown 等）在 constitution.py 中仍然生效，
# 不受本清单影响——这是保留的安全底线。
FORCE_COMPLETE_ALLOWLIST = {
    'read': ['read_file', 'read_config', 'read_memory', 'query', 'view', 'list'],
    'write': ['write_config', 'write_memory', 'write_log', 'write_report',
              'write_file', 'write_doc', 'write_script', 'save', 'update',
              'write', '生成报告', '写文件', '保存'],
    'exec': ['sandbox_query', 'sandbox_experiment', 'run_script', 'run_command',
             'execute', 'python', 'node', 'git', 'pip', 'curl', 'ffmpeg',
             '跑脚本', '执行命令'],
}

# force_complete 模式下沙盒升档目标（未显式指定 sandbox_mode 时生效）
FORCE_COMPLETE_SANDBOX_MODE = 'open'
# force_complete 模式下轮次上限（未显式指定更高值时生效）
FORCE_COMPLETE_MAX_ROUNDS_CAP = 20


def apply_force_complete(cfg, respect=None):
    """把 force_complete=True 的放宽规则应用到配置 dict（就地修改并返回）。

    只"放宽"不"收紧"：respect 集合（通常为调用方显式设置的键名）里的配置
    不会被本函数覆盖。安全底线（风险词硬拦截、黑名单/超时兜底）不在本函数
    范围内，始终由 constitution.py / sandbox.py 保留。
    """
    if not cfg.get('force_complete'):
        return cfg
    respect = set(respect or ())
    # 1. 收敛检测关闭：不再因发言相似提前 break
    if 'enable_consensus' not in respect and cfg.get('enable_consensus', True):
        cfg['enable_consensus'] = False
    # 2. 轮次上限放宽
    if 'max_rounds_cap' not in respect:
        cur_cap = cfg.get('max_rounds_cap')
        if cur_cap is None or cur_cap < FORCE_COMPLETE_MAX_ROUNDS_CAP:
            cfg['max_rounds_cap'] = FORCE_COMPLETE_MAX_ROUNDS_CAP
    # 3. 沙盒升档（未显式指定或仍为 strict 时）
    if 'sandbox_mode' not in respect:
        if not cfg.get('sandbox_mode') or cfg.get('sandbox_mode') == 'strict':
            cfg['sandbox_mode'] = FORCE_COMPLETE_SANDBOX_MODE
    # 4. 护栏宽松清单（未显式指定时）
    if 'constitution_allowlist' not in respect:
        if not cfg.get('constitution_allowlist'):
            cfg['constitution_allowlist'] = FORCE_COMPLETE_ALLOWLIST
    return cfg


def get_config(overrides=None):
    """返回一份合并后的配置。

    优先级：环境变量 > 传入的 overrides > DEFAULT_CONFIG。
    - max_rounds 可通过环境变量 LINGXI_MAX_ROUNDS 覆盖（默认 3-5）。
    - memory_data_dir 可通过环境变量 LINGXI_MEMORY_DIR 覆盖。
    - enable_metacognition 可通过环境变量 LINGXI_METACOGNITION 覆盖（0/1）。
    - enable_sandbox 可通过环境变量 LINGXI_SANDBOX 覆盖（0/1）。
    - sandbox_mode 可通过环境变量 LINGXI_SANDBOX_MODE 覆盖（strict/open/off）。
    - force_complete 可通过环境变量 LINGXI_FORCE_COMPLETE 覆盖（0/1）。
      force_complete=True 时自动应用 apply_force_complete() 的放宽规则；
      overrides 里显式设置的键会被尊重（不被放宽覆盖）。
    """
    import os

    cfg = dict(DEFAULT_CONFIG)

    # 环境变量覆盖
    env_max_rounds = os.environ.get('LINGXI_MAX_ROUNDS')
    if env_max_rounds:
        try:
            cfg['max_rounds'] = int(env_max_rounds)
        except ValueError:
            pass

    env_mem_dir = os.environ.get('LINGXI_MEMORY_DIR')
    if env_mem_dir:
        cfg['memory_data_dir'] = env_mem_dir

    env_meta = os.environ.get('LINGXI_METACOGNITION')
    if env_meta is not None:
        cfg['enable_metacognition'] = env_meta in ('1', 'true', 'True')

    env_sb = os.environ.get('LINGXI_SANDBOX')
    if env_sb is not None:
        cfg['enable_sandbox'] = env_sb in ('1', 'true', 'True')

    env_sb_mode = os.environ.get('LINGXI_SANDBOX_MODE')
    if env_sb_mode:
        cfg['sandbox_mode'] = env_sb_mode.strip().lower()

    env_fc = os.environ.get('LINGXI_FORCE_COMPLETE')
    if env_fc is not None:
        cfg['force_complete'] = env_fc in ('1', 'true', 'True')

    # 调用方显式覆盖（优先级最高）
    explicit = set()
    if overrides:
        explicit = set(overrides.keys())
        cfg.update(overrides)

    # force_complete 统一放宽（必须在所有覆盖应用之后；显式设置的键不被覆盖）
    apply_force_complete(cfg, respect=explicit)

    return cfg