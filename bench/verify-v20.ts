/**
 * verify-v20.ts — 实测「静默降级到本地」是否真被掐断
 * 运行：npx tsx bench/verify-v20.ts
 */
import 'dotenv/config';
import { AIHub } from '../src/ai/hub';

type Row = {
  input: string;
  resolved: string;
  provider: string;
  isLocal: string;
  degraded: string;
  verdict: string;
};

const hub = new AIHub();

function probe(h: AIHub, input: string): Row {
  const r: any = h.getClient(input);
  if (!r) {
    return { input: input || '(空)', resolved: '<null>', provider: '-', isLocal: '-', degraded: '-', verdict: '拒绝/无可用' };
  }
  return {
    input: input || '(空)',
    resolved: r.resolvedModel,
    provider: r.providerId || '?',
    isLocal: r.isLocal ? 'YES' : 'no',
    degraded: r.degraded ? 'YES' : 'no',
    verdict: '',
  };
}

const inputs = [
  '',
  'deepseek-flash',
  'glm-5.2:cloud',
  'glm-5.2',
  'kimi-k2.7-code:cloud',
  'totally-nonexistent-model-xyz-999',
];

console.log('\n================ A. LINGXI_ALLOW_LOCAL_FALLBACK=false（默认，应拒绝降级） ================');
process.env.LINGXI_ALLOW_LOCAL_FALLBACK = 'false';
const hubA = new AIHub();
const rowsA = inputs.map(i => probe(hubA, i));

console.log('\n================ B. LINGXI_ALLOW_LOCAL_FALLBACK=true（旧行为，允许降级但必须打标） ================');
process.env.LINGXI_ALLOW_LOCAL_FALLBACK = 'true';
const hubB = new AIHub();
const rowsB = inputs.map(i => probe(hubB, i));

function dump(title: string, rows: Row[]) {
  console.log(`\n--- ${title} ---`);
  console.log(['input', 'resolved', 'provider', 'isLocal', 'degraded'].join(' | '));
  rows.forEach(r => console.log([r.input, r.resolved, r.provider, r.isLocal, r.degraded].join(' | ')));
}
dump('A: fallback=false', rowsA);
dump('B: fallback=true ', rowsB);

console.log('\n================ C. 角色路由（真实链路入口） ================');
process.env.LINGXI_ALLOW_LOCAL_FALLBACK = 'false';
const hubC = new AIHub();
for (const role of ['tool', 'reply', 'default'] as const) {
  const r: any = hubC.getRoleClient(role);
  console.log(`  getRoleClient(${role}) → ${r ? `${r.resolvedModel} @ ${r.providerId} isLocal=${!!r.isLocal}` : '<null>'}`);
}
console.log(`  getDefaultModel() → ${hubC.getDefaultModel()}`);

console.log('\n================ D. 断言 ================');
let pass = 0, fail = 0;
function assert(cond: boolean, label: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

const idx = (name: string) => inputs.indexOf(name);
const aEmpty = rowsA[idx('')];
const aDs = rowsA[idx('deepseek-flash')];
const aGhost = rowsA[idx('totally-nonexistent-model-xyz-999')];
const aCloudShell = rowsA[idx('glm-5.2:cloud')];
const bGhost = rowsB[idx('totally-nonexistent-model-xyz-999')];

assert(aEmpty.provider !== 'ollama' && aEmpty.isLocal === 'no',
  `空模型名不再落到本地（实际 → ${aEmpty.resolved} @ ${aEmpty.provider}）`);
assert(aDs.provider !== 'ollama' && aDs.isLocal === 'no' && aDs.degraded === 'no',
  `deepseek-flash 精确命中云端且未降级（实际 → ${aDs.resolved} @ ${aDs.provider}）`);
assert(aDs.resolved === 'deepseek-flash', 'deepseek-flash 名字未被改写');
assert(aGhost.resolved === '<null>', '不存在的模型名 → 拒绝降级返回 null（不再偷跑本地）');
assert(bGhost.isLocal === 'YES' && bGhost.degraded === 'YES',
  `开关放开后仍会降级，但已显式标记 isLocal/degraded（实际 → ${bGhost.resolved}）`);
assert(aCloudShell.provider === 'ollama' || aCloudShell.isLocal === 'no',
  `glm-5.2:cloud 有明确归属（实际 → ${aCloudShell.resolved} @ ${aCloudShell.provider}, isLocal=${aCloudShell.isLocal}）`);
assert(rowsA.every(r => r.input !== 'deepseek-flash' || r.isLocal === 'no'), '云端模型不被本地劫持');

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
