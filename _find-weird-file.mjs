import { execSync } from 'child_process';
import fs from 'fs';

// Check if console.log(l)) file exists in repo
console.log('=== Check for weird file in repo ===');
const findCmd = `cmd /c "dir /s /b *console.log*" 2>nul"`;
try {
  const result = execSync(findCmd, { encoding: 'utf8', timeout: 30000, cwd: 'C:/Users/Administrator/lingxi-engine' });
  console.log('Found:', result || '(none)');
} catch (e) {
  console.log('Search failed');
}

// Also check git status
console.log('\n=== Git status ===');
try {
  const result = execSync('git status --short', { encoding: 'utf8', timeout: 10000, cwd: 'C:/Users/Administrator/lingxi-engine' });
  console.log(result || '(clean)');
} catch (e) {
  console.log('Failed');
}

// Check if file is tracked by git
console.log('\n=== Check git ls-files ===');
try {
  const result = execSync('git ls-files | grep -i console', { encoding: 'utf8', timeout: 10000, cwd: 'C:/Users/Administrator/lingxi-engine' });
  console.log('Tracked:', result || '(none)');
} catch (e) {
  console.log('No console files tracked');
}

// Check what files start with "console" in the repo
console.log('\n=== All files starting with console ===');
try {
  const result = execSync('git ls-files | findstr /i console', { encoding: 'utf8', timeout: 10000, cwd: 'C:/Users/Administrator/lingxi-engine' });
  console.log(result || '(none)');
} catch (e) {
  console.log('None');
}
