#!/usr/bin/env node
// 用本地模型 qwen3.8:27b-32k 真机实跑 L4，验证修复后的判分管道端到端可用
// 产出: workspace/bench/results/v36-L4-local/ + RUN-SUMMARY.txt
const { spawn, execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const REPO = 'C:/Users/Administrator/lingxi-engine';
const BENCH = path.join(REPO, 'workspace', 'bench');
const PORT = '3801';
const MODEL = 'qwen3.8:27b-32k';
const OUT = 'bench/results/v36-L4-local';
const LOG = path.join(BENCH, 'logs', 'v36-L4-local.log');

fs.mkdirSync(path.join(BENCH, 'logs'), { recursive: true });
const log = (m) => { const line = `[${new Date().toISOString()}] ${m}`; fs.appendFileSync(LOG, line + '\n'); console.log(line); };

function health() {
  return new Promise((res) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 4000 }, (x) => {
      let b = ''; x.on('data', (d) => (b += d)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
}

(async () => {
  log('=== 启动引擎 (port ' + PORT + ', model ' + MODEL + ') ===');
  const engine = spawn('npx', ['tsx', 'index.ts', '--port', PORT, '--data-dir', 'data-v36local'],
    { cwd: REPO, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  engine.unref();
  let elog = '';
  engine.stdout.on('data', (d) => (elog += d));
  engine.stderr.on('data', (d) => (elog += d));

  let h = null;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1500)); h = await health(); if (h && h.ok) break; }
  if (!h || !h.ok) { log('✗ 引擎未就绪'); fs.writeFileSync(LOG, log + '\nBOOT:\n' + elog, { flag: 'a' }); process.exit(2); }
  log('引擎就绪: version=' + h.version + ' commit=' + h.commit);

  log('=== 跑 L4（本地模型，单题上限 240s）===');
  const r = spawnSync('node', [path.join(BENCH, 'adapters', 'ws-adapter.cjs'),
    '--layers', 'L4', '--group', 'G4', '--bench-model', MODEL,
    '--url', `ws://localhost:${PORT}/ws?id=bench-runner`,
    '--timeout', '180', '--out', OUT],
    { cwd: path.join(REPO, 'workspace'), encoding: 'utf8', timeout: 1800000 });
  log('adapter exit=' + r.status);
  if (r.stdout) log('ADAPTER OUT:\n' + r.stdout.slice(-2000));
  if (r.stderr) log('ADAPTER ERR:\n' + r.stderr.slice(-1000));

  log('=== L4 安全判分 ===');
  const s = spawnSync('node', [path.join(BENCH, 'score-L4-safety.cjs'), OUT], { cwd: BENCH, encoding: 'utf8' });
  log(s.stdout || s.stderr || '(no output)');

  // 汇总
  const dir = path.join(BENCH, OUT);
  let summary = '';
  try { summary = fs.readFileSync(path.join(dir, 'SUMMARY-L4-SAFETY.json'), 'utf8'); } catch { summary = '(no SUMMARY-L4-SAFETY.json)'; }
  fs.writeFileSync(path.join(dir, 'RUN-SUMMARY.txt'),
    `L4 本地模型实跑 (${MODEL})\nengine=${h.version}/${h.commit}\nadapterExit=${r.status}\n\n${s.stdout || ''}\n\nSCORER JSON:\n${summary}\n`, 'utf8');
  log('✅ 完成，结果见 ' + OUT + '/RUN-SUMMARY.txt');
  process.exit(0);
})();
