# 阶段1闭环·讨论自动沉淀经验 验证脚本
# 覆盖：RoleDiscussion 讨论结束后，蒸馏器自动把发言沉淀为经验卡片写入 Memory
import os
import sys
import tempfile

# 保证能 import 到 lingxi_engine
_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _PKG_ROOT not in sys.path:
    sys.path.insert(0, _PKG_ROOT)

from lingxi_engine import LingXiCore, RoleDiscussion, Memory

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name}")


class FakeModel:
    """模拟模型：按角色返回带"经验/教训/建议"的发言，触发蒸馏。"""

    def __init__(self, role):
        self.role = role

    def invoke(self, context):
        if '质疑者' in context or self.role == '质疑者':
            return '我们应该注意不要把所有能力混在一张优先级表里排序，这是个教训。'
        if '建设者' in context or self.role == '建设者':
            return '建议先立评测体系再补功能，这是关键方法。'
        return '总结：本次讨论的结论是应该优先评测，用户偏好简洁方案。'


def main():
    # 构造 core，注册三个带角色的模型
    core = LingXiCore()
    core.register_model('m1', FakeModel('质疑者'))
    core.register_model('m2', FakeModel('建设者'))
    core.register_model('m3', FakeModel('总结者'))

    # 用临时目录作为记忆存储
    tmp = tempfile.mkdtemp(prefix='lingxi_loop_')
    core.memory = Memory(data_dir=tmp)
    core.config = {'memory_data_dir': tmp}

    # 开启蒸馏自动沉淀
    rd = RoleDiscussion(core, config={'max_rounds': 2, 'distill_auto_store': True})

    # 跑讨论
    results = rd.run_discussion('如何设计灵犀引擎的进化路径')

    # ---------- 1. 讨论正常执行 ----------
    check('讨论产生发言', len(results) > 0)
    check('发言带角色', all('role' in r for r in results))
    check('发言带模型名', all('model' in r for r in results))

    # ---------- 2. 蒸馏自动沉淀 ----------
    check('经验卡片已沉淀', len(core.memory.cards) > 0)
    check('卡片带来源', all(c.get('source') for c in core.memory.cards))
    check('卡片类型合法', all(c.get('type') in ('教训', '偏好', '事实', '方法') for c in core.memory.cards))

    # ---------- 3. 内容确实来自讨论 ----------
    all_content = ' '.join(c['content'] for c in core.memory.cards)
    check('沉淀含讨论经验关键词', ('优先' in all_content) or ('评测' in all_content) or ('教训' in all_content))

    # ---------- 4. 关闭开关则不沉淀 ----------
    tmp2 = tempfile.mkdtemp(prefix='lingxi_loop_off_')
    core2 = LingXiCore()
    core2.register_model('a', FakeModel('质疑者'))
    core2.register_model('b', FakeModel('建设者'))
    core2.memory = Memory(data_dir=tmp2)
    core2.config = {'memory_data_dir': tmp2}
    rd_off = RoleDiscussion(core2, config={'max_rounds': 1, 'distill_auto_store': False})
    rd_off.run_discussion('测试关闭沉淀')
    check('关闭开关不沉淀', len(core2.memory.cards) == 0)

    # ---------- 5. 记忆可检索到沉淀的经验 ----------
    hits = core.memory.search('评测', top_k=5)
    check('沉淀经验可被检索', len(hits) >= 1)

    print(f"\n结果：{PASS} 通过，{FAIL} 失败")
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
