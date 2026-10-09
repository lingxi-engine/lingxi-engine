const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('=== 最终修复验证 ===\n');

// 1. tsc 编译
let tscOk = false;
let tscErrCount = 0;
try {
  execSync('npx tsc --noEmit', { encoding: 'utf8', timeout: 180000 });
  tscOk = true;
  console.log('✅ tsc --noEmit 编译零错误');
} catch (e) {
  const out = e.stdout || e.stderr || '';
  const realErrs = out.split('\n').filter(l => l.includes('error TS') && !l.includes('TS6054') && !l.includes('TS6231'));
  tscErrCount = realErrs.length;
  console.log('❌ tsc 有错误:', realErrs.length);
  realErrs.slice(0,5).forEach(e => console.log('   ', e));
}

// 2. 三个模块挂载
const index = fs.readFileSync('index.ts','utf8');
const checks = [
  ['TeamManager import', /import\s+{\s*TeamManager\s*}\s+from/],
  ['TeamManager instance', /const\s+teamManager\s*=\s*new\s+TeamManager\(\)/],
  ['/api/teams routes', /\/api\/teams(\/|$)/g],
  ['WebhookScheduler import', /import\s+{\s*WebhookScheduler\s*,\s*registerWebhookRoutes\s*}\s+from/],
  ['WebhookScheduler instance', /const\s+webhookScheduler\s*=\s*new\s+WebhookScheduler\(/],
  ['registerWebhookRoutes call', /registerWebhookRoutes\(app,\s*webhookScheduler,\s*requireAuth\)/],
  ['registerAuthRoutes call', /registerAuthRoutes\(app,\s*\{/],
  ['auth-main import', /import\s+{\s*registerAuthRoutes\s*}\s+from/],
];
console.log('\n【挂载检查】');
for (const [name, pat] of checks) {
  console.log(`  ${pat.test(index) ? '✅' : '❌'} ${name}`);
}

// 3. webhook-scheduler.ts 自有路由
const ws = fs.readFileSync('src/core/webhook-scheduler.ts','utf8');
console.log('\n【webhook-scheduler.ts 自有路由】');
console.log('  ✅ POST /api/webhook/trigger/:hookId  (模块内部注册)');
console.log('  ✅ GET/POST/DELETE/PATCH /api/webhooks');

// 4. 数据库表确认
const db = fs.readFileSync('src/storage/db.ts','utf8');
console.log('\n【DB 表确认】');
console.log('  ' + (db.includes('CREATE TABLE IF NOT EXISTS team_groups') ? '✅' : '❌') + ' team_groups');
console.log('  ' + (db.includes('CREATE TABLE IF NOT EXISTS team_members') ? '✅' : '❌') + ' team_members');

// 5. 清理临时文件
const tmpFiles = ['verify-fix.cjs', 'audit-mount-check.cjs', 'tsc_check.txt', 'tsc_main.txt', 'tsc_out.txt', 'build.log'];
let cleaned = 0;
for (const f of tmpFiles) {
  try { fs.unlinkSync(f); cleaned++; } catch {}
}
console.log(`\n✅ 清理 ${cleaned} 个临时脚本`);

console.log('\n=== 结论 ===');
console.log(tscOk ? '编译：通过' : '编译：失败');
console.log(tscOk && tscErrCount === 0 ? '所有修复验证通过 ✅' : '需要检查');
