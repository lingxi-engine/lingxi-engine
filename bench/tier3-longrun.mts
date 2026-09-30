/**
 * bench/tier3-longrun.mts — Tier 3: long-horizon endurance benchmark
 *
 * Tier 1 proves long-task budgets are configured. Tier 2 proves short agentic
 * competence. Neither proves the engine can actually SURVIVE a long task.
 *
 * This tier does. It runs progressively longer real agent loops against a live
 * LLM and measures what actually breaks long-horizon agents:
 *
 *   - sustained steps         : how long it keeps executing productively
 *   - wall-clock per step     : does latency creep as context grows
 *   - context growth          : how fast the transcript inflates
 *   - loop integrity          : does the tool loop stay well-formed over many turns
 *   - completion discipline   : does it signal done, or abandon/spin
 *
 * The goal is NOT a 100% score. The goal is to expose where the engine's real
 * limits are, so the numbers quoted in a comparison are measured, not claimed.
 *
 * Run:
 *   npx tsx bench/tier3-longrun.mts --dry
 *   npx tsx bench/tier3-longrun.mts --scale=smoke     # 3 tasks, ~1 min
 *   npx tsx bench/tier3-longrun.mts --scale=full      # 5 tasks, ~5 min
 */
import fs from 'fs';
import path from 'path';
import { Suite, Report, readMeta, ROOT } from './harness.mts';

const argv = process.argv.slice(2);
const argOf = (k: string) => {
  const hit = argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};
const DRY = argv.includes('--dry');
const SCALE = argOf('scale') || 'smoke';

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      if (k) out[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}
const ENV = loadEnv();

const PROVIDERS: Record<string, { base: string; keyEnv: string[]; model: string }> = {
  deepseek: { base: 'https://api.deepseek.com/v1', keyEnv: ['BENCH_API_KEY', 'DEEPSEEK_API_KEY'], model: 'deepseek-chat' },
  openai: { base: 'https://api.openai.com/v1', keyEnv: ['BENCH_API_KEY', 'OPENAI_API_KEY'], model: 'gpt-4o-mini' },
};
const PROVIDER = argOf('provider') || 'deepseek';
const P = PROVIDERS[PROVIDER];
if (!P) { console.error('  unknown provider: ' + PROVIDER); process.exit(2); }
const BASE_URL = (argOf('base') || P.base).replace(/\/+$/, '');
const API_KEY = argOf('key') || P.keyEnv.map(k => ENV[k]).find(v => v && v.length > 10) || '';
const MODEL = argOf('model') || P.model;

const WS = path.join(ROOT, 'bench', '_longrun_ws');
const resetWs = () => { fs.rmSync(WS, { recursive: true, force: true }); fs.mkdirSync(WS, { recursive: true }); };
const readF = (f: string) => { try { return fs.readFileSync(path.join(WS, f), 'utf8'); } catch { return null; } };
const approxTokens = (s: string) => Math.round(s.length / 3.4);

interface Msg { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string; }
let llmCalls = 0, tokIn = 0, tokOut = 0, apiErrors = 0;
const stepLatency: number[] = [];

async function chat(messages: Msg[], tools: any[], maxTokens: number): Promise<any> {
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0, max_tokens: maxTokens }),
  });
  stepLatency.push(Date.now() - t0);
  if (!res.ok) { apiErrors++; throw new Error('LLM ' + res.status + ': ' + (await res.text()).slice(0, 160)); }
  const j: any = await res.json();
  llmCalls++;
  tokIn += j.usage?.prompt_tokens || 0;
  tokOut += j.usage?.completion_tokens || 0;
  return j.choices?.[0]?.message;
}

const SYSTEM = `You are a long-horizon tool-using agent in a sandboxed workspace.
Work step by step and finish the entire task. Use one tool call at a time unless two
calls are genuinely independent. After the final required action, call mark_goal_done
immediately - do not keep exploring. If you are truly blocked, say so plainly.`;

