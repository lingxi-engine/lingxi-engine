/**
 * bench/tier1-contract.mts — Tier 1: deterministic engine contract tests
 *
 * No LLM calls. Scores are reproducible. This is the engineering floor:
 * are tool contracts valid, are long-task budgets actually configured, and do
 * the long-horizon subsystems really exist?
 *
 * Security policy is tested separately in tier1-safety.mts (different intent).
 *
 * Run: npx tsx bench/tier1-contract.mts
 */
import fs from 'fs';
import path from 'path';
import { Suite, Report, readMeta, ROOT } from './harness.mts';

const report = new Report();

// ─── Suite 1: tool contract ───
const sTools = report.add(new Suite('tools.contract', 'Tool definition schema validity'));

let BUILTIN_TOOLS: any[] = [];
let TOOL_MODULE: any = null;
try {
  TOOL_MODULE = await import('../src/tools/builtin.ts');
  BUILTIN_TOOLS = TOOL_MODULE.BUILTIN_TOOLS || [];
  sTools.ok('builtin.ts loads', BUILTIN_TOOLS.length > 0, `${BUILTIN_TOOLS.length} entries`);
} catch (err: any) {
  sTools.ok('builtin.ts loads', false, String(err?.message).slice(0, 200));
}

sTools.ok('tool count >= 50', BUILTIN_TOOLS.length >= 50, `count=${BUILTIN_TOOLS.length}`);

const seen = new Set<string>();
let dupes = 0;
for (const entry of BUILTIN_TOOLS) {
  const t = entry.tool;
  if (!t) continue;
  if (seen.has(t.name)) { dupes++; sTools.check(`duplicate tool name: ${t.name}`, false, 'registered twice'); }
  seen.add(t.name);
}
sTools.eq('no duplicate tool names', dupes, 0);

let missingDesc = 0, missingParams = 0, badRequired = 0, missingHandler = 0;
for (const entry of BUILTIN_TOOLS) {
  const t = entry.tool;
  if (!t) continue;
  if (!t.description || t.description.length < 3) {
    missingDesc++; sTools.check(`${t.name}: has description`, false, 'empty description');
  }
  if (!t.parameters || typeof t.parameters !== 'object') {
    missingParams++; sTools.check(`${t.name}: has parameters object`, false);
  } else if (t.parameters.required && !Array.isArray(t.parameters.required)) {
    badRequired++; sTools.check(`${t.name}: required is array`, false, `got ${typeof t.parameters.required}`);
  }
  if (typeof entry.handler !== 'function' && !entry.instance) {
    missingHandler++; sTools.check(`${t.name}: has handler`, false, 'neither handler nor instance');
  }
}
sTools.eq('all tools have description', missingDesc, 0);
sTools.eq('all tools have parameters object', missingParams, 0);
sTools.eq('all required fields are arrays', badRequired, 0);
sTools.eq('all tools have handler or instance', missingHandler, 0);

let schemaFail = 0;
for (const { tool } of BUILTIN_TOOLS) {
  for (const [k, v] of Object.entries<any>(tool.parameters?.properties || {})) {
    if (!v || !v.type) { schemaFail++; sTools.check(`${tool.name}.${k} has type`, false); }
  }
}
sTools.eq('all param properties typed', schemaFail, 0);

if (TOOL_MODULE?.SKILL_CONFIGURATION) {
  const skills: any[] = TOOL_MODULE.SKILL_CONFIGURATION;
  const toolNames = new Set(BUILTIN_TOOLS.map(e => e.tool.name));
  let orphan = 0;
  for (const sk of skills) {
    for (const tn of (sk.tools || [])) {
      if (!toolNames.has(tn)) {
        orphan++; sTools.check(`skill ${sk.id} -> unknown tool ${tn}`, false, 'dangling reference');
      }
    }
  }
  sTools.eq('no dangling skill->tool refs', orphan, 0);
  sTools.ok('skill catalog present', skills.length > 0, `skills=${skills.length}`);
}

// sandbox / workspace plumbing
if (TOOL_MODULE?.getWorkspaceRoot) {
  const r = TOOL_MODULE.getWorkspaceRoot();
  sTools.ok('getWorkspaceRoot returns a string', typeof r === 'string', r);
}
if (TOOL_MODULE?.isSandboxEnabled) {
  sTools.ok('isSandboxEnabled returns boolean', typeof TOOL_MODULE.isSandboxEnabled() === 'boolean',
    `value=${TOOL_MODULE.isSandboxEnabled()}`);
}

// ─── Suite 2: long-task constants ───
const sLong = report.add(new Suite('longtask.constants', 'Long-task budget constants'));

function readIfExists(rel: string): string | null {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; }
}

