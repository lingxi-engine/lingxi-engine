# 错题本（评测消费端）
#
# 对应 AGI 进化路线图【阶段4·让它"进化"】P0 行动项 A2：
#   "评测消费端接线——读取 evaluation-records.json 低分记录，建立错题本数据源"
#
# 背景：TS 引擎 Evaluator 已把每次回复的质量评测写入
#   data/evaluation-records.json（score 0-100 + issues 问题清单 + fix 修正建议），
#   查询接口也已有（GET /api/evaluations/*），但【没有任何代码读取低分记录】——
#   评测数据只被"记录"和"查询"，从未被"消费"。低分记录是自博弈最好的种子：
#   "考砸"的输入 + 专家给出的修正建议（issues[].fix）→ 错题本。
#
# 本模块就是那个缺失的消费端：
#   1. 加载评测记录，按阈值筛出低分（考砸）记录
#   2. 提供错题统计（错误类型/严重度分布、平均分、Top 模型）
#   3. 生成自博弈种子样本（A3 run_selfplay 的输入素材）
#   4. 生成上下文注入块（让引擎"知道自己考砸过什么"）
#   5. 错题本落盘为 mistake_book.json，供下游稳定消费
#
# 数据格式说明：当前评测记录只存 triggerLen（输入长度），未存 trigger 原文；
#   因此种子样本以 issues 中的问题描述（description）与修正建议（fix）为锚点，
#   而不是依赖用户原话——错题本的价值在"错误模式 + 修正方法"，不在一句话本身。
#
# 纯 Python 实现，无外部依赖；评测文件不存在时优雅降级（空错题本，不报错）。

import json
import os
import time
from typing import Any, Dict, List, Optional

# 引擎默认评测记录路径（TS 侧 Evaluator 的落盘位置）
_DEFAULT_EVAL_PATHS = (
    os.path.join(os.environ.get("USERPROFILE") or os.path.expanduser("~"),
                  "lingxi-engine", "data", "evaluation-records.json"),
)


