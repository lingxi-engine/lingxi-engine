import { execSync } from 'child_process';

const host = '47.93.157.83';
const port = '8080';

const endpoints = [
  '/',
  '/public/lingxi-engine.tar.gz',
  '/install.ps1',
  '/api/upload',
  '/upload',
  '/api/health',
  '/download.html',
  '/version.txt',
];

console.log('=== Probing server endpoints ===');
for (const ep of endpoints) {
  try {
    const code = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "http://${host}:${port}${ep}"`,
      { encoding: 'utf8', timeout: 30000 }
    ).trim();
    console.log(`${code}  ${ep}`);
  } catch (e) {
    console.log(`ERR  ${ep}: ${e.message.slice(0, 60)}`);
  }
}

// Check what's running on the server
console.log('\n=== Check if port 8080 is the right one ===');
try {
  const health = execSync(
    `curl -s --connect-timeout 10 --max-time 15 "http://${host}:8080/api/health"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log('Health:', health.slice(0, 500));
} catch (e) {
  console.log('Health check failed:', e.message.slice(0, 200));
}

// Try port 80
console.log('\n=== Try port 80 ===');
try {
  const code = execSync(
    `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 15 "http://${host}/api/health"`,
    { encoding: 'utf8', timeout: 30000 }
  ).trim();
  console.log('Port 80 health:', code);
} catch (e) {
  console.log('Port 80 failed');
}

// Try other common ports
for (const p of [3000, 3456, 8081, 8443]) {
  try {
    const code = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "http://${host}:${p}/api/health"`,
      { encoding: 'utf8', timeout: 20000 }
    ).trim();
    console.log(`Port ${p}: ${code}`);
  } catch (e) {
    // silent
  }
}
