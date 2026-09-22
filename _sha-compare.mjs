#!/usr/bin/env node
// _sha-compare.mjs - compare local and server SHA256
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;
const LOCAL_FILE = 'F:/lingxi-engine-v2.0.23.tar.gz';

const localSha = crypto.createHash('sha256').update(fs.readFileSync(LOCAL_FILE)).digest('hex');
const localSize = fs.statSync(LOCAL_FILE).size;
console.log('Local SHA256: ' + localSha);
console.log('Local size: ' + localSize);

// Download from server via HTTP and compare
function download(path) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = http.request({ host: HOST, port: PORT, path: path, method: 'GET', timeout: 60000 }, (res) => {
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  // Try common paths for the uploaded file
  const paths = [
    '/uploads/lingxi-engine-v2.0.23.tar.gz',
    '/uploads/1790074377735-uuwb4g.bin',
    '/public/lingxi-engine-v2.0.23.tar.gz',
    '/download/lingxi-engine-v2.0.23.tar.gz',
  ];
  for (const p of paths) {
    try {
      const r = await download(p);
      if (r.status === 200 && r.body.length > 0) {
        const remoteSha = crypto.createHash('sha256').update(r.body).digest('hex');
        const remoteSize = r.body.length;
        console.log('\n' + p + ': ' + r.status + ' size:' + remoteSize);
        console.log('Remote SHA256: ' + remoteSha);
        console.log('MATCH: ' + (remoteSha === localSha && remoteSize === localSize));
        return;
      } else {
        console.log(p + ': ' + r.status + ' ' + r.body.slice(0, 100));
      }
    } catch (e) { console.log(p + ': ERR ' + e.message); }
  }
  console.log('\nCould not find uploaded file on server');
}

main().catch(e => { console.error(e); process.exit(1); });
