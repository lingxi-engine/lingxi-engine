#!/usr/bin/env node
/**
 * bench/run-v36.cjs —— L4/L5 重跑一键脚本（配额可用后直接点火）
 *
 * 前置：一个已启动的引擎实例（含 2.0.22 修复）在 ws://localhost:<PORT>
 *   npm start -- --port <PORT> --data-dir data-v36   # 另开一个终端
 *
 * 用法：
 *   node bench/run-v36.cjs --port 3622 --model glm-5.2:cloud
 *
 * 流程：preflight(/api/health 校验版本+commit) → 跑 L4 → 跑 L5 → 双聚合(含 L4 安全判分)
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PORT = get('port', '3622');
const MODEL = get('model', 'glm-5.2:cloud');
const TAG = get('tag', 'v36');

const BENCH = __dirname;                 // workspace/bench
const REPO = path.resolve(BENCH, '..', '..');
const WS = `ws://localhost:${PORT}/ws?id=bench-runner`;

function health() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 4000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

(async () => {
  console.log('=== v36 重跑前置检查 ===');
  const h = await health();
  if (!h || !h.ok) {
    console.error(`✗ 引擎未就绪于 127.0.0.1:${PORT} —— 请先启动: npm start -- --port ${PORT} --data-dir data-${TAG}`);
    process.exit(2);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  console.log(`  引擎在线: version=${h.version} commit=${h.commit} buildTime=${h.buildTime}`);
  if (h.version !== pkg.version) console.warn(`  ⚠️ 引擎版本(${h.version}) ≠ 代码版本(${pkg.version})，可能未重启到最新`);
  console.log(`  模型=${MODEL}  ws=${WS}\n`);
  if (args.includes('--preflight-only')) { console.log('  (--preflight-only: 仅检查，不重跑)'); process.exit(0); }

  const run = (label, extra) => {
    console.log(`--- 跑 ${label} ---`);
    const r = spawnSync('node', [path.join(BENCH, 'adapters', 'ws-adapter.cjs'),
      '--bench-model', MODEL, '--url', WS, ...extra],
      { cwd: path.join(REPO, 'workspace'), stdio: 'inherit' });
    if (r.status !== 0) console.warn(`  ⚠️ ${label} 退出码 ${r.status}`);
  };

  run('L4 对抗', ['--layers', 'L4', '--group', 'G4', '--out', path.join(BENCH, 'results', `${TAG}-L4`)]);
  run('L5 多Agent', ['--layers', 'L5', '--group', 'G6', '--out', path.join(BENCH, 'results', `${TAG}-L5`)]);

  console.log('\n=== 聚合判分 ===');
  for (const L of ['L4', 'L5']) {
    const dir = path.join(BENCH, 'results', `${TAG}-${L}`);
    if (!fs.existsSync(dir)) { console.log(`  跳过 ${L}（无结果目录）`); continue; }
    spawnSync('node', [path.join(BENCH, 'aggregate-corrected.cjs'), path.join('results', `${TAG}-${L}`)],
      { cwd: BENCH, stdio: 'inherit' });
    if (L === 'L4') {
      spawnSync('node', [path.join(BENCH, 'score-L4-safety.cjs'), path.join('results', `${TAG}-L4`)],
        { cwd: BENCH, stdio: 'inherit' });
    }
  }
  console.log('\n✅ v36 完成。检查 results/' + TAG + '-L4/SUMMARY-L4-SAFETY.json 与各 SUMMARY-CORRECTED.txt');
})();
