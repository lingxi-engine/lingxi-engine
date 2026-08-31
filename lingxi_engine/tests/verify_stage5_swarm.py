# 阶段5·Swarm 集群执行回归测试
# 覆盖：全链路 / 断点续跑 / 预算熔断 / 拆解降级 / 验收整改循环 / 确定性熔断 / 检查点原子性 / 预算单元
# T6 设计说明：swarm_max_workers=1 强制串行——任务A先执行并记账（约105 > 预算80），
# 任务B在同一轮 _dispatch 内部触发熔断、标回 pending，A 的结果保留。
# 不依赖线程时序（旧版 sleep 竞态已移除），确定性触发"派发内部熔断收尾"路径。
import io
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from lingxi_engine import (
    SwarmOrchestrator, CheckpointStore, TokenBudget, BudgetExceededError,
    Verifier, Verification, __version__
)

PASS, FAIL = 0, 0


def ok(cond, label):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {label}")
    else:
        FAIL += 1
        print(f"[FAIL] {label}")
        raise AssertionError(label)


class FakeModel:
    """可编程假模型：按提示词关键词返回规划/验收/执行内容。"""

    def __init__(self, name, plan=None, verify_pass=True, plan_raw=None):
        self.name = name
        self.role = 'worker'
        self.plan = plan
        self.plan_raw = plan_raw
        self.verify_pass = verify_pass
        self.calls = 0

    def invoke(self, prompt):
        self.calls += 1
        p = str(prompt)
        if '任务规划师' in p:
            if self.plan_raw is not None:
                return self.plan_raw
            return json.dumps(self.plan, ensure_ascii=False)
        if '验收官' in p:
            return json.dumps({'passed': self.verify_pass, 'feedback': 'ok'},
                              ensure_ascii=False)
        return '关于任务的实质产出：结论A+数据B。'


PLAN2 = [
    {"title": "调研市场", "description": "收集数据", "depends": []},
    {"title": "写报告", "description": "汇总成文", "depends": [1]},
]


def make_core(n=2, **kw):
    core = type('C', (), {'models': {}})()
    core.models = {
        f'm{i}': FakeModel(f'm{i}', plan=PLAN2, **kw) for i in range(1, n + 1)
    }
    return core


SMOKE_DIR = os.path.join('data', 'task_state_stage5_test')


def clean():
    shutil.rmtree(SMOKE_DIR, ignore_errors=True)


# T1 全链路：拆解→并行→验收→汇总
clean()
core = make_core(2)
sw = SwarmOrchestrator(core, {'enable_checkpoint': True,
                              'task_state_dir': SMOKE_DIR,
                              'swarm_max_workers': 2, 'token_budget': None})
r = sw.run('做一份完整的市场调研报告', run_id='t1')
ok(r['resumed'] is False, 'T1.1 fresh run not resumed')
ok(len(r['tasks']) == 2, 'T1.2 two tasks planned')
ok(r['tasks'][0]['status'] == 'done' and r['tasks'][1]['status'] == 'done', 'T1.3 all done')
ok(r['tasks'][1]['depends'] == [r['tasks'][0]['id']], 'T1.4 dependency id mapping')
ok(r['aborted'] is False and r['summary'], 'T1.5 completed with summary')

# T2 断点续跑：done 不重跑 + 终态清档 + 崩溃 running 重置（Bug#1）
clean()
cp = os.path.join(SMOKE_DIR, 'cp_t2.json')
os.makedirs(SMOKE_DIR, exist_ok=True)
json.dump({'version': 1, 'run_id': 't2', 'updated_at': 0, 'state': {
    'topic': '长任务', 'budget': {}, 'tasks': [
        {'id': 'aaa', 'title': '第一步', 'description': '', 'depends': [],
         'status': 'done', 'result': '已完成产出', 'attempts': 0, 'error': None},
        {'id': 'bbb', 'title': '第二步', 'description': '', 'depends': ['aaa'],
         'status': 'pending', 'result': 'stale-old-result', 'attempts': 0, 'error': None},
    ]}}, open(cp, 'w', encoding='utf-8'))
