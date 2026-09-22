#!/usr/bin/env node
// _final-check.mjs - final verification of all deliverables
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;

console.log('=== Final Check ===\n');

// 1. Version alignment
console.log('--- 1. Version Alignment ---');
const v1 = fs.readFileSync('version.txt', 'utf8').trim();
const v2 = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
let v3 = 'N/A';
try { v3 = JSON.parse(fs.readFileSync('BUILD-INFO.json', 'utf8')).version; } catch {}
console.log('version.txt: ' + v1);
console.log('package.json: ' + v2);
console.log('BUILD-INFO.json: ' + v3);
console.log('All match: ' + (v1 === v2 && v2 === v3 ? 'PASS' : 'FAIL'));

// 2. Tar.gz integrity
console.log('\n--- 2. Tar.gz Integrity ---');
for (const f of ['F:/lingxi-engine-v2.0.23.tar.gz', 'D:/lingxi-engine-v2.0.23.tar.gz']) {
  try {
    const s = fs.statSync(f);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    console.log(f + ' size=' + s.size + ' sha256=' + sha.slice(0, 16) + '...');
  } catch (e) {
    console.log(f + ' MISSING');
  }
}

// 3. Server health
console.log('\n--- 3. Server Health ---');
function api(method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: p, method: method, timeout: 15000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy());
    req.end();
  });
}
try {
  const r = await api('GET', '/api/health');
  console.log('/api/health: ' + r.status + ' ' + r.body.slice(0, 200));
} catch (e) {
  console.log('/api/health ERR: ' + e.message);
}

console.log('\n=== Check Complete ===');
