# 最终全量回归：跑全部验证脚本，汇总退出码（结果写入文件，规避 GBK 控制台）
import os, subprocess, sys

# run_all.py 位于 <workspace>/lingxi_engine/tests/，向上三层到 workspace 根
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _ROOT)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'run_all_result.txt')

scripts = [
    ('stage1_memory', 'verify_memory_distill.py'),
    ('stage1_loop',   'verify_stage1_loop.py'),
    ('stage2_meta',   'verify_metacognition.py'),
    # 阶段3沙盒是安全敏感模块，必须纳入回归（此前被遗漏）
    ('stage3_sandbox', 'verify_stage3_sandbox.py'),
    # 配置开关接线验证：防止 enable_* 开关再次沦为"没人读的假开关"
    ('config_switches', 'verify_config_switches.py'),
    # 第二批配置接线：max_rounds_cap/enable_memory/memory_window/enable_voting
    ('config_wiring', 'verify_config_wiring.py'),
    # 分歧信号检测（含否定豁免边界）：20260824 验证发现旧豁免实现
    # 对"不存在分歧"这类共享字符场景失效，修复后补齐回归
    ('roles_divergence', 'verify_roles_divergence.py'),
    # 四档沙盒模式回归：strict/open/full/off + 非法值回落 + 黑名单兜底
    ('sandbox_modes', 'verify_sandbox_modes.py'),
    # 阶段4·A3 自博弈对练：左右互搏闭环 + 评分 + 落盘
    ('stage4_selfplay', 'verify_selfplay.py'),
    # 阶段4·A5-A9 专项：世界模型/好奇探索/离线做梦/多模型议会/宪法护栏
    ('stage4_a5_a9', 'verify_stage4.py'),
    # 阶段4·端到端联动：真实评测数据走 A2→A5→A6→A7→A8→A9 全链路
    ('stage4_e2e', 'stage4_e2e.py'),
    # 阶段5·Swarm 集群执行：拆解/并行/验收/汇总/断点续跑/预算熔断/并发收尾
    ('stage5_swarm', 'verify_stage5_swarm.py'),
]

lines = []
all_ok = True
for label, name in scripts:
    p = os.path.join(_ROOT, 'lingxi_engine', 'tests', name)
    if not os.path.isfile(p):
        lines.append(f"[FAIL] {label}: 脚本缺失 {name}")
        all_ok = False
        continue
    r = subprocess.run([sys.executable, p], capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    tail = r.stdout.strip().splitlines()
    summary = tail[-1] if tail else '(no output)'
    status = 'PASS' if r.returncode == 0 else 'FAIL'
    if r.returncode != 0:
        all_ok = False
        # 失败时附带 stderr 尾部，方便定位
        err_tail = (r.stderr or '').strip().splitlines()[-3:]
        for e in err_tail:
            summary += ' | ' + e
    lines.append(f"[{status}] {label}: exit={r.returncode} | {summary}")

lines.append(f"ALL_OK={all_ok}")
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))
print("written")