#!/usr/bin/env node
// _cleanup3.mjs - remove console.log file and commit
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const weird = fs.readdirSync('.').filter(f => f.startsWith('console'));
for (const w of weird) {
  try {
    fs.rmSync(w, { force: true });
    console.log('Removed: ' + w);
  } catch (e) {
    console.log('Failed: ' + w + ' ' + e.message);
  }
}

try {
  execSync('git add -A', { encoding: 'utf8', timeout: 10000 });
  execSync('git commit -m "chore: deploy v2.0.23 - scripts, BUILD-INFO, deploy record"', { encoding: 'utf8', timeout: 10000 });
  console.log('Committed');
  const status = execSync('git status --short', { encoding: 'utf8', timeout: 10000 });
  console.log('Git status: ' + (status || 'clean'));
  const log = execSync('git --no-pager log --oneline -3', { encoding: 'utf8', timeout: 10000 });
  console.log('Recent commits:\n' + log);
} catch (e) {
  console.log('Git error: ' + e.message);
}
