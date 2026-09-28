/**
 * bench/run-all.mts — one-command benchmark entry point
 *
 * Runs tier-1 (deterministic, free) and tier-2 (LLM, costs tokens), then writes
 * a merged summary + a markdown report suitable for publishing.
 *
 * Run:
 *   npx tsx bench/run-all.mts                 # tier1 + tier2 (deepseek)
 *   npx tsx bench/run-all.mts --tier1-only    # free, no tokens
 *   npx tsx bench/run-all.mts --provider=openai --model=gpt-4o-mini --key=sk-...
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { ROOT, RESULTS_DIR } from './harness.mts';

const argv = process.argv.slice(2);
const argOf = (k: string) => {
  const hit = argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};
const TIER1_ONLY = argv.includes('--tier1-only');
const TSX = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

/** spawn the child and let it write to our stdout, then return its exit code */
function run(script: string, extra: string[] = []): number {
  const r = spawnSync(TSX, [path.join('bench', script), ...extra], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return typeof r.status === 'number' ? r.status : 1;
}

function readJson(f: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8')); } catch { return null; }
}

console.log('');
console.log('='.repeat(64));
console.log('  LingXi Engine — Full Benchmark');
console.log('='.repeat(64));
console.log('');

const rc1a = run('tier1-contract.mts');
const rc1b = run('tier1-safety.mts');
const tier1Ok = rc1a === 0 && rc1b === 0;

if (!TIER1_ONLY) {
  const extra = ['--provider=' + (argOf('provider') || 'deepseek')];
  const model = argOf('model');
  const key = argOf('key');
  if (model) extra.push('--model=' + model);
  if (key) extra.push('--key=' + key);
  run('tier2-agentic.mts', extra);
}

// ─── merge manifests ───
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const manifestNames = ['tier1-contract.json', 'tier1-safety.json']
  .concat(fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith('tier2-agentic-') && f.endsWith('.json')));

const t1 = manifestNames.map(readJson).filter(Boolean);
const t2 = manifestNames.map(readJson).filter(Boolean).find(m => m.meta?.tier === 2);
if (t1.length === 0) {
  console.error('  no manifests produced — aborting summary');
  process.exit(1);
}

const t1Cases = t1.reduce((s, m) => s + m.cases, 0);
const t1Pass = t1.reduce((s, m) => s + m.passed, 0);
const t2Cases = t2 ? t2.cases : 0;
const t2Pass = t2 ? t2.passed : 0;

const engineVersion = t1[0]?.meta?.engineVersion || 'unknown';
const commit = t1[0]?.meta?.commit || 'unknown';
const toolCount = t1[0]?.meta?.toolCount || 0;

