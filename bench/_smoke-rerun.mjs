import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = 'C:/Users/Administrator/lingxi-engine';

// 1. 清理旧 smoke 结果（v30 双重前缀时代）
console.log('=== 清理旧 smoke 结果 ===');
const smokeDir = path.join(ROOT, 'workspace/bench/results/smoke');
if (fs.existsSync(smokeDir)) {
  fs.rmSync(smokeDir, { recursive: true, force: true });
  console.log('  已删除 smoke/');
}

// 2. 跑 smoke test (L1-001 via WS adapter)
console.log('\n=== 跑 smoke test (L1-001 via WS) ===');
try {
  const out = execSync(
    `node workspace/bench/adapters/ws-adapter.cjs --layers L1 --group G1 --url ws://localhost:3456/ws?id=bench-smoke --only L1-001`,
    { cwd: ROOT, encoding: 'utf8', timeout: 300000 }
  );
  console.log(out);
} catch (e) {
  console.log('smoke exit code:', e.status);
  console.log('STDOUT:', e.stdout || '');
  console.log('STDERR:', e.stderr || '');
}

// 3. 检查结果
console.log('\n=== smoke 结果检查 ===');
const resultsDir = path.join(ROOT, 'workspace/bench/results/20260920');
if (fs.existsSync(resultsDir)) {
  const items = fs.readdirSync(resultsDir);
  console.log(`results/20260920: ${items.length} items`);
  for (const item of items) console.log(`  ${item}`);

  // 找 smoke 目录
  const smokeItems = items.filter(i => i.includes('smoke'));
  for (const s of smokeItems) {
    const sDir = path.join(resultsDir, s);
    const stat = fs.statSync(sDir);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(sDir);
      console.log(`\n  ${s}/:`);
      for (const f of files) console.log(`    ${f}`);

      // 读 raw.json 看结果
      const rawPath = path.join(sDir, 'raw.json');
      if (fs.existsSync(rawPath)) {
        const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
        for (const rec of raw) {
          console.log(`\n  📋 ${rec.taskId} (${rec.group}): success=${rec.success}, judge=${JSON.stringify(rec.judge)}, steps=${rec.steps}, envError=${rec.envError}`);
        }
      }

      // 读 SUMMARY
      const sumPath = path.join(sDir, 'SUMMARY.txt');
      if (fs.existsSync(sumPath)) {
        console.log(`\n  SUMMARY:\n${fs.readFileSync(sumPath, 'utf8')}`);
      }
    }
  }
} else {
  console.log('results/20260920 not found, checking other dates...');
  const resultsParent = path.join(ROOT, 'workspace/bench/results');
  if (fs.existsSync(resultsParent)) {
    const dates = fs.readdirSync(resultsParent).filter(d => {
      try { return fs.statSync(path.join(resultsParent, d)).isDirectory(); } catch { return false; }
    });
    console.log('dates:', dates.join(', '));
  }
}

console.log('\n=== done ===');
