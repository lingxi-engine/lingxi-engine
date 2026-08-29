// 批次12：mesh 内联块(引擎+REST) → 模块版（setupMesh + createMeshRoutes）
// 策略：锚点断言 + 从后往前切 + 孤儿 import 检测
import { readFileSync, writeFileSync } from 'fs';

const src = readFileSync('index.ts', 'utf8');
const lines = src.split('\n'); // 1-based 取用

function assertLine(n1, frag) {
  const actual = (lines[n1 - 1] || '').trim();
  if (!actual.includes(frag)) {
    console.error(`❌ 断言失败 L${n1}: 期望含 "${frag}"，实际: "${actual.slice(0, 80)}"`);
    process.exit(1);
  }
}

// ── 锚点断言（批次12实测行号）──
assertLine(56, "startInstanceMesh");
assertLine(2281, "Instance Mesh");
assertLine(2283, "{");
assertLine(2284, "const meshPlatformUrl");
assertLine(2387, "/api/mesh/status");
assertLine(2415, "/api/mesh/task");
assertLine(2422, "}");
assertLine(94, "createMiscRoutes");
assertLine(1532, "createMiscRoutes");

// ── misc.ts 修改（先改模块，再删内联）──
let m = readFileSync('src/routes/misc.ts', 'utf8');
const fixes = [
  ["router.get('/mesh/status', (_req, res)", "router.get('/mesh/status', requireAuth, (_req, res)"],
  ["router.get('/mesh/peers', async (_req, res)", "router.get('/mesh/peers', requireAuth, async (_req, res)"],
  ["router.post('/mesh/send', (req, res)", "router.post('/mesh/send', requireAuth, (req, res)"],
  ["router.post('/mesh/task', (req, res)", "router.post('/mesh/task', requireAuth, (req, res)"],
];
for (const [from, to] of fixes) {
  if (!m.includes(from)) { console.error('❌ misc.ts 找不到锚点: ' + from); process.exit(1); }
  m = m.replace(from, to);
}
if (!m.includes("startsWith('chat-platform-')")) { console.error('❌ misc.ts 找不到 chat-platform- 锚点'); process.exit(1); }
m = m.replace("startsWith('chat-platform-')", "startsWith('chat-')");
writeFileSync('src/routes/misc.ts', m);

// ── index.ts 修改 ──
lines[93] = "import { createMiscRoutes, setupMesh, createMeshRoutes } from './src/routes/misc.js';";
lines[2282] = "  setupMesh({ db, manager, router, broadcast, dataDir } as any, port); // 批次12: mesh引擎+REST已移交 src/routes/misc.ts";
lines[2283] = "  app.use('/api', createMeshRoutes({ db, manager, router, broadcast, dataDir } as any)); // REST 4条(模块版自带requireAuth)";
for (let i = 2285; i <= 2422; i++) lines[i - 1] = null;

const out = lines.filter(l => l !== null).join('\n');
writeFileSync('index.ts', out);

// ── 验证 ──
const after = readFileSync('index.ts', 'utf8');
const aLines = after.split('\n').length;
console.log(`index.ts: 2641 → ${aLines} 行（净删 ${2641 - aLines}）`);

for (const sym of ['setPeerMessageHandler', 'setPeerTaskHandler', 'sendPeerMessage', 'getMeshInfo', 'getInstanceId', 'PeerMessage', 'startInstanceMesh', 'processUserMessage']) {
  const n = after.split(sym).length - 1;
  console.log((n <= 1 ? '⚠️ 孤儿候选 ' : '✓ ') + `${sym}: ${n} 次`);
}
console.log('✅ 补丁完成');