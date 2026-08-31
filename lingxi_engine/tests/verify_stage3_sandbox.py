# -*- coding: utf-8 -*-
#
# 验证点：
#   1. Sandbox 白名单放行无害命令（echo）
#   2. Sandbox 拒绝越权命令（rm / shutdown 等）
#   3. Sandbox 安全加固：解释器不放行、shell 注入拒绝、前缀绕过拒绝
#      + 新增：find 危险参数（-delete/-exec）拦截
#   4. Sandbox 执行结果结构化（ok/stdout/exit_code/elapsed）
#   5. feedback_block 生成可注入的环境反馈文本
#   6. run_with_feedback 完整闭环：讨论 → 执行 → 反馈 → 调整（含建议被执行）
#   7. 回归：阶段1/2 仍可用；记忆原子写 + 坏文件备份
import sys
import traceback
import io, os, tempfile

# 仓库根目录 = 本文件向上两级（tests -> 仓库根），跨平台可移植
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"[PASS] {name}")
    else:
        FAIL += 1
        print(f"[FAIL] {name} {detail}")


os.chdir(_REPO_ROOT)

# 1. 沙盒基本执行
from lingxi_engine.sandbox import Sandbox, SandboxError

sb = Sandbox(config={'sandbox_timeout': 5})
r = sb.run('echo hello')
check("echo 放行且成功", r['ok'] and 'hello' in r['stdout'], f"got {r}")
check("执行结果结构化", all(k in r for k in ('ok', 'stdout', 'stderr', 'exit_code', 'elapsed')), f"keys={list(r)}")

# 2. 越权命令拒绝
blocked = False
try:
    sb.run('rm -rf /tmp/x')
except SandboxError:
    blocked = True
check("rm 被拒绝", blocked)

blocked2 = False
try:
    sb.run('shutdown now')
except SandboxError:  # noqa: F841
    blocked2 = True
check("shutdown 被拒绝", blocked2)

# 3.【安全加固】解释器与注入类命令必须全部拒绝
dangerous_cmds = [
    'python -c "import shutil; shutil.rmtree(\'data\')"',   # 解释器任意代码执行
    'python3 --version',
    'node -e "require(\'fs\').unlinkSync(\'x\')"',
    'echo hi && rm -rf /tmp/x',                              # shell 元字符注入（含黑名单词）
    'git push --force origin main',                          # 白名单外首词 + 卸载类标志
    'find . -name "*.tmp" -delete',                          # find 危险参数：删除
    'find . -type f -exec rm {} \\;',                        # find 危险参数：执行外部命令
    'find / -execdir sh -c "x" \\;',                         # find -execdir 变体
]
for cmd in dangerous_cmds:
    ok_blocked = False
    try:
        res = sb.run(cmd)
        # 若未抛异常，也必须是失败结果而非成功执行
        ok_blocked = (not res.get('ok'))
    except SandboxError:
        ok_blocked = True
    check(f"危险命令被拦截: {cmd[:44]}...", ok_blocked)

# 3b. 白名单精确匹配：白名单外首词必须拒
try:
    sb.run('curl http://example.com')
    curl_ok = False
except SandboxError:  # noqa: F841
    curl_ok = True
check("白名单外命令(curl)被拒", curl_ok)

# 3c.【行为契约】无 shell 环境下元字符是惰性文本：
# 管道/重定向不会被解释执行，只会原样出现在输出里——这是特性不是漏洞。
r_pipe = sb.run('echo hi | cat /etc/passwd')
check("元字符惰性透传(不解释执行)", r_pipe['ok']
      and '|' in r_pipe['stdout'] and '/etc/passwd' in r_pipe['stdout'],
      f"got {r_pipe}")

# 4. 超时控制：ping 已在白名单内，可直接模拟长任务
import shutil as _shutil
if _shutil.which('ping'):
    sb_timeout = Sandbox(config={'sandbox_timeout': 1})
    r2 = sb_timeout.run('ping -n 10 127.0.0.1') if os.name == 'nt' else sb_timeout.run('ping -c 10 127.0.0.1')
    check("超时被捕获", (not r2['ok']) and r2['exit_code'] == -1, f"got {r2}")
else:
    check("超时被捕获(环境无ping,跳过)", True)

# 5. feedback_block
fb = sb.feedback_block([r])
check("环境反馈可生成", '环境反馈' in fb and 'echo' in fb, f"fb={fb}")

