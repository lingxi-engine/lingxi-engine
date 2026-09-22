import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';

function sha256(path) {
  const buf = fs.readFileSync(path);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';
const localSha = sha256(tarPath);
console.log('Local SHA256:', localSha);

// Upload to server
const serverUrl = 'http://47.93.157.83:8080/upload';
console.log('\nUploading to', serverUrl);

try {
  const result = execSync(
    `curl -s -X POST -F "file=@\"${tarPath}\"" --connect-timeout 30 --max-time 300 "${serverUrl}"`,
    { encoding: 'utf8', timeout: 320000 }
  );
  console.log('Upload response:', result);
} catch (e) {
  console.log('Upload error:', e.stderr || e.message);
  // Try alternative methods
  console.log('\nTrying PowerShell WebClient...');
  try {
    const psResult = execSync(
      `powershell -Command "$wc = New-Object System.Net.WebClient; $wc.UploadFile('${serverUrl}', '${tarPath}')"`,
      { encoding: 'utf8', timeout: 320000 }
    );
    console.log('PS Upload result:', psResult);
  } catch (e2) {
    console.log('PS Upload error:', e2.stderr || e2.message);
  }
}

// Verify upload
console.log('\nVerifying upload...');
try {
  // Check if server has the file
  const check = execSync(
    `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 "http://47.93.157.83:8080/lingxi-engine-v2.0.23.tar.gz"`,
    { encoding: 'utf8', timeout: 30000 }
  );
  console.log('Remote file HTTP status:', check);
} catch (e) {
  console.log('Verify error:', e.message);
}
