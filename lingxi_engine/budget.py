# Token 预算熔断器（P2）
# 目标：防止多智能体集群失控烧钱。15 倍 token 消耗是多智能体的已知代价
#（Anthropic 工程复盘数据），必须有硬熔断而不是只靠模型自觉。
# 原则：超预算时"熔断但可恢复"——抛 BudgetExceededError，由上层决定续跑或终止。
import threading
import time
from typing import Optional


class BudgetExceededError(RuntimeError):
    """预算耗尽。携带已消耗量与上限，供上层记录与续跑判断。"""

    def __init__(self, message: str, used: int, budget: int):
        super().__init__(message)
        self.used = used
        self.budget = budget


class TokenBudget:
    """记录 token 消耗并在超限时熔断。

    线程安全：check/add/snapshot 内部持锁，多 Worker 并行记账不丢单。
    用法：
        budget = TokenBudget(100000)
        budget.check()            # 每次调用模型前检查
        budget.add(used_tokens)   # 每次调用后累加
    """

    def __init__(self, budget: Optional[int] = None):
        # budget=None 表示不限预算（向后兼容旧调用）
        self.budget = int(budget) if budget else None
        self.used = 0
        self.calls = 0
        self.started_at = time.time()
        self._lock = threading.Lock()

    @property
    def remaining(self) -> Optional[int]:
        if self.budget is None:
            return None
        with self._lock:
            return max(0, self.budget - self.used)

    @property
    def exhausted(self) -> bool:
        if self.budget is None:
            return False
        with self._lock:
            return self.used >= self.budget

    def check(self):
        """调用模型前检查预算，超限则抛 BudgetExceededError。"""
        if self.exhausted:
            raise BudgetExceededError(
                f"token budget exhausted: used={self.used}, budget={self.budget}",
                used=self.used, budget=self.budget,
            )

    def add(self, tokens: int) -> int:
        """累加消耗并返回当前已用量。负数输入被忽略（防脏数据）。"""
        if tokens and tokens > 0:
            with self._lock:
                self.used += int(tokens)
                self.calls += 1
        return self.used

    def snapshot(self) -> dict:
        """当前消耗快照，供检查点/日志记录。"""
        with self._lock:
            return {
                'budget': self.budget,
                'used': self.used,
                'calls': self.calls,
                'elapsed_sec': round(time.time() - self.started_at, 1),
            }


def estimate_tokens(text: str) -> int:
    """粗略估算文本 token 数。

    无 tokenizer 依赖的保守估计：中文约 1 字/token，英文约 4 字符/token。
    取两者加权平均的近似值，宁可高估不可低估（熔断器要保守）。
    """
    if not text:
        return 0
    text = str(text)
    cjk = sum(1 for ch in text if '\u4e00' <= ch <= '\u9fff')
    other = len(text) - cjk
    return cjk + (other + 3) // 4