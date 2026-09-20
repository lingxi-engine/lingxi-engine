import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = 'C:/Users/Administrator/lingxi-engine';

console.log('=== Smoke test (v31 verification) ===');
try {
  const out = execSync('node workspace/bench/adapters/ws-adapter.cjs --selftest', {
    cwd: ROOT, encoding: 'utf8', timeout: 30000
  });
  console.log(out);
} catch (e) {
  console.log('selftest exit:', e.status);
  console.log(e.stdout || '');
  console.log(e.stderr || '');
}

console.log('\n=== Check if engine is running on 3456 ===');
try {
  const out = execSync('curl -s http://localhost:3456/api/health 2>&1 || echo "no health endpoint"; curl -s -o /dev/null -w "%{http_code}" http://localhost:3456/ws 2>&1 || echo "no ws"', {
    cwd: ROOT, encoding: 'utf8', timeout: 10000
  });
  console.log(out);
} catch (e) {
  console.log('cannot check port');
}

console.log('\n=== Check node processes ===');
try {
  const out = execSync('tasklist 2>&1 | findstr node', { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
  console.log(out || 'no node processes');
} catch (e) {
  console.log('cannot check processes');
}

console.log('\n=== Check workspace/bench/out/_sbx ===');
const sbxDir = path.join(ROOT, 'workspace/bench/out/_sbx');
if (fs.existsSync(sbxDir)) {
  const items = fs.readdirSync(sbxDir);
  console.log(`_sbx has ${items.length} items:`);
  for (const item of items) console.log(`  ${item}`);
} else {
  console.log('_sbx dir missing');
}

console.log('\n=== done ===');
