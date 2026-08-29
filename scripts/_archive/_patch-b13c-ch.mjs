// 批次13c Part1: channel.ts 补强 (jwtAuth导入+requireAuth定义+4条管理路由加锁+telegram全局实例守卫)
import fs from 'fs';
const P = 'src/routes/channel.ts';
let src = fs.readFileSync(P, 'utf8');
const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL: ' + msg); process.exit(1); } };
const cnt = (s, sub) => s.split(sub).length - 1;

// ── 前置断言 ──
assert(cnt(src, "import { jwtAuth }") === 0, 'jwtAuth 已存在?');
assert(cnt(src, "import type { ServerContext } from '../server/context.js';") === 1, 'ServerContext import 锚点');
assert(cnt(src, "const { channelManager, router: msgRouter, manager, db, telegramAdapter } = ctx;") === 1, '解构行锚点');
assert(cnt(src, "router.get('/channels', (_req, res) => {") === 1, 'GET /channels 唯一');
assert(cnt(src, "router.post('/channels', (req, res) => {") === 1, 'POST /channels 唯一');
assert(cnt(src, "router.post('/channels/:id/enable', async (req, res) => {") === 1, 'enable 唯一');
assert(cnt(src, "router.delete('/channels/:id', (req, res) => {") === 1, 'DELETE 唯一');
assert(cnt(src, "case 'telegram': {") === 1, 'telegram case 唯一');

// ── A: jwtAuth 导入 ──
src = src.replace("import type { ServerContext } from '../server/context.js';",
  "import type { ServerContext } from '../server/context.js';\nimport { jwtAuth } from '../middleware/jwt-auth.js';");

// ── B: 头注释 ──
src = src.replace(' * 渠道路由 — 渠道管理、Webhook、渠道适配器启动',
  ' * 渠道路由 — 渠道管理、Webhook、渠道适配器启动\n * 批次13c: 4条管理路由补鉴权锁; telegram分支增加全局实例防重复启动检查');

// ── C: requireAuth 定义 ──
src = src.replace('const { channelManager, router: msgRouter, manager, db, telegramAdapter } = ctx;',
  "const { channelManager, router: msgRouter, manager, db, telegramAdapter } = ctx;\n  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;");

// ── D: 4 条管理路由加锁 (webhook 不动!) ──
const locks = [
  ["router.get('/channels', (_req, res) => {", "router.get('/channels', requireAuth, (_req, res) => {"],
  ["router.post('/channels', (req, res) => {", "router.post('/channels', requireAuth, (req, res) => {"],
  ["router.post('/channels/:id/enable', async (req, res) => {", "router.post('/channels/:id/enable', requireAuth, async (req, res) => {"],
  ["router.delete('/channels/:id', (req, res) => {", "router.delete('/channels/:id', requireAuth, (req, res) => {"],
];
for (const [from, to] of locks) { assert(cnt(src, from) === 1, '加锁前唯一性: ' + from); src = src.replace(from, to); }

// ── E: telegram 分支加全局实例守卫 (只改 telegram case 后的第一处) ──
const caseIdx = src.indexOf("case 'telegram': {");
const guard = 'if (!channelManager.getAdapter(ch.id) && ch.config.botToken) {';
const gIdx = src.indexOf(guard, caseIdx);
assert(gIdx > 0, 'telegram guard 定位');
src = src.slice(0, gIdx) + 'if (!channelManager.getAdapter(ch.id) && !ctx.telegramAdapter && ch.config.botToken) {' + src.slice(gIdx + guard.length);

// ── 后置断言 ──
assert(cnt(src, 'requireAuth') === 5, 'requireAuth 应为5 (1定义+4路由), 实际 ' + cnt(src, 'requireAuth'));
assert(cnt(src, '!ctx.telegramAdapter') === 1, 'telegram 守卫应1处');
assert((src.match(/router\.(get|post|delete)\('\/channels/g) || []).length === 11, '路由总数应11');
assert(cnt(src, "from '../middleware/jwt-auth.js'") === 1, 'jwtAuth 导入1处');

fs.writeFileSync(P, src);
console.log('PART1_OK lines=' + src.split('\n').length);