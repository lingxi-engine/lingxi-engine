#!/usr/bin/env node
/** _upload-now.mjs —— 将 v2.0.23 tar.gz 上传到服务器 47.93.157.83:8080 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';

const HOST = '47.93.157.83';
const PORT = 8080;
const TAR = 'F:/lingxi-engine-v2.0.23.tar.gz';

const localSha = crypto.createHash('sha256').update(fs.readFileSync(TAR)).digest('hex');
const localSize = fs.statSync(TAR).size;
console.log(`本地文件: ${TAR}`);
console.log(`大小: ${(localSize / 1048576).toFixed(2)} MB`);
console.log(`SHA256: ${localSha}`);

// 先探测健康接口
async function probe() {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: '/api/health', method: 'GET', timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 300) }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

// 尝试上传（multipart/form-data）
async function upload() {
  const boundary = '----lingxi-upload-' + Date.now();
  const buf = fs.readFileSync(TAR);
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="lingxi-engine-v2.0.23.tar.gz"\r\nContent-Type: application/gzip\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([
    Buffer.from(header),
    buf,
    Buffer.from(footer),
  ]);

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: PORT, path: '/api/upload',
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 300000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 500) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout 300s')); });
    req.write(body);
    req.end();
  });
}

// 尝试 PUT 上传（裸文件）
async function putUpload() {
  const buf = fs.readFileSync(TAR);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: PORT, path: '/api/upload',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Length': buf.length,
      },
      timeout: 300000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data.slice(0, 500) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout 300s')); });
    req.write(buf);
    req.end();
  });
}

try {
  console.log('\n=== 探测 /api/health ===');
  const health = await probe();
  console.log(`  status: ${health.status}`);
  console.log(`  body: ${health.body}`);
} catch (e) {
  console.log(`  health 失败: ${e.message}`);
}

try {
  console.log('\n=== POST /api/upload (multipart) ===');
  const r1 = await upload();
  console.log(`  status: ${r1.status}`);
  console.log(`  body: ${r1.body}`);
} catch (e) {
  console.log(`  失败: ${e.message}`);
}

try {
  console.log('\n=== PUT /api/upload (raw) ===');
  const r2 = await putUpload();
  console.log(`  status: ${r2.status}`);
  console.log(`  body: ${r2.body}`);
} catch (e) {
  console.log(`  失败: ${e.message}`);
}

console.log('\n完成');
