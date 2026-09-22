import { execSync } from 'child_process';
import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';

const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';
const projectRoot = 'C:/Users/Administrator/lingxi-engine';

console.log('=== Manual pack via git archive + Node zlib ===');

// Step 1: git archive to raw tar
console.log('git archive...');
const tarBuf = execSync(
  `git archive --format=tar --prefix=lingxi-engine/ HEAD`,
  { cwd: projectRoot, timeout: 60000, maxBuffer: 50 * 1024 * 1024 }
);
console.log('Tar size:', tarBuf.length, 'bytes');

// Step 2: gzip with Node zlib
console.log('gzip...');
const gzBuf = zlib.gzipSync(tarBuf);
console.log('Gzipped size:', gzBuf.length, 'bytes');

// Step 3: Write
fs.writeFileSync(tarPath, gzBuf);
console.log('Written to', tarPath);

// Step 4: Verify
const stat = fs.statSync(tarPath);
const sha = crypto.createHash('sha256').update(gzBuf).digest('hex');
console.log('SHA256:', sha);
console.log('Size:', stat.size, 'bytes');

// Step 5: List contents
console.log('\n=== Contents ===');
const listing = execSync(`tar -tzf "${tarPath}"`, { encoding: 'utf8', timeout: 30000 });
const lines = listing.trim().split('\n').filter(l => l.trim());
console.log('Total entries:', lines.length);

// Check for weird files
const hasWeird = lines.some(l => l.includes('console.log('));
console.log('Has console.log weird file:', hasWeird ? 'YES ❌' : 'NONE ✅');

// Check for .env
const envCount = lines.filter(l => {
  const fn = l.split('/').pop();
  return fn.startsWith('.env') && !fn.includes('example') && !fn.includes('template');
}).length;
console.log('Has .env files:', envCount === 0 ? 'NONE ✅' : 'YES ❌');

// Check for data dirs
const dataCount = lines.filter(l => l.includes('/data/') || l.includes('data-v')).length;
console.log('Has data dirs:', dataCount === 0 ? 'NONE ✅' : `YES (${dataCount})`);

// Check for node_modules
const nmCount = lines.filter(l => l.includes('node_modules')).length;
console.log('Has node_modules:', nmCount === 0 ? 'NONE ✅' : `YES (${nmCount})`);

// Check version.txt
const verEntry = lines.find(l => l.endsWith('version.txt'));
if (verEntry) {
  const ver = execSync(`tar -xzf "${tarPath}" -O ${verEntry}`, { encoding: 'utf8', timeout: 10000 }).trim();
  console.log('version.txt:', JSON.stringify(ver));
}

// Check BUILD-INFO
const buildEntry = lines.find(l => l.includes('BUILD-INFO'));
if (buildEntry) {
  const build = execSync(`tar -xzf "${tarPath}" -O ${buildEntry}`, { encoding: 'utf8', timeout: 10000 }).trim();
  console.log('BUILD-INFO:', build.slice(0, 200));
}

// Check key files exist (normalize: strip \r, match exact)
const keyFiles = ['index.ts', 'src/core/router.ts', 'src/ai/hub.ts', 'src/storage/db.ts', 'package.json', 'web/index.html'];
console.log('\n=== Key files ===');
for (const kf of keyFiles) {
  const pattern = `lingxi-engine/${kf}`;
  const found = lines.some(l => l.replace(/\r$/, '').startsWith(pattern));
  console.log(`${kf}: ${found ? 'OK ✅' : 'MISSING ❌'}`);
}

// Show sample entries
console.log('\n=== Sample entries ===');
lines.slice(0, 15).forEach(l => console.log('  ' + l.replace(/\r$/, '')));

// Show some src files
console.log('\n=== src files ===');
lines.filter(l => l.includes('/src/') && !l.endsWith('/')).slice(0, 20).forEach(l => console.log('  ' + l.replace(/\r$/, '')));
