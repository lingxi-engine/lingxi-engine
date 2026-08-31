# 多模型议会（A8）——异构模型辩论 + 记名投票
#
# 对应 AGI 进化路线图【阶段4·让它"进化"】P0 行动项 A8：
#   "多模型议会——让异构模型就同一议题辩论，投票产出决议"
#
# 核心思想：单一模型有系统性盲区，但异构模型的盲区往往不重叠。
#   议会机制把多个模型组织成"立法机构"：
#     1. 提案：把议题拆成若干可表决的动议（motions）
#     2. 辩论：每轮每个模型按席位发言（支持/反对/弃权 + 理由），
#        观点碰撞后按收敛检测（consensus.py）判定是否已趋同
#     3. 表决：记名投票（每个模型一票），按通过率产出决议
#     4. 落盘：议会记录存 data/parliament_records.json
#
# 与阶段0-3 已有机制的关系：
#   - RoleDiscussion 是"分工讨论"（质疑者/建设者/总结者各司其职）；
#   - Parliament 是"决策表决"（异构模型平权辩论 + 记名投票），
#     决策比讨论更正式——产出的是带票型的决议，可被 A9 护栏审计。
#
# 纯 Python 实现，无外部依赖；模型不可用时优雅降级（记录缺席，不崩溃）。

import json
import os
import time
from typing import Any, Dict, List, Optional


