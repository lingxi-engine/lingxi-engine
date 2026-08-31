# 宪法护栏（A9）——自改进动作的参数旋钮 + 回滚预案
#
# 对应 AGI 进化路线图【阶段4·让它"进化"】P0 行动项 A9：
#   "宪法护栏——给自改进装刹车：参数旋钮 + 回滚预案"
#
# 核心思想：让引擎自我进化，但不能"裸奔进化"。
#   自改进动作（改配置、改代码、改记忆、执行命令）在放行前必须过护栏：
#     1. 动作分级：read（只读，安全）/ write（写文件，需谨慎）/ exec（执行，高风险）
#     2. 风险词检测：动作描述含危险词（删除/覆盖/强推/格式化等）→ 拦截或降级
#     3. 允许清单：config['constitution_allowlist'] 显式放行的动作类型
#     4. 回滚预案：执行前先 snapshot 状态（配置 + 关键文件 hash），
#        出问题按预案回滚到快照
#
# 设计：
#   1. classify(action)：给动作打分级标签 {level, risk_words}
#   2. guard(action)：护栏检查 → {allowed, reason, level, risk}
#   3. snapshot()：状态快照（配置 + 关键文件指纹）→ 落盘 data/constitution_snapshot.json
#   4. rollback_plan(snapshot_id)：生成可执行的回滚指令
#   5. verify(action)：护栏 + 快照 一体（先检查、再留底）
#   enable_constitution=False 时 guard 全部放行（显式关闸，默认开启）
#
# 纯 Python 实现，无外部依赖。

import hashlib
import json
import os
import time
from typing import Any, Dict, List, Optional


