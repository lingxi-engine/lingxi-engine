#!/usr/bin/env node
// _discover-upload.mjs - find where server stores uploads
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;

function api(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: HOST, port: PORT, path: p, method: method, timeout: 15000, headers: h }, (res) => {
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
  // Try to find upload directory
  const paths = [
    '/uploads/',
    '/api/uploads',
    '/api/upload/list',
    '/uploads/list',
    '/files/',
    '/api/files',
    '/storage/',
    '/api/storage',
    '/data/',
    '/api/data',
    '/tmp/',
    '/api/tmp',
    '/public/',
    '/api/public',
    '/download/',
    '/api/download',
  ];
  for (const p of paths) {
    try {
      const r = await api('GET', p);
      if (r.status === 200) {
        console.log(p + ': 200 ' + r.body.slice(0, 500));
      }
    } catch (e) {}
  }

  // Also try to list root
  try {
    const r = await api('GET', '/');
    console.log('/: ' + r.status + ' ' + r.body.slice(0, 300));
  } catch (e) {}
}

main().catch(e => { console.error(e); process.exit(1); });
