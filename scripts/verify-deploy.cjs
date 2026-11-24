#!/usr/bin/env node
/**
 * scripts/verify-deploy.cjs —— 部署后自动验证线上实例与代码版本一致
 *
 * 用法:
 *   node scripts/verify-deploy.cjs --url http://203.0.113.7:3456
 *   node scripts/verify-deploy.cjs --host 127.0.0.1 --port 3456
 *   node scripts/verify-deploy.cjs --url ... --expect-commit abc1234 --expect-version 2.0.22
 *
 * 退出码: 0=PASS  1=版本/commit 不一致  2=不可达
 */
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

const REPO = path.resolve(__dirname, '..');
let url = get('url', '');
if (!url) {
  const host = get('host', '127.0.0.1');
  const port = get('port', '3456');
  url = `http://${host}:${port}`;
}
const base = url.replace(/\/+$/, '');

function localVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version; } catch { return null; }
}
function localCommit() {
  try { return execSync('git rev-parse --short HEAD', { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}

function fetchJson(u, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = u.startsWith('https') ? https : http;
    const req = mod.get(u, { timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('not JSON: ' + b.slice(0, 120))); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

(async () => {
  const expVer = get('expect-version', localVersion());
  const expCommit = get('expect-commit', localCommit());
  console.log('=== 部署验证 ===');
  console.log(`目标: ${base}/api/health`);
  console.log(`期望: version=${expVer} commit=${expCommit}\n`);

  let r;
  try {
    r = await fetchJson(base + '/api/health');
  } catch (e) {
    console.error(`✗ 线上不可达: ${e.message}`);
    process.exit(2);
  }
  console.log('线上返回:', JSON.stringify(r.body));
  if (r.status !== 200 || !r.body) { console.error(`✗ HTTP ${r.status}`); process.exit(2); }

  const checks = [];
  checks.push(['health.ok', r.body.ok === true]);
  checks.push([`version 一致 (${r.body.version} == ${expVer})`, r.body.version === expVer]);
  checks.push([`commit 一致 (${r.body.commit} == ${expCommit})`, r.body.commit === expCommit]);
  checks.push(['buildTime 存在', !!r.body.buildTime]);

  let pass = 0;
  console.log('');
  for (const [n, ok] of checks) { console.log((ok ? '✅ ' : '❌ ') + n); if (ok) pass++; }
  const allOk = pass === checks.length;
  console.log(`\n结果: ${pass}/${checks.length} ${allOk ? 'PASS —— 线上与代码一致' : 'FAIL —— 线上与代码不一致（需重启/重新部署）'}`);

  if (!allOk) {
    if (r.body.version !== expVer) console.log(`  → 版本漂移: 线上 ${r.body.version}, 代码 ${expVer}`);
    if (r.body.commit !== expCommit) console.log(`  → commit 漂移: 线上 ${r.body.commit}, 代码 ${expCommit}`);
  }
  process.exit(allOk ? 0 : 1);
})();
