# 记忆系统：三层记忆（短期 / 长期 / 经验卡片）
#
# 对应 AGI 进化路线图【阶段1·让它记住】：
#   - 短期记忆：当前会话内的上下文，随会话结束清空
#   - 长期记忆：跨会话持久化（JSON 落盘），记录关键事实与偏好
#   - 经验卡片：由 distill 模块蒸馏出的可复用经验，带来源与置信度
#
# 设计要点：
#   1. 记忆带时间戳与衰减（越旧权重越低），避免上下文无限膨胀
#   2. 长期记忆与经验卡片可持久化到 data/ 目录，实现"越用越聪明"
#   3. 检索时按相关度 + 新鲜度加权排序，供下游注入上下文
#   4. 【可靠性】持久化采用"临时文件 + os.replace 原子替换"，进程中途
#      崩溃不会留下半截 JSON；加载遇到坏文件时先备份原文件再重建，
#      绝不静默清空用户数据。

import json
import os
import time
from typing import Any, Dict, List, Optional


class Memory:
    """三层记忆容器。

    用法：
        mem = Memory(data_dir='data')
        mem.remember_short('用户喜欢简洁的回答')
        mem.remember_long('项目名是灵犀引擎')
        cards = mem.search('偏好')
    """

    # 经验卡片数量上限：防止卡片无限膨胀拖慢检索（超出时按新旧保留最新的）
    MAX_CARDS = 500

    def __init__(self, data_dir: str = 'data'):
        self.data_dir = data_dir
        # 短期记忆：仅存于内存，会话结束即清空
        self.short_term: List[Dict[str, Any]] = []
        # 长期记忆：持久化
        self.long_term: List[Dict[str, Any]] = []
        # 经验卡片：由 distill 蒸馏写入
        self.cards: List[Dict[str, Any]] = []

        self._load()

    # ---------- 路径与持久化 ----------
    def _path(self, name: str) -> str:
        return os.path.join(self.data_dir, name)

    def _load(self) -> None:
        """加载数据。坏文件先备份为 <name>.corrupt，再从空开始，绝不静默丢数据。"""
        os.makedirs(self.data_dir, exist_ok=True)
        for key, attr in (('long_term.json', 'long_term'), ('cards.json', 'cards')):
            p = self._path(key)
            if os.path.exists(p):
                try:
                    with open(p, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    if not isinstance(data, list):
                        raise ValueError(f'{key} 内容不是列表')
                    setattr(self, attr, data)
                except (json.JSONDecodeError, ValueError, OSError):
                    # 备份坏文件，避免下次覆盖时彻底丢失原始数据
                    try:
                        backup = p + '.corrupt'
                        with open(p, 'rb') as src, open(backup, 'wb') as dst:
                            dst.write(src.read())
                    except OSError:
                        pass
                    setattr(self, attr, [])

    @staticmethod
    def _atomic_write(path: str, data: List[Dict[str, Any]]) -> None:
        """原子写入：先写临时文件，再用 os.replace 原子替换。

        os.replace 在 Windows/Linux 上都是原子的；即使写入过程中崩溃，
        也只会留下一个 .tmp 文件，目标文件保持上一次的完整状态。
        """
        tmp_path = path + '.tmp'
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)

    def _save(self, name: str, data: List[Dict[str, Any]]) -> None:
        os.makedirs(self.data_dir, exist_ok=True)
        try:
            self._atomic_write(self._path(name), data)
        except OSError:
            # 落盘失败时至少保证内存态可用，不让主流程崩掉；
            # 下一次写入仍会重试。
            pass

    # ---------- 写入 ----------
    def remember_short(self, content: str, **meta) -> None:
        """写入短期记忆（带时间戳）。"""
        self.short_term.append({
            'content': content,
            'ts': time.time(),
            **meta,
        })

    def remember_long(self, content: str, **meta) -> None:
        """写入长期记忆并持久化。"""
        self.long_term.append({
            'content': content,
            'ts': time.time(),
            **meta,
        })
        self._save('long_term.json', self.long_term)

    def add_card(self, card: Dict[str, Any]) -> None:
        """写入一张经验卡片并持久化（卡片由 distill 生成）。

        相似度去重：内容高度相似（SequenceMatcher >= 0.9）的卡片不再重复入库，
        防止蒸馏触发词过泛导致同义卡片爆炸。
        """
        if 'ts' not in card:
            card['ts'] = time.time()
        content = str(card.get('content', ''))

        import difflib
        for existing in self.cards:
            if existing.get('content') == card.get('content'):
                return  # 完全相同，直接跳过
            ratio = difflib.SequenceMatcher(
                None, content, str(existing.get('content', ''))).ratio()
            if ratio >= 0.9 and len(content) > 0:
                return  # 高度相似，跳过

        self.cards.append(card)
        # 数量上限：只保留最新 MAX_CARDS 张
        if len(self.cards) > self.MAX_CARDS:
            self.cards = self.cards[-self.MAX_CARDS:]
        self._save('cards.json', self.cards)

    # ---------- 衰减 ----------
    @staticmethod
    def _decay(ts: float, now: float, half_life: float = 86400.0) -> float:
        """按时间指数衰减：半个衰减周期后权重减半。默认半衰期 1 天。"""
        return 0.5 ** ((now - ts) / half_life)

    # ---------- 检索 ----------
    def _score(self, item: Dict[str, Any], query: str) -> float:
        """相关度 + 新鲜度加权。相关度用关键词命中近似。"""
        content = str(item.get('content', ''))
        # 简单关键词相关度：query 的词在 content 中出现越多分越高
        q_words = [w for w in query.replace('，', ' ').replace('、', ' ').split() if w]
        hits = sum(1 for w in q_words if w in content)
        rel = hits / max(len(q_words), 1)
        fresh = self._decay(item.get('ts', 0), time.time())
        # 相关度权重 0.7，新鲜度权重 0.3
        return 0.7 * rel + 0.3 * fresh

    def search(self, query: str, top_k: int = 5, sources: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        """跨层检索，按加权分排序返回 top_k 条记忆。

        sources: 限定检索哪些层，默认全部（short/long/cards）。
        """
        sources = sources or ['short', 'long', 'cards']
        pool: List[Dict[str, Any]] = []
        if 'short' in sources:
            pool += [dict(it, _layer='short') for it in self.short_term]
        if 'long' in sources:
            pool += [dict(it, _layer='long') for it in self.long_term]
        if 'cards' in sources:
            pool += [dict(it, _layer='card') for it in self.cards]

        scored = [(self._score(it, query), it) for it in pool]
        scored.sort(key=lambda x: x[0], reverse=True)
        return [it for _, it in scored[:top_k]]

    def context_block(self, query: str, top_k: int = 5) -> str:
        """生成可直接拼进 prompt 的上下文文本。"""
        items = self.search(query, top_k=top_k)
        if not items:
            return ''
        lines = []
        for it in items:
            layer = it.get('_layer', '?')
            content = it.get('content', '')
            lines.append(f"[{layer}] {content}")
        return "\n".join(lines)

    # ---------- 会话清理 ----------
    def clear_short(self) -> None:
        """清空短期记忆（新会话调用）。"""
        self.short_term = []

    # ---------- 统计 ----------
    def stats(self) -> Dict[str, int]:
        return {
            'short': len(self.short_term),
            'long': len(self.long_term),
            'cards': len(self.cards),
        }
