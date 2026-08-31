# 经验卡片蒸馏
#
# 对应 AGI 进化路线图【阶段1·让它记住】中的"经验蒸馏"：
#   把一次讨论/反思中产生的、可复用的经验，提炼成一张张"经验卡片"，
#   沉淀进 Memory.long_term / cards，实现"越用越聪明"。
#
# 蒸馏流程（三层）：
#   1. 触发：一次多轮讨论或反思结束后，把全部发言喂给蒸馏器
#   2. 抽取：用启发式规则 + 可选 LLM 提炼出"经验/教训/偏好"
#   3. 沉淀：写成卡片（含来源、置信度、类型），写入记忆系统
#
# 无需外部依赖即可运行（纯 Python 启发式），也支持注入 model.invoke 升级为 LLM 蒸馏。

from typing import Any, Dict, List, Optional

# 经验卡片的类型
CARD_TYPES = ('教训', '偏好', '事实', '方法')


class Distiller:
    """经验卡片蒸馏器。

    用法：
        d = Distiller(store=memory)
        cards = d.distill(records, source='讨论:xxx')
        memory.add_card(cards[0])  # 或由 distill_and_store 自动沉淀
    """

    # 单次蒸馏产出的卡片数上限：防止一次讨论生成过多低质卡片
    MAX_CARDS_PER_DISTILL = 20

    def __init__(self, store=None, model: Optional[Any] = None,
                 min_length: int = 8, max_cards: int = 20):
        """
        参数：
            store: 一个 Memory 实例（可选），用于沉淀卡片
            model: 可选，带 invoke(text) 方法的模型；提供则走 LLM 蒸馏
            min_length: 候选经验句子的最小长度，过滤过短/无意义内容
            max_cards: 单次蒸馏产出的卡片数上限（Memory 侧另有总量上限）
        """
        self.store = store
        self.model = model
        self.min_length = min_length
        self.max_cards = max_cards

    # ---------- 启发式抽取 ----------
    # 触发词：命中即视为"值得沉淀的经验"
    _TRIGGERS = [
        '不要', '应该', '必须', '最好', '建议', '注意', '记住',
        '经验', '教训', '坑', '避免', '优先', '推荐', '惯例',
        '发现并验证', '结论是', '关键在于', '要点是', '用户偏好', '用户喜欢',
        '用户不喜欢', '下次', '以后',
    ]

    def _extract_candidates(self, text: str) -> List[str]:
        """按句子切分，挑出含触发词、长度足够的句子作为候选经验。"""
        import re
        # 按中文句号/感叹号/问号/分号切句
        sentences = re.split(r'[。！？；\n]', text)
        cands = []
        for s in sentences:
            s = s.strip()
            if len(s) < self.min_length:
                continue
            if any(t in s for t in self._TRIGGERS):
                cands.append(s)
        return cands

    @staticmethod
    def _classify(text: str) -> str:
        """给经验句子打类型标签。"""
        if any(t in text for t in ('不要', '避免', '坑', '教训')):
            return '教训'
        if any(t in text for t in ('用户喜欢', '用户不喜欢', '偏好', '喜欢')):
            return '偏好'
        if any(t in text for t in ('发现', '结论', '事实', '是')):
            return '事实'
        return '方法'

    # ---------- LLM 蒸馏（可选） ----------
    def _llm_distill(self, records: List[str]) -> List[Dict[str, Any]]:
        """用注入的模型做一次高质量蒸馏，返回结构化卡片。"""
        prompt = (
            "请从以下多模型讨论/反思记录中，提炼出 2-4 条可复用的经验或教训。\n"
            "每条输出为 JSON：{\"content\": \"经验内容\", \"type\": \"教训|偏好|事实|方法\"}\n"
            "要求：具体、可执行、避免空话。\n\n记录如下：\n"
            + "\n".join(f"- {r}" for r in records)
        )
        raw = self.model.invoke(prompt)
        import json
        import re
        cards = []
        # 尝试解析 JSON 数组
        m = re.search(r'\[.*\]', raw, re.S)
        if m:
            try:
                for item in json.loads(m.group(0)):
                    if isinstance(item, dict) and item.get('content'):
                        cards.append({
                            'content': item['content'],
                            'type': item.get('type', '方法'),
                        })
            except json.JSONDecodeError:
                cards = []
        # 若解析失败，退回启发式
        return cards

    # ---------- 蒸馏主流程 ----------
    def distill(self, records: List[str], source: str = '') -> List[Dict[str, Any]]:
        """从发言记录中蒸馏经验卡片。

        参数：
            records: 讨论/反思的发言文本列表
            source: 来源描述（如 '讨论:如何设计记忆系统'）
        返回：
            经验卡片列表（尚未写入 store）
        """
        # 优先走 LLM 蒸馏
        if self.model is not None:
            cards = self._llm_distill(records)
            if cards:
                for c in cards:
                    c['source'] = source
                return cards

        # 启发式蒸馏
        cards = []
        seen = set()
        for rec in records:
            for cand in self._extract_candidates(rec):
                if cand in seen:
                    continue
                seen.add(cand)
                cards.append({
                    'content': cand,
                    'type': self._classify(cand),
                    'source': source,
                })
                if len(cards) >= self.max_cards:
                    return cards
        return cards

    def distill_and_store(self, records: List[str], source: str = '') -> List[Dict[str, Any]]:
        """蒸馏并自动沉淀到 store（Memory），返回写入的卡片。"""
        if self.store is None:
            raise ValueError("distill_and_store 需要先传入 store（Memory 实例）")
        cards = self.distill(records, source)
        for c in cards:
            self.store.add_card(c)
        return cards
