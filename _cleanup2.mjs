#!/usr/bin/env node
// _cleanup2.mjs - final cleanup
import fs from 'node:fs';

const weird = fs.readdirSync('.').filter(f => f.startsWith('console'));
for (const w of weird) {
  try {
    fs.rmSync(w, { force: true });
    console.log('Removed: ' + w);
  } catch (e) {
    console.log('Failed: ' + w + ' ' + e.message);
  }
}

// Check git status via execSync
try {
  const status = execSync('git status --short', { encoding: 'utf8', timeout: 10000 });
  console.log('\nGit status:');
  console.log(status || '(clean)');
} catch (e) {
  console.log('Git status error: ' + e.message);
}
