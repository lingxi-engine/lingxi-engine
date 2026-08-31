# -*- coding: utf-8 -*-
"""阶段4 A5-A9 端到端联动验证：用真实评测数据走完整链路。

  1. A2 错题本真实加载（评测记录 evaluation-records.json）
  2. A5 世界模型：真实沙盒执行对账（echo/dir/pwd）
  3. A6 好奇探索：用真实高频错误类型选题 + 沙盒探索
  4. A7 离线做梦：重放真实错题/反事实/记忆，产出假设队列
  5. A8 多模型议会：真实表决流程（FakeModel 模拟异构议员）
  6. A9 宪法护栏：真实快照 + 回滚预案（exec 级动作需带显式授权关键词）

结果写入 tests/stage4_e2e_result.txt。
"""
import json
import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _ROOT)
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULT = os.path.join(BASE, 'tests', 'stage4_e2e_result.txt')
LINES = []
FAILS = []


def check(name, cond, detail=''):
    tag = 'PASS' if cond else 'FAIL'
    LINES.append("[{0}] {1}{2}".format(tag, name, (' | ' + detail) if detail else ''))
    if not cond:
        FAILS.append(name)


class FakeModel:
    def __init__(self, name, stance):
        self.name = name
        self.stance = stance

    def invoke(self, prompt):
        if '表决' in prompt:
            return self.stance
        if '辩论' in prompt:
            return '{0}：与立场一致'.format(self.stance)
        return '{0}的回复'.format(self.name)


def main():
    from lingxi_engine.mistakes import MistakeBook
    from lingxi_engine.world_model import WorldModel
    from lingxi_engine.curiosity import CuriosityExplorer
    from lingxi_engine.dream import Dreamer
    from lingxi_engine.parliament import Parliament
    from lingxi_engine.constitution import Constitution
    from lingxi_engine.config import get_config

    cfg = get_config()  # 真实默认配置（memory_data_dir='data'，会真实落盘）

    # ---- 1. 错题本真实加载 ----
    LINES.append('--- A2 错题本(真实数据) ---')
    book = MistakeBook(config=cfg)
    summ = book.summary()
    check('错题本加载真实评测记录', summ['total'] > 0,
          'total={0} avg={1}'.format(summ['total'], summ.get('avg_score')))
    check('错题本识别高频错误类型', len(summ.get('issue_types', {})) > 0,
          json.dumps(summ.get('issue_types'), ensure_ascii=False))

    # ---- 2. A5 世界模型：真实沙盒对账 ----
    LINES.append('--- A5 世界模型(真实沙盒) ---')
    wm = WorldModel(config=cfg)
    recs = wm.run_experiment(['echo 因果对账实验', 'dir .', 'pwd'])
    check('真实沙盒执行 3 条命令', len(recs) == 3)
    ok_cnt = sum(1 for r in recs if r.get('actual', {}).get('ok'))
    check('真实沙盒命令执行成功>=2', ok_cnt >= 2, 'ok={0}/3'.format(ok_cnt))
    acc = wm.accuracy()
    check('世界模型准确率统计', acc['total'] >= 3,
          'match_rate={0}'.format(acc['match_rate']))

    # ---- 3. A6 好奇探索：真实主题 ----
    LINES.append('--- A6 好奇探索(真实选题) ---')
    exp = CuriosityExplorer(config=cfg)
    mistake_types = book.top_issue_types(3)
    topics = exp.select_topics(confidence_report=None, mistake_types=mistake_types)
    check('按真实高频错误选题', len(topics) >= 1,
          json.dumps([t['topic'] for t in topics], ensure_ascii=False))
    if topics:
        erec = exp.explore(topics[0]['topic'])
        check('真实主题探索完成', erec['budget_used'] >= 1)

    # ---- 4. A7 离线做梦：真实素材 ----
    LINES.append('--- A7 离线做梦(真实素材) ---')
    dr = Dreamer(config=cfg)
    dres = dr.dream(max_hypotheses=5, seed=7)
    check('做梦重放真实素材', dres['replayed'] > 0,
          json.dumps(dres.get('sources_used'), ensure_ascii=False))
    check('假设入队', dres['queue_size'] > 0)

    # ---- 5. A8 多模型议会 ----
    LINES.append('--- A8 多模型议会(真实流程) ---')
    class Core:
        models = {
            '模型A': FakeModel('模型A', '支持'),
            '模型B': FakeModel('模型B', '支持'),
            '模型C': FakeModel('模型C', '反对'),
        }
    par = Parliament(Core(), config=cfg)
    sess = par.convene('世界模型因果对账机制')
    check('议会产出决议', sess['resolution']['decision'] in ('通过', '否决'),
          'decision={0}'.format(sess['resolution']['decision']))
    check('议会记录落盘', os.path.isfile(os.path.join('data', 'parliament_records.json')))

    # ---- 6. A9 宪法护栏 ----
    LINES.append('--- A9 宪法护栏(真实快照) ---')
    con = Constitution(config=cfg, base_dir=BASE)
    # exec 级动作需带允许清单关键词（sandbox_experiment）才算显式授权
    g = con.guard('sandbox_experiment: 世界模型因果对账实验')
    check('护栏放行已授权的世界模型实验', g['allowed'] is True, g['reason'])
    # 未授权 exec 动作：拒绝（护栏严格模式）
    g_un = con.guard('world_model 世界模型实验执行')
    check('护栏拒绝未授权 exec 动作', g_un['allowed'] is False, g_un['reason'])
    g_bad = con.guard('rm -rf data')
    check('护栏拦截危险自改进', g_bad['allowed'] is False, g_bad['reason'])
    snap = con.snapshot('阶段4端到端')
    plan = con.rollback_plan(snap['id'])
    check('回滚预案生成', len(plan.get('steps', [])) >= 1)

    # ---- 汇总 ----
    LINES.append('')
    total = len([l for l in LINES if l.startswith('[PASS]') or l.startswith('[FAIL]')])
    LINES.append('TOTAL={0} PASS={1} FAIL={2}'.format(total, total - len(FAILS), len(FAILS)))
    LINES.append('ALL_OK={0}'.format(len(FAILS) == 0))
    with open(RESULT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(LINES))
    print('written', RESULT)


if __name__ == '__main__':
    main()