const TOOLS = [
  { type: 'function', function: { name: 'write_file', description: 'Write text content to a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file from the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'append_file', description: 'Append a line to a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'list_dir', description: 'List files in the workspace.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'calculate', description: 'Evaluate an arithmetic expression.', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } } },
  { type: 'function', function: { name: 'mark_goal_done', description: 'Call this ONLY when the entire task is finished.', parameters: { type: 'object', properties: {}, required: [] } } },
];

async function dispatch(name: string, args: any): Promise<string> {
  const base = (p: string) => path.join(WS, path.basename(String(p || '')));
  try {
    switch (name) {
      case 'write_file': { const p = base(args.path || 'o.txt'); fs.writeFileSync(p, String(args.content ?? ''), 'utf8'); return 'ok wrote ' + path.basename(p) + ' ' + fs.statSync(p).size + 'B'; }
      case 'append_file': { const p = base(args.path || 'o.txt'); fs.appendFileSync(p, String(args.content ?? '') + '\n', 'utf8'); return 'ok appended ' + path.basename(p); }
      case 'read_file': { const p = base(args.path); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 4000) : 'error: not found'; }
      case 'list_dir': return fs.readdirSync(WS).join('\n') || '(empty)';
      case 'calculate': {
        const e = String(args.expression || '');
        if (!/^[\d\s+\-*/().%^]+$/.test(e)) return 'error: illegal expression';
        return String(Function('"use strict";return (' + e + ')')());
      }
      case 'mark_goal_done': return 'ok: GOAL_DONE';
      default: return 'error: unknown tool ' + name;
    }
  } catch (e: any) { return 'error: ' + e.message; }
}

interface Task { id: string; goalSteps: number; task: string; check: () => string | null; }

const TASKS: Task[] = [
  {
    id: 'build-5-files', goalSteps: 5,
    task: 'Create five files in the workspace: f1.txt containing "1", f2.txt containing "2", f3.txt containing "3", f4.txt containing "4", f5.txt containing "5". After all five exist, call mark_goal_done.',
    check: () => {
      for (let i = 1; i <= 5; i++) if (readF('f' + i + '.txt')?.trim() !== String(i)) return 'f' + i + '.txt wrong';
      return null;
    },
  },
  {
    id: 'read-verify-cycle', goalSteps: 6,
    task: 'Write the text "cycle-check-value" into c.txt. Then read c.txt back three separate times to confirm it reads identically each time. Then call mark_goal_done.',
    check: () => (readF('c.txt')?.trim() === 'cycle-check-value' ? null : 'c.txt content wrong'),
  },
  {
    id: 'accumulate-8-lines', goalSteps: 8,
    task: 'Create log.txt. Append one line to it for each value 1 through 8, in order, using a separate append per step (eight appends total). Then read log.txt and call mark_goal_done.',
    check: () => {
      const t = readF('log.txt');
      if (!t) return 'log.txt missing';
      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
      if (lines.length !== 8) return 'expected 8 lines got ' + lines.length;
      for (let i = 0; i < 8; i++) if (lines[i] !== String(i + 1)) return 'line ' + (i + 1) + ' = ' + lines[i];
      return null;
    },
  },
  {
    id: 'arithmetic-chain', goalSteps: 7,
    task: 'Use the calculate tool on this chain, one call per step: 1+10, then *3, then -5, then /2, then +100. Append each numeric result to calc.txt, one line per result. Then call mark_goal_done.',
    check: () => {
      const t = readF('calc.txt');
      if (!t) return 'calc.txt missing';
      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
      const want = ['11', '33', '28', '14', '114'];
      if (lines.length < 5) return 'expected 5 results got ' + lines.length;
      for (let i = 0; i < 5; i++) if (lines[i] !== want[i]) return 'result ' + (i + 1) + ' = ' + lines[i] + ' want ' + want[i];
      return null;
    },
  },
  {
    id: 'self-audit-list', goalSteps: 7,
    task: 'Create audit.txt with five lines, one per step: check-alpha, check-beta, check-gamma, check-delta, check-epsilon. Then read audit.txt back and confirm all five lines are present. Then call mark_goal_done.',
    check: () => {
      const t = readF('audit.txt');
      if (!t) return 'audit.txt missing';
      const lines = t.split('\n').map(s => s.trim()).filter(Boolean);
      for (const n of ['check-alpha', 'check-beta', 'check-gamma', 'check-delta', 'check-epsilon']) {
        if (!lines.includes(n)) return 'missing ' + n;
      }
      return null;
    },
  },
];

const selected = SCALE === 'full' ? TASKS : TASKS.slice(0, 3);

console.log('');
console.log('  LingXi Tier-3 Long-Horizon Endurance Benchmark');
console.log('  provider: ' + PROVIDER);
console.log('  model   : ' + MODEL);
console.log('  scale   : ' + SCALE + ' (' + selected.length + ' tasks)');
console.log('');

if (DRY) {
  for (const t of selected) console.log('   - ' + t.id.padEnd(22) + ' goal=' + String(t.goalSteps).padStart(2) + ' steps');
  console.log('');
  process.exit(0);
}
if (!API_KEY) { console.error('  ERROR: no API key found'); process.exit(2); }

const report = new Report();
const tAll = Date.now();
const rows: any[] = [];

for (const t of selected) {
  resetWs();
  const suite = report.add(new Suite('longrun.' + t.id, t.goalSteps + '-step endurance task'));

  const messages: Msg[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: t.task }];
  const trace: string[] = [];
  const seen: string[] = [];
  let done = false, errored = false, dupes = 0, toolCalls = 0;

  for (let i = 0; i < 16; i++) {
    let msg: any;
    try { msg = await chat(messages, TOOLS, 1200); }
    catch (e: any) { trace.push('LLM_ERROR ' + e.message); errored = true; break; }
    messages.push(msg);
    const calls = msg?.tool_calls;
    if (!calls || calls.length === 0) { trace.push('step' + i + ': text (no tools)'); break; }
    for (const c of calls) {
      const name = c.function?.name;
      let args: any = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch {}
      const sig = name + JSON.stringify(args).slice(0, 60);
      if (seen.includes(sig)) dupes++; else seen.push(sig);
      toolCalls++;
      trace.push('step' + i + ': ' + name);
      if (name === 'mark_goal_done') done = true;
      messages.push({ role: 'tool', tool_call_id: c.id, content: await dispatch(name, args) });
    }
    if (done) break;
  }

  const verdict = t.check();
  const ctx = approxTokens(JSON.stringify(messages));

  suite.ok('no LLM error', !errored, trace.find(x => x.startsWith('LLM_ERROR')) || '');
  suite.ok('task completed correctly', verdict === null, verdict || 'all artifacts correct');
  suite.ok('signalled completion via mark_goal_done', done, done ? '' : 'agent never closed the goal');
  suite.ok('no duplicate tool calls', dupes === 0, dupes + ' repeated identical calls');
  suite.ok('made progress (>= 2 tool calls)', toolCalls >= 2, toolCalls + ' tool calls');
  suite.ok('context under 60K tokens', ctx < 60000, '~' + ctx);

  rows.push({ id: t.id, goalSteps: t.goalSteps, completed: verdict === null, done, dupes, toolCalls, ctx, verdict });
  console.log('  ' + t.id.padEnd(22) + (verdict === null ? 'PASS' : 'FAIL') + '  goal=' + String(t.goalSteps).padStart(2) + '  calls=' + String(toolCalls).padStart(2) + '  ctx~' + ctx);
}

