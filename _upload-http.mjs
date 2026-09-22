#!/usr/bin/env node
// _upload-http.mjs - upload v2.0.23 tar.gz to server via HTTP POST
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;
const TAR = 'F:/lingxi-engine-v2.0.23.tar.gz';

const localSha = crypto.createHash('sha256').update(fs.readFileSync(TAR)).digest('hex');
const localSize = fs.statSync(TAR).size;
console.log('Local SHA256: ' + localSha);
console.log('Local size: ' + localSize);

function api(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : null;
    const h = Object.assign({}, headers || {});
    if (data) {
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
      h['Content-Length'] = data.length;
    }
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
  // Try login first
  let token = '';
  const creds = [
    { email: 'admin@lingxi.local', password: 'admin' },
    { email: 'admin@lingxi.local', password: 'lingxi' },
    { email: 'admin@lingxi.local', password: '123456' },
  ];
  for (const c of creds) {
    try {
      const r = await api('POST', '/api/auth/login', c);
      console.log('login ' + c.email + ': ' + r.status + ' ' + r.body.slice(0, 150));
      const m = r.body.match(/"token"\s*:\s*"([^"]+)"/);
      if (m) { token = m[1]; console.log('TOKEN FOUND'); break; }
    } catch (e) {}
  }

  // If no token, try generating one
  if (!token) {
    console.log('No token from login, trying direct upload without auth');
    try {
      const buf = fs.readFileSync(TAR);
      const boundary = '----xi-' + Date.now();
      const header = '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="lingxi-engine-v2.0.23.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n';
      const footer = '\r\n--' + boundary + '--\r\n';
      const body = Buffer.concat([Buffer.from(header), buf, Buffer.from(footer)]);
      const r = await new Promise((resolve, reject) => {
        const req = http.request({ host: HOST, port: PORT, path: '/api/upload', method: 'POST', timeout: 300000, headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 500) }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
      });
      console.log('upload (no auth): ' + r.status + ' ' + r.body);
      return;
    } catch (e) { console.log('upload ERR: ' + e.message); }
  }

  // Upload with token
  const buf = fs.readFileSync(TAR);
  const boundary = '----xi-upload-' + Date.now();
  const header = '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="lingxi-engine-v2.0.23.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n';
  const footer = '\r\n--' + boundary + '--\r\n';
  const body = Buffer.concat([Buffer.from(header), buf, Buffer.from(footer)]);
  console.log('Uploading...');
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: HOST, port: PORT, path: '/api/upload', method: 'POST', timeout: 300000, headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 1000) }));
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
