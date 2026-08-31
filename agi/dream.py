# 离线做梦（A7）——空闲算力重放 + 变异重组
#
# 对应 AGI 进化路线图【阶段4·让它"进化"】P0 行动项 A7：
#   "离线做梦——用空闲算力重放历史经验，变异重组出新假设"
#
# 核心思想：学习不只发生在"做题时"，也发生在"休息时"。
#   哺乳动物睡眠时重放白天的经历来巩固记忆；引擎也可以：
#   在空闲算力下，把历史经验（错题、自博弈记录、世界模型反事实样本、
#   记忆卡片、探索发现）重放一遍，再做变异重组，产生"新假设"——
#   这些假设不一定对，但它们是探索的种子（喂给 A6 好奇探索器验证）。
#
# 设计：
#   1. replay(sources)：重放多个来源的历史记录（错题/自博弈/反事实/记忆卡片）
#   2. mutate(text)：变异重组单条经验（词语替换 / 拼接 / 反转 / 主题翻转）
#   3. dream(sources)：一次完整做梦——取材 → 重放 → 变异 → 产出假设队列
#   4. 假设队列落盘 data/dream_queue.json（config['dream_queue_file']），
#      供 A6 好奇探索器消费（探索队列里的假设 = 待验证的新想法）
#   5. consume_queue(n)：A6 侧取走待验证假设
#
# 纯 Python 实现，无外部依赖；任何来源不可用时优雅降级不崩溃。

import json
import os
import random
import time
from typing import Any, Dict, List, Optional


