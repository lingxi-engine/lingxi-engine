#!/usr/bin/env node
/**
 * 巨石拆分 批次9 抽取脚本 — LAN 社交块 (30 路由) → src/routes/lan.ts
 * 带硬断言: 任一断言失败即退出(码1)，零写入。
 *
 * 抽取范围: index.ts L2426-L2808（迁移前坐标, 1-based, CRLF 文件按 \n split）
 *   - L2426-2428: LAN 横幅注释
 *   - L2430-2444: getLocalLanUsers()（含 agentByUser）
 *   - L2446:      lanSocial = new LanSocialHub(...)
 *   - L2448-2457: startLanDiscovery 启动逻辑
 *   - L2459-2467: lanUserId 身份绑定
 *   - L2470-2808: 30 条路由
 *
 * 依赖注入: app/db/manager/router/broadcast/requireAuth/port/dataDir
 * 模块自 import: getDB + lan-discovery/lan-transport/lan-social
 * 宿主删除: L56-58 三行 LAN import（使用全部落块内）
 * 登记点: index.ts import(L47后) + 挂载(L971后) + route-snapshot TARGETS/MOUNTS + smoke-mount MODULE_FILES/caseList
 */
import { readFileSync, writeFileSync } from 'fs';

const ROOT = process.cwd();
const idxPath = ROOT + '/index.ts';
const outPath = ROOT + '/src/routes/lan.ts';
const snapPath = ROOT + '/scripts/route-snapshot.mjs';
const smokePath = ROOT + '/scripts/smoke-mount.mts';

function fail(msg) { console.error('[batch9] FAIL ' + msg); process.exit(1); }

// ---- 读入（保持 CRLF 逐行结构: split('\n') 保留行尾 \r） ----
const raw = readFileSync(idxPath, 'utf8');
const lines = raw.split('\n');
console.log('[batch9] index.ts total lines: ' + lines.length);
if (lines.length !== 3231) fail('index.ts line count changed: ' + lines.length + ' (expect 3231)');

// ---- 断言: 块边界 (1-based L2426..L2808; 0-based 2425..2807) ----
const B0 = 2425, B1 = 2808; // slice(B0, B1) = L2426..L2808
if (!lines[2425] || !lines[2425].includes('────')) fail('L2426 should be banner dash line, got: ' + JSON.stringify(lines[2425].slice(0, 50)));
if (!lines[2426] || !/LAN Social|LAN/.test(lines[2426])) fail('L2427 should mention LAN Social, got: ' + JSON.stringify(lines[2426].slice(0, 80)));
if (!lines[2429] || !lines[2429].includes('function getLocalLanUsers')) fail('L2430 should define getLocalLanUsers');
if (!lines[2445] || !lines[2445].includes('new LanSocialHub')) fail('L2446 should construct LanSocialHub');
if (!lines[2449] || !lines[2449].includes('startLanDiscovery')) fail('L2450 should call startLanDiscovery');
if (!lines[2469] || !lines[2469].includes("app.get('/api/lan/status'")) fail('L2470 should be first LAN route');
if (!lines[2799] || !lines[2799].includes("app.post('/api/lan/peer/group-invite-accepted'")) fail('L2800 should be last LAN route');
if (!lines[2807] || !lines[2807].trim().endsWith('});')) fail('L2808 should end with });');
if (!lines[2808] || lines[2808].trim() !== '') fail('L2809 should be blank');
if (!lines[2809] || lines[2809].trim() !== '') fail('L2810 should be blank');
if (!lines[2810] || !lines[2810].includes("app.get('/api/profile'")) fail('L2811 should be /api/profile route');
if (!lines[2422] || lines[2422].trim() !== '}') fail('L2423 should be mesh block closing "}"');
if (!lines[2424] || lines[2424].trim() !== '') fail('L2425 should be blank');

const block = lines.slice(B0, B1); // 383 lines
const blockSrc = block.join('\n');
console.log('[batch9] block lines: ' + block.length);
if (block.length !== 383) fail('block length ' + block.length + ' != 383');

// ---- 断言: 块内恰好 30 条路由且路径精确 ----
const re = /\bapp\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/g;
const found = [];
let m;
while ((m = re.exec(blockSrc)) !== null) found.push(m[1].toUpperCase() + ' ' + m[2]);
const expected = [
  'GET /api/lan/status',
  'GET /api/lan/peers',
  'GET /api/lan/search',
  'GET /api/users/search',
  'POST /api/lan/friend-request',
  'GET /api/lan/friend-requests',
  'POST /api/lan/friend-respond',
  'GET /api/lan/friends',
  'POST /api/lan/group-create',
  'GET /api/lan/groups',
  'GET /api/lan/group',
  'POST /api/lan/group-mode',
  'POST /api/lan/group-message',
  'POST /api/lan/group-agent-topic',
  'POST /api/lan/peer/friend-request',
  'POST /api/lan/peer/friend-accept',
  'POST /api/lan/peer/group-invite',
  'POST /api/lan/peer/group-message',
  'POST /api/lan/peer/group-mode',
  'POST /api/lan/peer/agent-invoke',
  'POST /api/lan/remove-friend',
  'POST /api/lan/delete-group',
  'POST /api/lan/leave-group',
  'POST /api/lan/peer/friend-remove',
  'POST /api/lan/peer/group-deleted',
  'POST /api/lan/peer/group-member-left',
  'GET /api/lan/group-invites',
  'POST /api/lan/group-invite/accept',
  'POST /api/lan/group-invite/reject',
  'POST /api/lan/peer/group-invite-accepted',
].sort();
if (JSON.stringify([...found].sort()) !== JSON.stringify(expected)) {
  fail('routes mismatch. actual(' + found.length + '): ' + JSON.stringify(found));
}

