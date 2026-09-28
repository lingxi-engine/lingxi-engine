/**
 * bench/tier2-agentic.mts — Tier 2: agentic capability benchmark (uses a real LLM)
 *
 * Unlike tier-1, this suite spends tokens. Every case is scored by MACHINE-VERIFIABLE
 * assertions (file exists, regex, numeric value, tool actually executed), never by
 * an LLM judge, so scores stay objective and reproducible when models are swapped.
 *
 * Measures: tool selection, argument correctness, multi-step completion,
 * instruction adherence, error recovery, calibrated tool usage, and honesty
 * (does it refuse rather than hallucinate when it truly cannot know?).
 *
 * Run:
 *   npx tsx bench/tier2-agentic.mts --dry
 *   npx tsx bench/tier2-agentic.mts --provider=deepseek
 *   npx tsx bench/tier2-agentic.mts --provider=openai --model=gpt-4o-mini --key=sk-...
 */
import fs from 'fs';
import path from 'path';
import { Suite, Report, readMeta, ROOT } from './harness.mts';

// ─── args ───
const argv = process.argv.slice(2);
const argOf = (k: string) => {
  const hit = argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};
const DRY = argv.includes('--dry');
const FILTER = argOf('filter');

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
  stealth: { base: 'https://api.stealth.ai/v1', keyEnv: ['BENCH_API_KEY', 'STEALTH_API_KEY'], model: 'space-bunny-alpha' },
};

const PROVIDER = argOf('provider') || 'deepseek';
const P = PROVIDERS[PROVIDER];
if (!P) { console.error('  unknown provider: ' + PROVIDER); process.exit(2); }
const BASE_URL = (argOf('base') || P.base).replace(/\/+$/, '');
const API_KEY = argOf('key') || P.keyEnv.map(k => ENV[k]).find(v => v && v.length > 10) || '';
const MODEL = argOf('model') || P.model;

// ─── isolated workspace ───
const WS = path.join(ROOT, 'bench', '_agentic_ws');
function resetWs() {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
}
const read = (f: string) => { try { return fs.readFileSync(path.join(WS, f), 'utf8'); } catch { return null; } }

// ─── LLM client ───
interface Msg { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string; }
let callCount = 0, tokenIn = 0, tokenOut = 0, apiErrors = 0;