# 6. 完整闭环：run_with_feedback
from lingxi_engine.core import LingXiCore
from lingxi_engine.role_discussion import RoleDiscussion


class FakeModel:
    def __init__(self, name, role=''):
        self.name = name
        self.role = role

    def invoke(self, prompt):
        # 模拟：若提示含"环境反馈"，返回"目标达成"，否则返回"建议执行 echo hi"
        if '环境反馈' in prompt or '基于以上环境反馈' in prompt:
            return '目标达成'
        return f'[{self.name}] 建议执行命令 echo hi'


core = LingXiCore()
core.register_model('m1', FakeModel('m1', '建设者'))
core.register_model('m2', FakeModel('m2', '质疑者'))
core.register_model('m3', FakeModel('m3', '总结者'))

rd = RoleDiscussion(core, config={'max_rounds': 2})
result = rd.run_with_feedback('测试环境反馈闭环', actions=['echo hi', 'echo done'])

check("闭环返回含讨论", 'discussion' in result and len(result['discussion']) > 0, f"keys={list(result)}")
check("闭环执行了动作", len(result['executions']) == 2 and all(e['ok'] for e in result['executions']), f"exec={result['executions']}")
check("闭环有环境反馈", bool(result['feedback']) and '环境反馈' in result['feedback'])
check("闭环有调整", len(result['adjustments']) >= 1, f"adj={result['adjustments']}")

# 6b.【真闭环】模型给出下一步建议时应被实际执行
class SuggestThenDone(FakeModel):
    """第一轮反馈后给出新命令建议，第二轮确认达成。"""

    def __init__(self):
        super().__init__('s1')
        self.calls = 0

    def invoke(self, prompt):
        self.calls += 1
        if '基于以上环境反馈' in prompt or '环境反馈' in prompt:
            if self.calls <= 2:
                return "未达成。建议执行 `echo next-step`"
            return '目标达成'
        return f"[{self.name}] 建议执行命令 echo hi"


core2 = LingXiCore()
core2.register_model('s1', SuggestThenDone())
rd2 = RoleDiscussion(core2, config={'max_rounds': 1})
result2 = rd2.run_with_feedback('测试真闭环', actions=['echo first'])

adj_actions = [a.get('action') for a in result2['adjustments'] if a.get('action')]
check("调整轮的建议被实际执行", any(a == 'echo next-step' for a in adj_actions), f"actions={adj_actions}")
check("建议的执行结果已记录", all(a.get('execution') is not None for a in result2['adjustments'] if a.get('action')))
check("总执行数包含建议动作", len(result2['executions']) >= 2, f"n={len(result2['executions'])}")

check("沙盒统计可用", rd.sandbox_stats().get('allow_count', 0) > 0, f"stats={rd.sandbox_stats()}")

# 7. 回归：阶段1/2 仍可用
from lingxi_engine.metacognition import Metacognition
meta = Metacognition()
plan = meta.plan('帮我设计一个分布式系统架构，涉及删除数据库风险')
check("阶段2元认知仍工作", plan['allocation']['rounds'] >= 3 and plan['allocation']['reflection'], f"plan={plan['allocation']}")
check("阶段2 plan 含状态监控", 'monitor' in plan, f"keys={list(plan)}")

from lingxi_engine.memory import Memory
tmpdir = tempfile.mkdtemp()
mem = Memory(data_dir=tmpdir)
mem.remember_long('灵犀引擎支持多模型协作')
hits = mem.search('灵犀', top_k=3)
check("阶段1记忆仍工作", len(hits) >= 1, f"hits={len(hits)}")

# 8.【可靠性】记忆原子写入 + 坏文件备份
bad_dir = tempfile.mkdtemp()
with open(os.path.join(bad_dir, 'long_term.json'), 'w', encoding='utf-8') as f:
    f.write('{"broken json":')  # 故意写坏
mem_bad = Memory(data_dir=bad_dir)
check("坏文件不崩溃且置空", mem_bad.long_term == [])
check("坏文件已备份为 .corrupt", os.path.exists(os.path.join(bad_dir, 'long_term.json.corrupt')))
mem_bad.remember_long('恢复后的第一条')
mem_bad2 = Memory(data_dir=bad_dir)
check("修复后可正常持久化读取", len(mem_bad2.long_term) == 1)

print(f"\n===== 阶段3验证：{PASS} 通过, {FAIL} 失败 =====")
sys.exit(1 if FAIL else 0)
