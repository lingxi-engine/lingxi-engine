#!/usr/bin/env node
// _verify-upload.mjs - verify server received the upload
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;
const LOCAL_SHA = crypto.createHash('sha256').update(fs.readFileSync('F:/lingxi-engine-v2.0.23.tar.gz')).digest('hex');

function api(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: HOST, port: PORT, path: p, method: method, timeout: 30000, headers: h }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy());
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('Local SHA256: ' + LOCAL_SHA);

  // Check health
  try {
    const h = await api('GET', '/api/health');
    console.log('health: ' + h.status + ' ' + h.body.slice(0, 300));
  } catch (e) { console.log('health ERR: ' + e.message); }

  // Check /uploads/ directory listing (try various paths)
  for (const path of ['/uploads/', '/api/uploads', '/api/upload', '/uploads']) {
    try {
      const r = await api('GET', path);
      console.log(path + ': ' + r.status + ' ' + r.body.slice(0, 200));
    } catch (e) {}
  }

  // Check if the uploaded file is accessible via HTTP
  // The upload returned url: /uploads/1790074377735-uuwb4g.bin
  try {
    const r = await api('GET', '/uploads/1790074377735-uuwb4g.bin');
    console.log('uploaded file: ' + r.status + ' size:' + (r.body ? r.body.length : 0));
    if (r.status === 200 && r.body) {
      const remoteSha = crypto.createHash('sha256').update(Buffer.from(r.body)).digest('hex');
      console.log('remote sha256: ' + remoteSha);
      console.log('MATCH: ' + (remoteSha === LOCAL_SHA));
    }
  } catch (e) { console.log('uploaded file ERR: ' + e.message); }

  // Check /api/health more carefully
  try {
    const h = await api('GET', '/api/health');
    const body = JSON.parse(h.body);
    console.log('health version: ' + (body.version || 'N/A'));
  } catch (e) {}
}

main().catch(e => { console.error(e); process.exit(1); });