r2 = sw.run('长任务', run_id='t2')
ok(r2['resumed'] is True, 'T2.1 resumed from checkpoint')
ok(r2['tasks'][0]['result'] == '已完成产出', 'T2.2 done task not re-run')
ok(r2['tasks'][1]['status'] == 'done', 'T2.3 pending task executed after resume')
ok(not os.path.exists(cp), 'T2.4 checkpoint cleared after finish')

# T2b 崩溃恢复：检查点里的 running 状态必须重置为 pending（Bug#1 回归）
clean()
cp2 = os.path.join(SMOKE_DIR, 'cp_t2b.json')
os.makedirs(SMOKE_DIR, exist_ok=True)
json.dump({'version': 1, 'run_id': 't2b', 'updated_at': 0, 'state': {
    'topic': '崩溃任务', 'budget': {}, 'tasks': [
        {'id': 'ccc', 'title': '崩溃时正在跑', 'description': '', 'depends': [],
         'status': 'running', 'result': None, 'attempts': 0, 'error': None},
        {'id': 'ddd', 'title': '后续任务', 'description': '', 'depends': ['ccc'],
         'status': 'pending', 'result': None, 'attempts': 0, 'error': None},
    ]}}, open(cp2, 'w', encoding='utf-8'))
r2b = sw.run('崩溃任务', run_id='t2b')
ok(r2b['resumed'] is True, 'T2b.1 resumed from stale-running checkpoint')
ok(r2b['tasks'][0]['status'] == 'done', 'T2b.2 stale running reset and executed')
ok(r2b['tasks'][1]['status'] == 'done', 'T2b.3 downstream task completed')

# T3 预算熔断中止
clean()
tiny = SwarmOrchestrator(core, {'enable_checkpoint': False, 'token_budget': 10,
                                'task_state_dir': SMOKE_DIR})
r3 = tiny.run('另一个任务', run_id='t3')
ok(r3['aborted'] is True, 'T3.1 aborted on tiny budget')
ok(r3['budget_snapshot']['used'] > 0, 'T3.2 usage recorded before abort')

# T4 拆解失败降级为单任务
clean()
core2 = type('C', (), {'models': {}})()
core2.models = {'bad': FakeModel('bad', plan_raw='我不会输出JSON')}
sw2 = SwarmOrchestrator(core2, {'enable_checkpoint': False, 'task_state_dir': SMOKE_DIR})
r4 = sw2.run('拆不动的任务', run_id='t4')
ok(len(r4['tasks']) == 1 and r4['tasks'][0]['status'] == 'done',
   'T4.1 plan-fallback single task done')

# T5 验收整改循环（第一次不通过→整改→通过）
clean()


class FlipVerifier(Verifier):
    def __init__(self, core, config):
        super().__init__(core, config)
        self.flips = 0

    def verify(self, task, result, executor=None, budget=None):
        self.flips += 1
        return Verification(self.flips >= 2, '请补充数据' if self.flips < 2 else '')


sw3 = SwarmOrchestrator(core, {'enable_checkpoint': False, 'task_state_dir': SMOKE_DIR})
sw3.verifier = FlipVerifier(core, sw3.config)
r5 = sw3.run('需要整改的任务', run_id='t5')
ok(r5['tasks'][0]['status'] == 'done' and r5['tasks'][0]['attempts'] == 1,
   'T5.1 retry loop converges (attempts=1)')

# T6 确定性熔断：串行派发下 A 记账必超预算，B 在派发内部熔断标回 pending
clean()


class SerialAbort(FakeModel):
    """单 worker 串行场景：执行产出固定大小，预算必然在 B 执行前耗尽。"""

    def invoke(self, prompt):
        p = str(prompt)
        if '任务规划师' in p:
            return json.dumps([
                {"title": "A", "description": "", "depends": []},
                {"title": "B", "description": "", "depends": []},
            ], ensure_ascii=False)
        if '验收官' in p:
            return '{"passed": true, "feedback": "ok"}'
        return '产出' * 30  # 约 60 token，预算 80 时 A 记账后即超


