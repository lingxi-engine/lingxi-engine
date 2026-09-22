import { execSync } from 'child_process';

console.log('=== TSC ===');
try {
  const out = execSync('npx tsc --noEmit', { cwd: 'C:/Users/Administrator/lingxi-engine', encoding: 'utf8', timeout: 120000 });
  console.log('TSC OK (empty output)');
} catch (e) {
  console.log('TSC errors:');
  console.log(e.stdout || '');
  console.log(e.stderr || '');
}

console.log('\n=== VITEST ===');
try {
  const out = execSync('npx vitest run', { cwd: 'C:/Users/Administrator/lingxi-engine', encoding: 'utf8', timeout: 120000 });
  console.log(out);
} catch (e) {
  console.log('Vitest output:');
  console.log(e.stdout || '');
  console.log(e.stderr || '');
}
