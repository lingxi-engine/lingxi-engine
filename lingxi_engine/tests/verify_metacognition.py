# 阶段2·元认知控制器 + 动态资源分配 验证脚本
# 覆盖：难度评估、资源分配、状态监控、动态接入编排器
import os
import sys
import tempfile

# 脚本位于 lingxi_engine/tests/ 下，向上两级到 workspace 根目录
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _ROOT)

from lingxi_engine.metacognition import Metacognition, DIFFICULTY_LEVELS
from lingxi_engine.role_discussion import RoleDiscussion
from lingxi_engine.memory import Memory


class FakeModel:
    """模拟模型：记录被调用的次数。"""
    def __init__(self, name):
        self.name = name
        self.calls = 0

    def invoke(self, prompt):
        self.calls += 1
        return f"{self.name} 的回复（第{self.calls}次）"


class FakeCore:
    def __init__(self, names):
        self.models = {n: FakeModel(n) for n in names}


passed = 0
failed = 0


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print(f"[PASS] {name}")
    else:
        failed += 1
        print(f"[FAIL] {name}")


# ============ 1. 难度评估 ============
meta = Metacognition()

# 简单任务
ev = meta.evaluate("你好")
check("简单任务难度分低", ev['difficulty'] < 0.25)
check("简单任务等级为'简单'", ev['level'] == '简单')

# 复杂任务
ev2 = meta.evaluate("请设计一个分布式微服务架构，评估性能与扩展性权衡，并给出优化方案")
check("复杂任务难度分高", ev2['difficulty'] >= 0.5)
check("复杂任务等级为'复杂'或'极难'", ev2['level'] in ('复杂', '极难'))

# 高风险任务（涉及删除/生产）
ev3 = meta.evaluate("在生产环境删除数据库并重置所有用户数据，然后上线新系统")
check("高风险任务 risk 分高", ev3['risk'] >= 0.4)
check("高风险任务难度分偏高", ev3['difficulty'] >= 0.5)

# 空任务
check("空任务难度为0", meta.evaluate("")['difficulty'] == 0)

# 三个维度字段齐全
for key in ('complexity', 'ambiguity', 'risk', 'difficulty', 'level'):
    check(f"评估结果包含字段 {key}", key in ev)

# ============ 2. 动态资源分配 ============
# 简单任务：1轮、不反思
alloc = meta.allocate("你好", available_models=3)
check("简单任务分配 1 轮", alloc['rounds'] == 1)
check("简单任务不反思", alloc['reflection'] is False)
check("简单任务记忆检索力度低", alloc['memory_top_k'] <= 2)

# 复杂任务：至少 4 轮、全模型、反思、高记忆检索
alloc2 = meta.allocate("设计分布式系统架构并评估风险，涉及生产部署", available_models=5, max_rounds_cap=5)
check("复杂任务分配多轮", alloc2['rounds'] >= 4)
check("复杂任务反思开启", alloc2['reflection'] is True)
check("复杂任务记忆检索力度高", alloc2['memory_top_k'] >= 6)
check("复杂任务用全部模型", alloc2['use_all_models'] is True)

# 风险特判：低复杂度但高风险 → 强制反思 + 提高轮次
alloc3 = meta.allocate("删除生产数据库", available_models=3)
check("高风险任务强制反思", alloc3['reflection'] is True)
check("高风险任务轮次至少3", alloc3['rounds'] >= 3)

# 分配计划含 reason（可解释性）
check("分配计划含 reason", 'reason' in alloc2 and len(alloc2['reason']) > 0)

# 轮次上限约束
alloc4 = meta.allocate("极难任务" * 20, available_models=10, max_rounds_cap=3)
check("轮次不超过上限", alloc4['rounds'] <= 3)

# ============ 3. 自我状态监控 ============
mon = meta.monitor(context_length=100, token_budget=1000, available_models=3,
                   memory_stats={'short': 5, 'long': 10, 'cards': 8})
check("正常状态健康度>=0.8", mon['health'] >= 0.8)
check("正常状态 status 为'健康'", mon['status'] == '健康')

mon2 = meta.monitor(context_length=900, token_budget=1000, available_models=0,
                    memory_stats={'short': 5, 'long': 10, 'cards': 0})
check("紧张状态健康度降低", mon2['health'] < 0.8)
check("紧张状态有告警", len(mon2['warnings']) > 0)
check("无模型时 status 为'告急'或'紧张'", mon2['status'] in ('告急', '紧张'))

# ============ 4. 元认知接入编排器（动态资源分配落地） ============
core = FakeCore(['模型A', '模型B', '模型C'])
disc = RoleDiscussion(core, config={'enable_consensus': False})  # 关收敛，看完整轮次

# 简单任务 → 应只跑 1 轮（3模型各1次 = 3条）
plan = disc.plan_resources("你好")
check("简单任务元认知计划轮次为1", plan['allocation']['rounds'] == 1)
results = disc.run_discussion("你好", plan=plan)
check("简单任务实际只产生1轮记录", len(results) == 3)
check("简单任务每个模型只调用1次", all(m.calls == 1 for m in core.models.values()))

# 重置调用计数，测复杂任务
for m in core.models.values():
    m.calls = 0
plan2 = disc.plan_resources("请设计分布式系统架构并评估风险")
check("复杂任务元认知计划轮次>=3", plan2['allocation']['rounds'] >= 3)
results2 = disc.run_discussion("复杂任务", plan=plan2)
expected = plan2['allocation']['rounds'] * 3
check("复杂任务实际产生多轮记录", len(results2) == expected)
check("复杂任务模型被多次调用", any(m.calls > 1 for m in core.models.values()))

# 计划里带 evaluation 和 allocation 两层
check("plan 含 evaluation", 'evaluation' in plan)
check("plan 含 allocation", 'allocation' in plan)

# ============ 5. 记忆注入（阶段1+阶段2融合） ============
tmpdir = tempfile.mkdtemp()
mem = Memory(data_dir=tmpdir)
mem.remember_long("用户偏好简洁的回答，不要冗长")
mem.remember_long("分布式系统要注意数据一致性")

# 直接验证：用一个能记录 prompt 的模型
class RecordingModel:
    def __init__(self):
        self.last_prompt = ""
    def invoke(self, prompt):
        self.last_prompt = prompt
        return "ok"

rm = RecordingModel()
class CoreOne:
    def __init__(self):
        self.models = {'模型A': rm}
core3 = CoreOne()
disc3 = RoleDiscussion(core3, config={'enable_consensus': False, 'memory': mem, 'memory_top_k': 5})
disc3.run_discussion("设计分布式系统", plan=disc3.plan_resources("设计分布式系统"))
check("记忆注入后 prompt 含历史经验内容", "历史经验" in rm.last_prompt)
check("记忆注入后 prompt 含具体经验", "数据一致性" in rm.last_prompt)


# ============ 汇总 ============
print(f"\n===== 结果: {passed} 通过, {failed} 失败 =====")
sys.exit(1 if failed else 0)