class Parliament:
    """多模型议会：异构模型辩论 + 记名投票产出决议。"""

    # 默认动议模板：把议题变成可表决的陈述句
    _MOTION_TEMPLATES = [
        '议题「{topic}」应作为阶段4优先落地方向',
        '议题「{topic}」需要先做小规模验证再全面推行',
        '议题「{topic}」应纳入引擎自我进化的长期机制',
    ]

    def __init__(self, core, config: Optional[Dict[str, Any]] = None):
        """初始化。

        core: 引擎核心（需有 .models 字典：{模型名: 模型对象}）
        config: 配置（读取 memory_data_dir / parliament_max_rounds）
        """
        self.core = core
        self.config = config or {}
        # 辩论轮数上限（防止无限辩论）；可由 config['parliament_max_rounds'] 覆盖
        self.max_rounds = max(1, int(self.config.get('parliament_max_rounds', 3)))
        self.records: List[Dict[str, Any]] = []
        self._load_records()

    # ---------- 模型与席位 ----------
    def members(self) -> List[str]:
        """在册议员（可用模型名列表）。"""
        models = getattr(self.core, 'models', None) or {}
        return list(models.keys())

    def _invoke(self, name: str, prompt: str) -> str:
        """让指定模型发言；异常返回空串（缺席）。"""
        models = getattr(self.core, 'models', None) or {}
        m = models.get(name)
        if m is None:
            return ''
        try:
            return str(m.invoke(prompt))
        except Exception:
            return ''

    # ---------- 提案 ----------
    def propose_motions(self, topic: str, custom: Optional[List[str]] = None) -> List[str]:
        """把议题拆成动议；可传入自定义动议列表。"""
        if custom:
            return [str(c) for c in custom]
        return [t.format(topic=topic) for t in self._MOTION_TEMPLATES]

    # ---------- 辩论 ----------
    def debate(self, topic: str, motions: List[str],
               max_rounds: Optional[int] = None) -> Dict[str, Any]:
        """对动议做多轮辩论，返回辩论记录。

        每轮每个在册议员发言（支持/反对/弃权 + 理由）；
        轮间做收敛检测（委托 consensus.check_consensus），趋同则提前终止。
        """
        rounds_n = max(1, int(max_rounds or self.max_rounds))
        members = self.members()
        transcripts: List[Dict[str, Any]] = []
        for rnd in range(1, rounds_n + 1):
            round_speeches = []
            for name in members:
                prompt = (
                    '【多模型议会辩论】你是议席成员。\n'
                    f'议题：{topic}\n'
                    f'待表决动议：\n' + '\n'.join(f'- {m}' for m in motions) +
                    '\n\n请发言：明确表态（支持/反对/弃权）+ 一句理由。'
                    f'\n（辩论第 {rnd} 轮）'
                )
                speech = self._invoke(name, prompt)
                round_speeches.append({
                    'member': name,
                    'round': rnd,
                    'speech': speech,
                })
            transcripts.append({'round': rnd, 'speeches': round_speeches})

            # 收敛检测：趋同则提前闭会（用发言文本，忽略空串）
            texts = [s['speech'] for s in round_speeches if s['speech']]
            if texts:
                try:
                    from .consensus import check_consensus
                    if check_consensus(texts, threshold=0.8):
                        break
                except Exception:
                    pass
        return {'topic': topic, 'motions': motions, 'rounds': transcripts}

    # ---------- 表决 ----------
    def vote(self, motions: List[str]) -> Dict[str, Any]:
        """记名投票：每个模型对每条动议表决，产出决议。

        返回 {motions: [{motion, votes: [{member, stance, reason}], 
                          yea, nay, abstain, pass}], summary}
        """
        members = self.members()
        results = []
        for motion in motions:
            votes = []
            yea = nay = abstain = 0
            for name in members:
                prompt = (
                    '【议会表决】请对以下动议表决，只回复三选一：'
                    f'支持 / 反对 / 弃权\n动议：{motion}'
                )
                raw = self._invoke(name, prompt)
                stance = '弃权'
                if '支持' in raw:
                    stance = '支持'
                    yea += 1
                elif '反对' in raw:
                    stance = '反对'
                    nay += 1
                else:
                    abstain += 1
                votes.append({'member': name, 'stance': stance,
                              'reason': raw[:80]})
            total = yea + nay + abstain
            # 通过线：支持票过半（简单多数），且支持 > 反对
            passed = total > 0 and yea > nay and yea * 2 > total
            results.append({
                'motion': motion,
                'votes': votes,
                'yea': yea,
                'nay': nay,
                'abstain': abstain,
                'passed': passed,
            })
        summary = {
            'motions': len(results),
            'passed': sum(1 for r in results if r['passed']),
            'rejected': sum(1 for r in results if not r['passed']),
        }
        return {'motions': results, 'summary': summary}

    # ---------- 全会 ----------
    def convene(self, topic: str, motions: Optional[List[str]] = None,
                debate_rounds: Optional[int] = None) -> Dict[str, Any]:
        """召集一次完整议会：提案 → 辩论 → 表决 → 落盘。

        返回 {topic, motions, debate, vote, resolution, ts, records_file}
        """
        ms = self.propose_motions(topic, motions)
        debate = self.debate(topic, ms, max_rounds=debate_rounds)
        vote = self.vote(ms)
        resolution = {
            'topic': topic,
            'decision': '通过' if vote['summary']['passed'] > 0 else '否决',
            'passed_motions': [r['motion'] for r in vote['motions'] if r['passed']],
            'vote_summary': vote['summary'],
        }
        rec = {
            'ts': time.time(),
            'topic': topic,
            'motions': ms,
            'debate_rounds': len(debate['rounds']),
            'vote': vote,
            'resolution': resolution,
        }
        self.records.append(rec)
        self._save_records()
        rec['records_file'] = self._records_path()
        return rec

    # ---------- 落盘 ----------
    def _records_path(self) -> str:
        data_dir = self.config.get('memory_data_dir', 'data')
        return os.path.join(data_dir, 'parliament_records.json')

    def _load_records(self) -> None:
        p = self._records_path()
        if not os.path.isfile(p):
            return
        try:
            with open(p, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                self.records = data
        except (OSError, json.JSONDecodeError):
            self.records = []

    def _save_records(self) -> None:
        try:
            p = self._records_path()
            os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
            tmp = p + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.records, f, ensure_ascii=False, indent=2)
            os.replace(tmp, p)
        except OSError:
            pass

    # ---------- 统计 ----------
    def stats(self) -> Dict[str, Any]:
        return {
            'members': self.members(),
            'sessions': len(self.records),
            'records_file': self._records_path(),
        }
