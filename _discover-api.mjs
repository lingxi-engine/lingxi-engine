import { execSync } from 'child_process';
import fs from 'fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;
const tarPath = 'F:/lingxi-engine-v2.0.23.tar.gz';

console.log('=== Server API Discovery ===');

// Try to get API docs or list endpoints
async function tryEndpoint(path, method = 'GET') {
  return new Promise((resolve) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: path,
      method: method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ status: res.statusCode, body: data.slice(0, 300) });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message.slice(0, 100) }));
    req.end();
  });
}

async function discover() {
  // Try common API discovery paths
  const paths = [
    '/api', '/api/v1', '/api/v2', '/api/docs', '/api/openapi.json',
    '/docs', '/swagger', '/swagger.json', '/api/swagger.json',
    '/.well-known/openapi.json', '/api/openapi',
  ];
  for (const p of paths) {
    const r = await tryEndpoint(p);
    if (r.status !== 404 && r.status !== 0) {
      console.log(`${p}: ${r.status} ${r.body}`);
    }
  }

  // Try to find admin endpoints (site-server proxies /api/admin/* to port 3001)
  console.log('\n=== Try /api/admin/* ===');
  const adminPaths = [
    '/api/admin/health',
    '/api/admin/status',
    '/api/admin/info',
    '/api/admin/config',
    '/api/admin/version',
    '/api/admin/deploy',
    '/api/admin/upload',
    '/api/admin/release',
  ];
  for (const p of adminPaths) {
    const r = await tryEndpoint(p);
    console.log(`${p}: ${r.status} ${r.body.slice(0, 100)}`);
  }

  // Try platform port 3001 directly
  console.log('\n=== Try port 3001 ===');
  const port3001Paths = [
    '/api/health',
    '/api/admin/health',
    '/api/status',
    '/',
  ];
  for (const p of port3001Paths) {
    try {
      const r = await new Promise((resolve) => {
        const options = { hostname: HOST, port: 3001, path: p, method: 'GET' };
        const req = http.request(options, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 200) }));
        });
        req.on('error', (e) => resolve({ status: 0, body: e.message.slice(0, 100) }));
        req.end();
      });
      console.log(`3001${p}: ${r.status} ${r.body}`);
    } catch (e) { /* skip */ }
  }

  // Check 8080 root page for hints
  console.log('\n=== 8080 root ===');
  const r = await tryEndpoint('/');
  console.log(`/ : ${r.status}`);
  console.log(r.body.slice(0, 500));
}

discover().then(() => {
  console.log('\nDiscovery done');
}).catch(e => {
  console.log('Error:', e.message);
});
