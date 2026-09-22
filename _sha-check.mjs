import fs from 'fs';
import crypto from 'crypto';

function sha256(path) {
  const buf = fs.readFileSync(path);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const source = 'C:/Users/Administrator/AppData/Local/Temp/lingxi-engine-v2.0.23.tar.gz';
const targets = [
  'F:/lingxi-engine-v2.0.23.tar.gz',
  'D:/lingxi-engine-v2.0.23.tar.gz'
];

const srcSha = sha256(source);
console.log('Source SHA256:', srcSha);
console.log('Source size:', fs.statSync(source).size);

for (const target of targets) {
  try {
    const tgtSha = sha256(target);
    const match = srcSha === tgtSha ? 'MATCH' : 'MISMATCH';
    console.log(`\n[${match}] ${target}`);
    console.log(`  SHA256: ${tgtSha}`);
    console.log(`  Size: ${fs.statSync(target).size}`);
  } catch (e) {
    console.log(`\n[FAIL] ${target}: ${e.message}`);
  }
}
