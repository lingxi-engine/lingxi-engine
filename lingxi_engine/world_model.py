# 世界模型（因果模拟器）——沙盒内代码执行结果的因果预测对账
#
# 对应 AGI 进化路线图【阶段4·让它"进化"】P0 行动项 A5：
#   "世界模型原型——沙盒内做代码执行结果的因果预测对账实验"
#
# 核心思想：AGI 要"理解世界"，第一步不是背答案，而是建立"因果模拟器"——
#   对即将执行的动作（命令），先预测其结果（会不会成功、输出长什么样），
#   再在沙盒里真实执行，把预测与事实对账。预测对了 → 世界模型得到一次正反馈，
#   预测错了 → 得到一个"反事实样本"（我以为会 X，实际是 Y），这正是学习信号。
#
# 设计：
#   1. predict(command)：对命令执行结果做预测
#      - 注入 LLM 时优先让模型预测（输出 JSON 结果特征）
#      - 否则启发式预测（按命令类型推断 ok/exit_code/stdout 特征）
#   2. run_experiment(actions)：真实执行并逐条对账，产出因果对
#      {action, prediction, actual, match, stdout_hit}
#   3. 对账记录落盘 data/causal_pairs.json（config['world_model_pairs_file']）
#   4. accuracy()：世界模型准确率统计——"引擎对世界的理解有多准"
#
# 安全：实验执行走 Sandbox（白名单 + 超时 + 无 shell），预测本身不执行任何命令。
# 纯 Python 实现，无外部依赖；沙盒不可用时优雅降级（返回 unavailable，不崩溃）。
#
# 与 A4 的关系：trace_source() 检测到代码类断言时，建议"沙盒执行验证（A5 对账）"——
#   本模块就是那个验证的执行端：把"断言 → 实验 → 对账"变成可积累的世界知识。

import json
import os
import re
import time
from typing import Any, Dict, List, Optional


