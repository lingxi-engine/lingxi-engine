#!/usr/bin/env node
// _verify-upload.mjs - verify uploaded file on server
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;
const LOCAL_SHA = crypto.createHash('sha256').update(fs.readFileSync('F:/lingxi-engine-v2.0.23.tar.gz')).digest('hex');

console.log('Local SHA256: ' + LOCAL_SHA);

function api(method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: p, method: method, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  for (const path of [
    '/uploads/1790075104890-yhm5h5.bin',
    '/uploads/1790074377735-uuwb4g.bin',
    '/public/lingxi-engine-v2.0.23.tar.gz',
    '/uploads/lingxi-engine-v2.0.23.tar.gz',
  ]) {
    try {
      const r = await api('GET', path);
      if (r.status === 200 && r.body.length > 100000) {
        const remoteSha = crypto.createHash('sha256').update(r.body).digest('hex');
        console.log(path + ': 200 size=' + r.body.length);
        console.log('  remote sha256: ' + remoteSha);
        console.log('  local  sha256: ' + LOCAL_SHA);
        console.log('  MATCH: ' + (remoteSha === LOCAL_SHA ? 'YES' : 'NO'));
      } else {
        console.log(path + ': ' + r.status + ' ' + r.body.slice(0, 80));
      }
    } catch (e) { console.log(path + ': ERR ' + e.message); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
