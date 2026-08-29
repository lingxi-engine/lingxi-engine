// 批次13c Part2: index.ts 删内联块(L1785-2028)+删孤儿import(L72-79)+挂载模块+保留启动循环
import fs from 'fs';
const P = 'index.ts';
let L = fs.readFileSync(P, 'utf8').split(/\r?\n/);
const assert = (cond, msg) => { if (!cond) { console.error('ASSERT FAIL: ' + msg); process.exit(1); } };
const cnt = (arr, sub) => arr.filter(l => l.includes(sub)).length;

// ── 前置断言: 删除块边界 ──
assert(L[1784].includes('渠道管理 API'), 'L1785 注释锚点: ' + L[1784]);
assert(L[1785].includes("app.get('/api/channels'"), 'L1786 首路由');
assert(L[1899].includes('V5 P5') && L[1900].includes('startChannelAdapter'), 'L1900-1901 SCA 头');
assert(L[2024].includes('启动已配置的渠道'), 'L2025 循环注释');
assert(L[2025].includes('getEnabledChannels'), 'L2026 循环头');
assert(L[2026].includes('await startChannelAdapter(ch)'), 'L2027 循环调用');
assert(L[2027].trim() === '}', 'L2028 循环尾');
assert(L[2028].trim() === '', 'L2029 空行');
assert(L[2029].includes('────'), 'L2030 分隔线');
// ── 前置断言: 孤儿 import ──
assert(L[70].includes("from './src/channels/telegram.js'"), 'L71 telegram import');
for (let i = 71; i <= 78; i++) {
  assert(/from '\.\/src\/channels\/(discord|slack|wechat|feishu|qqbot|whatsapp|signal|imessage)\.js'/.test(L[i]), 'L' + (i + 1) + ' adapter import: ' + L[i]);
}
// ── 前置断言: 挂载锚点 ──
assert(cnt(L, 'createChannelRoutes') === 0, 'index.ts 不应已有 createChannelRoutes');
assert(cnt(L, "createRagRoutes({ router } as any)") === 1, 'rag 挂载锚点');
assert(cnt(L, "import { createRagRoutes } from './src/routes/rag.js';") === 1, 'rag import 锚点');

const before = L.length;

// ── 删除: 内联块 L1785-2028 (244行) + 孤儿 import L72-79 (8行) ──
L = L.filter((_, i) => {
  const n = i + 1;
  return !((n >= 72 && n <= 79) || (n >= 1785 && n <= 2028));
});

// ── 插入: 模块 import (紧跟 rag import) ──
const ragImpIdx = L.findIndex(l => l.includes("import { createRagRoutes } from './src/routes/rag.js';"));
assert(ragImpIdx > 0, 'rag import 定位');
L.splice(ragImpIdx + 1, 0, "import { createChannelRoutes, startChannelAdapter } from './src/routes/channel.js';");

// ── 插入: 挂载 + 启动循环 (紧跟 rag 挂载) ──
const ragMountIdx = L.findIndex(l => l.includes("createRagRoutes({ router } as any)"));
assert(ragMountIdx > 0, 'rag 挂载定位');
L.splice(ragMountIdx + 1, 0,
  '  // ── V5 P5: 渠道管理 API ── 批次13c: 11条路由移交 src/routes/channel.ts (4条管理带requireAuth, 7条webhook公网免锁)',
  '  const channelCtx = { channelManager, router, manager, db, get telegramAdapter() { return telegramAdapter; } } as any;',
  "  app.use('/api', createChannelRoutes(channelCtx));",
  '  // 启动已配置的渠道 (模块版 startChannelAdapter, telegram分支带全局实例防重复检查)',
  '  for (const ch of channelManager.getEnabledChannels()) {',
  '    await startChannelAdapter(ch, channelCtx);',
  '  }');

fs.writeFileSync(P, L.join('\n'));

// ── 后置断言 ──
const after = fs.readFileSync(P, 'utf8').split(/\r?\n/);
assert(after.length === before - 252 + 8, '行数: ' + before + ' -> ' + after.length + ' (应 ' + (before - 244) + ')');
assert((after.join('\n').match(/app\.(get|post|delete)\('\/api\/channels/g) || []).length === 0, '内联 channels 路由应清零');
assert(cnt(after, 'createChannelRoutes') === 2, 'createChannelRoutes 应2 (import+挂载)');
assert(cnt(after, 'startChannelAdapter') === 2, 'startChannelAdapter 应2 (import+循环)');
for (const a of ['discord.js', 'slack.js', 'wechat.js', 'feishu.js', 'qqbot.js', 'whatsapp.js', 'signal.js', 'imessage.js']) {
  assert(cnt(after, "channels/" + a) === 0, '孤儿 import 残留: ' + a);
}
assert(cnt(after, "channels/telegram.js") === 1, 'telegram import 保留');
assert(cnt(after, 'telegramAdapter') >= 5, 'telegramAdapter 引用保留');

console.log('PART2_OK ' + before + ' -> ' + after.length + ' (净 ' + (after.length - before) + ')');