# 好奇探索器（A6）——置信度驱动选题 + 沙盒预算
#
# 对应 AGI 进化路线图【阶段4·让它"进化"】P0 行动项 A6：
#   "好奇探索器——引擎主动探索自己不懂的领域"
#
# 核心思想：好奇不是随机，而是"知道哪里不懂才去问"。
#   引擎的"不懂"有两个现成信号源：
#     1. A4 置信度评估：低置信度断言（needs_verification > 0）→ 有事实待查证
#     2. A2 错题本：高频错误类型（top_issue_types）→ 有薄弱环节待补强
#   好奇探索器把这两类信号变成"探索主题"，然后在沙盒里做小实验，
#   用真实执行结果回答"我到底哪里理解错了"。
#
# 设计：
#   1. select_topics(confidence_report, mistake_types, budget)：
#      按优先级（低置信度断言 > 高频错误类型 > 随机候选）选题
#   2. explore(topic)：对主题构造探索实验（沙盒命令），受 curiosity_budget 约束
#      - 预算 = 单次探索最多执行的沙盒命令条数，防预算失控
#      - 探索产出 {topic, hypothesis, commands, results, findings}
#   3. 探索日志落盘 data/curiosity_log.json
#   4. 探索发现可选蒸馏沉淀为经验卡片（越探索越懂）
#
# 安全：所有实验命令走 Sandbox（白名单/超时/无 shell）；预算强制上限，
#   即使主题再多也只会执行有限条命令。纯 Python，无外部依赖。

import json
import os
import time
from typing import Any, Dict, List, Optional


