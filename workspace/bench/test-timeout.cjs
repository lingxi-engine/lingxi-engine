// 验证 computeTimeoutMs：显式 > budget > 60s，再乘倍率、再抬下限
const { computeTimeoutMs } = require('C:/Users/Administrator/lingxi-engine/workspace/bench/adapters/ws-adapter.cjs');

const cases = [
  ['budget 240s 默认', { budget: { seconds: 240 } }, {}, 240000],
  ['无 budget 回退 60s', {}, {}, 60000],
  ['L5 原预算 300s', { budget: { seconds: 300 } }, {}, 300000],
  ['min-timeout 900 抬到 900s', { budget: { seconds: 240 } }, { minTimeoutMs: 900000 }, 900000],
  ['L5-001 420s + min 900 仍抬到 900s', { budget: { seconds: 420 } }, { minTimeoutMs: 900000 }, 900000],
  ['timeout-mult 3 倍', { budget: { seconds: 300 } }, { timeoutMult: 3 }, 900000],
  ['显式 timeoutMs 覆盖 budget', { budget: { seconds: 240 } }, { timeoutMs: 5000 }, 5000],
  ['显式 + 下限', { budget: { seconds: 240 } }, { timeoutMs: 5000, minTimeoutMs: 60000 }, 60000],
  ['倍率 + 下限共同生效', { budget: { seconds: 200 } }, { timeoutMult: 2, minTimeoutMs: 900000 }, 900000],
];

let pass = 0;
for (const [name, task, opts, expect] of cases) {
  const got = computeTimeoutMs(task, opts);
  const ok = got === expect;
  if (ok) pass++;
  console.log((ok ? '✅ ' : '❌ ') + name + `  got=${got} expect=${expect}`);
}
console.log(`\n结果: ${pass}/${cases.length} ${pass === cases.length ? 'PASS' : 'FAIL'}`);
process.exit(pass === cases.length ? 0 : 1);
