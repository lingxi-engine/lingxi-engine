import { execSync } from 'child_process';
import fs from 'fs';

const host = '47.93.157.83';
const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';

// The server on 8080 is a management interface
// Let's check what endpoints exist by looking at the health response fully
console.log('=== Full health check ===');
try {
  const result = execSync(
    `curl -s --connect-timeout 10 --max-time 15 "http://${host}:8080/api/health"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log(result);
} catch (e) {
  console.log('Failed');
}

// Check if there's a /api/admin endpoint
console.log('\n=== Admin endpoints ===');
for (const ep of ['/api/admin/health', '/api/admin/status', '/api/admin/deploy', '/api/admin/upload', '/api/admin/release']) {
  try {
    const code = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "http://${host}:8080${ep}"`,
      { encoding: 'utf8', timeout: 20000 }
    ).trim();
    console.log(`${ep}: ${code}`);
  } catch (e) { /* skip */ }
}

// Check what the server actually is
console.log('\n=== Root path ===');
try {
  const result = execSync(
    `curl -s --connect-timeout 10 --max-time 15 "http://${host}:8080/"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log(result.slice(0, 500));
} catch (e) {
  console.log('Failed');
}

// Check if there's a deploy endpoint on the engine port (3456)
console.log('\n=== Check engine port 3456 ===');
try {
  const result = execSync(
    `curl -s --connect-timeout 10 --max-time 15 "http://${host}:3456/api/health"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log('Engine 3456:', result.slice(0, 500));
} catch (e) {
  console.log('Engine 3456 unreachable');
}
