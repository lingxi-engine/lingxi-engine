// _check-routes-ch.mjs — 模块版 channel.ts 路由清单 vs 删除清单对账
import { readFileSync } from 'fs';

const t = readFileSync('src/routes/channel.ts', 'utf8');
const re = /\b(?:router|msgRouter)\s*\.\s*(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;

let m; const moduleRoutes = [];
while ((m = re.exec(t)) !== null) moduleRoutes.push(`${m[1].toUpperCase()} ${m[2]}`);

console.log(`模块版 channel.ts 路由 ${moduleRoutes.length} 条:`);
moduleRoutes.forEach(r => console.log('  ' + r));

// 13c 移交清单（HEAD 删除的 11 条）
const expected = [
  'GET /api/channels',
  'POST /api/channels',
  'POST /api/channels/:id/enable',
  'DELETE /api/channels/:id',
  'POST /api/channels/slack/webhook',
  'GET /api/channels/wechat/webhook',
  'POST /api/channels/wechat/webhook',
  'POST /api/channels/feishu/webhook',
  'POST /api/channels/qqbot/webhook',
  'GET /api/channels/whatsapp/webhook',
  'POST /api/channels/whatsapp/webhook',
];

console.log('\n=== 对账 ===');
let ok = 0;
for (const e of expected) {
  const hit = moduleRoutes.includes(e);
  console.log(`  ${hit ? '✅' : '❌'} ${e}`);
  if (hit) ok++;
}
const extra = moduleRoutes.filter(r => !expected.includes(r));
console.log(`\n结果: ${ok}/${expected.length} 对上；模块版多出 ${extra.length} 条${extra.length ? '：' + extra.join(', ') : ''}`);
console.log(`鉴权检查: requireAuth 出现 ${((t.match(/requireAuth/g) || []).length)} 次（期望 5：1 定义 + 4 管理路由）`);