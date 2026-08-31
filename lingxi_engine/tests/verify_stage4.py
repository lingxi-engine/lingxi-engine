# -*- coding: utf-8 -*-
"""阶段4 A5-A9 验证脚本：世界模型 / 好奇探索器 / 离线做梦 / 多模型议会 / 宪法护栏。

结果写入 verify_stage4_result.txt（避免 stdout 编码问题）。
"""
import json
import os
import sys
import tempfile

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _ROOT)
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESULT = os.path.join(BASE, 'tests', 'verify_stage4_result.txt')
LINES = []
FAILS = []


def check(name, cond, detail=''):
    tag = 'PASS' if cond else 'FAIL'
    LINES.append("[{0}] {1}{2}".format(tag, name, (' | ' + detail) if detail else ''))
    if not cond:
        FAILS.append(name)


class FakeModel:
    """假模型：invoke 返回预置文本（模拟异构模型议员）。"""

    def __init__(self, name, stance):
        self.name = name
        self.stance = stance

    def invoke(self, prompt):
        if '表决' in prompt:
            return self.stance
        if '辩论' in prompt:
            return '{0}：理由与{1}的立场一致'.format(self.stance, self.name)
        return '{0}的回复'.format(self.name)


def main():
    tmp = tempfile.mkdtemp(prefix='lx_stage4_')
    cfg = {'memory_data_dir': tmp, 'curiosity_budget': 3,
           'sandbox_mode': 'strict', 'sandbox_timeout': 5}

    # ================= A5 世界模型 =================
    LINES.append('--- A5 WorldModel ---')
    from lingxi_engine.world_model import WorldModel
    wm = WorldModel(config=cfg)
    p1 = wm.predict('echo hello')
    check('A5 predict(echo) ok=True', p1.get('ok') is True,
          json.dumps(p1, ensure_ascii=False))
    p2 = wm.predict('rm -rf /tmp/x')
    check('A5 predict(rm -rf) ok=False', p2.get('ok') is False,
          json.dumps(p2, ensure_ascii=False))
    recs = wm.run_experiment(['echo hello', 'dir .', 'rm -rf /tmp/x'])
    check('A5 run_experiment 3 records', len(recs) == 3)
    echo_rec = next((r for r in recs if 'echo' in r['action']), None)
    check('A5 echo 对账 match=True', echo_rec is not None and echo_rec['match'] is True)
    rm_rec = next((r for r in recs if 'rm' in r['action']), None)
    check('A5 rm 对账 match=True(预测被拒)', rm_rec is not None and rm_rec['match'] is True,
          json.dumps(rm_rec, ensure_ascii=False) if rm_rec else '')
    acc = wm.accuracy()
    check('A5 accuracy() total=3', acc['total'] == 3)
    check('A5 accuracy() match_rate>=0.5', acc['match_rate'] >= 0.5,
          'rate={0}'.format(acc['match_rate']))
    cf = wm.counterfactuals()
    check('A5 counterfactuals() 返回列表', isinstance(cf, list))
    pairs_file = os.path.join(tmp, 'causal_pairs.json')
    check('A5 causal_pairs.json 落盘', os.path.isfile(pairs_file))

    # ================= A6 好奇探索器 =================
    LINES.append('--- A6 CuriosityExplorer ---')
    from lingxi_engine.curiosity import CuriosityExplorer
    exp = CuriosityExplorer(config=cfg)
    conf_report = {'low_confidence': [
        {'assertion': '文件读取应该用二进制模式', 'confidence': 0.3}]}
    mistake_types = [{'type': '指令遵循', 'count': 31}]
    topics = exp.select_topics(conf_report, mistake_types, limit=3)
    check('A6 select_topics 返回主题', len(topics) >= 1)
    check('A6 低置信度断言优先(priority=1)', topics[0]['priority'] == 1,
          json.dumps(topics, ensure_ascii=False))
    rec = exp.explore('指令遵循')
    check('A6 explore 预算内命令数<=3', rec['budget_used'] <= 3,
          'used={0}'.format(rec['budget_used']))
    check('A6 explore 有 findings', len(rec['findings']) >= 1)
    check('A6 curiosity_log.json 落盘',
          os.path.isfile(os.path.join(tmp, 'curiosity_log.json')))
    st = exp.stats()
    check('A6 stats() total>=1', st['total'] >= 1)

    # ================= A7 离线做梦 =================
    LINES.append('--- A7 Dreamer ---')
    from lingxi_engine.dream import Dreamer
    dr = Dreamer(config=cfg)
    variants = dr.mutate('不要重复犯错')
    check('A7 mutate 产出变体', len(variants) >= 1,
          json.dumps(variants, ensure_ascii=False))
    os.makedirs(tmp, exist_ok=True)
    with open(os.path.join(tmp, 'selfplay_records.json'), 'w', encoding='utf-8') as f:
        json.dump({'records': [
            {'final_answer': '修正后应该先验证再下结论'},
            {'final_answer': '避免使用模糊表述'},
        ]}, f, ensure_ascii=False)
    from lingxi_engine.memory import Memory
    mem = Memory(data_dir=tmp)
    mem.add_card({'content': '用户偏好简洁的回答', 'type': '偏好'})
    mem.add_card({'content': '遇到错误先记录再修复', 'type': '方法'})
    dres = dr.dream(max_hypotheses=6, seed=42)
    check('A7 dream 产出假设>=1', dres['hypotheses_generated'] >= 1,
          json.dumps(dres.get('sources_used'), ensure_ascii=False))
    check('A7 dream 重放素材>0', dres['replayed'] > 0)
    check('A7 dream_queue.json 落盘',
          os.path.isfile(os.path.join(tmp, 'dream_queue.json')))
    taken = dr.consume_queue(2)
    check('A7 consume_queue 取走 pending', len(taken) >= 1)
    if taken:
        dr.mark_result(taken[0]['hypothesis'], 'verified')
    st7 = dr.stats()
    check('A7 stats() verified 回写', st7['verified'] >= 1, json.dumps(st7))

    # ================= A8 多模型议会 =================
    LINES.append('--- A8 Parliament ---')
    from lingxi_engine.parliament import Parliament

    class Core:
        models = {
            '模型A-质疑': FakeModel('模型A-质疑', '支持'),
            '模型B-建设': FakeModel('模型B-建设', '支持'),
            '模型C-总结': FakeModel('模型C-总结', '反对'),
        }
    par = Parliament(Core(), config=cfg)
    ms = par.propose_motions('离线做梦机制')
    check('A8 propose_motions 3 条动议', len(ms) == 3)
    sess = par.convene('离线做梦机制', debate_rounds=2)
    check('A8 convene 产出决议', 'resolution' in sess)
    check('A8 决议含 passed_motions', isinstance(sess['resolution']['passed_motions'], list))
    check('A8 票型统计 yea=2', sess['vote']['motions'][0]['yea'] == 2,
          json.dumps(sess['vote']['motions'][0], ensure_ascii=False))
    check('A8 表决支持>反对=通过', sess['vote']['motions'][0]['passed'] is True)
    check('A8 parliament_records.json 落盘',
          os.path.isfile(os.path.join(tmp, 'parliament_records.json')))
    check('A8 stats() sessions=1', par.stats()['sessions'] == 1)

    # ================= A9 宪法护栏 =================
    LINES.append('--- A9 Constitution ---')
    from lingxi_engine.constitution import Constitution
    con = Constitution(config=cfg, base_dir=BASE)
    cls = con.classify('read_file')
    check('A9 classify(read_file)=read', cls['level'] == 'read')
    g1 = con.guard('read_file')
    check('A9 guard(read_file) 放行', g1['allowed'] is True)
    g2 = con.guard('rm -rf /tmp/x')
    check('A9 guard(rm -rf) 拦截', g2['allowed'] is False, g2['reason'])
    g3 = con.guard('write_config')
    check('A9 guard(write_config) 放行(默认清单)', g3['allowed'] is True)
    g4 = con.guard('drop database users')
    check('A9 guard(drop database) 拦截', g4['allowed'] is False)
    snap = con.snapshot('验证快照')
    diff = con.diff_since(snap['id'])
    check('A9 diff_since 无变化', len(diff['changed_files']) == 0,
          json.dumps(diff, ensure_ascii=False))
    plan = con.rollback_plan(snap['id'])
    check('A9 rollback_plan 生成步骤', 'steps' in plan)
    check('A9 constitution_snapshot.json 落盘',
          os.path.isfile(os.path.join(tmp, 'constitution_snapshot.json')))
    con_off = Constitution(config={**cfg, 'enable_constitution': False}, base_dir=BASE)
    g_off = con_off.guard('rm -rf /tmp/x')
    check('A9 enable_constitution=False 时放行', g_off['allowed'] is True)

    # ================= 汇总 =================
    LINES.append('')
    total = len([l for l in LINES if l.startswith('[PASS]') or l.startswith('[FAIL]')])
    LINES.append('TOTAL={0} PASS={1} FAIL={2}'.format(total, total - len(FAILS), len(FAILS)))
    LINES.append('ALL_OK={0}'.format(len(FAILS) == 0))
    with open(RESULT, 'w', encoding='utf-8') as f:
        f.write('\n'.join(LINES))
    print('written', RESULT)


if __name__ == '__main__':
    main()
