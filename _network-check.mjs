import { execSync } from 'child_process';
import fs from 'fs';

const host = '47.93.157.83';
const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';

// Check if we can reach the server at all
console.log('=== Network check ===');
try {
  const result = execSync(
    `ping -n 2 ${host} 2>&1`,
    { encoding: 'utf8', timeout: 15000 }
  );
  console.log(result);
} catch (e) {
  console.log('Ping failed:', e.message.slice(0, 200));
}

// Check if 8080 is really up
console.log('\n=== Port 8080 check ===');
try {
  const result = execSync(
    `curl -v --connect-timeout 10 --max-time 15 "http://${host}:8080/api/health" 2>&1`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log(result.slice(0, 1000));
} catch (e) {
  console.log('8080 failed:', e.message.slice(0, 300));
}

// Maybe the server needs a specific path prefix
console.log('\n=== Try with /lingxi prefix ===');
for (const prefix of ['', '/lingxi', '/engine', '/app', '/api']) {
  try {
    const result = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "http://${host}:8080${prefix}/api/health"`,
      { encoding: 'utf8', timeout: 20000 }
    );
    console.log(`${prefix}/api/health: ${result}`);
  } catch (e) { /* skip */ }
}

// Check if there's a deploy script in the repo
console.log('\n=== Look for deploy scripts ===');
const deployFiles = fs.readdirSync('.');
deployFiles.filter(f => f.toLowerCase().includes('deploy') || f.toLowerCase().includes('publish') || f.toLowerCase().includes('release'))
  .forEach(f => console.log(f));

// Check docs for deployment instructions
console.log('\n=== Check docs ===');
const docsDir = 'docs';
if (fs.existsSync(docsDir)) {
  const docs = fs.readdirSync(docsDir);
  docs.filter(d => d.toLowerCase().includes('deploy') || d.toLowerCase().includes('release') || d.toLowerCase().includes('install'))
    .forEach(d => console.log(path.join(docsDir, d)));
}
