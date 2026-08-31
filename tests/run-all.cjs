// 聚合测试入口：一条命令跑完所有本地可验证的测试（不依赖外部 AI API）
// 用法: node tests/run-all.cjs
const { spawnSync } = require('child_process');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const steps = [
  { name: 'TS 纯单元测试', cmd: 'node', args: ['tests/unit.pure.js'], cwd: ROOT },
  { name: 'Python 全量回归(152断言)', cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['tests/run_all.py'], cwd: path.join(ROOT, 'workspace/lingxi_engine') },
  { name: 'Python 沙盒模式专项', cmd: process.platform === 'win32' ? 'python' : 'python3', args: ['tests/verify_sandbox_modes.py'], cwd: path.join(ROOT, 'workspace/lingxi_engine') },
];

let failed = 0;
for (const s of steps) {
  console.log(`\n━━━ ${s.name} ━━━`);
  const r = spawnSync(s.cmd, s.args, { cwd: s.cwd, encoding: 'utf8', timeout: 180000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.trim().split('\n').slice(-12).join('\n');
  console.log(tail);
  const ok = r.status === 0;
  console.log(ok ? '✅ PASS' : `❌ FAIL (exit=${r.status})`);
  if (!ok) failed++;
}

console.log(`\n${failed === 0 ? '🎉 ALL TESTS PASSED' : `💥 ${failed} step(s) FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
