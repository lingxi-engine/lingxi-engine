# 元认知控制器 + 动态资源分配
#
# 对应 AGI 进化路线图【阶段2·让它"知道自己"】：
#   从"被动轮到"到"主动调度"——引擎能评估任务难度、监控自身状态，
#   并据此动态分配计算资源（轮次、模型、记忆检索力度、反思强度）。
#
# 核心设计：
#   1. 任务难度评估：从 复杂度 / 歧义度 / 风险度 三个维度打分，合成综合难度分
#   2. 资源分配策略：按难度分动态决定 轮次 / 模型数 / 记忆检索 / 反思强度
#   3. 自我状态监控：上下文长度、可用 token 预算、可用模型数、记忆规模
#   4. 可解释性：每次分配记录 reason，说明"为什么这么分"
#
# 难度合成策略：
#   综合分 = 0.5*复杂度 + 0.3*风险 + 0.2*歧义
#   但为避免"单维度高而被其他维度稀释"，引入 凸组合修正：
#   当任一分维度 >= 0.6 时，按 (0.6*主维度 + 0.4*加权分) 抬升，保证高难任务不被低估。
#   另加入 显式难度词识别：任务中出现"极难/超难/最高难度/非常复杂"等表述时，
#   直接抬升难度，避免纯技术关键词漏判（如"极难任务"这类不含技术词的表述）。
#
# LLM 评估：注入 model 后 evaluate() 会优先走 AI 难度评估（_llm_evaluate），
# 解析失败自动降级回启发式，保证任何情况下都能出结果。
#
# 【阶段4·A4】新增 断言级置信度评估 + 事实溯源：
#   assess_confidence(text)：把一段回复拆成"断言"，每条打上
#   {断言, 来源, 验证状态, 置信度} 标记，低置信度触发查证/复核——
#   这是"事实锚点层"的消费端：让引擎不只知道自己接的活难不难，
#   还知道自己答得靠不靠谱。注入 model 时走 LLM 评估，否则启发式兜底。
#
# 纯 Python 实现，无外部依赖；启发式可独立运行。

import json
import re
from typing import Any, Dict, List, Optional

# ---------- 难度等级 ----------
DIFFICULTY_LEVELS = ('简单', '中等', '复杂', '极难')