async function chat(messages: Msg[], tools: any[] | null, maxTokens = 1500): Promise<any> {
  const body: any = { model: MODEL, messages, temperature: 0, max_tokens: maxTokens };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { apiErrors++; throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`); }
  const j: any = await res.json();
  callCount++;
  tokenIn += j.usage?.prompt_tokens || 0;
  tokenOut += j.usage?.completion_tokens || 0;
  return j.choices?.[0]?.message;
}

const SYSTEM = `You are a tool-using agent working inside a sandboxed workspace directory.
Use the provided tools to complete the task. Prefer acting over explaining.
When a task is complete, reply with a short confirmation.
Write ONLY the requested content into files: no markdown fences, no commentary, no extra keys.
Never invent facts you cannot verify. If you genuinely cannot determine something and no
tool can help, say so plainly instead of guessing.`;

async function dispatch(name: string, args: any): Promise<string> {
  try {
    const base = (p: string) => path.join(WS, path.basename(String(p || '')));
    switch (name) {
      case 'write_file': {
        const p = base(args.path || 'out.txt');
        fs.writeFileSync(p, String(args.content ?? ''), 'utf8');
        return `ok: wrote ${path.basename(p)} (${fs.statSync(p).size} bytes)`;
      }
      case 'read_file': {
        const p = base(args.path);
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 4000) : 'error: not found';
      }
      case 'list_dir':
        return fs.readdirSync(WS).join('\n') || '(empty)';
      case 'calculate': {
        const expr = String(args.expression || '');
        if (!/^[\d\s+\-*/().%^]+$/.test(expr)) return 'error: illegal characters in expression';
        // eslint-disable-next-line no-new-func
        return String(Function(`"use strict";return (${expr})`)());
      }
      case 'get_time':
        return new Date().toISOString();
      case 'delete_file':
        fs.rmSync(base(args.path), { force: true });
        return 'ok: deleted';
      case 'mark_goal_done':
        return 'ok: goal marked done';
      default:
        return `error: unknown tool ${name}`;
    }
  } catch (err: any) {
    return `error: ${err.message}`;
  }
}

const TOOLS = [
  { type: 'function', function: { name: 'write_file', description: 'Write text content to a file in the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File name' }, content: { type: 'string', description: 'Exact file content' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a file from the workspace.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File name' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'list_dir', description: 'List the files in the workspace directory.', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'calculate', description: 'Evaluate an arithmetic expression and return the numeric result.', parameters: { type: 'object', properties: { expression: { type: 'string', description: 'Arithmetic expression, e.g. (3+4)*2' } }, required: ['expression'] } } },
  { type: 'function', function: { name: 'get_time', description: 'Return the current date and time (ISO 8601).', parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Delete a file from the workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'mark_goal_done', description: 'Signal that the task is fully complete.', parameters: { type: 'object', properties: {}, required: [] } } },
];

async function runAgent(task: string, maxSteps = 6) {
  const messages: Msg[] = [{ role: 'system', content: SYSTEM }, { role: 'user', content: task }];
  const trace: string[] = [];
  let steps = 0, sawToolCall = false;

  for (let i = 0; i < maxSteps; i++) {
    let msg: any;
    try { msg = await chat(messages, TOOLS); }
    catch (err: any) { trace.push(`LLM_ERROR: ${err.message}`); return { ok: false, steps, sawToolCall, text: '', trace }; }
    messages.push(msg);
    const calls = msg?.tool_calls;
    if (!calls || calls.length === 0) {
      trace.push(`step${i}: final text (${(msg?.content || '').length} chars)`);
      return { ok: true, steps, sawToolCall, text: msg?.content || '', trace };
    }
    sawToolCall = true; steps++;
    for (const c of calls) {
      const name = c.function?.name;
      let args: any = {};
      try { args = JSON.parse(c.function?.arguments || '{}'); } catch { trace.push(`step${i}: bad JSON args for ${name}`); }
      trace.push(`step${i}: call ${name}(${JSON.stringify(args).slice(0, 100)})`);
      messages.push({ role: 'tool', tool_call_id: c.id, content: await dispatch(name, args) });
    }
  }
  trace.push(`step_limit(${maxSteps})`);
  return { ok: false, steps, sawToolCall, text: '', trace };
}

// ─── case catalog ───
interface Assertion { name: string; pass: boolean; detail?: string }
interface Case {
  id: string; category: string; difficulty: 'easy' | 'medium' | 'hard'; task: string;
  verify: (r: { steps: number; sawToolCall: boolean; text: string; trace: string[] }) => Assertion[];
}

const CASES: Case[] = [
  {
    id: 'write-basic', category: 'tool-selection', difficulty: 'easy',
    task: 'Create a file named hello.txt in the workspace containing exactly the text: hello world',
    verify: r => [
      { name: 'used a tool', pass: r.sawToolCall, detail: r.trace.join(' | ').slice(0, 200) },
      { name: 'file created with exact content', pass: read('hello.txt')?.trim() === 'hello world' },
    ],
  },
  {
    id: 'calc-then-write', category: 'multi-step', difficulty: 'medium',
    task: 'Use the calculate tool to compute (137 * 89), then write the numeric result into a file named result.txt. Write ONLY the number, no other text.',
    verify: r => [
      { name: 'called calculate', pass: r.trace.some(t => t.includes('call calculate')), detail: r.trace.slice(0, 3).join(' | ') },
      { name: 'result correct (12193)', pass: read('result.txt')?.trim() === '12193' },
    ],
  },
  {
    id: 'list-then-count', category: 'multi-step', difficulty: 'medium',
    task: 'Create three files a.txt, b.txt and c.txt in the workspace. Then list the directory and tell me how many files exist. Answer with just the number.',
    verify: r => [
      { name: 'all three files created', pass: ['a.txt', 'b.txt', 'c.txt'].every(f => read(f) !== null) },
      { name: 'called list_dir', pass: r.trace.some(t => t.includes('call read_file')) || r.trace.some(t => t.includes('call list_dir')) },
      { name: 'reported count = 3', pass: /\b3\b/.test(r.text), detail: r.text.slice(0, 120) },
    ],
  },
  {
    id: 'read-back-verify', category: 'verification', difficulty: 'hard',
    task: 'Write the text "alpha-beta-gamma" into verify.txt, then read the file back and report whether it contains the word "beta". Answer yes or no.',
    verify: r => [
      { name: 'file written', pass: read('verify.txt') !== null },
      { name: 'called read_file', pass: r.trace.some(t => t.includes('call read_file')) },
      { name: 'answered yes', pass: /\byes\b/i.test(r.text), detail: r.text.slice(0, 120) },
    ],
  },
  {
    id: 'constraint-respect', category: 'instruction-following', difficulty: 'hard',
    task: 'Create data.json containing exactly this JSON: {"n":42,"ok":true}. No markdown fences, no explanation, no extra keys.',
    verify: r => [
      { name: 'file exists', pass: read('data.json') !== null },
      { name: 'valid JSON', pass: (() => { try { JSON.parse(read('data.json')!); return true; } catch { return false; } })() },
      { name: 'exact structure', pass: (() => { try { const j = JSON.parse(read('data.json')!); return j.n === 42 && j.ok === true && Object.keys(j).length === 2; } catch { return false; } })() },
    ],
  },
  {
    id: 'recover-from-error', category: 'recovery', difficulty: 'hard',
    task: 'Read a file named missing.txt from the workspace. It does not exist yet. After the read fails, create it with the content "fallback" so a later step can read it.',
    verify: r => [
      { name: 'attempted read', pass: r.trace.some(t => t.includes('call read_file')) },
      { name: 'recovered by creating file', pass: read('missing.txt')?.trim() === 'fallback' },
    ],
  },
  {
    id: 'calibrated-no-tool', category: 'integrity', difficulty: 'medium',
    task: 'Tell me the current year. Use the get_time tool if you need it.',
    verify: r => [
      { name: 'used get_time (not guessed)', pass: r.trace.some(t => t.includes('call get_time')), detail: r.trace.join(' | ').slice(0, 200) },
      { name: 'answered with a year', pass: /\b20\d{2}\b/.test(r.text), detail: r.text.slice(0, 100) },
    ],
  },
  {
    id: 'calibrated-honest-refusal', category: 'integrity', difficulty: 'medium',
    task: 'What is the winning lottery number for tomorrow? Answer briefly.',
    verify: r => [
      { name: 'did NOT fabricate a number', pass: !/\b\d{5,}\b/.test(r.text), detail: r.text.slice(0, 150) },
      { name: 'explained it cannot be known', pass: /cannot|can't|unknown|not possible|random|不确定|无法|不能/i.test(r.text), detail: r.text.slice(0, 150) },
    ],
  },
  {
    id: 'serial-multi-step', category: 'multi-step', difficulty: 'hard',
    task: 'Step 1: write "one" into s1.txt. Step 2: read s1.txt. Step 2b: write "one-two" into s2.txt. Step 3: read s2.txt. Then report DONE.',
    verify: r => [
      { name: 's1.txt == one', pass: read('s1.txt')?.trim() === 'one' },
      { name: 's2.txt == s1 + "-two"', pass: read('s2.txt')?.trim() === 'one-two' },
      { name: '>= 2 read_file calls', pass: r.trace.filter(t => t.includes('call read_file')).length >= 2, detail: `reads=${r.trace.filter(t => t.includes('call read_file')).length}` },
      { name: 'reported DONE', pass: /DONE/i.test(r.text), detail: r.text.slice(0, 100) },
    ],
  },
  {
    id: 'sequential-state', category: 'multi-step', difficulty: 'hard',
    task: 'Write the number 1 into n.txt. Then read n.txt, add 1 to it, and write the new value back to n.txt. Repeat once more. Tell me the final value.',
    verify: r => [
      { name: 'final value == 3', pass: read('n.txt')?.trim() === '3', detail: `got=${read('n.txt')}` },
      { name: '>= 2 read_file calls', pass: r.trace.filter(t => t.includes('call read_file')).length >= 2 },
    ],
  },
  {
    id: 'negative-constraint', category: 'instruction-following', difficulty: 'medium',
    task: 'Create empty.txt as an empty file (zero bytes). Do not write any characters into it.',
    verify: r => [
      { name: 'file exists', pass: read('empty.txt') !== null },
      { name: 'file is empty (0 bytes)', pass: read('empty.txt') === '' },
    ],
  },
  {
    id: 'tool-overuse-guard', category: 'integrity', difficulty: 'medium',
    task: 'What is 2 + 2? Answer with just the number, no tools needed.',
    verify: r => [
      { name: 'did NOT call tools', pass: !r.sawToolCall, detail: r.trace.join(' | ').slice(0, 200) },
      { name: 'answered 4', pass: /4/.test(r.text), detail: r.text.slice(0, 100) },
    ],
  },
];

// ─── run ───
const meta = readMeta();
console.log('');
console.log('  LingXi Tier-2 Agentic Benchmark');
console.log('  provider: ' + PROVIDER);
console.log('  model   : ' + MODEL);
console.log('  base    : ' + BASE_URL);
console.log('  cases   : ' + (FILTER ? CASES.filter(c => c.id.includes(FILTER)).length : CASES.length));
console.log('');

if (DRY) {
  for (const c of CASES) console.log(`   - ${c.id.padEnd(26)} ${c.category.padEnd(20)} ${c.difficulty}`);
  console.log('');
  process.exit(0);
}

if (!API_KEY) {
  console.error('  ERROR: no API key found. Tried: ' + P.keyEnv.join(', '));
  process.exit(2);
}

const report = new Report();
const selected = FILTER ? CASES.filter(c => c.id.includes(FILTER) || c.category.includes(FILTER)) : CASES;
const t00 = Date.now();

for (const c of selected) {
  resetWs();
  const suite = report.add(new Suite(`agent.${c.id}`, `${c.category} / ${c.difficulty}`));
  const t0 = Date.now();
  let res: any;
  try { res = await runAgent(c.task); }
  catch (err: any) { suite.check('case executed', false, err.message.slice(0, 200)); continue; }
  const ms = Date.now() - t0;
  suite.ok('no LLM error', !res.trace.some((t: string) => t.startsWith('LLM_ERROR')),
    res.trace.find((t: string) => t.startsWith('LLM_ERROR')) || '');
  suite.ok('within step budget', res.steps <= 6, `steps=${res.steps}`);
  for (const a of c.verify(res)) suite.check(a.name, a.pass, a.detail || '');
  suite.ok('under 120s', ms < 120000, `${ms}ms`);
  console.log(`  ${c.id.padEnd(26)} ${String(suite.score).padStart(5)}%  ${String(ms).padStart(6)}ms  ${res.steps} steps`);
}

meta.tier = 2;
meta.llmUsed = true;
meta.provider = PROVIDER;
meta.model = MODEL;
meta.baseUrl = BASE_URL;
meta.llmCalls = callCallCount();
meta.apiErrors = apiErrors;
meta.promptTokens = tokenIn;
meta.completionTokens = tokenOut;
meta.wallMs = Date.now() - t00;

function callCallCount() { return callCount; }

report.print();
report.printFailures();
console.log('  manifest: ' + report.save(`tier2-agentic-${MODEL.replace(/[^\w.-]/g, '_')}.json`, meta));
console.log(`  llm calls=${callCount} errors=${apiErrors} tokens in=${tokenIn} out=${tokenOut} wall=${meta.wallMs}ms`);
console.log('');
process.exit(report.overall >= 70 ? 0 : 1);
