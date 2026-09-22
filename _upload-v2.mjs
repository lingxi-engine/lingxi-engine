import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';

const host = '47.93.157.83';
const port = '8080';
const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';
const localSha = crypto.createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');

console.log('Local SHA256:', localSha);

// Upload via POST with proper content type
console.log('\n=== Trying upload endpoints ===');
const uploadUrls = [
  `http://${host}:${port}/api/upload`,
  `http://${host}:${port}/upload`,
  `http://${host}:${port}/api/deploy`,
  `http://${host}:${port}/deploy`,
  `http://${host}:${port}/api/release`,
];

for (const url of uploadUrls) {
  try {
    const result = execSync(
      `curl -s -X POST -F "file=@\"${tarPath}\"" --connect-timeout 10 --max-time 300 "${url}" 2>&1`,
      { encoding: 'utf8', timeout: 320000 }
    );
    console.log(`${url}: ${result.slice(0, 200)}`);
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message).toString().slice(0, 200);
    console.log(`${url}: ${msg}`);
  }
}

// Try PUT method
console.log('\n=== Trying PUT ===');
try {
  const result = execSync(
    `curl -s -X PUT -T "${tarPath}" --connect-timeout 10 --max-time 300 "http://${host}:${port}/api/upload" 2>&1`,
    { encoding: 'utf8', timeout: 320000 }
  );
  console.log('PUT result:', result.slice(0, 200));
} catch (e) {
  console.log('PUT failed:', (e.stderr || e.message).toString().slice(0, 200));
}

// Check server-side: what's in /opt/lingxi-engine?
console.log('\n=== Check server deploy dir via SSH ===');
try {
  const sshResult = execSync(
    `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@${host} "ls -la /opt/lingxi-engine/ 2>&1; echo ---; ls -la /var/www/lingxi/public/ 2>&1"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log(sshResult.slice(0, 1000));
} catch (e) {
  console.log('SSH failed:', (e.stderr || e.message).toString().slice(0, 300));
}
