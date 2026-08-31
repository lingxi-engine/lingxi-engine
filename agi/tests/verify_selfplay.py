# -*- coding: utf-8 -*-
"""验证 A3 自博弈对练 run_selfplay：

  1. 调用方种子 → 左右互搏（作答→批评→修正）→ 改进判定 + 评分
  2. 敷衍修正（短回复无关键词）→ 不判改进、低分
  3. 无种子 + 错题本不可用 → 合成种子兜底，不崩溃
  4. selfplay_max_rounds 配置驱动轮次上限（critic 调用次数）
  5. 结果落盘 selfplay_records.json（临时目录）
  6. 批评者优先选"质疑者"角色模型
"""
import json
import os
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _ROOT)
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

from lingxi_engine.role_discussion import RoleDiscussion


class FakeModel:
    """可控模型：按 prompt 关键词路由到 answer/critique/revise 脚本。"""

    def __init__(self, name, script=None):
        self.name = name
        self.script = script or {}
        self.calls = []

    def invoke(self, prompt):
        self.calls.append(prompt)
        if '【修正】' in prompt:
            return self.script.get(
                'revise',
                '修正后的回答：补充引用来源，明确列出数据依据，避免模糊表述。')
        if '【自我批评】' in prompt:
            return self.script.get(
                'critique',
                '你的回答缺少来源且表述模糊，需要补充具体依据并修正措辞。')
        return self.script.get('answer', '这是对错题的回答，尽量给出准确信息。')


class FakeCore:
    def __init__(self, models):
        self.models = models


failures = []
CHECKS = []


def check(name, cond):
    CHECKS.append(bool(cond))
    print('[%s] %s' % ('PASS' if cond else 'FAIL', name))
    if not cond:
        failures.append(name)


SEED = [{
    'problem': '请解释 TCP 三次握手的过程',
    'score': 40.0,
    'issues': [{
        'type': 'accuracy',
        'description': '缺少来源，表述模糊',
        'fix': '补充引用来源 明确列出数据依据',
    }],
    'model': 'A',
}]

TMP = tempfile.mkdtemp(prefix='lx_selfplay_')


# ========== 1. 正常对练：修正稿吸收 fix 关键词 → 改进 ==========
m1 = FakeModel('A', {
    'revise': '修正后的回答：补充引用来源，明确列出数据依据，'
              '三次握手依次是 SYN、SYN-ACK、ACK。',
})
rd1 = RoleDiscussion(FakeCore({'A': m1}), {
    'distill_auto_store': False,
    'memory_data_dir': TMP,
})
stats1 = rd1.run_selfplay(samples=SEED, max_rounds=2)
rec1 = stats1['records'][0]
check('对练产出记录', len(stats1['records']) == 1)
check('吸收 fix 关键词 → 判定为改进', rec1['improved'] is True)
check('自博弈分高于原分', rec1['selfplay_score'] > rec1['original_score'])
check('最终答案为修正稿', 'SYN' in rec1['final_answer'])
check('记录含批评与修正轮次',
      any(t['type'] == 'critique' for t in rec1['turns'])
      and any(t['type'] == 'revise' for t in rec1['turns']))

# ========== 2. 敷衍修正 → 不改进 + 低分 ==========
m2 = FakeModel('A', {'revise': '嗯嗯好的'})
rd2 = RoleDiscussion(FakeCore({'A': m2}), {
    'distill_auto_store': False,
    'memory_data_dir': TMP,
})
stats2 = rd2.run_selfplay(samples=SEED, max_rounds=2)
rec2 = stats2['records'][0]
check('敷衍修正不判改进', rec2['improved'] is False)
check('敷衍修正低分（<60）', rec2['selfplay_score'] < 60)

# ========== 3. 无种子 + 错题本不可用 → 合成兜底 ==========
# 注意：不能指向"不存在的文件"，因为 MistakeBook._resolve_path() 会继续
# 探测并命中引擎真实评测文件（data/evaluation-records.json，141 条），
# 那样走的是错题本而非合成兜底。这里显式指向一个"存在但无有效记录"
# （内容为 {}，非 list）的空 JSON → 空错题本 → 触发合成种子兜底。
m3 = FakeModel('A')
empty_eval = os.path.join(TMP, 'empty_eval.json')
with open(empty_eval, 'w', encoding='utf-8') as f:
    json.dump({}, f)
rd3 = RoleDiscussion(FakeCore({'A': m3}), {
    'distill_auto_store': False,
    'eval_records_path': empty_eval,
    'memory_data_dir': TMP,
})
stats3 = rd3.run_selfplay(topic='测试话题', max_rounds=1)
check('合成种子兜底不崩溃', stats3['seeds_used'] >= 1)
check('来源标记为合成', '合成' in stats3['source'])
check('合成题也有对练记录', len(stats3['records']) >= 1)

# ========== 4. config.selfplay_max_rounds 驱动轮次 ==========
m4 = FakeModel('A')
rd4 = RoleDiscussion(FakeCore({'A': m4}), {
    'distill_auto_store': False,
    'selfplay_max_rounds': 3,
    'memory_data_dir': TMP,
})
stats4 = rd4.run_selfplay(samples=SEED)  # 不显式传 max_rounds
rec4 = stats4['records'][0]
critic_calls = sum(1 for t in rec4['turns'] if t['type'] == 'critique')
check('默认轮次取自 config（=3）', critic_calls == 3)

# ========== 5. 落盘 selfplay_records.json ==========
target5 = os.path.join(TMP, 'selfplay_records.json')
check('selfplay_records.json 已落盘', os.path.isfile(target5))
with open(target5, encoding='utf-8') as f:
    payload5 = json.load(f)
check('落盘含对练记录', len(payload5.get('records', [])) >= 1)
check('落盘含统计（改进数）', 'improved_count' in payload5.get('stats', {}))

# ========== 6. 批评者优先选"质疑者"角色模型 ==========
# 注册顺序：A→质疑者，B→建设者。批评应落在质疑者 A 身上。
ma, mb = FakeModel('A'), FakeModel('B')
rd6 = RoleDiscussion(FakeCore({'A': ma, 'B': mb}), {
    'distill_auto_store': False,
    'memory_data_dir': TMP,
})
stats6 = rd6.run_selfplay(samples=SEED, max_rounds=1)
rec6 = stats6['records'][0]
critiques = [t for t in rec6['turns'] if t['type'] == 'critique']
check('批评者模型为质疑者(A)', critiques and critiques[0]['model'] == 'A')
check('批评 prompt 走了质疑者通道',
      critiques and any('【自我批评】' in c for c in ma.calls))

# ========== 汇总 ==========
total = len(CHECKS)
print('\nTOTAL=%d/%d' % (total - len(failures), total))
sys.exit(1 if failures else 0)