// ---- 断言: 依赖符号齐备（块内真实使用） ----
for (const sym of [
  'getLocalLanUsers', 'lanSocial', 'lanUserId', 'sendPeerResult',
  'new LanSocialHub', 'startLanDiscovery(', 'getLanSelfInfo()', 'getLanPeers()',
  'verifyLanRequest(', 'LAN_SOCIAL_CHANNEL', 'LanUser', 'getDB()',
  'requireAuth', 'broadcast', 'port', 'dataDir', 'manager.list()', 'router',
]) {
  if (!blockSrc.includes(sym)) fail('missing dep symbol: ' + sym);
}

// ---- 断言: 块外零引用块内私有符号 ----
const outside = lines.slice(0, B0).concat(lines.slice(B1)).join('\n');
for (const sym of ['lanSocial', 'getLocalLanUsers', 'sendPeerResult', 'lanUserId', 'agentByUser']) {
  const reO = new RegExp('\\b' + sym + '\\b');
  if (reO.test(outside)) fail('private symbol ' + sym + ' referenced outside block');
}

// ---- 断言: L56-58 三行 LAN import 当前存在 ----
if (!lines[55] || !lines[55].includes("from './src/net/lan-discovery.js'")) fail('L56 should import lan-discovery');
if (!lines[56] || !lines[56].includes("from './src/net/lan-transport.js'")) fail('L57 should import lan-transport');
if (!lines[57] || !lines[57].includes("from './src/net/lan-social.js'")) fail('L58 should import lan-social');

// ---- 生成 lan.ts ----
// 块内代码缩进 2（原在 main() 内）。新模块包一层 registerLanRoutes(app, deps) { ... }，
// 主体保持原缩进不动（2 空格 = 函数体一级），逐行保真。
const NL = '\r\n';
const headerLines = [
  '/**',
  ' * LAN 社交路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 9/N）',
  ' *',
  ' * 抽取范围: 原 index.ts L2426-L2808（迁移前坐标），共 383 行',
  ' *   - getLocalLanUsers(): 本机用户列表（含数字 ID 与各自灵犀引擎）',
  ' *   - lanSocial: LanSocialHub 实例（含离线补发队列）',
  ' *   - startLanDiscovery: UDP 发现启动（LAN_DISCOVERY=off 可关）',
  ' *   - lanUserId: LAN 写操作身份绑定（v5 安全修复）',
  ' *   - 30 条路由: /api/lan/* 状态/邻居/搜索/好友/群组/peer 回调/群邀请 + /api/users/search',
  ' *',
  ' * 原则: 业务代码逐行保真，仅做依赖注入改造',
  ' *   （app/db/manager/router/broadcast/requireAuth/port/dataDir 由宿主传入；',
  ' *     getDB 与 lan-discovery/lan-transport/lan-social 改为模块内 import）',
  ' * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查 + 冒烟 v2',
  ' */',
  "import type { Express, RequestHandler } from 'express';",
  "import { readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { getDB } from '../storage/db.js';",
  "import { startLanDiscovery, getLanPeers, getLanSelfInfo, type LanUser } from '../net/lan-discovery.js';",
  "import { verifyLanRequest } from '../net/lan-transport.js';",
  "import { LanSocialHub, LAN_SOCIAL_CHANNEL } from '../net/lan-social.js';",
  '',
  'export function registerLanRoutes(app: Express, deps: {',
  '  db: any;',
  '  manager: any;',
  '  router: any;',
  '  broadcast: (event: any) => void;',
  '  requireAuth: RequestHandler;',
  '  port: number;',
  '  dataDir: string;',
  '}) {',
  '  const { db, manager, router, broadcast, requireAuth, port, dataDir } = deps;',
  '',
];
const newModule = headerLines.join(NL) + NL + blockSrc + NL + '}' + NL;

// ---- 改造 index.ts: 1) 移除块  2) 删 L56-58 import  3) 加模块 import  4) 加挂载 ----
const newLines = [...lines.slice(0, B0), ...lines.slice(B1)];

