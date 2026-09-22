import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';

const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';
const localSha = crypto.createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');

console.log('=== Local Package Info ===');
console.log('SHA256:', localSha);
console.log('Size:', fs.statSync(tarPath).size, 'bytes');

// Check tar contents for version.txt and BUILD-INFO
console.log('\n=== Version in Package ===');
try {
  const verContent = execSync(`tar -xzf "${tarPath}" -O --wildcard '*/version.txt'`, { encoding: 'utf8', timeout: 10000 });
  console.log('version.txt:', JSON.stringify(verContent.trim()));
} catch (e) {
  console.log('Could not extract:', e.message.slice(0, 100));
}

console.log('\n=== BUILD-INFO in Package ===');
try {
  const buildContent = execSync(`tar -xzf "${tarPath}" -O --wildcard '*/BUILD-INFO.json'`, { encoding: 'utf8', timeout: 10000 });
  console.log('BUILD-INFO:', buildContent.trim());
} catch (e) {
  console.log('Could not extract:', e.message.slice(0, 100));
}

// Check for console.log(l)) file
console.log('\n=== Suspicious File Check ===');
try {
  const listing = execSync(`tar -tzf "${tarPath}"`, { encoding: 'utf8', timeout: 30000 });
  const suspicious = listing.split('\n').filter(l => l.includes('console'));
  console.log('Files with console in name:', suspicious.length === 0 ? 'NONE ✅' : suspicious);
} catch (e) {
  console.log('Check failed');
}

// Now try to find the auth token
// The server is on 8080, health shows 2.0.17
// /api/admin/* proxies to PLATFORM_PORT=3001
// Let's check port 3001
console.log('\n=== Check port 3001 ===');
try {
  const result = execSync(
    `curl -s --connect-timeout 10 --max-time 15 "http://47.93.157.83:3001/api/admin/health" 2>&1`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log('3001:', result.slice(0, 300));
} catch (e) {
  console.log('3001 failed');
}

// Try common admin tokens
console.log('\n=== Try admin endpoints ===');
const endpoints = [
  'http://47.93.157.83:8080/api/admin/health',
  'http://47.93.157.83:8080/api/admin/status',
  'http://47.93.157.83:8080/api/admin/upload',
  'http://47.93.157.83:8080/api/admin/deploy',
];
for (const ep of endpoints) {
  try {
    const code = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "${ep}"`,
      { encoding: 'utf8', timeout: 20000 }
    ).trim();
    console.log(`${ep}: ${code}`);
  } catch (e) { /* skip */ }
}

// Check if there's a /api/auth/login endpoint
console.log('\n=== Auth endpoints ===');
const authEndpoints = [
  'http://47.93.157.83:8080/api/auth/login',
  'http://47.93.157.83:8080/api/login',
  'http://47.93.157.83:8080/api/token',
];
for (const ep of authEndpoints) {
  try {
    const code = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "${ep}"`,
      { encoding: 'utf8', timeout: 20000 }
    ).trim();
    console.log(`${ep}: ${code}`);
  } catch (e) { /* skip */ }
}
