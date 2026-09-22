import { execSync } from 'child_process';
import fs from 'fs';

const version = JSON.parse(fs.readFileSync('C:/Users/Administrator/lingxi-engine/package.json', 'utf8')).version;
console.log('Version from package.json:', version);

console.log('\n=== Running pack-release.ps1 ===');
try {
  const out = execSync('powershell -ExecutionPolicy Bypass -File scripts/pack-release.ps1', {
    cwd: 'C:/Users/Administrator/lingxi-engine',
    encoding: 'utf8',
    timeout: 300000,
    stdio: 'pipe'
  });
  console.log(out);
} catch (e) {
  console.log('STDOUT:', e.stdout || '');
  console.log('STDERR:', e.stderr || '');
  console.log('Exit code:', e.status);
}

console.log('\n=== Checking output ===');
const tmpDir = process.env.TEMP || 'C:/Users/Administrator/AppData/Local/Temp';
const files = fs.readdirSync(tmpDir);
const tars = files.filter(f => f.startsWith('lingxi-engine-v') && f.endsWith('.tar.gz'));
console.log('Found in TEMP:', tars);
tars.forEach(f => {
  const stat = fs.statSync(`${tmpDir}/${f}`);
  console.log(`  ${f}: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
});
