# 角色化多轮讨论编排器（独立模块，抗覆盖）
#
# 背景：orchestrator.py 是共享文件，可能被多模型协作中其他模型反复改写。
# 为保证"角色差异化（质疑者/建设者/总结者）"这一能力稳定存在且不被覆盖丢失，
# 将角色化编排逻辑独立成此模块，自包含、自洽、可独立运行与测试。
#
# 能力：
#   1. 为每个模型分配角色（质疑者/建设者/总结者），按注册顺序轮流分配
#   2. 构造上下文时注入角色系统指令，使不同模型按职责发言，形成观点碰撞
#   3. 真正的多轮迭代（外层轮次、内层模型，max_rounds 可配置）
#   4. 反思机制（模型基于他人讨论反思后发言）
#   5. 收敛检测：委托共享模块 consensus.py（全配对相似度 + 分歧拦截 + 总结者兜底）
#   6. 每条发言记录都附带 role 字段
#   7. 【阶段1 闭环】讨论结束后自动调用 Distiller 把发言沉淀为经验卡片
#   8. 【阶段2 接入】plan_resources() 调用 Metacognition 生成资源分配计划；
#      run_discussion 支持传入 plan，按 plan 动态决定轮次/反思/记忆检索力度
#   9. 【阶段3 接入】run_with_feedback() 真正的"行动 → 观察 → 调整"闭环：
#      模型给出的下一步行动建议会被实际执行，新结果作为反馈进入下一轮调整，
#      直到目标达成或达到 max_adjust 上限。

from .config import get_config, apply_force_complete
from .consensus import DEFAULT_CONSENSUS_THRESHOLD, check_consensus, extract_texts, pairwise_similarity_scores
from .roles import assign_roles, get_role_instruction

# ---- 20260825 方案B：用户「一口气干完」自然语言关键词 ----
# 命中任一关键词即自动开启 force_complete（无需改配置，直接说就行）。
FORCE_COMPLETE_KEYWORDS = (
    '强制', '强制干完', '一口气', '一口气干完', '别停', '不要停',
    '一次性', '别问', '不要问', '不需要确认', '不用确认', '直接干完',
    '跑完', '别中断', '不要中断', '别停下来', '不停下',
)



