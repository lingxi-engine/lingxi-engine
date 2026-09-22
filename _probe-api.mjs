#!/usr/bin/env node
// _probe-api.mjs - find auth routes in source
import fs from 'node:fs';

function walk(dir, results = []) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = dir + '/' + f;
      const s = fs.statSync(p);
      if (s.isDirectory()) walk(p, results);
      else if (/\.(ts|js|cjs|mjs)$/.test(f)) {
        const c = fs.readFileSync(p, 'utf8');
        if (/auth|login|login/.test(c)) results.push(p);
      }
    }
  } catch (e) {}
  return results;
}

const files = walk('src');
console.log('Files with auth/login references:');
for (const f of files) console.log('  ' + f);

// Also search route definitions
console.log('\n=== Route patterns ===');
const allJs = walk('src');
for (const f of allJs) {
  const c = fs.readFileSync(f, 'utf8');
  const lines = c.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/app\.(get|post|put|delete|use)\s*\(\s*['"`]/.test(lines[i]) && /auth|login|upload|admin|user/i.test(lines[i])) {
      console.log(f + ':' + (i + 1) + ': ' + lines[i].trim().slice(0, 150));
    }
  }
}
