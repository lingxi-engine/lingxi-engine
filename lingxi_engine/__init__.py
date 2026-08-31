# 灵犀引擎 · Python 版多模型协作讨论框架
# 包入口：导出核心符号，保持既有导出不变，仅追加阶段5（Swarm 集群执行）导出。
#
# 版本：0.6.0（阶段5：任务分解/检查点/预算熔断/验收分离/Orchestrator-Worker 集群）
# 说明：顶层导出 Memory/Distiller/CARD_TYPES/LingXiCore/RoleDiscussion 及阶段4模块；
#       阶段5新增 task_plan/checkpoint/budget/verifier/swarm 五个模块。

from .memory import Memory
from .distill import Distiller, CARD_TYPES
from .core import LingXiCore
from .role_discussion import RoleDiscussion

# 阶段4·受限自改进（A1-A9）新模块
from .mistakes import MistakeBook
from .world_model import WorldModel
from .curiosity import CuriosityExplorer
from .dream import Dreamer
from .parliament import Parliament
from .constitution import Constitution

# 阶段5·Swarm 集群执行（Orchestrator-Worker）
from .task_plan import Task, TaskPlanner
from .checkpoint import CheckpointStore
from .budget import TokenBudget, BudgetExceededError
from .verifier import Verifier, Verification
from .swarm import SwarmOrchestrator

__all__ = [
    'Memory',
    'Distiller',
    'CARD_TYPES',
    'LingXiCore',
    'RoleDiscussion',
    # 阶段4
    'MistakeBook',
    'WorldModel',
    'CuriosityExplorer',
    'Dreamer',
    'Parliament',
    'Constitution',
    # 阶段5
    'Task',
    'TaskPlanner',
    'CheckpointStore',
    'TokenBudget',
    'BudgetExceededError',
    'Verifier',
    'Verification',
    'SwarmOrchestrator',
]

__version__ = '0.6.0'