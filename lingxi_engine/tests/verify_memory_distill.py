# 阶段1·记忆蒸馏 验证脚本
# 覆盖：Memory 三层记忆写入/衰减/检索/持久化，Distiller 启发式蒸馏/沉淀
import os
import sys
import tempfile

# 保证能 import 到 lingxi_engine：
# 脚本位于 <workspace>/lingxi_engine/tests/，包根在 <workspace>/
# 因此向上三层（tests -> lingxi_engine -> workspace）即包根
_PKG_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if _PKG_ROOT not in sys.path:
    sys.path.insert(0, _PKG_ROOT)

from lingxi_engine import Memory, Distiller, CARD_TYPES

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


def main():
    # 用临时目录，避免污染真实 data
    tmp = tempfile.mkdtemp(prefix='lingxi_mem_')
    mem = Memory(data_dir=tmp)

    # ---------- 1. 三层记忆写入 ----------
    mem.remember_short('用户喜欢简洁的回答')
    mem.remember_long('项目名是灵犀引擎')
    mem.add_card({'content': '多轮讨论应先明确收敛标准', 'type': '方法', 'source': '测试'})
    check('短期记忆写入', len(mem.short_term) == 1)
    check('长期记忆写入', len(mem.long_term) == 1)
    check('经验卡片写入', len(mem.cards) == 1)
    check('卡片类型合法', mem.cards[0]['type'] in CARD_TYPES)

    # ---------- 2. 持久化 ----------
    mem2 = Memory(data_dir=tmp)
    check('长期记忆持久化', len(mem2.long_term) == 1)
    check('经验卡片持久化', len(mem2.cards) == 1)

    # ---------- 3. 检索 ----------
    hits = mem.search('灵犀', top_k=5)
    check('关键词检索命中', len(hits) >= 1 and '灵犀' in hits[0]['content'])

    # ---------- 4. 衰减 ----------
    decay = Memory._decay(0, 0)  # 同一时刻权重 1
    check('零时差衰减=1', abs(decay - 1.0) < 1e-9)
    import time
    decay_old = Memory._decay(time.time() - 86400, time.time())  # 1 天前，半衰期 1 天
    check('一天后衰减≈0.5', abs(decay_old - 0.5) < 0.01)

    # ---------- 5. 短期记忆清空 ----------
    mem.clear_short()
    check('短期记忆清空', len(mem.short_term) == 0)

    # ---------- 6. Distiller 启发式蒸馏 ----------
    records = [
        '我们应该先立评测体系再补功能。',
        '注意不要把所有能力混在一张优先级表里排序。',
        '用户偏好简洁的回答方式。',
        '今天天气不错。',  # 无触发词，不应被抽为经验
    ]
    d = Distiller(store=mem)
    cards = d.distill(records, source='测试讨论')
    check('蒸馏出经验卡片', len(cards) >= 3)
    check('过滤无触发词句子', all('天气' not in c['content'] for c in cards))
    check('卡片带来源', all(c.get('source') for c in cards))
    # 类型分类
    types = {c['type'] for c in cards}
    check('分类覆盖教训/方法/偏好', '教训' in types or '方法' in types)

    # ---------- 7. 自动沉淀 ----------
    stored = d.distill_and_store(records, source='测试讨论-沉淀')
    check('自动沉淀返回卡片', len(stored) >= 3)
    check('沉淀后卡片数增加', len(mem.cards) >= 1 + len(stored))

    # ---------- 8. 统计 ----------
    s = mem.stats()
    check('stats 含三层计数', 'short' in s and 'long' in s and 'cards' in s)

    print(f"\n结果：{PASS} 通过，{FAIL} 失败")
    return 0 if FAIL == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
