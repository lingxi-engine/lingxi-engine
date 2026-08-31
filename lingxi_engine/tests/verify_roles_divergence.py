# 角色分歧信号检测回归：重点覆盖否定语境豁免（此前零测试覆盖导致缺陷漏网）
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from lingxi_engine.roles import has_divergence, assign_roles, get_role_instruction

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'[PASS] {name}')
    else:
        FAIL += 1
        print(f'[FAIL] {name}')


# ---- 否定豁免：不应判为分歧 ----
check('我不存在分歧的看法 -> 豁免（共享字符重叠场景）',
      not has_divergence(['我不存在分歧的看法']))
check('没有反对意见 -> 豁免',
      not has_divergence(['大家没有反对意见']))
check('无异议 -> 豁免',
      not has_divergence(['对方案A无异议']))
check('并非不同意 -> 豁免',
      not has_divergence(['我并不是不同意']))
check('不存在反对的声音 -> 豁免',
      not has_divergence(['目前不存在反对的声音']))

# ---- 真实分歧：必须拦截 ----
check('我反对这个方案 -> 分歧',
      has_divergence(['我反对这个方案']))
check('我有不同看法 -> 分歧',
      has_divergence(['我有不同的看法，不同意该结论']))
check('远距否定词不得豁免：毫无根据的存在分歧',
      has_divergence(['你的质疑毫无根据的存在分歧']))
check('英文 disagree -> 分歧',
      has_divergence(['I disagree with this approach']))
check('多条发言任一命中即算分歧',
      has_divergence(['方案不错', '存在分歧，需要继续讨论']))

# ---- 空输入与角色函数冒烟 ----
check('空列表不算分歧', not has_divergence([]))
check('None 不算分歧', not has_divergence(None))
check('未知角色回退通用指令', '通用协作' in get_role_instruction('不存在的角色'))
rm = assign_roles(['m1', 'm2', 'm3', 'm4'])
check('角色轮转分配 4 模型', rm == {'m1': '质疑者', 'm2': '建设者',
                                    'm3': '总结者', 'm4': '质疑者'})

# ---- 收敛检测集成：豁免修复后应能正确收敛 ----
from lingxi_engine.consensus import check_consensus
check('收敛检测：否定表述 + 高相似 => 收敛',
      check_consensus(['我不存在分歧的看法，方案A可行',
                       '我不存在分歧的看法，方案A可行'],
                      summarizer=None))

print(f'===== 分歧信号检测：{PASS} 通过, {FAIL} 失败 =====')
sys.exit(0 if FAIL == 0 else 1)
