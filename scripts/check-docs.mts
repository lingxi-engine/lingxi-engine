/**
 * scripts/check-docs.mts — keep README claims honest
 *
 * The README quotes concrete numbers (tool count, channel count, sandbox default,
 * long-task budgets). Those rot silently as the code changes. This asserts them
 * against the actual source tree, so a stale README fails CI instead of
 * misleading users who follow the quick-start.
 *
 * Count conventions (must match README wording):
 *   tools    = unique tool NAMES, i.e. `name: "web_search"` in builtin.ts.
 *              Do NOT count `tool: <Ident>` refs: that also matches the
 *              TypeScript type annotation `tool: ToolDefinition` and inflates
 *              the count by exactly one.
 *   channels = adapter modules in src/channels, excluding manager.ts
 *
 * Run: npx tsx scripts/check-docs.mts
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(process.cwd());
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log('  ok    ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

console.log('');
console.log('  README consistency check');
console.log('  -------------------------');
console.log('');

// ── tool count (by unique tool name) ──
const builtin = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'builtin.ts'), 'utf8');
const toolNames = [...builtin.matchAll(/name:\s*"([a-z_0-9]+)"/g)].map(m => m[1]);
const uniqueToolNames = new Set(toolNames);
const toolCount = uniqueToolNames.size;
const readmeToolNum = Number((readme.match(/(\d+)\s*个内置工具/) || [])[1]);
check('README tool count matches source', readmeToolNum === toolCount,
  'readme=' + readmeToolNum + ' source=' + toolCount);
check('tool names are unique (no duplicate registration)', uniqueToolNames.size === toolNames.length,
  'names=' + toolNames.length + ' unique=' + uniqueToolNames.size);

// ── channels ──
const channelFiles = fs.readdirSync(path.join(ROOT, 'src', 'channels'))
  .filter(f => f.endsWith('.ts') && !f.includes('.bak') && f !== 'manager.ts');
const readmeChanNum = Number((readme.match(/(\d+)\s*个消息渠道/) || [])[1]);
check('README channel count matches source', readmeChanNum === channelFiles.length,
  'readme=' + readmeChanNum + ' source=' + channelFiles.length);

// ── sandbox default must NOT claim "enabled by default" ──
const claimsDefaultOn = /沙箱.{0,20}默认开启|默认开启.{0,10}沙箱/.test(readme);
const srcRequiresOptIn = /SANDBOX_ENABLED === 'true'/.test(builtin);
check('sandbox default claim matches code', !(claimsDefaultOn && srcRequiresOptIn),
  srcRequiresOptIn ? 'code requires opt-in; README must not say default-on' : 'ok');

// ── long-task constants ──
const executor = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'executor.ts'), 'utf8');
// 2026-10-21: executor.ts writes `const maxIterations = options.maxIterations ?? 50`
// (nullish coalescing), NOT `maxIterations = 50`. The old regex matched neither
// form and reported code=undefined, so this check could never pass. Accept both.
const maxIter = (executor.match(/maxIterations\s*=\s*(?:options\.maxIterations\s*\?\?\s*)?(\d+)/) || [])[1];
if (!maxIter) {
  check('maxIterations default is parseable from executor.ts', false,
    'no `maxIterations = <n>` or `options.maxIterations ?? <n>` found');
} else {
  check('README quotes real maxIterations', readme.includes(maxIter + ' 轮工具循环'), 'code=' + maxIter);
}

let envSrc = '';
try { envSrc = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch {}
const taskTimeout = (envSrc.match(/^TASK_TIMEOUT_SECONDS=(\d+)/m) || [])[1];
if (taskTimeout) {
  const hours = Math.round(Number(taskTimeout) / 3600);
  check('README task-timeout claim present', readme.includes(hours + ' 小时'), taskTimeout + 's = ' + hours + 'h');
}

// ── no dangling relative links ──
// Hardening (post-6fc27e0 CI failure): disk existence alone is NOT enough.
// .gitignore can hide a file from CI's clean checkout while it exists locally.
// This bit us twice (skills/CATALOG.md, deploy/grafana/lingxi-dashboard.json —
// the `deploy/` and `/skills/` ignore rules). So additionally assert every
// README link target is TRACKED BY GIT, making the gate fail locally pre-push.
// Skipped when there is no .git (e.g. release source tarball) — disk check only.
const inGitRepo = fs.existsSync(path.join(ROOT, '.git'));
const links = [...readme.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)].map(m => m[1]);
for (const l of new Set(links)) {
  const rel = l.replace(/#.*$/, '');
  const p = path.join(ROOT, rel);
  check('link target exists: ' + l, fs.existsSync(p));
  if (inGitRepo) {
    let tracked = false;
    try {
      execSync('git ls-files --error-unmatch -- "' + rel + '"', { cwd: ROOT, stdio: 'pipe' });
      tracked = true;
    } catch { /* not tracked */ }
    check('link target tracked by git: ' + l, tracked,
      tracked ? '' : 'on disk but NOT in git — gitignored? fix: git add -f <path>');
  }
}

// ── env template ──
const tpl = ['.env.template', '.env.example'].find(f => fs.existsSync(path.join(ROOT, f)));
check('.env template exists (README quick-start depends on it)', !!tpl, tpl || 'neither .env.template nor .env.example');

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
process.exit(fail === 0 ? 0 : 1);
