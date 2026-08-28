#!/usr/bin/env node
/**
 * 批次6抽取脚本 — agents 三段孤岛 → src/routes/agents.ts
 * 纪律: 全部断言通过才写盘，任何断言失败立即退出且不写任何文件
 */
import { readFileSync, writeFileSync } from 'fs';

const ROOT = 'C:/Users/Administrator/lingxi-engine';
const IDX = ROOT + '/index.ts';
const SNAP = ROOT + '/scripts/route-snapshot.mjs';
const OUT = ROOT + '/src/routes/agents.ts';

const raw = readFileSync(IDX, 'utf8');
const lines = raw.split('\n');
const T = (s) => s.replace(/\r$/, '');
const L = (n) => lines[n - 1];
let failed = 0;
function assert(cond, msg) { if (!cond) { console.error('ASSERT FAIL: ' + msg); failed++; } }

// ---- 锚点与边界断言（迁移前 1-based 行号）----
assert(L(44).includes('registerMarketRoutes'), 'L44 import anchor');
assert(L(601).includes('registerAuthRoutes(app,'), 'L601 auth mount anchor');
assert(L(603).includes("app.post('/api/agents/register'"), 'L603 A-start');
assert(L(617).includes('syncAgentToPrivateChats(userId)'), 'L617 sync call');
assert(T(L(624)).trim() === '});', 'L624 A-end');
assert(L(627).includes('registerFriendsChatsRoutes'), 'L627 friends anchor');
assert(L(762).includes("app.get('/api/agents/:id/memory'"), 'L762 B-start');
assert(L(770).includes("app.put('/api/agents/:id/memory'"), 'L770 mem-put');
assert(L(778).includes("app.get('/api/agents',"), 'L778 list');
assert(T(L(781)).trim() === '});', 'L781 B-end');
assert(L(783).includes("app.get('/api/chats'"), 'L783 chats anchor');
assert(L(997).includes("app.patch('/api/agents/:id'"), 'L997 C-patch');
assert(L(1006).includes("app.post('/api/agents/:id/skills'"), 'L1006 skills');
assert(L(1010).includes('toolRegistry.bindSkills'), 'L1010 bindSkills');
assert(L(1015).includes("app.post('/api/agents/:id/reflect'"), 'L1015 reflect');
assert(L(1019).includes('router.reflectAgent'), 'L1019 reflectAgent');
assert(T(L(1022)).trim() === '});', 'L1022 C-end');
assert(L(1026).includes("app.get('/api/tools'"), 'L1026 tools anchor');

const blockA = lines.slice(602, 624).map(T).join('\n');
const blockB = lines.slice(761, 781).map(T).join('\n');
const blockC = lines.slice(995, 1022).map(T).join('\n');
assert(blockA.includes('manager.register(') && blockA.includes('P0-5'), 'A body markers');
assert(blockB.includes('db.getAgent(') && blockB.includes('db.updateAgent(') && blockB.includes('manager.list()'), 'B body markers');
assert(blockC.includes('manager.update(') && blockC.includes('toolRegistry.bindSkills') && blockC.includes('router.reflectAgent'), 'C body markers');
assert(!blockA.includes('registerWalletRoutes') && !blockB.includes('registerWalletRoutes') && !blockC.includes('registerWalletRoutes'), 'no wallet corpse');
assert((raw.match(/\/api\/agents/g) || []).length === 7, 'pre: exactly 7 /api/agents occurrences in index.ts');

if (failed > 0) { console.error('ABORT: ' + failed + ' assertion(s) failed, NOTHING written'); process.exit(1); }

// ---- 生成 agents.ts（业务代码逐行保真，仅依赖注入改造）----
const header = `/**
 * Agent 路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 6/N）
 *
 * 抽取范围: 原 index.ts 三段孤岛（迁移前坐标）
 *   A: L603-624  POST /api/agents/register（含 P0-5 越权防护 + syncAgentToPrivateChats 私聊同步）
 *   B: L762-781  GET/PUT /api/agents/:id/memory + GET /api/agents
 *   C: L996-1022 PATCH /api/agents/:id + POST /api/agents/:id/skills + POST /api/agents/:id/reflect
 * 共 7 条路由
 * 原则: 业务代码逐行保真，仅做依赖注入改造（db/manager/router/toolRegistry/requireAuth 由宿主传入，
 *       syncAgentToPrivateChats 从 storage/db.js 直接 import）
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查
 */
import type { Express, RequestHandler } from 'express';
import { syncAgentToPrivateChats } from '../storage/db.js';

export function registerAgentsRoutes(app: Express, deps: {
  db: any;
  manager: any;
  router: any;
  toolRegistry: any;
  requireAuth: RequestHandler;
}) {
  const { db, manager, router, toolRegistry, requireAuth } = deps;

`;
const agentsTs = header + blockA + '\n\n' + blockB + '\n\n' + blockC + '\n}\n';
writeFileSync(OUT, agentsTs.replace(/\n/g, '\r\n'));

// ---- 重建 index.ts（自底向上切，行号互不干扰）----
const mountBlock = [
  '  // ─── Agent 路由：已迁移至 src/routes/agents.ts（巨石拆分批次6，原三段孤岛 L603-624/L762-781/L996-1022）───',
  '  registerAgentsRoutes(app, { db, manager, router, toolRegistry, requireAuth });',
];
let outStr = [
  ...lines.slice(0, 44),
  "import { registerAgentsRoutes } from './src/routes/agents.js';",
  ...lines.slice(44, 602),
  ...mountBlock,
  ...lines.slice(624, 761),
  ...lines.slice(782, 995),
  ...lines.slice(1022),
].join('\n');

// 若 syncAgentToPrivateChats 在 index.ts 中已无使用点，从 import 中摘除（防 noUnusedLocals）
const codeUses = (outStr.match(/syncAgentToPrivateChats/g) || []).length - 1;
if (codeUses === 0) {
  outStr = outStr.replace(', syncAgentToPrivateChats }', ' }');
}

// ---- 终检 ----
assert(!/\/api\/agents/.test(outStr), 'post: no /api/agents residue in index.ts');
assert(outStr.includes('registerAgentsRoutes(app,'), 'post: mount present');
assert(outStr.includes("import { registerAgentsRoutes } from './src/routes/agents.js';"), 'post: import present');
if (failed > 0) { console.error('ABORT after build: ' + failed + ' failed, agents.ts written but index.ts NOT'); process.exit(1); }
writeFileSync(IDX, outStr);

// ---- 快照 TARGETS 追加 agents.ts ----
const snapRaw = readFileSync(SNAP, 'utf8');
const anchor = "join(ROOT, 'src', 'routes', 'market.ts'),";
assert(snapRaw.includes(anchor), 'snapshot anchor');
if (!snapRaw.includes("'agents.ts'")) {
  writeFileSync(SNAP, snapRaw.replace(anchor, anchor + "\n  join(ROOT, 'src', 'routes', 'agents.ts'),"));
}

console.log('OK index.ts=' + outStr.split('\n').length + ' lines, agents.ts=' + agentsTs.split('\n').length + ' lines, 7 routes migrated');