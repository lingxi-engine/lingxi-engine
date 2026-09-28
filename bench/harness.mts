/**
 * bench/harness.mjs — Benchmark harness core
 *
 * Design goals:
 *  - Deterministic: same engine + same version => same score. No LLM in loop for tier-1.
 *  - Reproducible: every run writes a manifest (engine version, commit, tool count, node).
 *  - Comparable: 0-100 per suite, so scores can be tracked across releases.
 *
 * Tier 1 (deterministic)  — tool contract, schema validity, path safety, SSRF guard.
 * Tier 2 (agentic)        — real LLM, scored by verifiable assertions. Opt-in via --tier2.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const RESULTS_DIR = path.join(ROOT, 'bench', 'results');

// ─── Reporting primitives ───

export class Suite {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.cases = [];
  }

  check(name, pass, detail = '') {
    this.cases.push({ name, pass: !!pass, detail: String(detail).slice(0, 300) });
    return pass;
  }

  eq(name, actual, expected) {
    return this.check(name, actual === expected,
      `got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
  }

  ok(name, condition, detail = '') {
    return this.check(name, !!condition, detail);
  }

  get passed() { return this.cases.filter(c => c.pass).length; }
  get total() { return this.cases.length; }
  get score() { return this.total === 0 ? 0 : Math.round((this.passed / this.total) * 1000) / 10; }

  toJSON() {
    return {
      id: this.id, title: this.title, score: this.score,
      passed: this.passed, total: this.total, cases: this.cases,
    };
  }
}

export class Report {
  constructor() {
    this.suites = [];
    this.startedAt = Date.now();
  }

  add(suite) { this.suites.push(suite); return suite; }

  get totalPassed() { return this.suites.reduce((s, x) => s + x.passed, 0); }
  get totalCases() { return this.suites.reduce((s, x) => s + x.total, 0); }
  get overall() {
    return this.totalCases === 0 ? 0 : Math.round((this.totalPassed / this.totalCases) * 1000) / 10;
  }

  toJSON(meta = {}) {
    return {
      schema: 'lingxi-bench/1',
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - this.startedAt,
      overall: this.overall,
      passed: this.totalPassed,
      cases: this.totalCases,
      meta,
      suites: this.suites.map(s => s.toJSON()),
    };
  }

  /** pretty console table */
  print() {
    const pad = (s, n) => String(s).padEnd(n);
    const lpad = (s, n) => String(s).padStart(n);
    console.log('');
    console.log('  ' + pad('SUITE', 36) + lpad('SCORE', 8) + lpad('PASS', 12));
    console.log('  ' + '-'.repeat(56));
    for (const s of this.suites) {
      const flag = s.score === 100 ? ' ' : (s.score >= 80 ? '!' : 'X');
      console.log('  ' + pad(flag + ' ' + s.id, 36) + lpad(s.score + '%', 8) + lpad(`${s.passed}/${s.total}`, 12));
    }
    console.log('  ' + '-'.repeat(56));
    console.log('  ' + pad('OVERALL', 36) + lpad(this.overall + '%', 8) + lpad(`${this.totalPassed}/${this.totalCases}`, 12));
    console.log('');
  }

  /** only failing cases — the actionable part */
  printFailures(limit = 25) {
    const fails = [];
    for (const s of this.suites) {
      for (const c of s.cases) if (!c.pass) fails.push({ suite: s.id, ...c });
    }
    if (fails.length === 0) { console.log('  no failures.'); return fails; }
    console.log(`  ${fails.length} failing case(s):`);
    for (const f of fails.slice(0, limit)) {
      console.log(`   - [${f.suite}] ${f.name}${f.detail ? ' :: ' + f.detail : ''}`);
    }
    if (fails.length > limit) console.log(`   ... and ${fails.length - limit} more`);
    return fails;
  }

  save(filename, meta: Record<string, any> = {}) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const out = path.join(RESULTS_DIR, filename);
    fs.writeFileSync(out, JSON.stringify(this.toJSON(meta), null, 2), 'utf8');
    return out;
  }
}

// ─── Meta / provenance ───

export function readMeta() {
  const meta = { node: process.version, platform: process.platform };
  try { meta.engineVersion = fs.readFileSync(path.join(ROOT, 'version.txt'), 'utf8').trim(); } catch {}
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    meta.pkgVersion = pkg.version;
    meta.license = pkg.license;
  } catch {}
  try {
    meta.commit = require('child_process')
      .execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch {}
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^DEFAULT_MODEL=(.+)$/m);
    if (m) meta.defaultModel = m[1].trim();
    const t = env.match(/^TASK_TIMEOUT_SECONDS=(.+)$/m);
    if (t) meta.taskTimeoutSec = Number(t[1].trim());
  } catch {}
  return meta;
}
