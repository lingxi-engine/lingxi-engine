// 验证 verify-deploy.cjs（异步 exec，避免阻塞同进程 mock 服务）
const http = require('http');
const { execFile } = require('child_process');
const path = require('path');
const REPO = 'C:/Users/Administrator/lingxi-engine';
const pkg = require(path.join(REPO, 'package.json'));
const gitCommit = require('child_process').execSync('git rev-parse --short HEAD', { cwd: REPO }).toString().trim();

const mk = (port, payload) => new Promise((res) => {
  const s = http.createServer((req, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify(payload)); });
  s.listen(port, () => res(s));
});

const run = (port) => new Promise((res) => {
  execFile('node', [path.join(REPO, 'scripts/verify-deploy.cjs'), '--host', '127.0.0.1', '--port', String(port)],
    { cwd: REPO }, (err, stdout) => res({ code: err ? err.code : 0, out: stdout || '' }));
});

(async () => {
  const s1 = await mk(3791, { ok: true, version: pkg.version, commit: gitCommit, buildTime: new Date().toISOString() });
  const s2 = await mk(3792, { ok: true, version: '1.0.0', commit: 'deadbee', buildTime: new Date().toISOString() });

  const a = await run(3791);
  const b = await run(3792);

  console.log('--- 一致(3791) ---');
  console.log(a.out.split('\n').filter((l) => /PASS|FAIL|一致|结果/.test(l)).join('\n'));
  console.log('--- 漂移(3792) ---');
  console.log(b.out.split('\n').filter((l) => /PASS|FAIL|漂移|结果|version 漂移|commit 漂移/.test(l)).join('\n'));

  const c1 = a.code === 0;
  const c2 = b.code === 1;
  console.log(`\n断言: 一致→exit0 ${c1 ? 'OK' : 'X'}; 漂移→exit1 ${c2 ? 'OK' : 'X'}`);
  console.log(`结果: ${[c1, c2].filter(Boolean).length}/2 ${c1 && c2 ? 'PASS' : 'FAIL'}`);
  s1.close(); s2.close();
  process.exit(c1 && c2 ? 0 : 1);
})();
