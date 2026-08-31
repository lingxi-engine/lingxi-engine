/**
 * 批次 10：LAN 块"抽+换"闭环（内容锚点版，不依赖硬编码行号）
 * 1. 删除 index.ts 内联 LAN 块（含块头注释，234 行）
 * 2. 原位挂载 src/routes/lan.ts 的 registerLanRoutes（仿 mesh 动态 import）
 * 3. 清理 import：readFileSync / lan-discovery 瘦身 / lan-transport / lan-social
 */
import { readFileSync, writeFileSync } from 'node:fs';

const p = 'src/index.ts';
const raw = readFileSync(p, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const lines = raw.split(eol);
const t = (s) => s.trim();

function abort(msg) {
  console.error('[ABORT] ' + msg);
  process.exit(1);
}
function expect(cond, desc) {
  if (!cond) abort('锚点失败: ' + desc);
  console.log('  OK ' + desc);
}

// ── 定位 LAN 块 ──
const titleIdx = lines.findIndex((l) => l.includes('LAN 社交') && l.includes('──'));
expect(titleIdx > 0, `LAN 标题行 idx=${titleIdx}`);
expect(lines[titleIdx - 1].trim().startsWith('//'), '标题上方是分隔线');
expect(lines[titleIdx + 1].trim().startsWith('//'), '标题下方是分隔线');
expect(lines[titleIdx + 2].includes('function getLocalLanUsers'), '块体第一函数 getLocalLanUsers');

// ── 定位块尾：HTTP 服务器标题往上找最后一条代码行 ──
const httpIdx = lines.findIndex((l) => l.includes('HTTP 服务器启动'));
expect(httpIdx > titleIdx, 'HTTP 标题在 LAN 块之后');
expect(lines[httpIdx - 1].trim().startsWith('//'), 'HTTP 标题上方是分隔线');
let endIdx = httpIdx - 2;
while (endIdx > titleIdx) {
  const s = lines[endIdx].trim();
  if (s === '' || s.startsWith('//')) endIdx--; else break;
}
expect(lines[endIdx].trim() === '});', `块尾是 '});' (L${endIdx + 1})`);

// ── 块内容抽查 ──
const block = lines.slice(titleIdx, endIdx + 1).join('\n');
expect(block.includes('startLanDiscovery'), '块内含 startLanDiscovery');
expect(block.includes('/api/lan/status'), '块内含 /api/lan/status');
expect(block.includes('/api/lan/peer/group-invite-accepted'), '块内含最后一个 peer 路由');
expect(!block.includes('HTTP 服务器启动'), '块内不含块后内容');

const startIdx = titleIdx - 1; // 连块首分隔线一起删
const count = endIdx - startIdx + 1;
expect(count === 234, `删除行数 ${count} === 234`);

// ── import 区断言 ──
expect(lines[11].includes('existsSync, mkdirSync, readFileSync'), 'L12 fs import');
expect(lines[30].includes('startLanDiscovery, stopLanDiscovery'), 'L31 lan-discovery import');
expect(lines[31].includes('lan-transport'), 'L32 lan-transport import');
expect(lines[32].includes('LanSocialHub'), 'L33 lan-social import');

console.log(`切割: 删 L${startIdx + 1}-${endIdx + 1} 共 ${count} 行, 挂载 5 行`);
const mount = [
  '  // ==================================================',
  '  // -- LAN 社交（批次 10：迁移至 src/routes/lan.ts） --',
  '  // ==================================================',
  "  const { registerLanRoutes } = await import('./src/routes/lan.js');",
  '  registerLanRoutes(app, { db, manager, router, broadcast, requireAuth, port, dataDir });',
];
lines.splice(startIdx, count, ...mount);

// ── 清理 import ──
lines[11] = "import { existsSync, mkdirSync } from 'fs';";
lines[30] = "import { stopLanDiscovery } from './src/net/lan-discovery.js';";
lines.splice(31, 2); // lan-transport + lan-social

writeFileSync(p, lines.join(eol));
console.log(`完成。新行数: ${lines.length}（原 1053，预期 824）`);