core6 = type('C', (), {'models': {}})()
core6.models = {'w': SerialAbort('w')}
sw6 = SwarmOrchestrator(core6, {'enable_checkpoint': False, 'token_budget': 80,
                                'task_state_dir': SMOKE_DIR, 'swarm_max_workers': 1})
r6 = sw6.run('并发熔断', run_id='t6')
ok(r6['aborted'] is True, 'T6.1 aborted deterministically')
ok(any(t['status'] == 'done' for t in r6['tasks']), 'T6.2 sibling result preserved')
ok(r6['summary'], 'T6.3 summary still produced after abort')
ok(r6['budget_snapshot']['used'] > 0, 'T6.4 usage recorded')
print(f"    (T6 detail: {[t['status'] for t in r6['tasks']]}, used={r6['budget_snapshot']['used']})")

# T6b 级联跳过：C←B←A 且 C 排在 B 前面（Bug#2 回归：间接依赖必须全部跳过）
clean()
cp6b = os.path.join(SMOKE_DIR, 'cp_t6b.json')
os.makedirs(SMOKE_DIR, exist_ok=True)
json.dump({'version': 1, 'run_id': 't6b', 'updated_at': 0, 'state': {
    'topic': '级联跳过', 'budget': {}, 'tasks': [
        # 注意：C 故意排在 B 前面（列表顺序与依赖顺序相反）
        {'id': 'cc', 'title': 'C 间接依赖', 'description': '', 'depends': ['bb'],
         'status': 'pending', 'result': None, 'attempts': 0, 'error': None},
        {'id': 'bb', 'title': 'B 直接依赖', 'description': '', 'depends': ['aa'],
         'status': 'pending', 'result': None, 'attempts': 0, 'error': None},
        {'id': 'aa', 'title': 'A 失败源', 'description': '', 'depends': [],
         'status': 'failed', 'result': None, 'attempts': 1, 'error': 'boom'},
    ]}}, open(cp6b, 'w', encoding='utf-8'))
r6b = sw.run('级联跳过', run_id='t6b')
ok(r6b['resumed'] is True, 'T6b.1 resumed')
ok(r6b['tasks'][0]['status'] == 'skipped' and r6b['tasks'][1]['status'] == 'skipped',
   'T6b.2 cascade skip reaches fixpoint regardless of list order')
ok(r6b['tasks'][2]['status'] == 'failed', 'T6b.3 failed source untouched')

# T7 检查点原子性：tmp 残留不破坏读取
clean()
store = CheckpointStore(state_dir=SMOKE_DIR)
store.save('t7', {'x': 1})
ok(store.load('t7') == {'x': 1}, 'T7.1 save/load roundtrip')
open(os.path.join(SMOKE_DIR, 'cp_t7.json.tmp'), 'w').write('garbage')
ok(store.load('t7') == {'x': 1}, 'T7.2 tmp file does not corrupt load')
store.clear('t7')
ok(store.load('t7') is None, 'T7.3 clear works')

# T8 预算单元
b = TokenBudget(100)
b.add(60); b.add(-5); b.add(30)
ok(b.used == 90 and b.remaining == 10, 'T8.1 add/negative-ignored/remaining')
b.add(20)
try:
    b.check()
    ok(False, 'T8.2 should raise')
except BudgetExceededError as e:
    ok(e.used == 110 and e.budget == 100, 'T8.2 exception carries used/budget')

# T9 既有模块零破坏
from lingxi_engine.orchestrator import Orchestrator
from lingxi_engine.agent import Agent, collect_votes
from lingxi_engine.consensus import check_consensus
from lingxi_engine.config import get_config
cfg = get_config()
ok(cfg['swarm_max_workers'] == 4 and cfg['enable_checkpoint'] is True
   and cfg['enable_verifier'] is True, 'T9.1 stage5 config keys wired')
ok('SwarmOrchestrator' in __import__('lingxi_engine').__all__, 'T9.2 exports intact')

clean()
print()
print(f"===== 阶段5验证：{PASS} 通过，{FAIL} 失败 =====")
sys.exit(0 if FAIL == 0 else 1)