class CuriosityExplorer:
    """好奇探索器：把"不懂"变成"实验"，把实验变成"理解"。"""

    # 探索主题 → 候选验证命令的构造规则（启发式）
    # key 为错误类型或主题关键词，value 为命令模板列表（{topic} 会被替换）
    _TOPIC_COMMANDS = {
        '指令遵循': ['echo "探索主题: {topic}"', 'dir .'],
        '相关性': ['echo "主题相关性检查: {topic}"', 'where python'],
        '模糊性': ['echo "歧义检查: {topic}"', 'pwd'],
        '事实性': ['echo "事实核验: {topic}"', 'dir .'],
        '完整性': ['echo "完整性检查: {topic}"', 'dir .'],
        '格式': ['echo "格式检查: {topic}"', 'pwd'],
        '默认': ['echo "探索: {topic}"', 'pwd'],
    }

    def __init__(self, config: Optional[Dict[str, Any]] = None,
                 sandbox: Optional[Any] = None, store=None):
        """初始化。

        config: 配置（读取 curiosity_budget / memory_data_dir / sandbox_*）
        sandbox: 可选 Sandbox；为 None 时惰性创建
        store: 可选 Memory，用于把探索发现蒸馏沉淀
        """
        self.config = config or {}
        self._sandbox = sandbox
        self.store = store
        # 预算：单次探索最多执行的命令条数（config['curiosity_budget']，默认 5）
        self.budget = max(1, int(self.config.get('curiosity_budget', 5)))
        self.log: List[Dict[str, Any]] = []
        self._load_log()

    # ---------- 沙盒 ----------
    def _get_sandbox(self):
        if self._sandbox is not None:
            return self._sandbox
        try:
            from .sandbox import Sandbox
            self._sandbox = Sandbox(config=self.config)
        except Exception:
            self._sandbox = None
        return self._sandbox

    # ---------- 选题 ----------
    def select_topics(self, confidence_report: Optional[Dict[str, Any]] = None,
                      mistake_types: Optional[List[Dict[str, Any]]] = None,
                      limit: int = 3) -> List[Dict[str, Any]]:
        """从"不懂信号"里选探索主题。

        优先级：
          1. 低置信度断言（A4 输出里 confidence < threshold 的断言）
          2. 高频错误类型（A2 错题本 top_issue_types）
          3. 兜底：通用探索主题
        返回：[{topic, source, priority, detail}]
        """
        topics: List[Dict[str, Any]] = []

        # 信号 1：A4 低置信度断言
        if confidence_report:
            low = confidence_report.get('low_confidence') or []
            for it in low[:limit]:
                topics.append({
                    'topic': str(it.get('assertion', ''))[:60],
                    'source': '低置信度断言',
                    'priority': 1,
                    'detail': it,
                })

        # 信号 2：A2 高频错误类型
        if mistake_types:
            for mt in mistake_types[:limit]:
                t = str(mt.get('type', ''))
                if t and not any(x['topic'] == t for x in topics):
                    topics.append({
                        'topic': t,
                        'source': '高频错误类型',
                        'priority': 2,
                        'detail': mt,
                    })

        # 兜底：通用主题
        if not topics:
            topics.append({
                'topic': '沙盒能力边界',
                'source': '默认',
                'priority': 3,
                'detail': {},
            })

        topics.sort(key=lambda x: x['priority'])
        return topics[:limit]

    # ---------- 探索 ----------
    def _commands_for(self, topic: str) -> List[str]:
        """为主题构造探索命令（受预算约束）。"""
        tpls = self._TOPIC_COMMANDS.get(topic, self._TOPIC_COMMANDS['默认'])
        cmds = [t.replace('{topic}', topic[:20]) for t in tpls]
        return cmds[:self.budget]

    def explore(self, topic: str) -> Dict[str, Any]:
        """对单个主题做一次探索实验。

        流程：构造假设 → 生成命令（预算内）→ 沙盒执行 → 记录发现。
        返回 {topic, hypothesis, commands, results, findings, budget_used, ts}
        """
        sb = self._get_sandbox()
        hypothesis = '引擎对「{0}」的理解可能存在偏差，需要用真实执行验证'.format(topic)
        cmds = self._commands_for(topic)
        results = []
        findings = []
        budget_used = 0

        for cmd in cmds:
            if budget_used >= self.budget:
                break
            budget_used += 1
            if sb is None:
                results.append({'command': cmd, 'ok': False,
                                'stderr': '沙盒不可用', 'stdout': '',
                                'exit_code': -99, 'elapsed': 0})
                continue
            try:
                results.append(sb.run(cmd))
            except Exception as e:
                results.append({'command': cmd, 'ok': False, 'stderr': str(e),
                                'stdout': '', 'exit_code': -3, 'elapsed': 0})

        # 发现提取：成功执行的命令 → "验证通过"；失败 → "需要进一步查证"
        for r in results:
            cmd_txt = r.get('command', '')
            if r.get('ok'):
                out = str(r.get('stdout', ''))[:80]
                findings.append('命令 `{0}` 执行成功，输出: {1}'.format(cmd_txt, out))
            else:
                err = str(r.get('stderr', ''))[:80]
                findings.append('命令 `{0}` 执行失败：{1}'.format(cmd_txt, err))

        rec = {
            'ts': time.time(),
            'topic': topic,
            'hypothesis': hypothesis,
            'commands': cmds,
            'results': results,
            'findings': findings,
            'budget_used': budget_used,
        }
        self.log.append(rec)
        self._save_log()

        # 可选：把发现蒸馏沉淀为经验卡片
        if self.store is not None and findings:
            try:
                from .distill import Distiller
                d = Distiller(store=self.store)
                d.distill_and_store(findings, source='好奇探索:{0}'.format(topic))
            except Exception:
                pass

        return rec

    def explore_many(self, topics: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """对多个主题依次探索（总预算仍受每主题预算约束）。"""
        out = []
        for t in topics or []:
            out.append(self.explore(str(t.get('topic', '未知主题'))))
        return out

    # ---------- 日志 ----------
    def _log_path(self) -> str:
        data_dir = self.config.get('memory_data_dir', 'data')
        return os.path.join(data_dir, 'curiosity_log.json')

    def _load_log(self) -> None:
        p = self._log_path()
        if not os.path.isfile(p):
            return
        try:
            with open(p, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                self.log = data
        except (OSError, json.JSONDecodeError):
            self.log = []

    def _save_log(self) -> None:
        try:
            p = self._log_path()
            os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
            tmp = p + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.log, f, ensure_ascii=False, indent=2)
            os.replace(tmp, p)
        except OSError:
            pass

    # ---------- 统计 ----------
    def stats(self) -> Dict[str, Any]:
        """探索统计：次数、预算使用、成功率。"""
        total = len(self.log)
        if total == 0:
            return {'total': 0, 'budget': self.budget, 'success_rate': 0.0}
        ok = 0
        total_cmds = 0
        for rec in self.log:
            for r in rec.get('results', []):
                total_cmds += 1
                if r.get('ok'):
                    ok += 1
        return {
            'total': total,
            'budget': self.budget,
            'commands_run': total_cmds,
            'success_rate': round(ok / max(total_cmds, 1), 3),
            'recent_topics': [r.get('topic') for r in self.log[-5:]],
        }