class Constitution:
    """宪法护栏：自改进的安全闸门 + 回滚预案。"""

    # 动作分级
    LEVELS = ('read', 'write', 'exec')
    # 各分级对应的风险词（命中 → 提高警惕）
    _RISK_WORDS = {
        'read': [],
        'write': ['覆盖', '删除', '清空', '重置', '强推', 'drop', 'truncate',
                  'rm ', '格式化'],
        'exec': ['shutdown', 'reboot', 'format', 'mkfs', 'dd ', '--force',
                 'rm -rf', 'del /', 'drop database'],
    }
    # 默认允许清单：write 只读场景默认放行 write_config / write_memory；
    # exec 默认只放行沙盒查询类（白名单由 Sandbox 再兜一层）
    _DEFAULT_ALLOWLIST = {
        'read': ['read_file', 'read_config', 'read_memory', 'query'],
        'write': ['write_config', 'write_memory', 'write_log', 'write_report'],
        'exec': ['sandbox_query', 'sandbox_experiment'],
    }
    # 快照里要留指纹的关键文件（相对 memory_data_dir 或绝对路径）
    _KEY_FILES = [
        'config.py', 'mistakes.py', 'metacognition.py', 'role_discussion.py',
        'world_model.py', 'curiosity.py', 'dream.py', 'parliament.py',
        'constitution.py',
    ]

    def __init__(self, config: Optional[Dict[str, Any]] = None,
                 base_dir: Optional[str] = None):
        """初始化。

        config: 配置（读取 enable_constitution / constitution_allowlist /
                       memory_data_dir）
        base_dir: 模块根目录（用于给 _KEY_FILES 算指纹），默认取本文件所在目录
        """
        self.config = config or {}
        self.enabled = bool(self.config.get('enable_constitution', True))
        allow = self.config.get('constitution_allowlist')
        self.allowlist = allow if isinstance(allow, dict) else self._DEFAULT_ALLOWLIST
        self.base_dir = base_dir or os.path.dirname(os.path.abspath(__file__))
        self.snapshots: List[Dict[str, Any]] = []
        self._load_snapshots()

    # ---------- 动作分类 ----------
    def classify(self, action: str, action_type: Optional[str] = None) -> Dict[str, Any]:
        """给动作打分级标签。

        action_type 未指定时按动作名推断：含 file/read/query → read；
        含 write/save/update → write；含 exec/run/command → exec；默认 exec。
        """
        a = str(action)
        if action_type and action_type in self.LEVELS:
            level = action_type
        elif any(k in a.lower() for k in ('file', 'read', 'query', 'view', 'list')):
            level = 'read'
        elif any(k in a.lower() for k in ('write', 'save', 'update', 'config')):
            level = 'write'
        else:
            level = 'exec'
        risk_words = [w for w in self._RISK_WORDS.get(level, []) if w in a]
        return {'level': level, 'risk_words': risk_words, 'risk': bool(risk_words)}

    # ---------- 护栏检查 ----------
    def guard(self, action: str, action_type: Optional[str] = None) -> Dict[str, Any]:
        """护栏检查：放行 / 拦截 / 降级。

        返回 {allowed, reason, level, risk, action}
        """
        info = self.classify(action, action_type)
        level = info['level']
        if not self.enabled:
            return {**info, 'allowed': True,
                    'reason': '宪法护栏已显式关闭（enable_constitution=False）'}
        # 1. 风险词硬拦截：写/执行类动作含危险词 → 拒绝
        if info['risk']:
            return {**info, 'allowed': False,
                    'reason': f"动作含风险词 {info['risk_words']}，护栏拦截"}
        # 2. 允许清单：动作名在对应分级的清单里 → 放行
        allow_items = self.allowlist.get(level, [])
        if any(k in action for k in allow_items):
            return {**info, 'allowed': True,
                    'reason': f'动作属于 {level} 级允许清单'}
        # 3. read 级默认放行；write/exec 级不在清单 → 需人工确认（降级为拒绝）
        if level == 'read':
            return {**info, 'allowed': True, 'reason': '只读动作，默认放行'}
        return {**info, 'allowed': False,
                'reason': f'{level} 级动作不在允许清单，需显式授权'}

    # ---------- 状态快照 ----------
    def _file_fingerprint(self, path: str) -> Optional[str]:
        """计算文件 SHA-256 指纹；不存在返回 None。"""
        if not os.path.isfile(path):
            return None
        try:
            with open(path, 'rb') as f:
                return hashlib.sha256(f.read()).hexdigest()[:16]
        except OSError:
            return None

    def _key_files_fingerprints(self) -> Dict[str, Optional[str]]:
        """对关键文件算指纹（存在才算，不存在的跳过）。"""
        out: Dict[str, Optional[str]] = {}
        for fname in self._KEY_FILES:
            fp = os.path.join(self.base_dir, fname)
            fp = self._file_fingerprint(fp)
            if fp is not None:
                out[fname] = fp
        return out

    def snapshot(self, label: str = '') -> Dict[str, Any]:
        """创建状态快照：配置要点 + 关键文件指纹 + 时间戳。

        快照是回滚的依据：执行自改进前先留底，出问题按指纹对比定位改动。
        """
        snap = {
            'id': 'snap-%d' % int(time.time()),
            'ts': time.time(),
            'label': label,
            'config_keys': sorted(self.config.keys()),
            'file_fingerprints': self._key_files_fingerprints(),
        }
        self.snapshots.append(snap)
        self._save_snapshots()
        return snap

    def diff_since(self, snap_id: str) -> Dict[str, Any]:
        """对比某快照之后发生的文件变化（回滚的定位依据）。"""
        snap = next((s for s in self.snapshots if s['id'] == snap_id), None)
        if snap is None:
            return {'error': f'快照不存在: {snap_id}'}
        before = snap['file_fingerprints']
        now = self._key_files_fingerprints()
        changed = {}
        for fname, fp in before.items():
            if now.get(fname) != fp:
                changed[fname] = {'before': fp, 'after': now.get(fname)}
        return {'snapshot': snap_id, 'changed_files': changed,
                'unchanged': len(before) - len(changed)}

    # ---------- 回滚预案 ----------
    def rollback_plan(self, snap_id: Optional[str] = None) -> Dict[str, Any]:
        """生成回滚预案：基于快照的恢复指令。

        由于 Python 模块改动无法热回滚，预案提供两种策略：
          1. 文件级：用备份/版本控制恢复（git checkout）
          2. 配置级：把配置恢复到快照时的键集合
        返回 {snapshot, strategy, steps}
        """
        snap = None
        if snap_id:
            snap = next((s for s in self.snapshots if s['id'] == snap_id), None)
        if snap is None and self.snapshots:
            snap = self.snapshots[-1]
        if snap is None:
            return {'error': '无可用快照，无法生成回滚预案',
                    'strategy': 'manual', 'steps': []}
        diff = self.diff_since(snap['id'])
        steps = []
        for fname in diff.get('changed_files', {}):
            steps.append(
                f'git checkout -- {fname}  # 恢复 {fname} 到快照 {snap["id"]} 状态'
            )
        if not steps:
            steps.append('未检测到文件变化，无需回滚')
        steps.append('重启引擎进程使配置生效')
        return {
            'snapshot': snap['id'],
            'snapshot_ts': snap['ts'],
            'strategy': 'git-checkout + 重启' if steps else 'manual',
            'changed_files': diff.get('changed_files', {}),
            'steps': steps,
        }

    # ---------- 一体入口 ----------
    def verify(self, action: str, action_type: Optional[str] = None,
               label: str = '') -> Dict[str, Any]:
        """护栏 + 留底 一体：先检查动作是否合法，再打快照留底。

        返回 {guard: {...}, snapshot: {...}}
        """
        g = self.guard(action, action_type)
        snap = self.snapshot(label or action[:40]) if g['allowed'] else None
        return {'guard': g, 'snapshot': snap}

    # ---------- 落盘 ----------
    def _snapshots_path(self) -> str:
        data_dir = self.config.get('memory_data_dir', 'data')
        return os.path.join(data_dir, 'constitution_snapshot.json')

    def _load_snapshots(self) -> None:
        p = self._snapshots_path()
        if not os.path.isfile(p):
            return
        try:
            with open(p, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                self.snapshots = data
        except (OSError, json.JSONDecodeError):
            self.snapshots = []

    def _save_snapshots(self) -> None:
        try:
            p = self._snapshots_path()
            os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
            tmp = p + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.snapshots, f, ensure_ascii=False, indent=2)
            os.replace(tmp, p)
        except OSError:
            pass

    # ---------- 统计 ----------
    def stats(self) -> Dict[str, Any]:
        return {
            'enabled': self.enabled,
            'levels': list(self.LEVELS),
            'allowlist': {k: len(v) for k, v in self.allowlist.items()},
            'snapshots': len(self.snapshots),
            'snapshots_file': self._snapshots_path(),
        }