class MistakeBook:
    """错题本：把低分评测记录变成可消费的训练/改进素材。

    用法：
        book = MistakeBook(config={'mistake_threshold': 60})
        book.summary()          # 错题统计
        book.seed_samples(5)    # 自博弈种子（A3 输入）
        book.context_block('文件读取', top_k=3)  # 上下文注入
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        # 低分阈值：score < threshold 视为"考砸了"
        self.threshold = float(self.config.get('mistake_threshold', 60))
        # 评测文件路径：显式指定 > 相对 memory_data_dir > 引擎默认路径
        self.path = self._resolve_path()
        # 错题记录（低分）与全部记录
        self.records: List[Dict[str, Any]] = []
        self.all_records: List[Dict[str, Any]] = []
        self.loaded_at: Optional[float] = None
        self._load()

    # ---------- 路径解析 ----------
    def _resolve_path(self) -> Optional[str]:
        """解析评测记录文件路径；找不到返回 None（优雅降级）。"""
        explicit = self.config.get('eval_records_path')
        if explicit and os.path.isfile(explicit):
            return explicit

        # 相对 memory_data_dir 探测
        mem_dir = self.config.get('memory_data_dir', 'data')
        rel = os.path.join(mem_dir, 'evaluation-records.json')
        if os.path.isfile(rel):
            return rel

        # 引擎默认路径
        for p in _DEFAULT_EVAL_PATHS:
            if os.path.isfile(p):
                return p
        return None

    # ---------- 加载 ----------
    def _load(self) -> None:
        """加载评测记录，筛出低分错题。文件缺失/损坏时优雅降级为空。"""
        self.all_records = []
        self.records = []
        if self.path is None:
            return
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if not isinstance(data, list):
                return
            self.all_records = data
            self.records = [
                r for r in data
                if isinstance(r, dict) and r.get('score') is not None
                and float(r['score']) < self.threshold
            ]
            self.loaded_at = time.time()
        except (OSError, json.JSONDecodeError, ValueError):
            self.records = []
            self.all_records = []

    def reload(self) -> None:
        """重新加载（评测记录是增量写入的，跑批前先 reload 拿到最新错题）。"""
        self._load()

    # ---------- 工具 ----------
    @staticmethod
    def _problem_anchor(record: Dict[str, Any]) -> str:
        """提取一条错题的"问题锚点"：优先用户原话，否则用第一条 issue 描述。

        当前评测记录未存 trigger 原文，因此锚点退化为 issue 描述——
        描述里包含了用户意图与出错点的完整信息，足以支撑自博弈评分。
        """
        trigger = record.get('trigger')
        if isinstance(trigger, str) and trigger.strip():
            return trigger.strip()
        issues = record.get('issues') or []
        if issues:
            desc = str(issues[0].get('description', '')).strip()
            if desc:
                return desc[:120]
        return '(无输入记录)'

    # ---------- 统计 ----------
    def summary(self) -> Dict[str, Any]:
        """错题统计：总量、平均分、通过率、错误类型/严重度分布、Top 模型。"""
        recs = self.records
        total = len(recs)
        if total == 0:
            return {
                'source': self.path,
                'loaded': self.loaded_at is not None,
                'total': 0,
                'avg_score': 0.0,
                'issue_types': {},
                'severity': {},
                'top_models': [],
            }

        scores = [float(r['score']) for r in recs]
        type_counter: Dict[str, int] = {}
        sev_counter: Dict[str, int] = {}
        model_counter: Dict[str, Dict[str, Any]] = {}
        for r in recs:
            m = r.get('model', '?')
            mc = model_counter.setdefault(m, {'count': 0, 'sum': 0.0})
            mc['count'] += 1
            mc['sum'] += float(r['score'])
            for issue in r.get('issues', []) or []:
                t = issue.get('type', '?')
                type_counter[t] = type_counter.get(t, 0) + 1
                s = issue.get('severity', '?')
                sev_counter[s] = sev_counter.get(s, 0) + 1

        top_models = [
            {'model': m, 'count': v['count'],
             'avg_score': round(v['sum'] / v['count'], 1)}
            for m, v in model_counter.items()
        ]
        top_models.sort(key=lambda x: x['count'], reverse=True)

        return {
            'source': self.path,
            'loaded': self.loaded_at is not None,
            'total': total,
            'avg_score': round(sum(scores) / total, 1),
            'min_score': min(scores),
            'issue_types': type_counter,
            'severity': sev_counter,
            'top_models': top_models[:5],
        }

    # ---------- 自博弈种子（A3 输入） ----------
    def seed_samples(self, limit: int = 10) -> List[Dict[str, Any]]:
        """生成自博弈种子样本。

        每条样本 = 一道"做错的题"：问题锚点 + 原得分 + 问题清单 + 修正建议。
        这是 run_selfplay 的天然"用户侧输入"：让模型重答这道做错的题，
        用 issues/fix 做评分信号，答对了就是一次真实的"补课"。

        返回：[
            {'problem': 问题锚点, 'score': 原得分,
             'issues': [{type, severity, description, fix}],
             'model': 当时作答的模型}
        ]
        """
        recs = sorted(self.records, key=lambda r: float(r.get('score', 0)))
        samples = []
        for r in recs[:limit]:
            samples.append({
                'problem': self._problem_anchor(r),
                'score': float(r.get('score', 0)),
                'issues': list(r.get('issues', []) or []),
                'model': r.get('model', '?'),
            })
        return samples

    # ---------- 上下文注入 ----------
    def context_block(self, query: str = '', top_k: int = 3) -> str:
        """生成错题上下文块（注入 prompt，让引擎"知道自己考砸过什么"）。

        按 query 关键词相关度选错题；无 query 时取分最低的几条。
        """
        if not self.records:
            return ''
        pool = list(self.records)
        if query:
            q_words = [w for w in query.replace('，', ' ').replace('、', ' ').split() if w]
            if q_words:
                def _rel(r):
                    text = self._problem_anchor(r)
                    hits = sum(1 for w in q_words if w in text)
                    return hits / max(len(q_words), 1)
                pool.sort(key=lambda r: (_rel(r), -float(r.get('score', 0))),
                          reverse=True)
            else:
                pool.sort(key=lambda r: float(r.get('score', 0)))
        else:
            pool.sort(key=lambda r: float(r.get('score', 0)))

        lines = ['【错题本提醒（低分评测记录）】']
        for r in pool[:top_k]:
            anchor = self._problem_anchor(r)
            score = r.get('score')
            top_issue = ''
            if r.get('issues'):
                top_issue = str(r['issues'][0].get('description', ''))[:120]
            lines.append(f"- 「{anchor[:60]}」曾得 {score} 分；主要问题：{top_issue}")
        lines.append('请避免重犯上述错误。')
        return '\n'.join(lines)

    # ---------- 高频错误类型（A6 好奇探索选题素材） ----------
    def top_issue_types(self, n: int = 5) -> List[Dict[str, Any]]:
        """按出现次数排序的高频错误类型，供好奇探索器选题。"""
        counter: Dict[str, int] = {}
        for r in self.records:
            for issue in r.get('issues', []) or []:
                t = issue.get('type', '?')
                counter[t] = counter.get(t, 0) + 1
        items = [{'type': t, 'count': c} for t, c in counter.items()]
        items.sort(key=lambda x: x['count'], reverse=True)
        return items[:n]

    # ---------- 错题本落盘 ----------
    def save(self, path: Optional[str] = None) -> str:
        """把错题本落盘为 mistake_book.json（供下游稳定消费）。"""
        data_dir = self.config.get('memory_data_dir', 'data')
        os.makedirs(data_dir, exist_ok=True)
        target = path or os.path.join(data_dir, 'mistake_book.json')
        payload = {
            'generated_at': time.time(),
            'threshold': self.threshold,
            'source': self.path,
            'summary': self.summary(),
            'mistakes': self.records[:200],
        }
        tmp = target + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, target)
        return target
