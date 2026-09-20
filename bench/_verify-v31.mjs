import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = 'C:/Users/Administrator/lingxi-engine';

console.log('=== Step 1: tsc --noEmit ===');
try {
  const out = execSync('npx tsc --noEmit', { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  console.log('  tsc: PASS ✅');
} catch (e) {
  console.log('  tsc: FAIL ❌');
  console.log(e.stdout || e.stderr);
}

console.log('\n=== Step 2: run selftest ===');
try {
  const out = execSync('node workspace/bench/run.ts --selftest', { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  console.log(out);
} catch (e) {
  console.log('  selftest exit code:', e.status);
  console.log(e.stdout || '');
  console.log(e.stderr || '');
}

console.log('\n=== Step 3: check smoke results ===');
const smokeDir = path.join(ROOT, 'workspace/bench/results/smoke');
if (fs.existsSync(smokeDir)) {
  const items = fs.readdirSync(smokeDir);
  console.log(`  smoke dir has ${items.length} items`);
  for (const item of items.slice(0, 10)) console.log(`    ${item}`);
} else {
  console.log('  smoke dir missing');
}

console.log('\n=== Step 4: list L1/L2/L3 tasks ===');
for (const layer of ['L1', 'L2', 'L3']) {
  const f = path.join(ROOT, `workspace/bench/tasks/${layer}-*.json`);
  const matches = fs.readdirSync(path.join(ROOT, 'workspace/bench/tasks')).filter(n => n.startsWith(layer + '-'));
  for (const m of matches) {
    const content = fs.readFileSync(path.join(ROOT, 'workspace/bench/tasks', m), 'utf8');
    const data = JSON.parse(content);
    console.log(`  ${m}: ${data.tasks?.length || '?'} tasks, name="${data.name || '?'}"`);
  }
}

console.log('\n=== done ===');
