# -*- coding: utf-8 -*-
# 验证 config 假开关接线：enable_metacognition / enable_sandbox 必须真实生效。
# 背景：这两个开关曾长期存在于 DEFAULT_CONFIG 却无任何代码读取（"开关骗人"）。
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _ROOT)
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

from lingxi_engine.role_discussion import RoleDiscussion
from lingxi_engine.config import get_config


class FakeModel:
    def __init__(self, name):
        self.name = name
        self.role = name

    def invoke(self, prompt):
        return '%s 的回复' % self.name

    def reflect(self, own_response, others_responses):
        return '%s 反思后的回复' % self.name


class FakeCore:
    def __init__(self):
        self.models = {
            '模型A': FakeModel('模型A'),
            '模型B': FakeModel('模型B'),
            '模型C': FakeModel('模型C'),
        }


failures = []


def check(name, cond):
    status = 'PASS' if cond else 'FAIL'
    print('[%s] %s' % (status, name))
    if not cond:
        failures.append(name)


# --- 默认开启路径 ---
rd_on = RoleDiscussion(FakeCore(), config={})
check('默认 enable_metacognition=True 时元认知可用', rd_on._get_metacog() is not None)
check('默认 enable_sandbox=True 时沙盒可用', rd_on._get_sandbox() is not None)

# --- 元认知关闭 ---
rd_nometa = RoleDiscussion(FakeCore(), config={'enable_metacognition': False})
check('enable_metacognition=False 时 _get_metacog 返回 None',
      rd_nometa._get_metacog() is None)
plan = rd_nometa.plan_resources('任意任务')
check('元认知关闭时 plan_resources 走默认兜底计划',
      plan.get('allocation', {}).get('reason') == '元认知不可用，使用默认配置')

# --- 沙盒关闭 ---
rd_nosb = RoleDiscussion(FakeCore(), config={'enable_sandbox': False})
check('enable_sandbox=False 时 _get_sandbox 返回 None',
      rd_nosb._get_sandbox() is None)
stats = rd_nosb.sandbox_stats()
check('沙盒关闭时 sandbox_stats 报告不可用', stats.get('available') is False)
out = rd_nosb.run_with_feedback('测试话题', ['echo hi'])
check('沙盒关闭时 run_with_feedback 明确报错并点名开关',
      isinstance(out, dict) and 'error' in out and 'enable_sandbox' in out.get('error', ''))

# --- 环境变量覆盖 ---
os.environ['LINGXI_SANDBOX'] = '0'
cfg = get_config()
check('LINGXI_SANDBOX=0 能把 enable_sandbox 关掉', cfg['enable_sandbox'] is False)
os.environ.pop('LINGXI_SANDBOX', None)

total = 8
print('TOTAL=%d/%d' % (total - len(failures), total))
sys.exit(1 if failures else 0)