// 删 L56-58（0-based 55..57）— 注意此时块已移除但行号 56-58 在块之前不受影响
if (!newLines[55] || !newLines[55].includes("from './src/net/lan-discovery.js'")) fail('post-cut L56 anchor lost');
newLines.splice(55, 3);

// 加模块 import（锚: registerCustomProviderRoutes import 行）
const impIdx = newLines.findIndex(l => l.includes("import { registerCustomProviderRoutes }"));
if (impIdx < 0) fail('anchor not found: registerCustomProviderRoutes import');
newLines.splice(impIdx + 1, 0, "import { registerLanRoutes } from './src/routes/lan.js';\r");

// 加挂载（锚: registerCustomProviderRoutes(app,...) 调用行）
const regIdx = newLines.findIndex(l => l.includes('registerCustomProviderRoutes(app,'));
if (regIdx < 0) fail('anchor not found: registerCustomProviderRoutes call');
newLines.splice(regIdx + 1, 0, '  registerLanRoutes(app, { db, manager, router, broadcast, requireAuth, port, dataDir });\r');

const remainSrc = newLines.join('\n');

// ---- 断言: 零残留 ----
let cnt = 0;
const reR = /\bapp\.(?:get|post|put|delete|patch|all)\(\s*['"`]\/api\/(lan|users\/search)/g;
while (reR.exec(remainSrc) !== null) cnt++;
if (cnt !== 0) fail('index.ts still has ' + cnt + ' LAN route registrations');
for (const sym of ['LanSocialHub', 'LAN_SOCIAL_CHANNEL', 'verifyLanRequest', 'getLocalLanUsers', 'startLanDiscovery', 'getLanPeers', 'getLanSelfInfo', 'lanUserId', 'sendPeerResult']) {
  const reS = new RegExp('\\b' + sym + '\\b');
  if (reS.test(remainSrc)) fail('index.ts still references LAN symbol: ' + sym);
}

// ---- 快照脚本: TARGETS 追加 lan.ts ----
let snap = readFileSync(snapPath, 'utf8');
const snapAnchor = "join(ROOT, 'src', 'routes', 'custom-providers.ts'),";
if (!snap.includes(snapAnchor)) fail('snapshot TARGETS anchor (custom-providers.ts) not found');
if (snap.includes("'lan.ts'")) fail('lan.ts already in TARGETS');
snap = snap.replace(snapAnchor, snapAnchor + "\r\n  join(ROOT, 'src', 'routes', 'lan.ts'),");

// ---- 快照脚本: MOUNTS 追加 ----
const mountAnchor = "['registerCustomProviderRoutes', './src/routes/custom-providers.js'],";
if (!snap.includes(mountAnchor)) fail('snapshot MOUNTS anchor not found');
if (snap.includes("'registerLanRoutes'")) fail('registerLanRoutes already in MOUNTS');
snap = snap.replace(mountAnchor, mountAnchor + "\r\n  ['registerLanRoutes', './src/routes/lan.js'],");

// ---- 冒烟脚本: MODULE_FILES 追加 ----
let smoke = readFileSync(smokePath, 'utf8');
const smokeAnchor = "  ['custom-providers', 'src/routes/custom-providers.ts'],";
if (!smoke.includes(smokeAnchor)) fail('smoke MODULE_FILES anchor not found');
if (smoke.includes("'src/routes/lan.ts'")) fail('lan already in smoke MODULE_FILES');
smoke = smoke.replace(smokeAnchor, smokeAnchor + "\r\n  ['lan', 'src/routes/lan.ts'],");

// ---- 冒烟脚本: caseList 追加 ----
const caseAnchor = "  ['custom-providers', () => import('../src/routes/custom-providers.js'), { INFERENCE_BACKENDS: [], customProviderManager: ANY, requireAuth: passThrough }],";
if (!smoke.includes(caseAnchor)) fail('smoke caseList anchor not found');
if (smoke.includes("import('../src/routes/lan.js')")) fail('lan already in smoke caseList');
smoke = smoke.replace(caseAnchor, caseAnchor + "\r\n  ['lan', () => import('../src/routes/lan.js'), { db: ANY, manager: ANY, router: ANY, broadcast: ANY, requireAuth: passThrough, port: 3456, dataDir: './data' }],");

// ---- 全部断言通过，落盘 ----
writeFileSync(outPath, newModule, 'utf8');
writeFileSync(idxPath, remainSrc, 'utf8');
writeFileSync(snapPath, snap, 'utf8');
writeFileSync(smokePath, smoke, 'utf8');
console.log('[batch9] OK wrote: src/routes/lan.ts (' + (headerLines.length + block.length + 2) + ' lines, 30 routes)');
console.log('[batch9] OK wrote: index.ts (' + newLines.length + ' lines, was 3231)');
console.log('[batch9] OK wrote: scripts/route-snapshot.mjs (TARGETS+MOUNTS +lan)');
console.log('[batch9] OK wrote: scripts/smoke-mount.mts (MODULE_FILES+caseList +lan)');