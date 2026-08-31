# 主从编排器（P1：Orchestrator-Worker 集群执行）
# 定位：与 orchestrator.py（多轮讨论编排，管"想得对"）互补，
#       swarm.py 管"干得快"——主 Agent 拆解任务、子 Agent 并行执行。
# 架构参照 Anthropic Orchestrator-Worker 工程复盘：主 Agent 持久化计划，
# 派生子 Agent 并行探索，各自压缩信息后交回主 Agent 汇总。
# 配套：token 预算熔断 + 检查点断点续跑 + 执行/验收分离。
import os
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from typing import Any, Dict, List, Optional

from .budget import TokenBudget, BudgetExceededError, estimate_tokens
from .checkpoint import CheckpointStore
from .task_plan import Task, TaskPlanner
from .verifier import Verifier, Verification

# 子 Agent 单任务重试上限（防死循环烧钱）
MAX_TASK_RETRIES = 2
# 单个子 Agent 结果压缩上限（字符），防止主 Agent 上下文爆炸
RESULT_COMPRESS_LIMIT = 2000


class SwarmOrchestrator:
    """Orchestrator-Worker 模式：主 Agent 拆解+派发+汇总，子 Agent 并行执行。

    config 可用键：
        swarm_max_workers: 并行子 Agent 数上限（默认 4）
        token_budget: token 总预算（None 不限；超限抛 BudgetExceededError 熔断）
        enable_checkpoint: 断点续跑开关（默认 True）
        planner_model / verifier_model / worker_model / swarm_summary_model: 指定模型名
        task_state_dir: 检查点目录（默认 data/task_state）
    """

    def __init__(self, core, config=None):
        self.core = core
        self.config = config or {}
        self.planner = TaskPlanner(core, self.config)
        self.verifier = Verifier(core, self.config)
        self.checkpoint = CheckpointStore(
            state_dir=self.config.get('task_state_dir')
            or os.path.join('data', 'task_state')
        )
        try:
            self.max_workers = max(1, int(self.config.get('swarm_max_workers', 4)))
        except (TypeError, ValueError):
            self.max_workers = 4
        # budget 累加锁：多线程并行调用 add() 时保护计数
        self._budget_lock = Lock()

    # ------------------------------------------------------------------
    # 对外主入口
    # ------------------------------------------------------------------
    def run(self, topic: str, run_id: str = None) -> Dict[str, Any]:
        """执行一个长任务：拆解 → 并行执行 → 验收 → 汇总。

        返回结构（稳定契约）：
        {
            'run_id': str,
            'topic': str,
            'tasks': [task.to_dict()...],
            'summary': str,            # 主 Agent 最终汇总
            'budget_snapshot': {...},
            'resumed': bool,           # 是否从检查点恢复
            'aborted': bool,           # 是否因预算熔断中止
            'aborted_at_task': str,    # 熔断时正要跑的任务 id
        }
        """
        run_id = run_id or uuid.uuid4().hex[:12]
        budget = TokenBudget(self.config.get('token_budget'))
        store = self.checkpoint

        # ---- 1. 拆解（或从检查点恢复）----
        resumed = False
        tasks = None
        if self.config.get('enable_checkpoint', True):
            saved = store.load(run_id)
            if saved:
                restored = CheckpointStore.restore_tasks(saved.get('tasks'))
                if restored:
                    tasks = restored
                    resumed = True
        if tasks is None:
            tasks = self.planner.plan(topic)

        if not tasks:
            return self._result(run_id, topic, [], '（未生成任何子任务）',
                                budget, resumed, False, None)

        # ---- 2. 调度循环 ----
        aborted = False
        aborted_at = None
        while True:
            # 检查点：每轮调度前落盘
            if self.config.get('enable_checkpoint', True):
                store.save(run_id, {
                    'topic': topic,
                    'tasks': CheckpointStore.sanitize_tasks(tasks),
                    'budget': budget.snapshot(),
                })

            ready = self._ready_tasks(tasks)
            finished = [t for t in tasks if t.status in ('done', 'skipped')]
            if not ready and len(finished) == len(tasks):
                break  # 全部完成
            if not ready:
                # 有任务未完成但无可跑任务：依赖死锁（依赖了失败/跳过的任务）
                # Bug#2 修复：级联跳过迭代到不动点——单层传播会漏掉
                # "任务列表顺序在失败者之前"的间接依赖链（C←B←A 中 C 排在 B 前）
                self._cascade_skip(tasks)
                if not self._ready_tasks(tasks):
                    break  # 仍无可跑任务，退出避免死循环

            # 预算检查：熔断时中止调度（已完成进度已在检查点里）
            try:
                budget.check()
            except BudgetExceededError:
                aborted = True
                aborted_at = ready[0].id if ready else None
                break

            # 并行派发本轮就绪任务；预算熔断在派发全部收尾后统一抛出，
            # 保证不丢任何已完成子任务的结果
            try:
                self._dispatch(ready, budget)
            except BudgetExceededError:
                aborted = True
                aborted_at = ','.join(t.id for t in ready if t.status == 'running')
                break

        # ---- 3. 汇总 ----
        summary = self._summarize(topic, tasks, budget)
        if not aborted and self.config.get('enable_checkpoint', True):
            store.clear(run_id)  # 正常收尾，清理检查点

        return self._result(run_id, topic, tasks, summary,
                            budget, resumed, aborted, aborted_at)

    # ------------------------------------------------------------------
    # 内部实现
    # ------------------------------------------------------------------
    def _ready_tasks(self, tasks: List[Task]) -> List[Task]:
        """依赖全部 done 的 pending 任务。"""
        return [
            t for t in tasks
            if t.status == 'pending' and all(
                (self._by_id(tasks, d) is None) or
                (self._by_id(tasks, d).status == 'done')
                for d in t.depends
            )
        ]

    @staticmethod
    def _cascade_skip(tasks: List[Task]):
        """级联跳过：依赖链上任何一环失败/跳过，后续全部跳过。

        迭代到不动点（单层传播会漏掉间接依赖），保证无死锁残留。
        """
        changed = True
        while changed:
            changed = False
            for t in tasks:
                if t.status != 'pending':
                    continue
                deps = [x for x in (SwarmOrchestrator._by_id(tasks, d) for d in t.depends) if x]
                if deps and all(d.status in ('failed', 'skipped') for d in deps):
                    t.status = 'skipped'
                    t.error = '依赖任务失败，级联跳过'
                    changed = True

    @staticmethod
    def _by_id(tasks: List[Task], tid: str) -> Optional[Task]:
        for t in tasks:
            if t.id == tid:
                return t
        return None

    def _dispatch(self, ready: List[Task], budget: TokenBudget):
        """并行派发就绪任务：每任务一个子 Agent（线程池），含重试与验收。

        异常策略：先等全部 Future 收尾（不丢任何任务的结果/状态更新），
        之后若有 BudgetExceededError 再统一抛出，交由 run() 的调度循环感知。
        其他异常已在 _run_one 内部消化为任务 failed，不会到这里。
        Bug#4 修复：ready 为空时防御性直接返回（min(0) 会炸 ThreadPoolExecutor）。
        """
        if not ready:
            return
        budget_error = None
        with ThreadPoolExecutor(max_workers=min(self.max_workers, len(ready))) as pool:
            futures = {}
            for task in ready:
                task.status = 'running'
                futures[pool.submit(self._run_one, task, budget)] = task
            for fut in as_completed(futures):
                task = futures[fut]
                try:
                    fut.result()
                except BudgetExceededError:
                    # 无论第几个熔断，任务都标回 pending（进度不丢，可续跑）
                    task.status = 'pending'
                    if budget_error is None:
                        budget_error = BudgetExceededError(
                            'token budget exhausted during dispatch',
                            used=budget.used, budget=budget.budget)
                except Exception as e:  # 双保险：子 Agent 崩溃不拖垮整体
                    task.status = 'failed'
                    task.error = str(e)[:500]
        if budget_error is not None:
            raise budget_error

    def _run_one(self, task: Task, budget: TokenBudget):
        """单个子 Agent 执行一个子任务：执行 → 验收 → 整改（含重试）。

        预算熔断向上传播（交由 _dispatch 统一处理）；
        其他异常就地消化为任务 failed，不影响兄弟任务。
        """
        executor_model = self._pick_worker_model()
        if executor_model is None:
            task.status = 'failed'
            task.error = 'no worker model registered'
            return

        def run_fn(instruction: str) -> str:
            budget.check()  # 每次调用前检查预算（超限抛 BudgetExceededError）
            prompt = (
                f"你是执行子智能体。请完成以下子任务并给出实质产出（不要空泛套话）：\n"
                f"子任务：{task.title}\n"
                f"要求：{instruction}\n"
            )
            resp = str(executor_model.invoke(prompt))
            with self._budget_lock:
                budget.add(estimate_tokens(prompt) + estimate_tokens(resp))
            return resp

        try:
            # Bug#3 配套：验收调用同样走预算记账
            result, verdict, attempts = self.verifier.verify_with_retries(
                task, executor_model, run_fn, budget=budget
            )
        except BudgetExceededError:
            raise  # 熔断必须向上传播
        except Exception as e:
            task.status = 'failed'
            task.error = f'worker error: {str(e)[:400]}'
            return

        task.result = (result or '')[:RESULT_COMPRESS_LIMIT]
        task.attempts = attempts
        if verdict.passed:
            task.status = 'done'
        else:
            task.status = 'failed'
            task.error = f'verify failed: {verdict.feedback[:300]}'

    def _pick_worker_model(self):
        """选执行模型：config['worker_model'] 指定 > 第一个注册模型。"""
        specified = self.config.get('worker_model')
        if specified and specified in self.core.models:
            return self.core.models[specified]
        for name, model in self.core.models.items():
            return model
        return None

    def _summarize(self, topic, tasks, budget) -> str:
        """主 Agent 汇总：把各子任务压缩结果拼给汇总模型。"""
        model = self._pick_summary_model()
        parts = []
        for t in tasks:
            status_txt = {'done': '✅', 'failed': '❌', 'skipped': '⏭'}.get(
                t.status, '⏳')
            parts.append(f"{status_txt} [{t.title}] {t.result or t.error or ''}")
        digest = "\n".join(parts)
        if model is None:
            return digest  # 无模型可用，返回结构化摘要本身
        if budget.exhausted:
            # 熔断后不再发起汇总调用（Bug#4：避免异常路径，直接降级）
            return digest
        prompt = (
            f"总任务：{topic}\n\n各子任务执行结果：\n{digest}\n\n"
            f"请作为主智能体汇总最终成果：给出结论、关键产出和未尽事项。"
        )
        try:
            budget.check()
            resp = str(model.invoke(prompt))
            with self._budget_lock:
                budget.add(estimate_tokens(prompt) + estimate_tokens(resp))
            return resp
        except BudgetExceededError:
            # 汇总阶段熔断：退化为结构化摘要（保住已有产出）
            return digest
        except Exception as e:
            return f"{digest}\n（汇总失败：{e}）"

    def _pick_summary_model(self):
        specified = (self.config.get('swarm_summary_model')
                     or self.config.get('planner_model'))
        if specified and specified in self.core.models:
            return self.core.models[specified]
        for name, model in self.core.models.items():
            return model
        return None

    @staticmethod
    def _result(run_id, topic, tasks, summary, budget, resumed, aborted, aborted_at):
        return {
            'run_id': run_id,
            'topic': topic,
            'tasks': [t.to_dict() for t in tasks],
            'summary': summary,
            'budget_snapshot': budget.snapshot(),
            'resumed': resumed,
            'aborted': aborted,
            'aborted_at_task': aborted_at,
        }