class RoleDiscussion:
    """角色化多轮讨论编排器。"""

    def __init__(self, core, config=None):
        self.core = core
        self.config = get_config(config)
        self.max_rounds = self.config.get('max_rounds', 3)
        self.consensus_threshold = self.config.get(
            'consensus_threshold', DEFAULT_CONSENSUS_THRESHOLD)
        self.enable_reflection = self.config.get('enable_reflection', True)
        # 收敛检测总开关：enable_consensus（默认 True）
        self.enable_consensus = self.config.get('enable_consensus', True)
        # 投票开关：独立于收敛检测
        self.enable_voting = self.config.get('enable_voting', True)
        # 阶段1 闭环：蒸馏自动沉淀开关（默认开启）
        self.distill_auto_store = self.config.get('distill_auto_store', True)
        # 记忆实例：可从 config['memory'] 或 core.memory 获取
        self.memory = self.config.get('memory') or getattr(core, 'memory', None)
        self.memory_top_k = self.config.get('memory_top_k', 5)
        # 元认知控制器（阶段2）
        self._metacog = None
        # 为每个模型分配角色
        self.role_map = assign_roles(list(core.models.keys()))
        # 阶段3：沙盒执行环境（惰性创建，避免依赖不可用时影响主流程）
        # enable_sandbox 开关接线：False 时 _get_sandbox 返回 None，
        # run_with_feedback 会明确报错而不是静默降级。
        self.enable_sandbox = self.config.get('enable_sandbox', True)
        self._sandbox = None
        # 20260825 方案B：force_complete 开关（默认关，命中关键词或配置开启后放宽）
        self.force_complete = bool(self.config.get('force_complete', False))

    # ------------------------------------------------------------------
    # 阶段2：元认知资源规划
    # ------------------------------------------------------------------
    def _get_metacog(self):
        """惰性创建元认知控制器。

        enable_metacognition=False 时直接返回 None（走默认资源计划），
        让这个配置开关真正生效——此前它只是个没人读的假开关。
        """
        if not self.config.get('enable_metacognition', True):
            return None
        if self._metacog is None:
            try:
                from .metacognition import Metacognition
                self._metacog = Metacognition(config=self.config)
            except ImportError:
                self._metacog = None
        return self._metacog

    def plan_resources(self, task: str) -> dict:
        """用元认知评估任务难度，生成资源分配计划。

        返回：{evaluation: {...}, allocation: {rounds, memory_top_k, reflection, ...}}
        若元认知不可用，返回基于默认配置的兜底计划。
        """
        meta = self._get_metacog()
        if meta is not None:
            available_models = len(getattr(self.core, 'models', {}))
            # max_rounds_cap 接线：动态分配轮次的硬上限（缺省回落到 max_rounds）。
            # 此前这个配置从未被读取，属于"承诺了上限却没人执行"的死键。
            cap = self.config.get('max_rounds_cap') or self.max_rounds
            return meta.plan(task, available_models=available_models,
                             max_rounds_cap=cap)
        # 兜底：默认计划
        return {
            'task': task,
            'evaluation': {'level': '中等', 'difficulty': 0.5},
            'allocation': {
                'rounds': self.max_rounds,
                'use_all_models': True,
                'memory_top_k': self.memory_top_k,
                'reflection': self.enable_reflection,
                'reason': '元认知不可用，使用默认配置',
            },
        }

    @staticmethod
    def _detect_force_complete(topic: str) -> bool:
        """20260825 方案B：检测用户消息是否要求「一口气干完」。"""
        if not topic:
            return False
        t = str(topic)
        return any(k in t for k in FORCE_COMPLETE_KEYWORDS)

    def get_role_map(self):
        """返回 {模型名: 角色名} 映射。"""
        return dict(self.role_map)

    # ------------------------------------------------------------------
    # 阶段3：沙盒执行 + 环境反馈闭环
    # ------------------------------------------------------------------
    def _get_sandbox(self):
        """惰性创建沙盒执行环境。

        enable_sandbox=False 时直接返回 None（明确禁用），
        让这个配置开关真正生效。
        """
        if not self.enable_sandbox:
            return None
        if self._sandbox is None:
            try:
                from .sandbox import Sandbox
                self._sandbox = Sandbox(config=self.config)
            except ImportError:
                self._sandbox = None
        return self._sandbox

    def sandbox_stats(self):
        """返回沙盒环境信息（供元认知监控）。"""
        sb = self._get_sandbox()
        return sb.stats() if sb is not None else {'available': False}

    def _execute_actions(self, actions):
        """在沙盒里执行一批动作，返回执行结果列表。"""
        sb = self._get_sandbox()
        executions = []
        for act in actions or []:
            try:
                executions.append(sb.run(act))
            except Exception as e:
                executions.append({'ok': False, 'command': act, 'stderr': str(e),
                                   'stdout': '', 'exit_code': -3, 'elapsed': 0})
        return executions

    @staticmethod
    def _extract_action(resp_text):
        """从模型回复中提取下一步行动命令（反引号内或整行）。"""
        import re
        text = str(resp_text).strip()
        m = re.search(r'`([^`]+)`', text)
        if m:
            return m.group(1).strip()
        # 兜底：取第一行非空内容
        for line in text.splitlines():
            line = line.strip()
            if line:
                return line
        return ''

    def run_with_feedback(self, topic, actions, plan=None, max_adjust=2):
        """【阶段3】讨论 + 沙盒执行 + 环境反馈闭环（真闭环）。

        流程：
          1. 先跑一轮角色化多轮讨论，得出行动方案（actions 为候选命令）
          2. 在沙盒里实际执行这些命令，得到真实环境反馈
          3. 把执行结果喂回给模型；若模型认为未达成目标并给出下一步建议，
             该建议会被【实际执行】，其结果再作为新一轮反馈继续调整
          4. 最多调整 max_adjust 轮，避免无限循环

        返回：{discussion, executions, adjustments, final_action, feedback}
        其中 adjustments[i] 包含 response / action / execution 字段，
        保证每一步建议都有对应的真实执行记录——这是与旧版伪闭环的本质区别。
        """
        sb = self._get_sandbox()
        if sb is None:
            reason = ('沙盒已被配置禁用（enable_sandbox=False）'
                      if not self.enable_sandbox else
                      '沙盒模块不可用')
            return {'error': '无法执行环境反馈闭环：' + reason}
        # sandbox_mode='off' 时讨论可以照跑，但闭环没有意义——
        # 早退并给出明确错误，而不是让每条命令都失败收场
        if getattr(sb, 'mode', '') == 'off':
            return {'error': "无法执行环境反馈闭环：sandbox_mode='off'（沙盒已关闭）"}

        # 1. 讨论得出行动方案
        discussion = self.run_discussion(topic, plan=plan)

        # 2. 在沙盒执行候选动作
        executions = self._execute_actions(actions)

        # 3. 把执行结果作为环境反馈，喂给模型调整
        feedback = sb.feedback_block(executions)
        all_executions = list(executions)
        adjustments = []
        current = topic
        for i in range(max_adjust):
            if not feedback:
                break
            prompt = (
                f"话题：{current}\n\n{feedback}\n\n"
                "请基于以上环境反馈，判断动作是否达成目标。\n"
                "如果已达成，只回复：目标达成\n"
                "如果未达成，给出下一步具体行动建议（一句话，命令请放在反引号内）。"
            )
            resp = self._ask_first_model(prompt)
            adj = {'round': i + 1, 'response': resp}

            if '目标达成' in resp:
                adjustments.append(adj)
                break

            # ---- 真闭环核心：把模型的下一步建议实际执行掉 ----
            action = self._extract_action(resp)
            if action:
                new_execs = self._execute_actions([action])
                adj['action'] = action
                adj['execution'] = new_execs[0] if new_execs else None
                all_executions.extend(new_execs)
                # 用最新执行结果刷新反馈，供下一轮判断
                feedback = sb.feedback_block(new_execs) or feedback
            else:
                # 模型没给出可执行的建议，避免空转
                adjustments.append(adj)
                break

            adjustments.append(adj)

        return {
            'discussion': discussion,
            'executions': all_executions,
            'adjustments': adjustments,
            'final_action': (
                adjustments[-1].get('action') or adjustments[-1]['response']
                if adjustments else ''
            ),
            'feedback': feedback,
        }

    def _ask_first_model(self, prompt):
        """让第一个可用模型回答。"""
        for name, model in self.core.models.items():
            try:
                return model.invoke(prompt)
            except Exception:
                continue
        return ''

    # ------------------------------------------------------------------
    # 记忆注入
    # ------------------------------------------------------------------
    def _inject_memory(self, context: str, query: str, top_k: int = None) -> str:
        """把 Memory 检索到的历史经验注入上下文，实现"知道自己知道什么"。"""
        if self.memory is None:
            return context
        k = top_k if top_k is not None else self.memory_top_k
        try:
            block = self.memory.context_block(query, top_k=k)
        except Exception:
            return context
        if not block:
            return context
        return f"{context}\n\n【历史经验（来自记忆）】\n{block}"

    # ------------------------------------------------------------------
    # 主流程
    # ------------------------------------------------------------------
    def run_discussion(self, topic: str, plan: dict = None):
        """运行角色化多轮讨论，返回带 role 字段的完整记录。

        参数：
            topic: 讨论话题
            plan: 可选，由 plan_resources() 生成的资源分配计划。
                  提供时按 plan 动态决定轮次、反思、记忆检索力度。
        讨论结束后，若开启 distill_auto_store，会把全部发言喂给蒸馏器，
        沉淀成经验卡片写入 Memory，实现"越用越聪明"。
        """
        # ---- 20260825 方案B：自然语言「强制干完」自动进入一口气模式 ----
        # 用户消息命中关键词（强制/一口气/别停/不要问等）时，自动开启
        # force_complete，并把放宽规则应用到本实例配置：关闭收敛提前终止、
        # 放宽轮次上限、沙盒升档、护栏放行常规动作（安全底线风险词硬拦截保留）。
        if not self.force_complete and self._detect_force_complete(topic):
            self.force_complete = True
            self.config['force_complete'] = True
            apply_force_complete(self.config)
            # 重新读取被放宽的开关
            self.enable_consensus = self.config.get('enable_consensus', True)
            self.max_rounds = self.config.get('max_rounds', 3)
            self.consensus_threshold = self.config.get(
                'consensus_threshold', DEFAULT_CONSENSUS_THRESHOLD)
            self._sandbox = None  # 沙盒模式可能已升档，重建实例

        # 应用元认知计划（阶段2）
        rounds = self.max_rounds
        reflection = self.enable_reflection
        mem_top_k = self.memory_top_k  # 局部变量，不污染实例状态
        if plan and plan.get('allocation'):
            alloc = plan['allocation']
            if alloc.get('rounds'):
                rounds = alloc['rounds']
            if 'reflection' in alloc:
                reflection = alloc['reflection']
            if alloc.get('memory_top_k'):
                mem_top_k = alloc['memory_top_k']

        results = []
        for round_idx in range(rounds):
            round_results = []
            for name, model in self.core.models.items():
                context = self._build_context(topic, results, name)
                # 记忆注入（阶段1+阶段2融合）
                context = self._inject_memory(context, topic, top_k=mem_top_k)

                # 反思机制：优先走 Agent.reflect（与 Orchestrator 同一语义），
                # 让模型看到自己上轮发言 + 其他模型回复；无 reflect 方法的
                # 模型退回反思提示词。两条路径都标记 reflected。
                if reflection:
                    prev = [r for r in results if r['model'] == name]
                    if prev:
                        own_prev = prev[-1]['response']
                        # 路径A：模型自带 reflect 方法（与 Orchestrator 同语义）
                        if hasattr(model, 'reflect') and callable(getattr(model, 'reflect', None)):
                            others = [r['response'] for r in results if r['model'] != name]
                            resp = model.reflect(own_prev, others)
                            round_results.append({
                                'round': round_idx,
                                'model': name,
                                'role': self.role_map.get(name, '通用协作'),
                                'response': resp,
                                'reflected': True,
                            })
                            continue
                        # 路径B：兜底反思提示词（同样视为经过反思）
                        context = self._reflect_prompt(name, context, own_prev)
                        resp = model.invoke(context)
                        round_results.append({
                            'round': round_idx,
                            'model': name,
                            'role': self.role_map.get(name, '通用协作'),
                            'response': resp,
                            'reflected': True,
                        })
                        continue

                # 普通发言（首轮或未开启反思）：不标记 reflected
                resp = model.invoke(context)
                round_results.append({
                    'round': round_idx,
                    'model': name,
                    'role': self.role_map.get(name, '通用协作'),
                    'response': resp,
                })
            results.extend(round_results)

            # 收敛检测：仅由 enable_consensus 控制（独立于 enable_voting）
            if self.enable_consensus and self._check_consensus(round_results):
                break

        # ---- 投票机制：enable_voting 开启时对最后一轮候选发言真实投票 ----
        # 与 Orchestrator 共用 agent.collect_votes，结果挂在 self.vote_result。
        self.vote_result = None
        if self.enable_voting and results:
            last_idx = max(r['round'] for r in results)
            last_texts = [r['response'] for r in results if r['round'] == last_idx]
            if len(last_texts) >= 2:
                from .agent import collect_votes
                self.vote_result = collect_votes(self.core.models, last_texts)

        # ---- 阶段1 闭环：讨论结束后自动沉淀经验卡片 ----
        if self.distill_auto_store:
            self._distill_discussion(topic, results)

        return results

    # ------------------------------------------------------------------
    # 阶段1 闭环：蒸馏沉淀
    # ------------------------------------------------------------------
    def _distill_discussion(self, topic, results):
        """把本次讨论的发言蒸馏成经验卡片，写入 Memory。

        惰性导入 Distiller / Memory，避免循环依赖；
        若 core 上挂了 memory 或 config 指定了 memory，则自动沉淀。
        """
        try:
            from .distill import Distiller
        except ImportError:
            return

        memory = self.memory
        if memory is None:
            # 兼容：config 里带 memory_data_dir 时，尝试构造一个 Memory
            data_dir = self.config.get('memory_data_dir') or \
                (getattr(self.core, 'config', {}) or {}).get('memory_data_dir')
            if data_dir:
                try:
                    from .memory import Memory
                    memory = Memory(data_dir=data_dir)
                    self.memory = memory
                except Exception:
                    memory = None
        if memory is None:
            return

        # 收集全部发言文本作为蒸馏原料
        records = [f"{item['model']}({item.get('role', '')}): {item['response']}"
                   for item in results]
        if not records:
            return

        try:
            d = Distiller(store=memory)
            d.distill_and_store(records, source=f'讨论:{topic}')
        except Exception:
            # 蒸馏失败不影响主流程
            pass

    # ------------------------------------------------------------------
    # 上下文构造 + 角色注入
    # ------------------------------------------------------------------
    def _build_context(self, topic, history, model_name=None):
        """构造上下文，并为指定模型注入其角色的系统指令。"""
        role_name = self.role_map.get(model_name, '通用协作')
        role_instruction = get_role_instruction(role_name)

        base = f"【你的角色】\n{role_instruction}\n\n话题: {topic}"
        if not history:
            return base

        context = f"{base}\n\n之前的讨论:\n"
        for item in history:
            context += f"[{item['model']}]: {item['response']}\n\n"
        context += "请基于以上讨论，按你的角色职责继续发言。"
        return context

    def _reflect_prompt(self, name, context, own_prev):
        return (
            f"{context}\n\n"
            f"[反思] 你上一轮的发言是：{own_prev}\n"
            f"请结合其他模型的讨论，反思并修正或深化你的观点。"
        )

    # ------------------------------------------------------------------
    # 收敛检测：委托共享模块 consensus.py（与 Orchestrator 同一实现）
    # ------------------------------------------------------------------
    def _check_consensus(self, round_results, threshold=None):
        threshold = threshold if threshold is not None else self.consensus_threshold
        texts = extract_texts(round_results)
        summarizer = self._find_summarizer()
        return check_consensus(texts, threshold=threshold, summarizer=summarizer)

    def _pairwise_similarity(self, texts):
        """全配对相似度（保留方法以兼容既有调用方）。"""
        return pairwise_similarity_scores(list(texts))

    def _find_summarizer(self):
        """寻找角色为"总结者"的模型，找不到返回 None。"""
        cfg_summarizer = self.config.get('summarizer')
        if cfg_summarizer:
            return cfg_summarizer
        for name, model in self.core.models.items():
            role = getattr(model, 'role', '') or ''
            if '总结' in name or '总结' in role or 'summar' in name.lower():
                return model
        return None

    def _ask_summarizer(self, summarizer, round_results):
        """让总结者判定是否达成共识（兼容保留的入口）。"""
        from .consensus import ask_summarizer_verdict
        return ask_summarizer_verdict(summarizer, extract_texts(round_results))



    # ------------------------------------------------------------------
    # 阶段4·A3：自博弈对练（左右互搏自举）
    # ------------------------------------------------------------------
    # 对应 AGI 进化路线图【阶段4·让它"进化"】A3：
    #   run_selfplay()：让引擎重答自己做错的题，再自我批评、自我修正，
    #   形成"作答 → 批评 → 修正"的左右互搏闭环——训练信号自产自销。
    #
    # 设计：
    #   1. 种子 = A2 错题本（MistakeBook.seed_samples），拿不到时合成兜底
    #   2. 每条错题做 max_rounds 轮"批评→修正"迭代（首轮前先作答）
    #   3. 批评者优先选"质疑者"角色模型；修正/作答用第一个可用模型
    #   4. 启发式评分：修正稿是否吸收了 issues[].fix 的关键词（补课信号）
    #      + 反思信号 + 长度惩罚，得到 0-100 自博弈分
    #   5. 结果落盘 data/selfplay_records.json，供蒸馏沉淀与复盘
    # 纯 Python 实现，无外部依赖；种子为空或模型异常时优雅降级不崩溃。

    # 修正建议停用词：从 fix 文本里剔除后再提取关键词，避免"避免/应该"
    # 这类动作词被当成补课信号（修正稿说"应该改正"不等于真改了）。
    _SELFPLAY_STOP = frozenset([
        '的', '了', '在', '和', '与', '或', '对', '把', '被', '是', '要', '请',
        '进行', '应该', '需要', '可以', '避免', '不要', '建议', '改为', '改成',
        '添加', '增加', '补充', '明确', '给出', '说明', '确保', '保证', '使用',
        '通过', '根据', '内容', '部分', '相关', '以下', '同时', '但是', '因为',
        '所以', '如果', '然后', '这样', '其中', '并且', '以及', '没有', '不是',
        '是否', '重新', '再次', '尽量', '尽可能',
    ])

    def run_selfplay(self, topic: str = '', samples=None, max_rounds: int = None) -> dict:
        """【A3】自博弈对练：重答错题 → 自我批评 → 修正，左右互搏自举。

        参数：
            topic: 话题描述（用于无错题数据时的合成种子）
            samples: 可选，直接传入种子样本（[{problem, score, issues, model}]）；
                     为空时自动从 A2 错题本拉取（MistakeBook.seed_samples）
            max_rounds: 单题对练轮数上限（默认取 config['selfplay_max_rounds']，4）
        返回：
            {source, seeds_used, records, improved_count, avg_before,
             avg_after, records_file}
        """
        import json
        import os
        import time

        # ---- 1. 种子：优先调用方传入，其次 A2 错题本，最后合成兜底 ----
        seeds = list(samples) if samples else []
        source = '调用方提供'
        if not seeds:
            try:
                from .mistakes import MistakeBook
                book = MistakeBook(config=self.config)
                seeds = book.seed_samples(limit=10)
                if seeds:
                    source = '错题本: %s' % (book.path or 'unknown')
            except Exception:
                seeds = []
        if not seeds:
            seeds = [{'problem': topic or '通用话题', 'score': 0,
                      'issues': [], 'model': '?'}]
            source = '合成种子（无错题数据）'

        rounds = int(max_rounds or self.config.get('selfplay_max_rounds', 4))
        records = []
        for seed in seeds:
            rec = self._selfplay_one(seed, rounds)
            if rec is not None:
                records.append(rec)

        # ---- 5. 统计 + 落盘 ----
        improved = sum(1 for r in records if r.get('improved'))
        before = [r['original_score'] for r in records]
        after = [r['selfplay_score'] for r in records]
        stats = {
            'source': source,
            'seeds_used': len(seeds),
            'records': records,
            'improved_count': improved,
            'avg_before': round(sum(before) / len(before), 1) if before else 0.0,
            'avg_after': round(sum(after) / len(after), 1) if after else 0.0,
        }

        # 蒸馏沉淀（可选）：把对练结果当讨论喂给 Distiller，沉淀经验卡片
        if self.distill_auto_store and records:
            fake_results = [{'model': '自博弈', 'role': '作答者',
                             'response': r['final_answer']} for r in records]
            self._distill_discussion('自博弈:%s' % topic, fake_results)

        # 落盘：memory_data_dir/selfplay_records.json（测试可传临时目录）
        try:
            data_dir = self.config.get('memory_data_dir', 'data')
            os.makedirs(data_dir, exist_ok=True)
            target = os.path.join(data_dir, 'selfplay_records.json')
            payload = {
                'generated_at': time.time(),
                'stats': {
                    'source': source,
                    'improved_count': improved,
                    'avg_before': stats['avg_before'],
                    'avg_after': stats['avg_after'],
                },
                'records': records,
            }
            tmp = target + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
            os.replace(tmp, target)
            stats['records_file'] = target
        except Exception:
            stats['records_file'] = None

        return stats

    def _selfplay_one(self, seed: dict, rounds: int) -> dict:
        """对单道错题做完整自博弈对练：作答 → (批评 → 修正) × rounds → 评分。

        返回记录 dict；模型全部不可用时返回 None（该题跳过，不拖垮整体）。
        """
        problem = str(seed.get('problem') or '(无问题)')
        original = float(seed.get('score', 0) or 0)
        issues = list(seed.get('issues', []) or [])

        # ---- 作答 ----
        answer_prompt = (
            '【错题重答】以下是引擎曾经做错的一道题，请认真重新作答。\n'
            '题目：%s\n请给出你的回答。' % problem
        )
        current = self._ask_first_model(answer_prompt)
        if not current:
            return None

        turns = [{'round': 0, 'type': 'answer',
                  'model': self._first_model_name(), 'text': current}]

        # ---- 批评 → 修正 迭代（左右互搏） ----
        critic = self._pick_model('质疑')
        critic_name = getattr(critic, 'name', None) or self._first_model_name()
        for i in range(1, rounds + 1):
            issues_text = self._format_issues(issues)
            critique_prompt = (
                '【自我批评】你是质疑者。以下是对错题「%s」的回答：\n%s\n\n'
                '已知问题清单（来自评测）：\n%s\n\n'
                '请严厉指出回答中仍存在的错误、遗漏与不足，给出具体批评。'
                % (problem[:60], current, issues_text or '（无）')
            )
            try:
                if critic is not None:
                    critique = critic.invoke(critique_prompt)
                else:
                    critique = self._ask_first_model(critique_prompt)
            except Exception:
                critique = self._ask_first_model(critique_prompt)
            if not critique:
                break
            turns.append({'round': i, 'type': 'critique',
                          'model': critic_name, 'text': critique})

            revise_prompt = (
                '【修正】以下是批评意见，请据此修正你的回答，'
                '输出修正后的完整版本：\n%s' % critique
            )
            revised = self._ask_first_model(revise_prompt)
            if not revised:
                break
            current = revised
            turns.append({'round': i, 'type': 'revise',
                          'model': self._first_model_name(), 'text': revised})

        score = self._score_revised(current, issues)
        return {
            'problem': problem,
            'original_score': original,
            'turns': turns,
            'final_answer': current,
            'selfplay_score': score,
            'improved': score > original,
        }

    def _first_model_name(self):
        """第一个可用模型名（无模型返回 '?'）。"""
        for name in self.core.models:
            return name
        return '?'

    def _pick_model(self, role_hint: str):
        """按角色关键字挑模型（如 '质疑'），没有匹配返回 None。"""
        if role_hint:
            for name, model in self.core.models.items():
                role = self.role_map.get(name, '') or ''
                if role_hint in role or role_hint in name:
                    return model
        return None

    @staticmethod
    def _format_issues(issues) -> str:
        """把 issues 列表格式化成可读文本（type + description + fix）。"""
        lines = []
        for it in issues or []:
            t = it.get('type', '')
            desc = str(it.get('description', ''))[:100]
            fix = str(it.get('fix', ''))[:100]
            parts = [p for p in (t, desc, fix) if p]
            if parts:
                lines.append('- ' + '；'.join(parts))
        return '\n'.join(lines)

    @classmethod
    def _fix_keywords(cls, fix) -> list:
        """从修正建议里提取补课关键词（剔除停用词后，去重保序，最多 6 个）。"""
        import re
        text = str(fix)
        for w in cls._SELFPLAY_STOP:
            text = text.replace(w, ' ')
        toks = re.findall(
            r'[\u4e00-\u9fff]{2,8}|[A-Za-z_][A-Za-z0-9_]{1,20}', text)
        out = []
        for t in toks:
            if len(t) < 2 or t in out:
                continue
            out.append(t)
        return out[:6]

    @classmethod
    def _score_revised(cls, revised, issues) -> int:
        """启发式自博弈评分（0-100）。

        规则：
          - 基础 30 分
          - 修正稿吸收 fix 关键词：每个 issue +15（上限 +45）——"补课信号"
          - 出现反思/修正措辞：+10
          - 修正稿过短（<40 字）：-15（敷衍信号）
        """
        text = str(revised)
        score = 30.0
        hits = 0
        for issue in issues or []:
            kws = cls._fix_keywords(issue.get('fix', ''))
            if kws and any(kw in text for kw in kws):
                hits += 1
        score += min(45, hits * 15)
        if any(w in text for w in ('改进', '修正', '不足', '错误', '应该',
                                   '避免', '重新', '补充')):
            score += 10
        if len(text) < 40:
            score -= 15
        return max(0, min(100, int(score)))
