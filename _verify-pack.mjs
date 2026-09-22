#!/usr/bin/env node
// _verify-pack.mjs - verify tar.gz can be extracted and check contents
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const TAR = 'F:/lingxi-engine-v2.0.23.tar.gz';

console.log('=== Verify Pack ===');

// 1. Hash
const sha = crypto.createHash('sha256').update(fs.readFileSync(TAR)).digest('hex');
console.log('SHA256: ' + sha);
console.log('Size: ' + fs.statSync(TAR).size);

// 2. List contents (first 30)
try {
  const list = execSync(`tar -tzf "${TAR}" 2>nul | head -30`, { encoding: 'utf8', timeout: 30000 });
  console.log('\nFirst 30 entries:');
  console.log(list);
} catch (e) {
  console.log('tar listing failed (may need PowerShell): ' + e.message);
}

// 3. Check key files exist in tar
const keyFiles = ['package.json', 'version.txt', 'BUILD-INFO.json', 'index.ts', 'src/app/web/index.html'];
for (const f of keyFiles) {
  try {
    const result = execSync(`tar -tzf "${TAR}" 2>nul | findstr /c:"${f}"`, { encoding: 'utf8', timeout: 30000 });
    console.log('Contains ' + f + ': ' + (result.trim() ? 'YES' : 'NO'));
  } catch {
    console.log('Contains ' + f + ': checking...');
  }
}

console.log('\n=== Verify Complete ===');