class Metacognition:
    """元认知控制器：评估任务难度，动态分配资源。

    用法：
        meta = Metacognition()
        plan = meta.plan('帮我设计一个分布式系统架构')
        # plan 包含难度分、等级、和资源分配建议，可直接喂给 Orchestrator
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None, model: Optional[Any] = None):
        self.config = config or {}
        self.model = model  # 可选 LLM，提供则 evaluate() 优先走 AI 难度评估

    # ============ 1. 任务难度评估 ============
    # 复杂度信号：长句、技术词、多子任务、需要多轮推理
    _COMPLEXITY_SIGNALS = [
        '架构', '设计', '系统', '分布式', '算法', '优化',
        '分析', '评估', '对比', '权衡', '实现', '开发', '部署',
        '规划', '策略', '流程', '框架', '模型', '数据', '性能',
        '微服务', '扩展',
    ]
    # 歧义度信号：指代模糊、缺上下文、多义
    _AMBIGUITY_SIGNALS = [
        '它', '这个', '那个', '这些', '那些', '随便', '差不多',
        '看看', '弄一下', '搞一下', '之类', '等等', '大概',
    ]
    # 风险度信号：涉及安全 / 不可逆 / 对外影响
    _RISK_SIGNALS = [
        '删除', '清空', '覆盖', '重置', '上线', '发布', '支付',
        '转账', '删除数据库', 'rm ', 'drop ', '生产', '正式',
        '对外', '客户', '合同', '法律', '安全', '权限', 'root',
    ]
    # 显式难度表述：任务里直接说"极难/超难/最高难度"等，视为高难信号。
    # 这类词不含技术关键词，但语义上明确要求高强度处理。
    _EXPLICIT_DIFFICULTY = [
        '极难', '超难', '最难', '最高难度', '非常复杂', '极其复杂',
        '特别复杂', 'hardest', 'extremely hard', 'most difficult',
    ]

    # 单维度命中数饱和值：命中达到该数量即记满分，
    # 避免长文本因命中绝对数大而被过度高估。
    _SIGNAL_SATURATION = 5


    def _score_signal(self, text: str, signals: List[str]) -> float:
        """统计命中信号的比例（0~1），作为维度分。"""
        if not text:
            return 0.0
        hits = sum(1 for s in signals if s in text)
        # 命中数达到饱和值（见 _SIGNAL_SATURATION）即记满分，避免长文本被过度高估
        return min(1.0, hits / self._SIGNAL_SATURATION)

    def evaluate(self, task: str) -> Dict[str, Any]:
        """评估任务，返回三个维度分 + 综合难度分 + 等级。

        注入了 model 时优先走 LLM 评估；LLM 输出解析失败时降级为启发式。
        """
        if not task:
            return {'complexity': 0, 'ambiguity': 0, 'risk': 0,
                    'difficulty': 0, 'level': DIFFICULTY_LEVELS[0]}

        llm_ev = self._llm_evaluate(task)
        if llm_ev is not None:
            # 补齐缺失字段并归一化，保证下游拿到的结构稳定
            result = {
                'complexity': float(llm_ev.get('complexity', 0.5)),
                'ambiguity': float(llm_ev.get('ambiguity', 0.5)),
                'risk': float(llm_ev.get('risk', 0.5)),
            }
            for k in ('complexity', 'ambiguity', 'risk'):
                result[k] = max(0.0, min(1.0, result[k]))
            difficulty = 0.5 * result['complexity'] + 0.3 * result['risk'] + 0.2 * result['ambiguity']
            top = max(result.values())
            if top >= 0.6:
                difficulty = 0.6 * top + 0.4 * difficulty
            level = llm_ev.get('level')
            if level not in DIFFICULTY_LEVELS:
                level = self._difficulty_to_level(difficulty)
            result['difficulty'] = round(difficulty, 3)
            result['level'] = level
            return result

        return self._heuristic_evaluate(task)

    @staticmethod
    def _difficulty_to_level(difficulty: float) -> str:
        if difficulty < 0.25:
            return DIFFICULTY_LEVELS[0]
        elif difficulty < 0.5:
            return DIFFICULTY_LEVELS[1]
        elif difficulty < 0.75:
            return DIFFICULTY_LEVELS[2]
        return DIFFICULTY_LEVELS[3]

    def _heuristic_evaluate(self, task: str) -> Dict[str, Any]:
        """启发式难度评估（无 LLM 时的兜底路径）。"""
        # 文本长度也作为复杂度的一部分（长任务通常更难）
        length_factor = min(1.0, len(task) / 200.0)

        complexity = self._score_signal(task, self._COMPLEXITY_SIGNALS)
        complexity = min(1.0, complexity * 0.8 + length_factor * 0.2)

        ambiguity = self._score_signal(task, self._AMBIGUITY_SIGNALS)
        risk = self._score_signal(task, self._RISK_SIGNALS)

        # 显式难度词：命中即显著抬升复杂度（至少到 0.8）
        if any(w in task for w in self._EXPLICIT_DIFFICULTY):
            complexity = max(complexity, 0.8)

        # 基础加权综合分：复杂度 0.5 + 风险 0.3 + 歧义 0.2
        weighted = 0.5 * complexity + 0.3 * risk + 0.2 * ambiguity

        # 凸组合修正：当任一维度突出（>=0.6）时抬升综合分，避免被其他维度稀释。
        top = max(complexity, risk, ambiguity)
        if top >= 0.6:
            difficulty = 0.6 * top + 0.4 * weighted
        else:
            difficulty = weighted

        return {
            'complexity': round(complexity, 3),
            'ambiguity': round(ambiguity, 3),
            'risk': round(risk, 3),
            'difficulty': round(difficulty, 3),
            'level': self._difficulty_to_level(difficulty),
        }

    # ============ 2. 动态资源分配 ============
    def allocate(self, task: str, available_models: int = 3,
                 max_rounds_cap: int = 5) -> Dict[str, Any]:
        """根据难度分配资源。

        参数：
            available_models: 当前可用模型数
            max_rounds_cap: 轮次上限（防止分配过多）
        返回：
            资源分配计划（轮次、是否用全部模型、记忆检索力度、反思强度、理由）
        """
        ev = self.evaluate(task)
        level = ev['level']

        # 按难度档位分配
        if level == '简单':
            rounds = 1
            use_all_models = available_models <= 2
            memory_top_k = 2
            reflection = False
            reason = '简单任务：单轮即可，减少开销，避免过度计算'
        elif level == '中等':
            rounds = 2
            use_all_models = True
            memory_top_k = 4
            reflection = True
            reason = '中等任务：2轮讨论 + 反思，适度检索记忆'
        elif level == '复杂':
            rounds = min(4, max_rounds_cap)
            use_all_models = True
            memory_top_k = 6
            reflection = True
            reason = '复杂任务：多轮碰撞 + 反思，充分检索历史经验'
        else:  # 极难
            rounds = min(max_rounds_cap, 5)
            use_all_models = True
            memory_top_k = 8
            reflection = True
            reason = '极难任务：全力调度，最大化轮次与记忆，重点反思'

        # 风险特判：高风险任务强制开启反思 + 提高轮次
        if ev['risk'] >= 0.4:
            reflection = True
            rounds = max(rounds, 3)
            reason += '；检测到高风险，强制开启反思并提高轮次'

        return {
            'difficulty': ev,
            'rounds': rounds,
            'use_all_models': use_all_models,
            'memory_top_k': memory_top_k,
            'reflection': reflection,
            'reason': reason,
        }

    # ============ 3. 自我状态监控 ============
    def monitor(self, context_length: int = 0, token_budget: int = 8000,
                available_models: int = 0, memory_stats: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
        """监控引擎自身运行状态，输出健康度与建议。

        参数：
            context_length: 当前已用上下文长度（字符数）
            token_budget: token 预算上限
            available_models: 可用模型数
            memory_stats: Memory.stats() 的输出（short/long/cards 数量）
        返回：
            状态报告 + 健康度 + 是否需要精简/扩充
        """
        mem = memory_stats or {}
        context_ratio = context_length / token_budget if token_budget else 0.0

        # 健康度：上下文占用、模型数、记忆规模
        health = 1.0
        warnings = []

        if context_ratio > 0.8:
            health -= 0.4
            warnings.append('上下文接近上限，建议精简记忆检索或分段处理')
        elif context_ratio > 0.5:
            health -= 0.15
            warnings.append('上下文占用偏高')

        if available_models == 0:
            health -= 0.2
            warnings.append('无可用模型，无法执行')
        elif available_models == 1:
            health -= 0.1
            warnings.append('仅 1 个模型可用，多轮讨论受限')

        if mem.get('cards', 0) == 0:
            warnings.append('经验卡片为空，建议先累积经验')

        health = max(0.0, min(1.0, health))
        status = '健康' if health >= 0.8 else ('紧张' if health >= 0.5 else '告急')

        return {
            'health': round(health, 2),
            'status': status,
            'context_ratio': round(context_ratio, 3),
            'available_models': available_models,
            'memory_stats': mem,
            'warnings': warnings,
        }

    # ============ 4. 可选的 LLM 难度评估 ============
    def _llm_evaluate(self, task: str) -> Optional[Dict[str, Any]]:
        """用注入的模型做一次 AI 难度评估；失败返回 None（由调用方降级）。"""
        if self.model is None:
            return None
        prompt = (
            "请评估以下任务的难度，输出 JSON："
            '{"complexity": 0-1, "ambiguity": 0-1, "risk": 0-1, "level": "简单|中等|复杂|极难"}\n'
            f"任务：{task}"
        )
        try:
            raw = self.model.invoke(prompt)
        except Exception:
            return None
        m = re.search(r'\{.*\}', raw, re.S)
        if m:
            try:
                data = json.loads(m.group(0))
                if isinstance(data, dict):
                    return data
            except json.JSONDecodeError:
                return None
        return None

    # ============ 一键规划 ============
    def plan(self, task: str, **alloc_kwargs) -> Dict[str, Any]:
        """评估 + 分配 + 状态监控的一键入口。

        注释曾承诺"含状态监控"但旧实现没调 monitor()，现已接上：
        监控结果挂在返回值的 'monitor' 字段。
        """
        ev = self.evaluate(task)
        alloc = self.allocate(task, **alloc_kwargs)
        mon = self.monitor(
            context_length=len(task),
            available_models=alloc_kwargs.get('available_models', 0),
        )
        return {
            'task': task,
            'evaluation': ev,
            'allocation': alloc,
            'monitor': mon,
        }

    # ==================================================================
    # 【阶段4·A4】断言级置信度评估 + 事实溯源
    # ==================================================================
    # 现状缺口：evaluate() 输出的是"任务难度"三维分——引擎知道自己接的活
    # 难不难，但不知道自己答得靠不靠谱。assess_confidence() 补上另一半：
    # 把回复拆成断言，逐条打"来源 + 验证状态 + 置信度"标记，低置信度触发查证。
    # 这是"事实锚点层"的消费端，也是世界模型（A5）防漂移与自博弈（A3）
    # 评分信号共同依赖的地基。
    #
    # 溯源成本控制：默认只在低置信度断言上触发查证（异步/抽样），
    # 而不是每条全量——回应"溯源会拖慢回复延迟"的风险点。

    # 断言动词信号：句子含这些词大概率是在"陈述一个事实/判断"
    _ASSERT_VERBS = [
        '是', '会', '能', '可以', '应该', '必须', '将', '需要',
        '存在', '提供', '支持', '包含', '具有', '实现', '导致',
        '意味着', '表明', '显示', '等于', '来自', '属于',
    ]
    # 引用/来源信号：句子出现这些词 → 有出处支撑
    _SOURCE_SIGNALS = [
        '根据', '来源', '引用', '参考', '文档', '官方', '数据显示',
        '实验', '测试', '论文', '规范', '文档说', '文档中', 'README',
        'https://', 'http://', 'RFC', '标准', '接口文档', '实测',
    ]
    # 确定性信号：句子出现这些词 → 已通过验证
    _VERIFIED_SIGNALS = [
        '已验证', '实测', '测试通过', '验证通过', '已确认', '已实现',
        '跑通了', '通过验证', '确认无误', '已落地', '已生效',
    ]
    # 不确定性信号：出现这些词 → 置信度下调
    _UNCERTAIN_SIGNALS = [
        '可能', '或许', '大概', '估计', '也许', '猜测', '据说',
        '应该是', '不一定', '我不确定', '不确定', '大约', '左右',
        '似乎', '好像', '我认为', '我觉得', '感觉',
    ]

    def _extract_assertions(self, text: str) -> List[str]:
        """启发式抽取断言：按句子切分，挑含断言动词的陈述句。

        不依赖 LLM，任何环境都能跑；LLM 版本（_llm_confidence）作为升级路径。
        """
        if not text:
            return []
        # 按句号/感叹号/问号/分号/换行切句
        sentences = re.split(r'[。！？；\n]', str(text))
        asserts = []
        for s in sentences:
            s = s.strip()
            if len(s) < 6:  # 太短不成断言
                continue
            if any(v in s for v in self._ASSERT_VERBS):
                asserts.append(s)
        return asserts

    def _assess_one(self, assertion: str) -> Dict[str, Any]:
        """对单条断言做启发式置信度评估。"""
        has_source = any(sig in assertion for sig in self._SOURCE_SIGNALS)
        verified = any(sig in assertion for sig in self._VERIFIED_SIGNALS)
        uncertain = any(sig in assertion for sig in self._UNCERTAIN_SIGNALS)

        # 基础分 0.5；有来源 +0.25；已验证 +0.15；不确定 -0.2
        conf = 0.5
        if has_source:
            conf += 0.25
        if verified:
            conf += 0.15
        if uncertain:
            conf -= 0.2
        conf = max(0.0, min(1.0, round(conf, 2)))

        # 验证状态：已验证 > 可验证（有来源未验证）> 未验证 > 不可验证（纯推测）
        if verified:
            state = 'verified'
        elif has_source:
            state = 'verifiable'
        elif uncertain:
            state = 'unverifiable'
        else:
            state = 'unverified'

        return {
            'assertion': assertion,
            'source': 'has_source' if has_source else 'no_source',
            'verification': state,
            'confidence': conf,
        }

    def _llm_confidence(self, text: str) -> Optional[List[Dict[str, Any]]]:
        """用注入的模型做一次断言级置信度评估；失败返回 None（调用方降级）。

        让 LLM 输出断言列表，每条带 confidence/source/verification；
        解析失败或输出异常时降级回启发式，保证任何情况都能出结果。
        """
        if self.model is None:
            return None
        prompt = (
            "请把下面的回复拆成若干条'断言'（陈述事实/判断的句子），"
            "对每条输出 JSON："
            '{"assertion": "断言原文", "confidence": 0-1, '
            '"source": "has_source|no_source", '
            '"verification": "verified|verifiable|unverified|unverifiable"}\n'
            "输出 JSON 数组。\n回复：\n" + str(text)
        )
        try:
            raw = self.model.invoke(prompt)
        except Exception:
            return None
        m = re.search(r'\[.*\]', raw, re.S)
        if m:
            try:
                data = json.loads(m.group(0))
                if isinstance(data, list):
                    items = []
                    for it in data:
                        if isinstance(it, dict) and it.get('assertion'):
                            conf = float(it.get('confidence', 0.5))
                            items.append({
                                'assertion': str(it['assertion']),
                                'source': it.get('source', 'no_source'),
                                'verification': it.get('verification', 'unverified'),
                                'confidence': max(0.0, min(1.0, conf)),
                            })
                    if items:
                        return items
            except (json.JSONDecodeError, ValueError, TypeError):
                return None
        return None

    def assess_confidence(self, text: str) -> Dict[str, Any]:
        """【A4】对一段回复做断言级置信度评估 + 溯源标记。

        返回：
            {
              'text': 原文（截断展示用）,
              'assertions': [{assertion, source, verification, confidence}, ...],
              'overall_confidence': 全部断言置信度均值,
              'low_confidence': 低于阈值（config['confidence_low_threshold']，默认 0.5）的断言,
              'needs_verification': 需要查证的断言数,
              'verifier': 'llm' 或 'heuristic'（本次评估用的路径）
            }
        """
        if not text or not str(text).strip():
            return {
                'text': '', 'assertions': [], 'overall_confidence': 1.0,
                'low_confidence': [], 'needs_verification': 0, 'verifier': 'none',
            }

        threshold = float(self.config.get('confidence_low_threshold', 0.5))

        # 优先 LLM 评估（注入 model 时），失败降级启发式
        items = self._llm_confidence(text)
        verifier = 'llm'
        if items is None:
            items = [self._assess_one(a) for a in self._extract_assertions(text)]
            verifier = 'heuristic'

        if not items:
            return {
                'text': str(text)[:200], 'assertions': [],
                'overall_confidence': 1.0, 'low_confidence': [],
                'needs_verification': 0, 'verifier': verifier,
            }

        overall = round(sum(i['confidence'] for i in items) / len(items), 2)
        low = [i for i in items if i['confidence'] < threshold]
        return {
            'text': str(text)[:200],
            'assertions': items,
            'overall_confidence': overall,
            'low_confidence': low,
            'needs_verification': len(low),
            'verifier': verifier,
        }

    def trace_source(self, assertion: str) -> Dict[str, Any]:
        """【A4】事实溯源 API：对一条断言给出溯源/查证建议。

        不承诺"能查到"，而是给出可执行的查证路径（异步/抽样，不阻塞主流程）：
          1. 文本内引用检查（URL/文档名）
          2. 沙盒执行验证（可执行代码类断言）
          3. 记忆/经验卡片对照（引擎自己沉淀过什么）
        返回 {assertion, refs_found, verify_hints, recommended}
        """
        assertion = str(assertion)
        refs = re.findall(r'https?://\S+|[\w.-]+\.(?:md|json|txt|log)\b', assertion)
        # 代码类断言（含函数名/命令/文件路径）→ 建议沙盒验证
        code_hint = bool(re.search(r'[a-zA-Z_]\w*\s*\(|`[^`]+`|\.py\b|\.js\b', assertion))
        mem_hint = bool(re.search(r'经验|卡片|记忆|之前|上次|曾', assertion))

        hints = []
        if refs:
            hints.append('直接核验引用来源：' + '、'.join(refs[:3]))
        if code_hint:
            hints.append('代码/命令类断言：建议在沙盒内实际执行验证（A5 世界模型对账）')
        if mem_hint:
            hints.append('涉及历史经验：建议检索记忆/经验卡片对照（阶段1 记忆检索）')
        if not hints:
            hints.append('无内联引用：建议标注为待查证，或补充数据来源后再下结论')

        return {
            'assertion': assertion,
            'refs_found': refs[:3],
            'verify_hints': hints,
            'recommended': 'verify' if (code_hint or refs) else 'mark_unverified',
        }