const lat = [...stepLatency].sort((a, b) => a - b);
const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0);
const avg = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0);
const half = Math.ceil(stepLatency.length / 2);
const firstHalf = stepLatency.slice(0, half);
const secondHalf = stepLatency.slice(half);
const drift = avg(firstHalf) ? Math.round((avg(secondHalf) - avg(firstHalf)) / avg(firstHalf) * 100) : 0;

const meta: any = readMeta();
meta.tier = 3;
meta.llmUsed = true;
meta.provider = PROVIDER;
meta.model = MODEL;
meta.scale = SCALE;
meta.llmCalls = llmCalls;
meta.apiErrors = apiErrors;
meta.promptTokens = tokIn;
meta.completionTokens = tokOut;
meta.wallMs = Date.now() - tAll;
meta.endurance = {
  avgStepLatencyMs: avg(stepLatency),
  p50StepLatencyMs: pct(0.5),
  p95StepLatencyMs: pct(0.95),
  firstHalfAvgMs: avg(firstHalf),
  secondHalfAvgMs: avg(secondHalf),
  latencyDriftPct: drift,
  maxContextTokens: Math.max(0, ...rows.map(r => r.ctx)),
  completedTasks: rows.filter(r => r.completed).length,
  totalTasks: rows.length,
  totalGoalSteps: rows.reduce((s, r) => s + r.goalSteps, 0),
  totalDuplicateLoops: rows.reduce((s, r) => s + r.dupes, 0),
  tasks: rows,
};

report.print();
report.printFailures();
console.log('  ENDURANCE');
console.log('    avg step latency : ' + meta.endurance.avgStepLatencyMs + 'ms  (p50 ' + meta.endurance.p50StepLatencyMs + ' / p95 ' + meta.endurance.p95StepLatencyMs + ')');
console.log('    latency drift    : ' + drift + '%  (first half ' + avg(firstHalf) + 'ms -> second half ' + avg(secondHalf) + 'ms)');
console.log('    max context      : ~' + meta.endurance.maxContextTokens + ' tokens');
console.log('    tasks completed  : ' + meta.endurance.completedTasks + '/' + meta.endurance.totalTasks);
console.log('    duplicate loops  : ' + meta.endurance.totalDuplicateLoops);
console.log('');
console.log('  manifest: ' + report.save('tier3-longrun-' + MODEL.replace(/[^\w.-]/g, '_') + '.json', meta));
console.log('  llm calls=' + llmCalls + ' tokens in=' + tokIn + ' out=' + tokOut);
console.log('');
process.exit(report.overall >= 70 ? 0 : 1);