class WorldModel:
    """因果模拟器：预测 → 执行 → 对账 → 积累世界知识。"""

    # 已知命令类型的启发式规则（命令首词 → 预测特征）
    _KNOWN_CMDS = {
        # 原生内建：echo 必然成功且输出参数文本
        'echo': {'ok': True, 'exit_code': 0, 'stdout_hint': '参数文本', 'stderr': ''},
        'pwd': {'ok': True, 'exit_code': 0, 'stdout_hint': '路径', 'stderr': ''},
        # dir/ls：目标存在则成功；目标不存在则失败（预测 exit 1）
        'dir': {'ok': True, 'exit_code': 0, 'stdout_hint': '目录项', 'stderr': '', 'path_sensitive': True},
        'ls': {'ok': True, 'exit_code': 0, 'stdout_hint': '目录项', 'stderr': '', 'path_sensitive': True},
        # type/cat：文件存在则成功，否则失败
        'type': {'ok': True, 'exit_code': 0, 'stdout_hint': '文件内容', 'stderr': '', 'file_sensitive': True},
        'cat': {'ok': True, 'exit_code': 0, 'stdout_hint': '文件内容', 'stderr': '', 'file_sensitive': True},
        # 查找类：通常成功（找不到也不报错）
        'where': {'ok': True, 'exit_code': 0, 'stdout_hint': '路径列表', 'stderr': ''},
        'which': {'ok': True, 'exit_code': 0, 'stdout_hint': '路径列表', 'stderr': ''},
        'find': {'ok': True, 'exit_code': 0, 'stdout_hint': '匹配列表', 'stderr': ''},
        # 网络探测：主机可达则成功，超时/不可达则失败
        'ping': {'ok': True, 'exit_code': 0, 'stdout_hint': 'Ping 统计', 'stderr': ''},
        # 解释器：脚本正确则成功（预测 exit 0）
        'python': {'ok': True, 'exit_code': 0, 'stdout_hint': '脚本输出', 'stderr': ''},
        'python3': {'ok': True, 'exit_code': 0, 'stdout_hint': '脚本输出', 'stderr': ''},
        'py': {'ok': True, 'exit_code': 0, 'stdout_hint': '脚本输出', 'stderr': ''},
        'node': {'ok': True, 'exit_code': 0, 'stdout_hint': '脚本输出', 'stderr': ''},
    }

    def __init__(self, config: Optional[Dict[str, Any]] = None,
                 sandbox: Optional[Any] = None, model: Optional[Any] = None):
        """初始化。

        config: 配置（读取 memory_data_dir / world_model_pairs_file / sandbox_*）
        sandbox: 可选的 Sandbox 实例；为 None 时惰性创建
        model: 可选的 LLM（带 invoke），提供则 predict 优先走 LLM 预测
        """
        self.config = config or {}
        self._sandbox = sandbox
        self.model = model
        self.pairs: List[Dict[str, Any]] = []
        self._load_pairs()

    # ---------- 沙盒 ----------
    def _get_sandbox(self):
        """惰性创建沙盒；不可用返回 None。"""
        if self._sandbox is not None:
            return self._sandbox
        try:
            from .sandbox import Sandbox
            self._sandbox = Sandbox(config=self.config)
        except Exception:
            self._sandbox = None
        return self._sandbox

    # ---------- 预测 ----------
    def _heuristic_predict(self, command: str) -> Dict[str, Any]:
        """启发式预测：按命令首词 + 参数特征推断结果。"""
        parts = command.strip().split()
        if not parts:
            return {'ok': False, 'exit_code': -1, 'stdout_hint': '',
                    'stderr_hint': '空命令', 'reasoning': '空命令不可能成功'}
        first = parts[0].lower()
        rule = self._KNOWN_CMDS.get(first)

        # 危险/被禁命令 → 预测被沙盒拒绝
        dangerous = re.search(r'\b(rm|del|format|shutdown|reboot|dd)\b|--force|-rf',
                              command, re.I)
        if dangerous:
            return {'ok': False, 'exit_code': -3, 'stdout_hint': '',
                    'stderr_hint': '沙盒拒绝（危险操作）',
                    'reasoning': f'命令含危险操作 {dangerous.group(0)}，沙盒会拦截'}

        if rule is None:
            # 未知命令：白名单之外大概率被拒
            return {'ok': False, 'exit_code': -3, 'stdout_hint': '',
                    'stderr_hint': '沙盒拒绝（不在白名单）',
                    'reasoning': f'未知命令 {first!r}，不在沙盒白名单，预测被拒'}

        pred = {'ok': rule['ok'], 'exit_code': rule['exit_code'],
                'stdout_hint': rule['stdout_hint'],
                'stderr_hint': rule.get('stderr', '')}

        # 路径敏感命令：检查参数里的路径是否存在
        if rule.get('path_sensitive') or rule.get('file_sensitive'):
            target = next((a for a in parts[1:] if not a.startswith('-')), None)
            if target:
                exists = os.path.exists(target)
                if not exists:
                    pred['ok'] = False
                    pred['exit_code'] = 1
                    pred['stderr_hint'] = f'路径不存在: {target}'
                    pred['reasoning'] = f'目标路径 {target!r} 不存在，预测执行失败'
                    return pred
        pred['reasoning'] = f'{first} 类命令通常 {pred["exit_code"] == 0 and "成功" or "失败"}'
        return pred

    def _llm_predict(self, command: str) -> Optional[Dict[str, Any]]:
        """LLM 预测：让模型模拟执行并预测结果；失败返回 None（降级启发式）。"""
        if self.model is None:
            return None
        prompt = (
            '你是世界模型的因果预测器。请预测在沙盒中执行以下命令的结果，'
            '输出 JSON：{"ok": true/false, "exit_code": 0, '
            '"stdout_hint": "预期输出的特征", "stderr_hint": "预期错误"}\n'
            f'命令：{command}'
        )
        try:
            raw = self.model.invoke(prompt)
        except Exception:
            return None
        m = re.search(r'\{.*\}', raw, re.S)
        if not m:
            return None
        try:
            data = json.loads(m.group(0))
            if isinstance(data, dict) and 'ok' in data:
                data['reasoning'] = 'LLM 预测'
                return data
        except (json.JSONDecodeError, ValueError):
            return None
        return None

    def predict(self, command: str) -> Dict[str, Any]:
        """对一条命令做执行结果预测。

        优先 LLM（注入 model 时），失败自动降级启发式；
        返回统一结构 {ok, exit_code, stdout_hint, stderr_hint, reasoning, predictor}
        """
        llm = self._llm_predict(command)
        if llm is not None:
            llm['predictor'] = 'llm'
            return llm
        pred = self._heuristic_predict(command)
        pred['predictor'] = 'heuristic'
        return pred

    # ---------- 实验：预测 → 执行 → 对账 ----------
    def run_experiment(self, actions: List[str]) -> List[Dict[str, Any]]:
        """对一批动作做因果对账实验。

        流程：预测每条命令结果 → 沙盒真实执行 → 逐条对账 → 落盘因果对。
        返回本次实验的对账记录列表（每条含 prediction/actual/match/stdout_hit）。
        """
        sb = self._get_sandbox()
        records = []
        for act in actions or []:
            pred = self.predict(act)
            actual = {'ok': None, 'exit_code': None, 'stdout': '', 'stderr': '',
                      'elapsed': 0}
            if sb is None:
                actual['stderr'] = '沙盒不可用'
                actual['ok'] = False
                actual['exit_code'] = -99
            else:
                try:
                    r = sb.run(act)
                    actual = {k: r.get(k, '') for k in
                              ('ok', 'exit_code', 'stdout', 'stderr', 'elapsed')}
                except Exception as e:
                    actual['ok'] = False
                    actual['exit_code'] = -3
                    actual['stderr'] = str(e)

            match = (pred.get('ok') == actual.get('ok'))
            # stdout_hit：预测的 stdout 特征在真实输出里出现（启发式粗略判定）
            hint = str(pred.get('stdout_hint', ''))
            stdout_hit = False
            if hint and hint not in ('参数文本', '目录项', '路径', '路径列表',
                                     '文件内容', '匹配列表', 'Ping 统计', '脚本输出'):
                stdout_hit = hint in str(actual.get('stdout', ''))

            rec = {
                'ts': time.time(),
                'action': act,
                'prediction': pred,
                'actual': actual,
                'match': match,
                'stdout_hit': stdout_hit,
            }
            records.append(rec)
            self.pairs.append(rec)

        self._save_pairs()
        return records

    # ---------- 统计 ----------
    def accuracy(self) -> Dict[str, Any]:
        """世界模型准确率：预测 ok 与真实 ok 的对账命中率。"""
        if not self.pairs:
            return {'total': 0, 'match_rate': 0.0, 'stdout_hit_rate': 0.0,
                    'by_predictor': {}, 'recent': []}
        total = len(self.pairs)
        matched = sum(1 for p in self.pairs if p.get('match'))
        hit = sum(1 for p in self.pairs if p.get('stdout_hit'))
        by_pred: Dict[str, Dict[str, int]] = {}
        for p in self.pairs:
            key = p.get('prediction', {}).get('predictor', '?')
            b = by_pred.setdefault(key, {'total': 0, 'matched': 0})
            b['total'] += 1
            if p.get('match'):
                b['matched'] += 1
        for k in by_pred:
            b = by_pred[k]
            b['match_rate'] = round(b['matched'] / max(b['total'], 1), 3)
        return {
            'total': total,
            'match_rate': round(matched / total, 3),
            'stdout_hit_rate': round(hit / total, 3) if total else 0.0,
            'by_predictor': by_pred,
            'recent': self.pairs[-5:],
        }

    def summary(self) -> Dict[str, Any]:
        """人类可读摘要。"""
        acc = self.accuracy()
        return {
            'pairs_file': self._pairs_path(),
            'pairs_count': acc['total'],
            'match_rate': acc['match_rate'],
            'stdout_hit_rate': acc['stdout_hit_rate'],
            'by_predictor': acc['by_predictor'],
        }

    # ---------- 落盘 ----------
    def _pairs_path(self) -> str:
        data_dir = self.config.get('memory_data_dir', 'data')
        fname = self.config.get('world_model_pairs_file', 'causal_pairs.json')
        return os.path.join(data_dir, fname)

    def _load_pairs(self) -> None:
        """加载历史因果对（世界模型的知识积累）。"""
        p = self._pairs_path()
        if not os.path.isfile(p):
            return
        try:
            with open(p, 'r', encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, list):
                self.pairs = data
        except (OSError, json.JSONDecodeError):
            self.pairs = []

    def _save_pairs(self) -> None:
        """原子落盘因果对。"""
        try:
            p = self._pairs_path()
            os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
            tmp = p + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(self.pairs, f, ensure_ascii=False, indent=2)
            os.replace(tmp, p)
        except OSError:
            pass

    # ---------- 反事实样本（A7 做梦素材） ----------
    def counterfactuals(self, limit: int = 10) -> List[Dict[str, Any]]:
        """收集预测与事实不符的因果对——"我以为会 X，实际是 Y"的反事实样本。

        这些是引擎理解世界的"意外"，最适合 A7 离线做梦做变异重组的原料：
        重放反事实 → 修正世界模型假设 → 提出新假设。
        """
        bad = [p for p in self.pairs if not p.get('match')]
        return bad[-limit:]
