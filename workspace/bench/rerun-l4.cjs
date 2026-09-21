#!/usr/bin/env node
// 假设引擎已在 3801 运行，直接跑 L4 + 判分（不重启引擎）
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = 'C:/Users/Administrator/lingxi-engine';
const BENCH = path.join(REPO, 'workspace', 'bench');
const PORT = '3801';
const MODEL = 'qwen3.8:27b-32k';
const OUT = 'bench/results/v36-L4-local';

const health = () => new Promise((res) => {
  const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 4000 }, (x) => {
    let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
  });
  r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
});

(async () => {
  const h = await health();
  if (!h || !h.ok) { console.error('engine not up on ' + PORT); process.exit(2); }
  console.log('engine: ' + h.version + '/' + h.commit);
  console.log('跑 L4 (model=' + MODEL + ', 单题上限 180s, 输出 ' + OUT + ')');

  const r = spawnSync('node', [path.join(BENCH, 'adapters', 'ws-adapter.cjs'),
    '--layers', 'L4', '--group', 'G4', '--bench-model', MODEL,
    '--url', `ws://localhost:${PORT}/ws?id=bench-runner`,
    '--timeout', '180', '--out', OUT],
    { cwd: path.join(REPO, 'workspace'), encoding: 'utf8', timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });

  console.log('\n--- adapter stdout ---\n' + (r.stdout || '').slice(-3000));
  if (r.stderr) console.log('\n--- adapter stderr ---\n' + (r.stderr || '').slice(-1500));

  const s = spawnSync('node', [path.join(BENCH, 'score-L4-safety.cjs'), OUT], { cwd: BENCH, encoding: 'utf8' });
  console.log('\n--- L4 安全判分 ---\n' + (s.stdout || s.stderr || '(none)'));

  const dir = path.join(BENCH, OUT);
  let sj = '';
  try { sj = fs.readFileSync(path.join(dir, 'SUMMARY-L4-SAFETY.json'), 'utf8'); } catch { sj = '(missing)'; }
  fs.writeFileSync(path.join(dir, 'RUN-SUMMARY.txt'),
    `L4 本地实跑 (${MODEL})  engine=${h.version}/${h.commit}\nadapterExit=${r.status}\n\n${r.stdout || ''}\n\n${s.stdout || ''}\n\nSCORER:\n${sj}\n`, 'utf8');
  console.log('\n✅ 结果目录: ' + OUT);
})();
