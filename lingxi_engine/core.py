# 灵犀引擎核心
from typing import Any, Dict, List, Tuple

# 历史记录上限：防止长期运行时无限追加导致内存泄漏。
# 超出后保留最新的 _MAX_HISTORY 条。
_MAX_HISTORY = 1000


class LingXiCore:
    def __init__(self):
        self.models: Dict[str, Any] = {}
        self.tools: Dict[str, Any] = {}
        self.history: List[Tuple[str, str]] = []
        self.running = False

    def register_model(self, name, model):
        self.models[name] = model

    def register_tool(self, name, tool):
        self.tools[name] = tool

    def run(self, task: str):
        """执行一次编排。异常时也保证 running 状态被复位（try/finally）。"""
        self.running = True
        try:
            return self._orchestrate(task)
        finally:
            self.running = False

    def _orchestrate(self, task):
        # 单次编排逻辑
        responses = []
        for name, model in self.models.items():
            resp = model.invoke(task)
            responses.append((name, resp))
            self._append_history((name, resp))
        return responses

    def _append_history(self, item: Tuple[str, str]) -> None:
        """追加历史，超出上限时裁剪最旧的记录。"""
        self.history.append(item)
        if len(self.history) > _MAX_HISTORY:
            self.history = self.history[-_MAX_HISTORY:]

    def get_history(self):
        return self.history
