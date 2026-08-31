# 四档沙盒模式验证：strict / open / full / off
# 覆盖点：
#   1. 模式集合完整性（SANDBOX_MODES 含 full）
#   2. strict 默认行为不回退（echo 放行 / python 拒绝）
#   3. 非法值回落 strict（宁严勿松）
#   4. open 档扩展白名单齐全（解释器 + ffmpeg/tar 等工具链）
#   5. full 档跳过白名单（任意存在命令放行），但黑名单仍然兜底
#   6. off 档全拒
#   7. 环境变量 LINGXI_SANDBOX_MODE 覆盖生效
#   8. RoleDiscussion.run_with_feedback 在 off 档早退（不烧模型调用）
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _ROOT)

from lingxi_engine.sandbox import Sandbox, SandboxError, SANDBOX_MODES
from lingxi_engine.config import get_config

passed = 0
failed = 0


def check(name, cond):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS {name}")
    else:
        failed += 1
        print(f"FAIL {name}")


def expect_deny(sb, cmd):
    try:
        sb.run(cmd)
        return False
    except SandboxError:
        return True


# ---------- 1. 模式集合 ----------
check("SANDBOX_MODES 含 full 且共四档",
      set(SANDBOX_MODES) == {'strict', 'open', 'full', 'off'})

# ---------- 2. strict 默认不回退 ----------
sb = Sandbox()
check("strict 为默认模式", sb.mode == 'strict')
check("strict 放行 echo", sb.run('echo hi')['ok'] and sb.run('echo hi')['stdout'] == 'hi')
check("strict 拒绝 python", expect_deny(sb, 'python --version'))
check("strict 拒绝 rm", expect_deny(sb, 'rm -rf tmp'))

# ---------- 3. 非法值回落 ----------
sb_bad = Sandbox(config={'sandbox_mode': 'yolo'})
check("非法模式值回落 strict", sb_bad.mode == 'strict')

# ---------- 4. open 档扩展白名单 ----------
sb_open = Sandbox(config={'sandbox_mode': 'open'})
allow = {a.lower() for a in sb_open.allow}
need = {'python', 'python3', 'py', 'node', 'npm', 'npx',
        'pip', 'pip3', 'git', 'curl',
        'ffmpeg', 'ffprobe', 'tar', 'unzip', 'gzip', 'ssh', 'scp'}
missing = need - allow
check(f"open 档扩展白名单齐全（缺:{sorted(missing)}）", not missing)

# ---------- 5. full 档：白名单失效，黑名单仍在 ----------
sb_full = Sandbox(config={'sandbox_mode': 'full'})
check("full 模式解析正确", sb_full.mode == 'full')

# 5a. 内建命令照常（原生实现路径不受影响）
r = sb_full.run('echo full-mode-ok')
check("full 档内建命令可用", r['ok'])

# 5b. 白名单外的真实命令放行（hostname 在 Win/Linux 都存在且无害）
try:
    r = sb_full.run('hostname')
    ok = r['ok'] and bool(r['stdout'].strip())
except SandboxError:
    ok = False
check("full 档放行白名单外命令(hostname)", ok)

# 5c. 解释器可跑（full 的核心诉求）
try:
    r = sb_full.run(f'{sys.executable} --version')
    ok = r['ok']
except SandboxError:
    ok = False
check("full 档可执行解释器", ok)

# 5d. 黑名单兜底仍然生效
check("full 档黑名单拦截 rm -rf", expect_deny(sb_full, 'rm -rf data'))
check("full 档黑名单拦截 shutdown", expect_deny(sb_full, 'shutdown /s'))
check("full 档黑名单拦截 find -delete", expect_deny(sb_full, 'find . -delete'))

# ---------- 6. off 档全拒 ----------
sb_off = Sandbox(config={'sandbox_mode': 'off'})
check("off 档拒绝 echo", expect_deny(sb_off, 'echo hi'))
check("off 档拒绝 ls", expect_deny(sb_off, 'ls'))
check("off 档拒绝 python", expect_deny(sb_off, 'python --version'))

# ---------- 7. 环境变量覆盖 ----------
os.environ['LINGXI_SANDBOX_MODE'] = 'full'
cfg_env = get_config()
del os.environ['LINGXI_SANDBOX_MODE']
check("LINGXI_SANDBOX_MODE 环境变量覆盖生效", cfg_env.get('sandbox_mode') == 'full')

# ---------- 8. RoleDiscussion off 档早退 ----------
class _FakeModel:
    def invoke(self, prompt):
        raise AssertionError("off 档不应触发任何模型调用")


class _FakeCore:
    models = {'fake': _FakeModel()}
    memory = None


from lingxi_engine.role_discussion import RoleDiscussion

rd = RoleDiscussion(_FakeCore(), config={'enable_sandbox': True,
                                         'sandbox_mode': 'off'})
res = rd.run_with_feedback('test topic', actions=['echo hi'])
check("off 档 run_with_feedback 早退且不调模型",
      isinstance(res, dict) and 'error' in res and 'off' in res['error'])

# ---------- 汇总 ----------
print(f"\nTOTAL passed={passed} failed={failed}")
sys.exit(0 if failed == 0 else 1)
