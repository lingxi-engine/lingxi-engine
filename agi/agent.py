# 智能体
class Agent:
    def __init__(self, name, model, role='general'):
        self.name = name
        self.model = model
        self.role = role
        self.memory = []

    def think(self, prompt):
        return self.model.invoke(prompt)

    def reflect(self, own_response, others_responses):
        """反思机制：让模型看到自己上一轮的发言及其他模型的回复，
        生成修订意见或补充观点（二者选其一）。

        参数：
            own_response: 该模型上一轮自己的发言（需反思的对象）
            others_responses: 其他模型在本轮之前给出的回复列表
        返回：
            修订后的观点，或在原观点基础上的补充观点。
        """
        others = "\n".join(f"[其他模型{i + 1}]: {r}" for i, r in enumerate(others_responses))
        return self.model.invoke(
            f"你上一轮的观点是：{own_response}\n"
            f"其他模型的回复：\n{others}\n"
            f"请反思。要求：\n"
            f"1. 如果其他模型指出了你观点中的漏洞或不足，请给出修订后的观点；\n"
            f"2. 如果你的观点无需修订，请基于其他模型的讨论补充新的观点或论据；\n"
            f"3. 请明确输出【修订】或【补充】作为开头，再给出内容。"
        )

    def vote(self, options):
        """投票机制：让模型从候选项中选出最认可的一个。

        实现：把候选项编号后交给底层模型评估，解析其回复中的选项编号；
        解析失败时降级为 None（明确表示"没投出来"），绝不假装投了票。
        """
        if not options:
            return None
        if len(options) == 1:
            return options[0]

        numbered = "\n".join(f"{i + 1}. {opt}" for i, opt in enumerate(options))
        prompt = (
            f"请从以下候选方案中选出你认为最认可的一个，只回复选项编号（如 1、2、3）。\n\n{numbered}"
        )
        try:
            resp = str(self.model.invoke(prompt)).strip()
        except Exception:
            return None

        # 从回复中提取第一个出现的合法编号
        import re
        m = re.search(r'\d+', resp)
        if m:
            idx = int(m.group(0)) - 1
            if 0 <= idx < len(options):
                return options[idx]
        return None

    def remember(self, item):
        self.memory.append(item)


def collect_votes(voters, options):
    """让多个投票人对候选项真实投票，返回结构化结果。

    参数：
        voters: {名字: 投票人} 映射；投票人需带 vote(options) 方法，
                没有该方法或投票失败的自动弃权，绝不伪造选票。
        options: 候选项列表（至少 2 项才有意义）
    返回：
        {"winner": 得票最多的候选项或 None,
         "tally": {候选项: 票数},
         "ballots": {投票人: 所投候选项}}
    """
    tally = {}
    ballots = {}
    for name, voter in dict(voters or {}).items():
        vote_fn = getattr(voter, 'vote', None)
        if not callable(vote_fn):
            continue  # 无投票能力的对象直接跳过
        try:
            choice = vote_fn(list(options))
        except Exception:
            continue  # 投票失败视为弃权
        if choice is None:
            continue
        ballots[name] = choice
        tally[choice] = tally.get(choice, 0) + 1
    winner = None
    if tally:
        winner = max(tally.items(), key=lambda kv: kv[1])[0]
    return {'winner': winner, 'tally': tally, 'ballots': ballots}

