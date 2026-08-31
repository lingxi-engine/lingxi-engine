# 编排器
from .config import get_config, apply_force_complete
from .consensus import (
    DEFAULT_CONSENSUS_THRESHOLD,
    check_consensus,
    extract_texts,
    pairwise_similarity_scores,
)


class Orchestrator:
    def __init__(self, core, config=None):
        self.core = core
        # 从可配置的 config 读取轮数，不再硬编码为 1
        self.config = get_config(config)
        self.max_rounds = self.config.get('max_rounds', 3)  # 默认 3-5，可配
        # 20260825 方案B：force_complete 开关（命中关键词或配置开启后放宽）
        self.force_complete = bool(self.config.get('force_complete', False))

    def run_discussion(self, topic: str):
        """真正的多轮讨论：外层轮次、内层模型。

        每个模型在每一轮都能看到前面所有模型的发言，从而"动"起来；
        反思机制通过 Agent.reflect 接入：让每个模型看到自己的上轮发言
        及其他模型的回复，生成修订意见或补充观点。

        收敛检测独立于投票开关：只要收敛检测开启（enable_consensus），
        一旦判定达成共识就提前终止，不依赖 enable_voting。
        """
        # ---- 20260825 方案B：自然语言「强制干完」自动进入一口气模式 ----
        if not self.force_complete and self._detect_force_complete(topic):
            self.force_complete = True
            self.config['force_complete'] = True
            apply_force_complete(self.config)
            self.max_rounds = self.config.get('max_rounds', 3)

        results = []
        for round_idx in range(self.max_rounds):
            round_results = []
            for name, model in self.core.models.items():
                context = self._build_context(topic, results)

                # 反思机制：让模型基于自己的上轮发言 + 其他模型回复反思后发言
                if self.config.get('enable_reflection', False):
                    prev = [r for r in results if r['model'] == name]
                    if prev:
                        own_prev = prev[-1]['response']
                        others = [
                            r['response'] for r in results
                            if r['model'] != name
                        ]
                        # 优先调用 Agent.reflect（看到自己上轮 + 他人回复，生成修订）
                        if hasattr(model, 'reflect') and callable(model.reflect):
                            resp = model.reflect(own_prev, others)
                            round_results.append({
                                'round': round_idx,
                                'model': name,
                                'response': resp,
                                'reflected': True,
                            })
                            continue
                        # 兜底：无 reflect 方法的模型，用反思提示词
                        context = self._reflect_prompt(name, context, own_prev)

                resp = model.invoke(context)
                round_results.append({
                    'round': round_idx,
                    'model': name,
                    'response': resp,
                })
            results.extend(round_results)

            # 收敛检测：独立于 enable_voting 生效。
            if self._consensus_enabled() and self._check_consensus(round_results):
                break

        # 投票机制：enable_voting 开启时，对最后一轮候选发言做一次真实投票。
        # 结果挂在 self.vote_result（不改动返回结构，兼容既有调用方）；
        # 模型未实现 vote() 时自动弃权，绝不伪造选票。
        self.vote_result = None
        if self.config.get('enable_voting', False) and results:
            last_idx = max(r['round'] for r in results)
            options = [r['response'] for r in results if r['round'] == last_idx]
            if len(options) >= 2:
                from .agent import collect_votes
                self.vote_result = collect_votes(self.core.models, options)

        return results

    @staticmethod
    def _detect_force_complete(topic) -> bool:
        """20260825 方案B：检测用户消息是否要求「一口气干完」。"""
        if not topic:
            return False
        from .role_discussion import FORCE_COMPLETE_KEYWORDS
        t = str(topic)
        return any(k in t for k in FORCE_COMPLETE_KEYWORDS)

    def _consensus_enabled(self):
        """收敛检测开关。

        收敛检测是独立机制，不应被 enable_voting（投票）绑架。
        默认开启；可通过 config['enable_consensus'] 显式关闭。
        """
        return self.config.get('enable_consensus', True)

    def _reflect_prompt(self, name, context, own_prev):
        return (
            f"{context}\n\n"
            f"[反思] 你上一轮的发言是：{own_prev}\n"
            f"请结合其他模型的讨论，反思并修正或深化你的观点。"
        )

    # ------------------------------------------------------------------
    # 收敛检测：委托给共享模块 consensus.py，与 RoleDiscussion 保持同一实现
    # ------------------------------------------------------------------
    def _check_consensus(self, round_results, threshold=None):
        """判断最近一轮各模型回复是否已达成共识。

        实现细节见 consensus.check_consensus：
          0. 分歧信号拦截（含否定语境豁免）
          1. 全配对相似度最小值 >= 阈值 → 硬判定收敛
          2. 有趋同倾向时总结者软兜底确认
        """
        threshold = threshold if threshold is not None else \
            self.config.get('consensus_threshold', DEFAULT_CONSENSUS_THRESHOLD)
        texts = extract_texts(round_results)
        summarizer = self._find_summarizer() if self._summarizer_enabled() else None
        return check_consensus(texts, threshold=threshold, summarizer=summarizer)

    def _summarizer_enabled(self):
        """是否允许总结者软兜底通道。"""
        return True

    def _pairwise_similarity(self, texts):
        """全配对相似度（保留方法以兼容既有调用方）。"""
        return pairwise_similarity_scores(list(texts))

    def _find_summarizer(self):
        """寻找角色为"总结者"的模型。

        优先取 config 中显式指定的 summarizer，其次扫描 core.models 里
        名字或角色含"总结/summar"的模型。找不到返回 None。
        """
        cfg_summarizer = self.config.get('summarizer')
        if cfg_summarizer:
            return cfg_summarizer

        for name, model in self.core.models.items():
            role = getattr(model, 'role', '') or ''
            if '总结' in name or '总结' in role or 'summar' in name.lower():
                return model
        return None

    def _ask_summarizer(self, summarizer, round_results):
        """让总结者模型判定最近一轮是否已达成共识（兼容保留的入口）。"""
        from .consensus import ask_summarizer_verdict
        texts = extract_texts(round_results)
        return ask_summarizer_verdict(summarizer, texts)

    def _build_context(self, topic, history):
        """构造上下文。接两个记忆配置：

        - enable_memory=False：完全不注入历史讨论（上下文只有话题本身）
        - memory_window=N：只注入最近 N 条历史（N<=0 表示不限）
        """
        if not self.config.get('enable_memory', True):
            return topic
        if not history:
            return topic
        window = self.config.get('memory_window', 10)
        if isinstance(window, int) and window > 0:
            history = history[-window:]
        # 把历史拼成上下文
        context = f"话题: {topic}\n\n之前的讨论:\n"
        for item in history:
            context += f"[{item['model']}]: {item['response']}\n\n"
        context += "请基于以上讨论继续发言。"
        return context
