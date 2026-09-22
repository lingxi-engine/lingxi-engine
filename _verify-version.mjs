#!/usr/bin/env node
// _verify-version.mjs - check all version sources are aligned
import fs from 'node:fs';

const checks = [];

function check(name, path, expected) {
  try {
    let actual;
    if (path.endsWith('.json')) {
      actual = JSON.parse(fs.readFileSync(path, 'utf8')).version;
    } else {
      actual = fs.readFileSync(path, 'utf8').trim();
    }
    const pass = expected ? actual === expected : true;
    checks.push({ name, actual, expected, pass });
  } catch (e) {
    checks.push({ name, actual: 'ERROR: ' + e.message, expected, pass: false });
  }
}

check('version.txt', 'version.txt', '2.0.23');
check('package.json', 'package.json', '2.0.23');
check('BUILD-INFO.json', 'BUILD-INFO.json', '2.0.23');
check('CHANGELOG.md (first version)', 'CHANGELOG.md', null); // just show first line

console.log('=== Version Alignment Check ===');
for (const c of checks) {
  const icon = c.pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${c.name}: ${c.actual}${c.expected ? ' (expected: ' + c.expected + ')' : ''}`);
}

// Show CHANGELOG first few lines
try {
  const cl = fs.readFileSync('CHANGELOG.md', 'utf8');
  const lines = cl.split('\n').filter(l => l.trim()).slice(0, 5);
  console.log('\n=== CHANGELOG first lines ===');
  for (const l of lines) console.log(l.slice(0, 120));
} catch {}

// Check git tag
console.log('\n=== Git Tag ===');

// Check if tar.gz exists
try {
  const s = fs.statSync('F:/lingxi-engine-v2.0.23.tar.gz');
  console.log('F: tar.gz exists, size: ' + s.size);
} catch {
  console.log('F: tar.gz MISSING');
}
try {
  const s = fs.statSync('D:/lingxi-engine-v2.0.23.tar.gz');
  console.log('D: tar.gz exists, size: ' + s.size);
} catch {
  console.log('D: tar.gz MISSING');
}
