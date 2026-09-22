import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;
const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';
const localSha = crypto.createHash('sha256').update(fs.readFileSync(tarPath)).digest('hex');

console.log('=== Upload v2.0.23 ===');
console.log('Local SHA256:', localSha);
console.log('Size:', fs.statSync(tarPath).size, 'bytes');

const authHeaders = [
  { 'Authorization': 'Bearer admin' },
  { 'Authorization': 'Bearer root' },
  { 'Authorization': 'Bearer lingxi' },
  { 'Authorization': 'Token admin' },
  { 'Authorization': 'Token root' },
  { 'x-admin-token': 'admin' },
  { 'x-admin-token': 'root' },
  { 'x-admin-token': 'lingxi' },
];

function uploadWithAuth(authHeader) {
  return new Promise((resolve, reject) => {
    const formData = fs.readFileSync(tarPath);
    const boundary = '----WebKitFormBoundary' + Date.now();
    const parts = [];
    parts.push(`--${boundary}\r\n`);
    parts.push(`Content-Disposition: form-data; name="file"; filename="lingxi-engine-v2.0.23.tar.gz"\r\n`);
    parts.push(`Content-Type: application/gzip\r\n\r\n`);
    const header = parts.join('');
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(header),
      formData,
      Buffer.from(footer)
    ]);

    const options = {
      hostname: HOST,
      port: PORT,
      path: '/api/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
        ...authHeader
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data.slice(0, 300) });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function tryUploads() {
  for (const h of authHeaders) {
    try {
      const result = await uploadWithAuth(h);
      console.log(`Auth ${JSON.stringify(h)}: ${result.status} ${result.body}`);
    } catch (e) {
      console.log(`Auth ${JSON.stringify(h)}: ERROR ${e.message.slice(0, 100)}`);
    }
  }
}

tryUploads().then(() => {
  console.log('\nAll auth attempts done');
}).catch(e => {
  console.log('Upload failed:', e.message.slice(0, 300));
});
