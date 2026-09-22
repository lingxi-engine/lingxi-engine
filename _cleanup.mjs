#!/usr/bin/env node
// _cleanup.mjs - remove weird files and list remaining
import fs from 'node:fs';

const weird = fs.readdirSync('.').filter(f => f.startsWith('console'));
for (const w of weird) {
  try {
    fs.rmSync(w, { force: true });
    console.log('Removed: ' + w);
  } catch (e) {
    console.log('Failed to remove ' + w + ': ' + e.message);
  }
}

// List remaining _ files
const files = fs.readdirSync('.').filter(f => f.startsWith('_')).sort();
console.log('\nAll _ files:');
for (const f of files) console.log('  ' + f + ' (' + fs.statSync(f).size + ' bytes)');