class Dreamer:
    """离线做梦器：空闲算力下的经验重放 + 假设生成。"""

    # 变异词对：把经验里的 A 词替换成 B 词，制造"换个角度"
    _MUTATION_PAIRS = [
        ('不要', '要'),
        ('必须', '可以'),
        ('用户', '系统'),
        ('快', '慢'),
        ('简单', '复杂'),
        ('成功', '失败'),
        ('提升', '降低'),
        ('增加', '减少'),
        ('优先', '延后'),
        ('明确', '模糊'),
    ]
    # 变异模板：拼接出新的假设句式
    _MUTATION_TEMPLATES = [
        '如果 {a}，那么 {b} 是否也成立？',
        '把 {a} 与 {b} 组合，能否解决单一方案解决不了的问题？',
        '{a} 的反面是什么？在什么条件下反面更好？',
        '从 {a} 可以推断出什么隐含假设？这个假设还成立吗？',
        '能否用 {b} 的思路重新解决 {a} 指向的问题？',
    ]

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        self.config = config or {}
        self.queue: List[Dict[str, Any]] = []
        self._load_queue()

    # ---------- 取材 ----------
    def _gather_sources(self) -> Dict[str, List[str]]:
        """收集可重放的素材（各来源异常时静默降级为空列表）。"""
        sources: Dict[str, List[str]] = {}
        data_dir = self.config.get('memory_data_dir', 'data')

        # 1. 错题本（A2 产物）
        try:
            from .mistakes import MistakeBook
            book = MistakeBook(config=self.config)
            sources['错题本'] = [
                s.get('problem', '') for s in book.seed_samples(10)
                if s.get('problem')
            ]
        except Exception:
            sources['错题本'] = []

        # 2. 自博弈记录（A3 产物）
        try:
            sp_path = os.path.join(data_dir, 'selfplay_records.json')
            if os.path.isfile(sp_path):
                with open(sp_path, 'r', encoding='utf-8') as f:
                    sp = json.load(f)
                sources['自博弈'] = [
                    str(r.get('final_answer', ''))[:100]
                    for r in (sp.get('records') or [])[:10]
                    if r.get('final_answer')
                ]
        except Exception:
            sources['自博弈'] = []

        # 3. 世界模型反事实样本（A5 产物）
        try:
            from .world_model import WorldModel
            wm = WorldModel(config=self.config)
            sources['反事实'] = [
                f"预测 {p.get('action')} 会 {p.get('prediction', {}).get('ok')}，"
                f"实际 {p.get('actual', {}).get('ok')}"
                for p in wm.counterfactuals(10)
            ]
        except Exception:
            sources['反事实'] = []

        # 4. 记忆卡片（阶段1 产物）
        try:
            from .memory import Memory
            mem = Memory(data_dir=data_dir)
            sources['记忆卡片'] = [
                str(c.get('content', '')) for c in mem.cards[-10:]
            ]
        except Exception:
            sources['记忆卡片'] = []

        # 5. 探索发现（A6 产物）
        try:
            log_path = os.path.join(data_dir, 'curiosity_log.json')
            if os.path.isfile(log_path):
                with open(log_path, 'r', encoding='utf-8') as f:
                    clog = json.load(f)
                sources['探索发现'] = [
                    str(f)[:100] for r in clog[-10:]
                    for f in (r.get('findings') or [])
                ]
        except Exception:
            sources['探索发现'] = []

        return sources

    # ---------- 变异 ----------
    def mutate(self, text: str) -> List[str]:
        """对一条经验做变异重组，产出 1-3 个变体假设。"""
        text = str(text).strip()
        if not text:
            return []
        out: List[str] = []
        # 变体 1：关键词替换
        for a, b in self._MUTATION_PAIRS:
            if a in text:
                out.append(text.replace(a, b, 1))
                break
        # 变体 2：模板拼接（取两段不同的素材拼）
        out.append(self._MUTATION_TEMPLATES[0].format(a=text[:40], b='经验'))
        return out[:3]

    def _mutate_pair(self, a: str, b: str) -> str:
        """两段素材组合出新假设。"""
        return self._MUTATION_TEMPLATES[1].format(a=a[:40], b=b[:40])

    # ---------- 做梦主流程 ----------
    def dream(self, max_hypotheses: int = 8, seed: Optional[int] = None) -> Dict[str, Any]:
        """一次完整做梦：取材 → 重放 → 变异 → 假设入队。

        返回 {sources_used, replayed, hypotheses, queue_size, queue_file}
        """
        if seed is not None:
            random.seed(seed)
        sources = self._gather_sources()
        all_items: List[str] = []
        for name, items in sources.items():
            all_items.extend(items)

        replayed = len(all_items)
        hypotheses: List[str] = []

        # 变异：单条替换
        for item in all_items[:max_hypotheses]:
            for v in self.mutate(item):
                hypotheses.append(v)
                if len(hypotheses) >= max_hypotheses:
                    break
            if len(hypotheses) >= max_hypotheses:
                break

        # 变异：两两组合（素材充足时补充）
        if len(hypotheses) < max_hypotheses and len(all_items) >= 2:
            for i in range(0, min(len(all_items), 6), 2):
                if i + 1 < len(all_items):
                    hypotheses.append(self._mutate_pair(all_items[i], all_items[i + 1]))
                    if len(hypotheses) >= max_hypotheses:
                        break

        # 入队（每条假设带来源与时间戳，供 A6 消费）
        new_entries = []
        for h in hypotheses[:max_hypotheses]:
            entry = {
                'hypothesis': h,
                'ts': time.time(),
                'status': 'pending',   # pending → 被 A6 取走验证 → verified/falsified
            }
            self.queue.append(entry)
            new_entries.append(entry)
        self._save_queue()

        return {
            'sources_used': {k: len(v) for k, v in sources.items()},
            'replayed': replayed,
            'hypotheses_generated': len(new_entries),
            'queue_size': len(self.queue),
            'queue_file': self._queue_path(),
        }

    # ---------- 队列 ----------
    def _queue_path(self) -> str:
        data_dir = self.config.get('memory_data_dir', 'data')
        fname = self.config.get('dream_queue_file', 'dream_queue.json')
        return os.path.join(data_dir, fname)

    def _load_queue(self) -> None:
        p = self._queue_path()
        if not os.path.isfile(p):
            return
        try:
            with open(p, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                self.queue = data
        except (OSError, json.JSONDecodeError):
            self.queue = []

    def _save_queue(self) -> None:
        try:
            p = self._queue_path()
            os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
            tmp = p + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.queue, f, ensure_ascii=False, indent=2)
            os.replace(tmp, p)
        except OSError:
            pass

    def consume_queue(self, n: int = 3) -> List[Dict[str, Any]]:
        """A6 侧取走待验证假设（取走后标记 in_progress，不删除——保留审计痕迹）。"""
        pending = [e for e in self.queue if e.get('status') == 'pending']
        taken = pending[:n]
        for e in taken:
            e['status'] = 'in_progress'
        self._save_queue()
        return taken

    def mark_result(self, hypothesis: str, verdict: str) -> None:
        """验证后回写结论（verified/falsified），闭环。"""
        for e in self.queue:
            if e.get('hypothesis') == hypothesis:
                e['status'] = verdict
                e['resolved_at'] = time.time()
        self._save_queue()

    # ---------- 统计 ----------
    def stats(self) -> Dict[str, Any]:
        return {
            'queue_size': len(self.queue),
            'pending': sum(1 for e in self.queue if e.get('status') == 'pending'),
            'verified': sum(1 for e in self.queue if e.get('status') == 'verified'),
            'falsified': sum(1 for e in self.queue if e.get('status') == 'falsified'),
            'queue_file': self._queue_path(),
        }
