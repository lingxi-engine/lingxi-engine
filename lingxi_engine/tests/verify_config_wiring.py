# -*- coding: utf-8 -*-
"""验证第二批死配置接线：max_rounds_cap / enable_memory / memory_window / enable_voting。

背景：审计发现这四个配置存在于 DEFAULT_CONFIG 却无人消费（temperature 已删除）。
本脚本逐项验证它们现在真实生效。
"""
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _ROOT)
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

from lingxi_engine.config import DEFAULT_CONFIG
from lingxi_engine.role_discussion import RoleDiscussion
from lingxi_engine.orchestrator import Orchestrator
from lingxi_engine.agent import collect_votes
from lingxi_engine.core import LingXiCore


class FakeModel:
    """可控投票模型：vote 返回预设选项，invoke 返回固定文本。"""

    def __init__(self, name):
        self.name = name
        self.vote_choice = None
        self.last_context = ''

    def invoke(self, prompt):
        self.last_context = prompt
        return '%s 的回复' % self.name

    def vote(self, options):
        if self.vote_choice is None:
            return None
        for opt in options:
            if opt.startswith(self.vote_choice):
                return opt
        return None


class FakeCore:
    def __init__(self, n=3):
        self.models = {('模型%s' % chr(ord('A') + i)): FakeModel('模型%s' % chr(ord('A') + i))
                       for i in range(n)}


failures = []
CHECKS = []


def check(name, cond):
    CHECKS.append(bool(cond))
    print('[%s] %s' % ('PASS' if cond else 'FAIL', name))
    if not cond:
        failures.append(name)


# ========== 1. temperature 已删除 ==========
check('DEFAULT_CONFIG 不再包含 temperature', 'temperature' not in DEFAULT_CONFIG)

# ========== 2. max_rounds_cap 接线 ==========
rd_cap = RoleDiscussion(FakeCore(), config={
    'enable_metacognition': False,
})
plan = rd_cap.plan_resources('任务')
check('元认知关闭时 plan 走兜底（cap 无副作用）',
      plan['allocation']['reason'] == '元认知不可用，使用默认配置')

from lingxi_engine.metacognition import Metacognition
meta = Metacognition()
alloc_capped = meta.allocate('设计分布式系统架构并评估风险', available_models=5,
                             max_rounds_cap=2)
check('max_rounds_cap=2 时复杂任务轮次被压到 2', alloc_capped['rounds'] == 2)
alloc_uncapped = meta.allocate('设计分布式系统架构并评估风险', available_models=5,
                               max_rounds_cap=5)
check('max_rounds_cap=5 时复杂任务轮次为 4', alloc_uncapped['rounds'] == 4)

# RoleDiscussion.plan_resources 把 config 的 cap 传给 meta.plan
rd_cap2 = RoleDiscussion.__new__(RoleDiscussion)
rd_cap2.core = FakeCore()
rd_cap2.config = {'max_rounds_cap': 2}
rd_cap2.max_rounds = 3
rd_cap2.memory_top_k = 5
rd_cap2.enable_reflection = True
rd_cap2._metacog = Metacognition()
plan2 = rd_cap2.plan_resources('设计分布式系统架构并评估风险')
check('plan_resources 尊重 config.max_rounds_cap',
      plan2['allocation']['rounds'] <= 2)

# ========== 3. enable_memory / memory_window 接线（Orchestrator）==========
core_mem = LingXiCore()
m1, m2 = FakeModel('A'), FakeModel('B')
core_mem.register_model('A', m1)
core_mem.register_model('B', m2)

orch_full = Orchestrator(core_mem, {'max_rounds': 3, 'enable_reflection': False,
                                    'enable_consensus': False})
res = orch_full.run_discussion('话题X')
check('记忆开启时第2轮上下文含历史讨论',
      '之前的讨论' in m1.last_context)

orch_nomem = Orchestrator(core_mem, {'max_rounds': 3, 'enable_reflection': False,
                                     'enable_consensus': False,
                                     'enable_memory': False})
orch_nomem.run_discussion('话题Y')
check('enable_memory=False 时上下文只有话题本身',
      '之前的讨论' not in m1.last_context and '话题Y' in m1.last_context)

orch_win1 = Orchestrator(core_mem, {'max_rounds': 3, 'enable_reflection': False,
                                    'enable_consensus': False,
                                    'memory_window': 1})
orch_win1.run_discussion('话题Z')
check('memory_window=1 时上下文最多含 1 条历史',
      m1.last_context.count('[A]:') + m1.last_context.count('[B]:') <= 1)

# ========== 4. enable_voting 真实投票（RoleDiscussion）==========
core_v = LingXiCore()
va, vb, vc = FakeModel('甲'), FakeModel('乙'), FakeModel('丙')
core_v.register_model('甲', va)
core_v.register_model('乙', vb)
core_v.register_model('丙', vc)
# 甲乙投给"丙的发言"，丙弃权 → 丙的发言应胜出
va.vote_choice = '丙'
vb.vote_choice = '丙'

rd_vote = RoleDiscussion(core_v, {'max_rounds': 2, 'enable_reflection': False,
                                  'distill_auto_store': False})
rd_vote.run_discussion('投票测试话题')
vr = rd_vote.vote_result
check('投票结果存在且结构完整',
      isinstance(vr, dict) and set(vr.keys()) == {'winner', 'tally', 'ballots'})
check('得票最高者胜出', vr is not None and vr['winner'].startswith('丙'))
check('票数正确（2 票）', vr is not None and vr['tally'][vr['winner']] == 2)
check('弃权者不出现在选票中', vr is not None and '丙' not in vr['ballots'])

# 关闭开关则不投票
rd_novote = RoleDiscussion(core_v, {'max_rounds': 1, 'enable_reflection': False,
                                    'enable_voting': False,
                                    'distill_auto_store': False})
rd_novote.run_discussion('投票测试话题')
check('enable_voting=False 时不产生投票结果', rd_novote.vote_result is None)

# ========== 5. collect_votes 边界 ==========
r0 = collect_votes({}, ['a', 'b'])
check('无投票人时 winner=None', r0['winner'] is None)


class NoVote:
    pass


r1 = collect_votes({'x': NoVote()}, ['a', 'b'])
check('无 vote 方法的对象被跳过', r1['winner'] is None and r1['ballots'] == {})


class BrokenVoter:
    def vote(self, options):
        raise RuntimeError('boom')


r2 = collect_votes({'x': BrokenVoter(), 'y': FakeModel('y')}, ['a', 'b'])
check('投票异常视为弃权不崩溃', r2['ballots'] == {})

total = len(CHECKS)
print('\nTOTAL=%d/%d' % (total - len(failures), total))
sys.exit(1 if failures else 0)
