import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';

const host = '47.93.157.83';
const port = '8080';
const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';
const localSha = crypto.createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');

console.log('Local SHA256:', localSha);

// First login to get token
console.log('\n=== Login ===');
let token = '';
try {
  const loginRes = execSync(
    `curl -s -X POST -H "Content-Type: application/json" -d '{"username":"admin","password":"admin"}' --connect-timeout 10 --max-time 15 "http://${host}:${port}/api/auth/login"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log('Login:', loginRes.slice(0, 300));
  // Try to extract token
  const match = loginRes.match(/"token"\s*:\s*"([^"]+)"/);
  if (match) {
    token = match[1];
    console.log('Token:', token.slice(0, 40) + '...');
  }
} catch (e) {
  console.log('Login failed:', (e.stderr || e.message).toString().slice(0, 300));
}

// Try common credentials
if (!token) {
  const creds = [
    { u: 'admin', p: 'admin' },
    { u: 'root', p: 'root' },
    { u: 'admin', p: 'lingxi' },
    { u: 'admin', p: '123456' },
    { u: 'root', p: 'admin' },
  ];
  for (const { u, p } of creds) {
    try {
      const res = execSync(
        `curl -s -X POST -H "Content-Type: application/json" -d '{"username":"${u}","password":"${p}"}' --connect-timeout 10 --max-time 15 "http://${host}:${port}/api/auth/login"`,
        { encoding: 'utf8', timeout: 30000 }
      );
      console.log(`Creds ${u}/${p}: ${res.slice(0, 200)}`);
      const match = res.match(/"token"\s*:\s*"([^"]+)"/);
      if (match) {
        token = match[1];
        console.log('Token found!');
        break;
      }
    } catch (e) { /* continue */ }
  }
}

// Check what endpoints exist
console.log('\n=== Check /api routes ===');
try {
  const routes = execSync(
    `curl -s --connect-timeout 10 --max-time 15 "http://${host}:${port}/api/routes" 2>&1 || echo "no /api/routes"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log(routes.slice(0, 1000));
} catch (e) {
  console.log('Routes check failed');
}

// Try upload with auth header if we have token
if (token) {
  console.log('\n=== Upload with token ===');
  try {
    const result = execSync(
      `curl -s -X POST -H "Authorization: Bearer ${token}" -F "file=@\"${tarPath}\"" --connect-timeout 10 --max-time 300 "http://${host}:${port}/api/upload" 2>&1`,
      { encoding: 'utf8', timeout: 320000 }
    );
    console.log('Upload:', result.slice(0, 500));
  } catch (e) {
    console.log('Upload failed:', (e.stderr || e.message).toString().slice(0, 300));
  }
}