const envSrc = readIfExists('.env');
if (envSrc) {
  const t = envSrc.match(/^TASK_TIMEOUT_SECONDS=(\d+)/m);
  sLong.ok('TASK_TIMEOUT_SECONDS set', !!t, t ? `value=${t[1]}` : 'not found in .env');
  if (t) sLong.ok('task timeout >= 3600s', Number(t[1]) >= 3600, `value=${t[1]}`);
  const o = envSrc.match(/^ORCHESTRATOR_TIMEOUT_SECONDS=(\d+)/m);
  sLong.ok('ORCHESTRATOR_TIMEOUT_SECONDS set', !!o, o ? `value=${o[1]}` : 'missing');
  const c = envSrc.match(/^CHAT_TIMEOUT_SECONDS=(\d+)/m);
  sLong.ok('CHAT_TIMEOUT_SECONDS set', !!c, c ? `value=${c[1]}` : 'missing');
  const strict = envSrc.match(/^LINGXI_STRICT_MODEL=(true|false)/m);
  sLong.ok('model strictness flag documented', !!strict, strict ? `value=${strict[1]}` : 'missing');
} else {
  sLong.check('.env readable', false, 'cannot verify timeouts');
}

const execSrc = readIfExists('src/tools/executor.ts');
if (execSrc) {
  const m = execSrc.match(/maxIterations\s*=\s*(\d+)/);
  sLong.ok('executor maxIterations defined', !!m, m ? `value=${m[1]}` : 'no default found');
  if (m) {
    sLong.ok('maxIterations >= 25', Number(m[1]) >= 25, `value=${m[1]}`);
    sLong.ok('maxIterations has hard cap', Number(m[1]) <= 200, `value=${m[1]}`);
  }
  for (const reason of ['idle_stop', 'max_iterations', 'tool_failures', 'ai_errors', 'repeat_tool', 'aborted']) {
    sLong.ok(`stopReason '${reason}' implemented`, execSrc.includes(reason), '');
  }
} else {
  sLong.check('src/tools/executor.ts readable', false);
}

const compactSrc = readIfExists('src/core/compaction.ts');
if (compactSrc) {
  const thr = compactSrc.match(/maxTokens\s*=\s*(\d+)/);
  const keep = compactSrc.match(/keepRecent\s*=\s*(\d+)/);
  sLong.ok('compaction threshold defined', !!thr, thr ? `maxTokens=${thr[1]}` : 'missing');
  sLong.ok('compaction keepRecent defined', !!keep, keep ? `keepRecent=${keep[1]}` : 'missing');
  sLong.ok('compaction has degraded fallback', /catch/.test(compactSrc), 'must survive summarizer failure');
} else {
  sLong.check('src/core/compaction.ts readable', false);
}

// ─── Suite 3: long-horizon subsystems ───
const sMod = report.add(new Suite('modules.presence', 'Long-horizon subsystem presence'));

const required: [string, string][] = [
  ['src/core/memory-search.ts', 'memory search'],
  ['src/core/memory-reflector.ts', 'memory reflection'],
  ['src/core/memory-decay.ts', 'memory decay'],
  ['src/core/goal-tracker.ts', 'goal tracking'],
  ['src/core/goal-executor.ts', 'goal execution'],
  ['src/core/subagent-manager.ts', 'subagent orchestration'],
  ['src/core/orchestrator.ts', 'orchestrator'],
  ['src/core/context-roller.ts', 'context rolling'],
  ['src/core/watchdog.ts', 'watchdog'],
  ['src/core/evaluator.ts', 'evaluator'],
  ['src/core/team-manager.ts', 'team management'],
  ['src/core/rag-engine.ts', 'RAG engine'],
];
for (const [rel, label] of required) {
  const full = path.join(ROOT, rel);
  const exists = fs.existsSync(full);
  sMod.check(`${label} exists`, exists, exists ? `${fs.statSync(full).size}B` : 'missing');
  if (exists) sMod.check(`${label} non-trivial (>1KB)`, fs.statSync(full).size > 1024, `${fs.statSync(full).size}B`);
}

let channels: string[] = [];
try { channels = fs.readdirSync(path.join(ROOT, 'src', 'channels')).filter(f => f.endsWith('.ts')); } catch {}
sMod.ok('multi-channel adapters (>=8)', channels.length >= 8, `count=${channels.length}: ${channels.join(',')}`);

let providers: string[] = [];
try { providers = fs.readdirSync(path.join(ROOT, 'src', 'ai')).filter(f => f.endsWith('.ts')); } catch {}
sMod.ok('model provider layer present', providers.length > 0, `count=${providers.length}: ${providers.join(',')}`);

// ─── output ───
const meta = readMeta();
meta.toolCount = BUILTIN_TOOLS.length;
meta.tier = 1;
meta.llmUsed = false;
meta.suite = 'contract';

report.print();
report.printFailures();
console.log('  manifest: ' + report.save('tier1-contract.json', meta));
console.log('  engine=' + meta.engineVersion + ' commit=' + meta.commit + ' tools=' + meta.toolCount);
console.log('');
process.exit(report.overall >= 100 ? 0 : 1);
