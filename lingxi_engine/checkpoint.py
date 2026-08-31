# 检查点模块（P0：长任务骨架 · 断点续跑）
# 任务状态周期性落盘为 JSON；进程重启后可从最近检查点恢复进度，已完成子任务不重跑。
# 设计原则：任何落盘/读取失败都不应导致任务失败，只降级为"无检查点保护"。
import json
import os
import time
from typing import Any, Dict, List, Optional

from .task_plan import Task, VALID_STATUS

# 检查点文件格式版本，结构变更时递增
CHECKPOINT_VERSION = 1


class CheckpointStore:
    """基于 JSON 文件的检查点存储：一个任务一个文件，原子写入（tmp + rename）。"""

    def __init__(self, state_dir: str = None):
        # 默认落在引擎数据目录下，与其他模块（memory/world_model）同级
        self.state_dir = state_dir or os.path.join('data', 'task_state')
        self._ensure_dir()

    def _ensure_dir(self):
        try:
            os.makedirs(self.state_dir, exist_ok=True)
        except OSError:
            # 目录创建失败（只读盘等）：降级为不落盘
            self.state_dir = None

    def _path_for(self, run_id: str) -> Optional[str]:
        if not self.state_dir or not run_id:
            return None
        # run_id 只允许安全字符，防止路径穿越
        safe = ''.join(c for c in str(run_id) if c.isalnum() or c in '-_')
        if not safe:
            return None
        return os.path.join(self.state_dir, f'cp_{safe}.json')

    def save(self, run_id: str, state: Dict[str, Any]) -> bool:
        """原子写入检查点。成功返回 True，失败静默降级返回 False。"""
        path = self._path_for(run_id)
        if not path:
            return False
        payload = {
            'version': CHECKPOINT_VERSION,
            'run_id': run_id,
            'updated_at': time.time(),
            'state': state,
        }
        tmp = path + '.tmp'
        try:
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(payload, f, ensure_ascii=False, indent=1)
            os.replace(tmp, path)  # 原子替换，避免写一半被读到
            return True
        except (OSError, TypeError, ValueError):
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            return False

    def load(self, run_id: str) -> Optional[Dict[str, Any]]:
        """读取检查点；不存在/损坏/版本不识别时返回 None（视为无检查点）。"""
        path = self._path_for(run_id)
        if not path or not os.path.exists(path):
            return None
        try:
            with open(path, 'r', encoding='utf-8') as f:
                payload = json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(payload, dict):
            return None
        if int(payload.get('version') or 0) != CHECKPOINT_VERSION:
            return None
        state = payload.get('state')
        return state if isinstance(state, dict) else None

    def clear(self, run_id: str) -> bool:
        """任务终态（done/failed）后清理检查点文件。"""
        path = self._path_for(run_id)
        if not path:
            return False
        try:
            if os.path.exists(path):
                os.remove(path)
            return True
        except OSError:
            return False

    @staticmethod
    def sanitize_tasks(tasks, status_whitelist=VALID_STATUS) -> List[Dict[str, Any]]:
        """把 Task 对象列表转成可 JSON 化的 dict 列表，并校正非法状态。"""
        out = []
        for t in tasks or []:
            d = t.to_dict() if hasattr(t, 'to_dict') else dict(t)
            if d.get('status') not in status_whitelist:
                d['status'] = 'pending'
            out.append(d)
        return out

    @staticmethod
    def restore_tasks(raw_tasks) -> List[Task]:
        """从 dict 列表恢复 Task 对象列表；空/非法输入返回 []。

        Bug#1 修复：running 是进程内瞬态状态——检查点里出现 running，
        只可能是进程硬崩溃时留下的陈旧状态（正常收尾不会以 running 落盘）。
        续跑时若不重置，_ready_tasks 只认 pending，该任务永远不被调度，
        也不满足级联跳过条件 → 断点续跑死等。故恢复时 running 一律重置为 pending。
        """
        if not isinstance(raw_tasks, list):
            return []
        out: List[Task] = []
        for d in raw_tasks:
            if not isinstance(d, dict):
                continue
            if d.get('status') == 'running':
                d = dict(d)  # 不污染调用方数据
                d['status'] = 'pending'
            out.append(Task.from_dict(d))
        return out