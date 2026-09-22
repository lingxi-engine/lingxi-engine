import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';

const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';
const localSha = crypto.createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');

console.log('=== Package Verification ===');
console.log('SHA256:', localSha);
console.log('Size:', fs.statSync(tarPath).size, 'bytes');

// Check tar contents
console.log('\n=== Tar Contents (top level) ===');
try {
  const listing = execSync(
    `tar -tzf "${tarPath}" | head -30`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log(listing);
} catch (e) {
  console.log('tar list failed:', e.message.slice(0, 200));
}

// Check for sensitive files
console.log('\n=== Checking for sensitive files ===');
try {
  const allFiles = execSync(`tar -tzf "${tarPath}"`, { encoding: 'utf8', timeout: 30000 });
  const envFiles = allFiles.split('\n').filter(f => f.includes('.env') && !f.includes('.env.example') && !f.includes('.env.template'));
  const dataDirs = allFiles.split('\n').filter(f => f.includes('/data') || f.includes('data-v'));
  const nodeModules = allFiles.split('\n').filter(f => f.includes('node_modules'));
  console.log('.env files in package:', envFiles.length === 0 ? 'NONE ✅' : envFiles);
  console.log('data dirs in package:', dataDirs.length === 0 ? 'NONE ✅' : dataDirs.slice(0, 5));
  console.log('node_modules in package:', nodeModules.length === 0 ? 'NONE ✅' : `(${nodeModules.length} entries)`);
} catch (e) {
  console.log('Check failed:', e.message.slice(0, 200));
}

// Try to download server's existing tar.gz to check version
console.log('\n=== Check server existing tar.gz ===');
const urls = [
  'http://47.93.157.83:8080/public/lingxi-engine.tar.gz',
  'http://47.93.157.83:8080/public/lingxi-engine-v2.0.22.tar.gz',
  'http://47.93.157.83:8080/lingxi-engine.tar.gz',
];
for (const url of urls) {
  try {
    execSync(
      `curl -s -o /tmp/server-tar.gz --connect-timeout 10 --max-time 30 "${url}"`,
      { encoding: 'utf8', timeout: 60000 }
    );
    const stat = fs.statSync('/tmp/server-tar.gz');
    if (stat.size > 1000) {
      const sha = crypto.createHash('sha256').update(fs.readFileSync('/tmp/server-tar.gz')).digest('hex');
      console.log(`${url}: ${stat.size} bytes, SHA256: ${sha.slice(0, 16)}...`);
    }
  } catch (e) {
    console.log(`${url}: failed`);
  }
}
