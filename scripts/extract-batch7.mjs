#!/usr/bin/env node
/**
 * 巨石拆分 批次7 抽取脚本 — subagent/collab 块 (8 路由) → src/routes/subagents.ts
 * 带硬断言: 任一断言失败即退出(码1)，零写入。
 */
import { readFileSync, writeFileSync } from 'fs';

const ROOT = process.cwd();
const idxPath = ROOT + '/index.ts';
const outPath = ROOT + '/src/routes/subagents.ts';
const snapPath = ROOT + '/scripts/route-snapshot.mjs';

function fail(msg) { console.error('[batch7] FAIL ' + msg); process.exit(1); }

// ---- 读入 ----
const raw = readFileSync(idxPath, 'utf8');
const lines = raw.split('\n');
console.log('[batch7] index.ts total lines: ' + lines.length);

// ---- 断言: 块边界 (1-based: L1610 P1-3注释, L1611 首路由, L1691 末路由结束, L1692 空行, L1693 P1-4注释) ----
if (!lines[1609] || !lines[1609].includes('P1-3')) fail('L1610 should contain P1-3, got: ' + JSON.stringify(lines[1609]));
if (!lines[1610] || !lines[1610].includes("app.get('/api/subagents'")) fail('L1611 should be GET /api/subagents');
if (!lines[1690] || !lines[1690].trim().endsWith('});')) fail('L1691 should end with }); got: ' + JSON.stringify(lines[1690]));
if (!lines[1691] || lines[1691].trim() !== '') fail('L1692 should be blank, got: ' + JSON.stringify(lines[1691]));
if (!lines[1692] || !lines[1692].includes('P1-4')) fail('L1693 should contain P1-4, got: ' + JSON.stringify(lines[1692]));

const block = lines.slice(1609, 1691); // 0-based 1609..1690 = 1-based 1610..1691
const blockSrc = block.join('\n');
console.log('[batch7] block lines: ' + block.length);

// ---- 断言: 块内恰好 8 条路由且路径精确 ----
const re = /\bapp\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/g;
const found = [];
let m;
while ((m = re.exec(blockSrc)) !== null) found.push(m[1].toUpperCase() + ' ' + m[2]);
const expected = [
  'GET /api/subagents',
  'POST /api/subagents/spawn',
  'POST /api/subagents/:id/steer',
  'DELETE /api/subagents/:id',
  'POST /api/subagents/collab',
  'GET /api/subagents/collab',
  'GET /api/subagents/collab/:id',
  'POST /api/subagents/collab/:id/cancel',
].sort();
if (JSON.stringify([...found].sort()) !== JSON.stringify(expected)) {
  fail('routes mismatch. actual: ' + JSON.stringify(found));
}

// ---- 断言: 依赖符号齐备 ----
for (const sym of [
  'subAgentManager.list(', 'subAgentManager.spawn(', 'subAgentManager.steer(',
  'subAgentManager.kill(', 'subAgentManager.collab(', 'subAgentManager.listCollabs(',
  'subAgentManager.getCollab(', 'subAgentManager.killCollab(', 'broadcast({', 'requireAuth',
]) {
  if (!blockSrc.includes(sym)) fail('missing dep symbol: ' + sym);
}

// ---- 生成 subagents.ts ----
const NL = '\r\n';
const headerLines = [
  '/**',
  ' * 子代理/多智能体协作路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 7/N）',
  ' *',
  ' * 抽取范围: 原 index.ts L1610-L1691（迁移前坐标）',
  ' *   P1-3 子代理 API: GET /api/subagents | POST /api/subagents/spawn',
  ' *                    POST /api/subagents/:id/steer | DELETE /api/subagents/:id',
  ' *   v2.1 协作 API:   POST/GET /api/subagents/collab',
  ' *                    GET /api/subagents/collab/:id | POST /api/subagents/collab/:id/cancel',
  ' * 共 8 条路由',
  ' * 原则: 业务代码逐行保真，仅做依赖注入改造（subAgentManager/broadcast/requireAuth 由宿主传入）',
  ' * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查',
  ' */',
  "import type { Express, RequestHandler } from 'express';",
  '',
  'export function registerSubAgentRoutes(app: Express, deps: {',
  '  subAgentManager: any;',
  '  broadcast: (event: any) => void;',
  '  requireAuth: RequestHandler;',
  '}) {',
  '  const { subAgentManager, broadcast, requireAuth } = deps;',
  '',
];
const newModule = headerLines.join(NL) + NL + blockSrc + NL + '}' + NL;

// ---- 改造 index.ts: 移除块 + 加 import + 加挂载 ----
const newLines = [...lines.slice(0, 1609), ...lines.slice(1692)];

const impIdx = newLines.findIndex(l => l.includes("import { registerAgentsRoutes }"));
if (impIdx < 0) fail('anchor not found: registerAgentsRoutes import');
const regIdx = newLines.findIndex(l => l.includes('registerAgentsRoutes(app,'));
if (regIdx < 0) fail('anchor not found: registerAgentsRoutes call');

newLines.splice(impIdx + 1, 0, "import { registerSubAgentRoutes } from './src/routes/subagents.js';\r");
newLines.splice(regIdx + 2, 0, '  registerSubAgentRoutes(app, { subAgentManager, broadcast, requireAuth });\r');

const remainSrc = newLines.join('\n');
let cnt = 0;
const reR = /\bapp\.(?:get|post|put|delete|patch|all)\(\s*['"`]\/api\/subagents/g;
while (reR.exec(remainSrc) !== null) cnt++;
if (cnt !== 0) fail('index.ts still has ' + cnt + ' /api/subagents route registrations');

// ---- 快照脚本 TARGETS 追加 ----
let snap = readFileSync(snapPath, 'utf8');
const anchor = "join(ROOT, 'src', 'routes', 'agents.ts'),";
if (!snap.includes(anchor)) fail('snapshot TARGETS anchor (agents.ts) not found');
if (snap.includes("'subagents.ts'")) fail('subagents.ts already in TARGETS');
snap = snap.replace(anchor, anchor + "\r\n  join(ROOT, 'src', 'routes', 'subagents.ts'),");

// ---- 全部断言通过，落盘 ----
writeFileSync(outPath, newModule, 'utf8');
writeFileSync(idxPath, remainSrc, 'utf8');
writeFileSync(snapPath, snap, 'utf8');
console.log('[batch7] OK wrote: src/routes/subagents.ts (module ' + (headerLines.length + block.length + 1) + ' lines)');
console.log('[batch7] OK wrote: index.ts (' + newLines.length + ' lines)');
console.log('[batch7] OK wrote: scripts/route-snapshot.mjs (TARGETS +subagents.ts)');