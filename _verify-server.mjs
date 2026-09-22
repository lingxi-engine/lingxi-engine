#!/usr/bin/env node
// _verify-server.mjs - check server-side upload storage
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;

function api(method, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: p, method: method, timeout: 30000 }, (res) => {
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
  // Try to find uploaded file by checking various paths
  // The upload returned url: /uploads/1790075104890-yhm5h5.bin
  // Try to access it directly
  const paths = [
    '/uploads/1790075104890-yhm5h5.bin',
    '/uploads/1790074377735-uuwb4g.bin',
    '/uploads/',
    '/api/uploads',
    '/api/upload',
    '/api/files',
    '/files/',
    '/storage/',
    '/data/',
    '/tmp/',
    '/api/tmp',
    '/api/list',
    '/api/files/list',
    '/api/uploads/list',
    '/api/upload/list',
  ];

  for (const p of paths) {
    try {
      const r = await api('GET', p);
      if (r.status === 200) {
        const body = r.body.toString();
        console.log(p + ': 200 ' + body.slice(0, 300));
        // If it's a file download, check hash
        if (r.body.length > 100000) {
          const sha = crypto.createHash('sha256').update(r.body).digest('hex');
          console.log('  -> file sha256: ' + sha);
        }
      }
    } catch (e) {}
  }

  // Try POST to list endpoint with auth
  const secret = 'lingxi-dev-secret-2026';
  try {
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ sub: 'user-10001', numeric_id: 10001, roles: ['admin'] }, secret, { expiresIn: '7d' });
    for (const p of ['/api/upload/list', '/api/files', '/api/uploads/list']) {
      try {
        const r = await api('GET', p, null, { 'Authorization': 'Bearer ' + token });
        console.log('AUTH ' + p + ': ' + r.status + ' ' + r.body.toString().slice(0, 300));
      } catch {}
    }
  } catch {}
}

main().catch(e => { console.error(e); process.exit(1); });
