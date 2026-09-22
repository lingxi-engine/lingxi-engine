import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';

const host = '47.93.157.83';
const port = '8080';
const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';
const localSha = crypto.createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');

console.log('Local SHA256:', localSha);

// The server is running on 8080 but is a DIFFERENT app (health shows 2.0.17)
// The install.ps1 at 8080 was the real deployment target
// Let's check if there's a separate port for the engine
console.log('\n=== Checking all ports ===');
const ports = [3456, 8080, 443, 80, 3000, 8081, 8443, 9000];
for (const p of ports) {
  try {
    const code = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "http://${host}:${p}/api/health" 2>&1`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
    if (code !== '000') console.log(`Port ${p}: ${code}`);
  } catch (e) { /* skip */ }
}

// Check if install.ps1 works
console.log('\n=== Check install.ps1 ===');
try {
  const result = execSync(
    `curl -s --connect-timeout 10 --max-time 15 -o /dev/null -w "%{http_code}" "http://${host}:8080/install.ps1"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log('install.ps1 status:', result);
} catch (e) {
  console.log('install.ps1 failed');
}

// Check /public/lingxi-engine.tar.gz
console.log('\n=== Check public tar.gz ===');
try {
  const result = execSync(
    `curl -s --connect-timeout 10 --max-time 15 -o /dev/null -w "%{http_code}" "http://${host}:8080/public/lingxi-engine.tar.gz"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log('public tar.gz status:', result);
} catch (e) {
  console.log('public tar.gz failed');
}

// The server on 8080 seems to be a management interface
// Maybe the actual engine runs on a different port or via pm2
console.log('\n=== Try direct engine port 3456 ===');
try {
  const result = execSync(
    `curl -s --connect-timeout 10 --max-time 15 "http://${host}:3456/api/health"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log('Engine 3456:', result.slice(0, 500));
} catch (e) {
  console.log('Engine 3456 unreachable');
}
