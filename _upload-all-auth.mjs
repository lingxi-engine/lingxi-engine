#!/usr/bin/env node
// _upload-all-auth.mjs - upload with auth token
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');

const HOST = '47.93.157.83';
const PORT = 8080;
const TAR = 'F:/lingxi-engine-v2.0.23.tar.gz';

const localSha = crypto.createHash('sha256').update(fs.readFileSync(TAR)).digest('hex');
console.log('Local SHA256: ' + localSha);

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
  const secret = 'lingxi-dev-secret-2026';
  const token = jwt.sign(
    { sub: 'user-10001', numeric_id: 10001, sid: 'admin-session', roles: ['admin', 'user'] },
    secret,
    { expiresIn: '7d' }
  );
  console.log('Token generated');

  // Upload
  const buf = fs.readFileSync(TAR);
  const boundary = '----xi-upload-' + Date.now();
  const header = '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="lingxi-engine-v2.0.23.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n';
  const footer = '\r\n--' + boundary + '--\r\n';
  const body = Buffer.concat([Buffer.from(header), buf, Buffer.from(footer)]);
  console.log('Uploading ' + (body.length / 1048576).toFixed(2) + ' MB...');

  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: HOST, port: PORT, path: '/api/upload', method: 'POST', timeout: 300000, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 500) }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    console.log('upload: ' + r.status + ' ' + r.body);
  } catch (e) { console.log('upload ERR: ' + e.message); }
}

main().catch(e => { console.error(e); process.exit(1); });