const summary: any = {
  schema: 'lingxi-bench-summary/1',
  generatedAt: new Date().toISOString(),
  engine: { version: engineVersion, commit, toolCount },
  tier1: {
    cases: t1Cases, passed: t1Pass,
    score: t1Cases ? Math.round((t1Pass / t1Cases) * 1000) / 10 : 0,
    free: true,
  },
  tier2: t2 ? {
    cases: t2Cases, passed: t2Pass,
    score: t2Cases ? Math.round((t2Pass / t2Cases) * 1000) / 10 : 0,
    model: t2.meta.model,
    provider: t2.meta.provider,
    wallMs: t2.meta.wallMs,
    tokens: { in: t2.meta.promptTokens, out: t2.meta.completionTokens },
  } : null,
};
fs.writeFileSync(path.join(RESULTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

// ─── markdown report ───
const md: string[] = [];
md.push('# LingXi Engine — Benchmark Report');
md.push('');
md.push(`- engine: \`${engineVersion}\` (commit \`${commit}\`)`);
md.push(`- generated: ${summary.generatedAt}`);
md.push(`- built-in tools: **${toolCount}**`);
md.push('');
md.push('## Headline');
md.push('');
md.push('| Tier | What it measures | Result | Cost |');
md.push('|---|---|---|---|');
md.push(`| Tier 1 | tool contracts, SSRF policy, long-task budgets, subsystem presence | **${summary.tier1.score}%** (${t1Pass}/${t1Cases}) | free |`);
if (summary.tier2) {
  const t = summary.tier2;
  md.push(`| Tier 2 | agentic execution with a live LLM (\`${t.model}\`) | **${t.score}%** (${t.passed}/${t.cases}) | ${t.tokens.in} in / ${t.tokens.out} out |`);
} else {
  md.push('| Tier 2 | agentic execution with a live LLM | not run | — |');
}
md.push('');
md.push('> Tier 1 is deterministic and free, so it can gate every commit.');
md.push('> Tier 2 spends tokens; the numbers below come from a real run against a live API.');
md.push('');

if (summary.tier2) {
  md.push('## Tier 2 — agentic cases');
  md.push('');
  md.push('| Case | Category | Score |');
  md.push('|---|---|---|');
  for (const s of t2.suites) md.push(`| \`${s.id}\` | ${s.title} | ${s.score}% (${s.passed}/${s.total}) |`);
  md.push('');
  md.push(`Wall time ${(summary.tier2.wallMs / 1000).toFixed(1)}s across ${t2Cases} cases, ${t2.meta.llmCalls} LLM calls, ${t2.meta.apiErrors} errors.`);
  md.push('');
}

md.push('## Tier 1 — suites');
md.push('');
md.push('| Suite | Score | Cases |');
md.push('|---|---|---|');
for (const m of t1) {
  for (const s of m.suites) md.push(`| \`${s.id}\` | ${s.score}% | ${s.passed}/${s.total} |`);
}
md.push('');
md.push('## Reproduce');
md.push('');
md.push('```bash');
md.push('npm run bench:fast     # deterministic tier-1 only, no tokens');
md.push('npm run bench          # + live LLM (deepseek by default)');
md.push('npm run bench:agentic -- --provider=openai --model=gpt-4o-mini --key=sk-...');
md.push('```');
md.push('');
md.push('## Design notes');
md.push('');
md.push('- **No LLM judge.** Every tier-2 assertion is machine-verifiable: exact file bytes,');
md.push('  a regex over the reply, numeric equality, or the recorded tool-call trace. Swapping');
md.push('  models changes the score honestly instead of moving the goalposts.');
md.push('- **Honesty is scored.** Two cases check the model refuses rather than fabricates,');
md.push('  two check it does not over-use tools. A model that always complies scores lower');
md.push('  than one that knows its limits.');
md.push('- **The SSRF suite asserts the real v1.9.2 policy** (block cloud metadata, allow LAN),');
md.push('  because the agent runs on the user\'s own machine and must reach a local Ollama.');
md.push('');

fs.writeFileSync(path.join(RESULTS_DIR, 'REPORT.md'), md.join('\n'), 'utf8');

console.log('');
console.log('='.repeat(64));
console.log('  SUMMARY');
console.log('='.repeat(64));
console.log(`  engine         : ${engineVersion} (${commit})`);
console.log(`  built-in tools : ${toolCount}`);
console.log(`  tier1 (free)   : ${summary.tier1.score}%  ${t1Pass}/${t1Cases}`);
if (summary.tier2) {
  const t = summary.tier2;
  console.log(`  tier2 (${t.model})`.padEnd(19) + `: ${t.score}%  ${t.passed}/${t.cases}  ${(t.wallMs / 1000).toFixed(1)}s`);
} else {
  console.log('  tier2          : skipped');
}
console.log('');
console.log('  summary.json -> ' + path.join(RESULTS_DIR, 'summary.json'));
console.log('  REPORT.md    -> ' + path.join(RESULTS_DIR, 'REPORT.md'));
console.log('');
process.exit(tier1Ok ? 0 : 1);
