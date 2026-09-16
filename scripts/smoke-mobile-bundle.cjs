/**
 * 冒烟测试：启动 mobile bundle，探测 /api/mobile/status（须返回 200 JSON），然后干净退出
 * 用法：node scripts/smoke-mobile-bundle.cjs
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = '3499';
const PROBE_PATH = '/api/mobile/status';
const DATA_DIR = path.join(ROOT, 'mobile-dist', '_smoketest');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const child = spawn(process.execPath, [path.join(ROOT, 'mobile-dist', 'lingxi-mobile.js')], {
  env: { ...process.env, LINGXI_PORT: PORT, LINGXI_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

function probe(retry) {
  http.get({ host: '127.0.0.1', port: PORT, path: PROBE_PATH, timeout: 4000 }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      console.log(`PROBE-STATUS=${res.statusCode}`);
      console.log(`PROBE-BODY=${body.slice(0, 400)}`);
      if (res.statusCode === 200) {
        console.log('SMOKE=PASS');
        finish(0);
      } else {
        console.log('SMOKE=FAIL (non-200)');
        console.log('==CHILD OUTPUT==');
        console.log(out.split('\n').slice(0, 60).join('\n'));
        finish(1);
      }
    });
  }).on('error', (e) => {
    if (retry > 0) {
      setTimeout(() => probe(retry - 1), 1500);
    } else {
      console.log(`PROBE-FAIL=${e.message}`);
      console.log('==CHILD OUTPUT==');
      console.log(out.split('\n').slice(0, 60).join('\n'));
      console.log('SMOKE=FAIL');
      finish(1);
    }
  });
}

function finish(code) {
  try { child.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} process.exit(code); }, 1500);
}

setTimeout(() => probe(8), 2500);
setTimeout(() => { console.log('SMOKE=TIMEOUT'); finish(2); }, 45000);
