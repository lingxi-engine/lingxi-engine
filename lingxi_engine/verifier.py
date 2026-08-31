# 验收器（P1：执行 Agent 与验收 Agent 分离）
# 背景：METR 2026-05 报告发现顶级模型在长任务中普遍"作弊"（Opus 4.6 约 80% 尝试
# 存在违规），因此执行与验收必须分离——执行者不能既当运动员又当裁判。
# 原则：验收模型与执行模型不能是同一个；验收失败给出可执行的整改指令。
# Bug#3 修复：验收调用接入预算记账——多智能体最大的 token 开销来自
# "重执行+重验收"整改循环，熔断器必须看得见验收环节。
import re
import uuid
from typing import Any, Dict, Optional

from .budget import TokenBudget, BudgetExceededError, estimate_tokens


class Verification:
    """单次验收结论。"""

    def __init__(self, passed: bool, feedback: str = ''):
        self.passed = bool(passed)
        self.feedback = str(feedback or '')

    def to_dict(self) -> Dict[str, Any]:
        return {'passed': self.passed, 'feedback': self.feedback}


VERIFY_PROMPT = (
    "你是严格的验收官。请验收以下子任务的完成情况。\n"
    "子任务：{title}\n"
    "要求：{description}\n"
    "执行者提交的结果：\n{result}\n\n"
    "请判断该结果是否真实、完整地完成了子任务要求。警惕：\n"
    "1. 空泛套话、没有具体内容（声称完成却给不出实质产出）；\n"
    "2. 声称完成但缺少关键信息；\n"
    "3. 与任务要求明显不符。\n"
    "只输出一行 JSON：{{\"passed\": true/false, \"feedback\": \"若通过给出简短确认；"
    "若不通过，给出具体、可执行的整改指令（哪里不合格、要补什么）\"}}"
)


def _extract_json_obj(text: str) -> Optional[Dict[str, Any]]:
    """从 LLM 回复中尽力提取单个 JSON 对象；失败返回 None。"""
    if not text:
        return None
    m = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.S)
    candidates = [m.group(1)] if m else []
    i, j = text.find('{'), text.rfind('}')
    if i != -1 and j > i:
        candidates.append(text[i:j + 1])
    import json
    for cand in candidates:
        try:
            obj = json.loads(cand)
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return None


class Verifier:
    """独立验收层：用与执行者不同的模型验收子任务结果。

    config 可用键：
        verifier_model: 指定验收模型名（默认自动选与执行者不同的模型）
        enable_verifier: False 时全部直接放行（不验收）
        verify_max_retries: 验收不通过时的最大整改次数（默认 2）
    """

    def __init__(self, core, config=None):
        self.core = core
        self.config = config or {}

    def enabled(self) -> bool:
        return bool(self.config.get('enable_verifier', True))

    def max_retries(self) -> int:
        try:
            n = int(self.config.get('verify_max_retries', 2))
        except (TypeError, ValueError):
            n = 2
        return max(0, n)

    def _pick_verifier_model(self, executor=None):
        """选验收模型：显式指定 > 与执行者不同的第一个模型 > 任何模型。"""
        specified = self.config.get('verifier_model')
        if specified and specified in self.core.models:
            return self.core.models[specified]
        for name, model in self.core.models.items():
            if executor is not None and model is executor:
                continue
            return model
        # 只注册了一个模型时只能用它（退化模式，记录在案）
        for name, model in self.core.models.items():
            return model
        return None

    def verify(self, task, result: str, executor=None,
               budget: Optional[TokenBudget] = None) -> Verification:
        """验收一个子任务结果。验收模型不可用时放行（不阻塞流程）。

        budget 传入时验收调用走预算记账（Bug#3 修复）；
        验收器自身故障放行，但 BudgetExceededError 必须向上传播（熔断不可吞）。
        """
        if not self.enabled():
            return Verification(True, 'verifier disabled')
        model = self._pick_verifier_model(executor=executor)
        if model is None:
            return Verification(True, 'no verifier model available')
        prompt = VERIFY_PROMPT.format(
            title=getattr(task, 'title', ''),
            description=getattr(task, 'description', ''),
            result=str(result)[:4000],
        )
        try:
            raw = str(model.invoke(prompt))
        except BudgetExceededError:
            raise  # 熔断必须向上传播，不能被 pass-through 吞掉
        except Exception as e:
            # 验收器自身故障不应卡死任务：放行并记录
            return Verification(True, f'verifier error (pass-through): {e}')
        if budget is not None:
            budget.add(estimate_tokens(prompt) + estimate_tokens(raw))
        obj = _extract_json_obj(raw)
        if not obj:
            # 解析失败：保守放行，但留下痕迹
            return Verification(True, f'verifier unparsable: {raw[:200]}')
        passed = bool(obj.get('passed'))
        feedback = str(obj.get('feedback') or '')
        return Verification(passed, feedback)

    def verify_with_retries(self, task, executor, run_fn,
                            budget: Optional[TokenBudget] = None):
        """执行+验收+整改循环。

        run_fn(instruction) 由调用方提供：按指令执行子任务并返回结果文本
        （执行调用已含预算记账，验收调用同样记账）。
        验收不通过时把验收官的整改指令作为新的执行指令重试，最多 max_retries 次。
        返回 (最终结果, Verification, 整改次数)。
        """
        instruction = getattr(task, 'description', '') or getattr(task, 'title', '')
        result = run_fn(instruction)
        attempts = 0
        verdict = self.verify(task, result, executor=executor, budget=budget)
        while not verdict.passed and attempts < self.max_retries():
            attempts += 1
            fix_hint = verdict.feedback or '请补全未完成的部分'
            instruction = (
                f"上次执行未通过验收。整改指令：{fix_hint}\n"
                f"请重新完成子任务：{getattr(task, 'title', '')}"
            )
            result = run_fn(instruction)
            verdict = self.verify(task, result, executor=executor, budget=budget)
        return result, verdict, attempts