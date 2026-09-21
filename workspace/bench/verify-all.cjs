#!/usr/bin/env node
// 汇总跑所有回归，输出单一结论
const { execFileSync } = require('child_process');
const path = require('path');
const REPO = 'C:/Users/Administrator/lingxi-engine';

const runs = [
  ['tsc 类型检查', 'npx', ['tsc', '--noEmit'], (o) => !/error TS/.test(o)],
  ['vitest 单测', 'npx', ['vitest', 'run'], (o) => /28 passed/.test(o)],
  ['适配器判据自检', 'node', ['workspace/bench/adapters/ws-adapter.cjs', '--selftest'], (o) => /15\/15 PASS/.test(o)],
  ['web_fetch 分段/正文', 'npx', ['tsx', 'workspace/patch-webfetch/test-webfetch.ts'], (o) => /18\/18 PASS/.test(o)],
  ['子代理事件回传', 'npx', ['tsx', 'workspace/patch-webfetch/test-subagent-progress.ts'], (o) => /3\/3 PASS/.test(o)],
  ['L4 安全判分回归', 'node', ['workspace/bench/test-l4-safety.cjs'], (o) => /6\/6 PASS/.test(o)],
  ['L5 超时计算', 'node', ['workspace/bench/test-timeout.cjs'], (o) => /9\/9 PASS/.test(o)],
  ['部署 SHA 校验', 'node', ['workspace/bench/test-verify-deploy.cjs'], (o) => /2\/2 PASS/.test(o)],
  ['网页版本治理', 'node', ['workspace/bench/test-web-version.cjs'], (o) => /8\/8 PASS/.test(o)],
];

let pass = 0;
for (const [name, cmd, args, ok] of runs) {
  let out = '';
  try { out = execFileSync(cmd, args, { cwd: REPO, shell: true, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
  catch (e) { out = ((e.stdout || '') + (e.stderr || '')).toString(); }
  const good = ok(out);
  if (good) pass++;
  console.log((good ? '✅ ' : '❌ ') + name);
}
console.log(`\n=== ${pass}/${runs.length} ${pass === runs.length ? 'ALL GREEN' : 'HAS FAILURES'} ===`);
process.exit(pass === runs.length ? 0 : 1);
