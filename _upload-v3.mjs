import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';

const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';
const localSha = crypto.createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');

// List tar contents using Node
console.log('=== Tar Contents ===');
try {
  const listing = execSync(`tar -tzf "${tarPath}"`, { encoding: 'utf8', timeout: 30000 });
  const lines = listing.trim().split('\n').filter(l => l.trim());
  console.log('Total entries:', lines.length);
  // Show top-level dirs
  const topLevel = new Set(lines.map(l => l.split('/')[0]));
  console.log('Top-level entries:', [...topLevel].join(', '));
  // Show first 20
  console.log('\nFirst 20 entries:');
  lines.slice(0, 20).forEach(l => console.log('  ' + l));
  // Check for version.txt in package
  const verFile = lines.find(l => l.endsWith('version.txt'));
  if (verFile) {
    console.log('\nversion.txt found at:', verFile);
  }
  // Check for BUILD-INFO
  const buildInfo = lines.find(l => l.includes('BUILD-INFO'));
  if (buildInfo) {
    console.log('BUILD-INFO found at:', buildInfo);
  }
} catch (e) {
  console.log('Failed:', e.message.slice(0, 200));
}

// Now try upload via multiple methods
console.log('\n=== Upload Attempts ===');
const host = '47.93.157.83';
const port = '8080';

// Method 1: POST to /api/upload with admin token
console.log('\n[1] POST /api/upload (try without auth first)');
try {
  const result = execSync(
    `curl -s -X POST -F "file=@\"${tarPath}\"" --connect-timeout 10 --max-time 300 "http://${host}:${port}/api/upload" 2>&1`,
    { encoding: 'utf8', timeout: 320000 }
  );
  console.log('Response:', result.slice(0, 300));
} catch (e) {
  console.log('Error:', (e.stderr || e.message).toString().slice(0, 200));
}

// Method 2: Check if there's a deploy endpoint in the server code
console.log('\n[2] Checking server-side deploy endpoint');
// The site-server.js doesn't have upload - it's a static file server
// The install.ps1 at 8080/install.ps1 is the deployment script

// Method 3: Try uploading via the install endpoint pattern
console.log('\n[3] Try PUT /public/lingxi-engine.tar.gz');
try {
  const result = execSync(
    `curl -s -X PUT -T "${tarPath}" --connect-timeout 10 --max-time 300 "http://${host}:${port}/public/lingxi-engine.tar.gz" 2>&1`,
    { encoding: 'utf8', timeout: 320000 }
  );
  console.log('Response:', result.slice(0, 300));
} catch (e) {
  console.log('Error:', (e.stderr || e.message).toString().slice(0, 200));
}

// Method 4: Check if there's a separate upload service
console.log('\n[4] Check for upload service on other ports');
for (const p of [9000, 9001, 9002, 9090]) {
  try {
    const code = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 5 "http://${host}:${p}/" 2>&1`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    if (code !== '000') console.log(`Port ${p}: ${code}`);
  } catch (e) { /* skip */ }
}
