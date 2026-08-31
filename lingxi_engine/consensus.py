# 收敛检测共享模块
#
# 背景：orchestrator.py 与 role_discussion.py 曾各自维护一份几乎相同的
# 收敛检测实现，已经出现行为漂移的风险面。现抽成单一实现，两个编排器
# 都委托到这里，保证语义一致。
#
# 检测逻辑（双通道 + 分歧信号拦截）：
#   0. 分歧信号拦截：任一发言明确表达反对/分歧（且不被否定词修饰），必不收敛
#   1. 相似度硬判定：全配对相似度的【最小值】达到阈值才判定收敛。
#      （旧实现只看相邻对，A≈B、B≈C 不代表 A≈C，存在漏判；改用全配对最小值）
#   2. 总结者软兜底：相似度未达硬阈值但有趋同倾向（最小值超过最低线）时，
#      交给总结者模型精确确认，避免漏判也避免误判。
#
# 纯标准库实现，无第三方依赖。

import difflib
from typing import Any, List, Optional, Sequence

from .roles import has_divergence

DEFAULT_CONSENSUS_THRESHOLD = 0.8


def extract_texts(round_results: Sequence[Any]) -> List[str]:
    """从轮次记录中提取发言文本。

    兼容两种输入：dict 记录列表（含 'response' 键）或纯文本列表。
    """
    texts: List[str] = []
    for item in round_results or []:
        if isinstance(item, dict):
            texts.append(str(item.get('response', '')))
        else:
            texts.append(str(item))
    return texts


def pairwise_similarity_scores(texts: Sequence[str]) -> List[float]:
    """计算全部两两配对的相似度（i<j 的所有组合）。"""
    scores: List[float] = []
    n = len(texts)
    for i in range(n):
        for j in range(i + 1, n):
            scores.append(difflib.SequenceMatcher(None, texts[i], texts[j]).ratio())
    return scores


def ask_summarizer_verdict(summarizer: Any, texts: Sequence[str]) -> bool:
    """让总结者模型判定是否达成共识。

    调用失败时降级为 False（宁可继续讨论，也不误报收敛）。
    """
    round_text = "\n".join(
        f"[发言{i + 1}]: {t}" for i, t in enumerate(texts)
    )
    prompt = (
        "你是总结者。请判断以下各模型的发言是否已经达成共识。\n"
        "如果观点已经收敛、没有实质分歧，请只回复：达成共识\n"
        "如果仍有实质分歧或需要继续讨论，请只回复：继续讨论\n\n"
        f"发言内容：\n{round_text}"
    )
    try:
        verdict = summarizer.invoke(prompt)
    except Exception:
        return False
    return '共识' in verdict and '继续' not in verdict


def check_consensus(
    texts: Sequence[str],
    threshold: float = DEFAULT_CONSENSUS_THRESHOLD,
    summarizer: Optional[Any] = None,
) -> bool:
    """判断一轮发言是否达成共识。

    参数：
        texts: 本轮全部发言文本
        threshold: 相似度硬阈值
        summarizer: 总结者模型（可为 None，此时退化为纯相似度判断）
    """
    if not texts:
        return False

    # ---- 通道零：分歧信号拦截（优先级最高）----
    if has_divergence(texts):
        return False

    scores = pairwise_similarity_scores(texts)
    if not scores:
        return False  # 单条发言无从比较，不误判收敛

    min_sim = min(scores)

    # ---- 通道一：相似度硬判定（全配对最小值达标才算收敛）----
    if min_sim >= threshold:
        return True

    # ---- 通道二：总结者软兜底 ----
    # 触发条件：存在趋同倾向（最小值超过最低线），但未全达硬阈值。
    if summarizer is not None and min_sim >= threshold * 0.5:
        return ask_summarizer_verdict(summarizer, texts)

    return False
