# 任务分解器（P0：长任务骨架 · 分片）
# 将大任务拆解为带依赖关系的子任务 DAG，供 SwarmOrchestrator 并行派发。
# 原则：LLM 输出解析失败时降级为"单任务原样执行"，绝不伪造拆解结果。
import json
import re
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# 子任务状态机：pending → running → done / failed / skipped
VALID_STATUS = ('pending', 'running', 'done', 'failed', 'skipped')


@dataclass
class Task:
    """一个可独立执行的子任务节点。"""
    title: str
    description: str = ''
    id: str = ''
    depends: List[str] = field(default_factory=list)  # 依赖的任务 id
    status: str = 'pending'
    result: Optional[str] = None
    attempts: int = 0
    error: Optional[str] = None

    def __post_init__(self):
        if not self.id:
            self.id = uuid.uuid4().hex[:8]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'id': self.id, 'title': self.title, 'description': self.description,
            'depends': list(self.depends), 'status': self.status,
            'result': self.result, 'attempts': self.attempts, 'error': self.error,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> 'Task':
        return cls(
            title=str(d.get('title', '')),
            description=str(d.get('description', '')),
            id=str(d.get('id') or uuid.uuid4().hex[:8]),
            depends=list(d.get('depends') or []),
            status=d.get('status') if d.get('status') in VALID_STATUS else 'pending',
            result=d.get('result'),
            attempts=int(d.get('attempts') or 0),
            error=d.get('error'),
        )


PLAN_PROMPT = (
    "你是任务规划师。请把下面的总任务拆解为 2~8 个可独立执行的子任务。\n"
    "只输出一个 JSON 数组，不要输出任何其他文字。每个元素形如：\n"
    '{{"title": "子任务标题", "description": "具体要做什么、产出什么", '
    '"depends": [前置子任务的序号数字，如 [1,2]，无依赖则为 []]}}\n'
    "序号从 1 开始按数组顺序编号；depends 里引用的序号必须小于当前元素序号（只允许依赖更早的任务）。\n\n"
    "总任务：{topic}"
)


def _extract_json_array(text: str) -> Optional[List[Dict[str, Any]]]:
    """从 LLM 回复中尽力提取 JSON 数组；失败返回 None。"""
    if not text:
        return None
    # 优先取 ```json ... ``` 代码块
    m = re.search(r'```(?:json)?\s*(\[.*?\])\s*```', text, re.S)
    candidates = [m.group(1)] if m else []
    # 兜底：取第一个 '[' 到最后一个 ']' 的片段
    i, j = text.find('['), text.rfind(']')
    if i != -1 and j > i:
        candidates.append(text[i:j + 1])
    for cand in candidates:
        try:
            arr = json.loads(cand)
            if isinstance(arr, list) and arr and all(isinstance(x, dict) for x in arr):
                return arr
        except Exception:
            continue
    return None


class TaskPlanner:
    """用规划模型把总任务拆成子任务 DAG。"""

    def __init__(self, core, config=None):
        self.core = core
        self.config = config or {}

    def plan(self, topic: str) -> List[Task]:
        """拆解总任务。拆解失败时降级为单任务（原任务本身），保证流程不断。"""
        model = self._pick_planner_model()
        if model is None:
            return [Task(title=topic, description=topic)]
        prompt = PLAN_PROMPT.format(topic=topic)
        try:
            raw = str(model.invoke(prompt))
        except Exception:
            raw = ''
        arr = _extract_json_array(raw)
        if not arr:
            return [Task(title=topic, description=topic)]

        tasks: List[Task] = []
        id_by_idx: Dict[int, str] = {}
        for idx, item in enumerate(arr, start=1):
            title = str(item.get('title') or f'子任务{idx}').strip()
            desc = str(item.get('description') or title).strip()
            t = Task(title=title[:200], description=desc[:2000])
            id_by_idx[idx] = t.id
            tasks.append(t)
        # 第二遍回填依赖：把序号引用翻译成任务 id（只允许依赖更早的任务）
        for idx, item in enumerate(arr, start=1):
            deps = item.get('depends') or []
            if not isinstance(deps, list):
                continue
            for d in deps:
                try:
                    di = int(d)
                except (TypeError, ValueError):
                    continue
                if 1 <= di < idx and di in id_by_idx:
                    tasks[idx - 1].depends.append(id_by_idx[di])
        # 防御：清掉重复依赖
        for t in tasks:
            t.depends = list(dict.fromkeys(t.depends))
        return tasks

    def _pick_planner_model(self):
        """选规划模型：优先 config['planner_model'] 指定，否则取第一个注册模型。"""
        specified = self.config.get('planner_model')
        if specified and specified in self.core.models:
            return self.core.models[specified]
        for name, model in self.core.models.items():
            return model
        return None