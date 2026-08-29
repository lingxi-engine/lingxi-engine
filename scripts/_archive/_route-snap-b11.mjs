// 批次11收尾：路由快照对比 —— 验证被删内联路由全部有模块版兜底
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const headSrc = execSync('git show HEAD:index.ts', { encoding: 'utf8' });
const workSrc = readFileSync('index.ts', 'utf8');

function extractAppRoutes(src) {
  const out = new Set();
  const re = /app\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1].toUpperCase() + ' ' + m[2]);
  return out;
}
function extractRouterRoutes(file) {
  const src = readFileSync(file, 'utf8');
  const out = new Set();
  const re = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1].toUpperCase() + ' ' + m[2]);
  return out;
}

const headRoutes = extractAppRoutes(headSrc);
const workRoutes = extractAppRoutes(workSrc);

// 模块路由（misc/profile/upload 走 app.use('/api', factory())，需补 /api 前缀）
const moduleRoutes = new Set();
for (const f of ['src/routes/misc.ts', 'src/routes/profile.ts', 'src/routes/upload.ts']) {
  for (const r of extractRouterRoutes(f)) {
    const [method, ...pathParts] = r.split(' ');
    const p = pathParts.join(' ');
    moduleRoutes.add(method + ' ' + (p.startsWith('/api') ? p : '/api' + p));
  }
}

const deleted = [...headRoutes].filter(r => !workRoutes.has(r));
console.log('HEAD 内联路由数: ' + headRoutes.size);
console.log('工作区内联路由数: ' + workRoutes.size);
console.log('被删内联路由数: ' + deleted.length);
console.log('--- 逐条核验模块兜底 ---');
let missing = 0;
for (const r of deleted.sort()) {
  const covered = moduleRoutes.has(r);
  if (!covered) missing++;
  console.log((covered ? 'OK ' : 'MISS ') + r);
}
console.log('---');
console.log('模块路由总数(含前缀): ' + moduleRoutes.size);
console.log(missing === 0 ? '✅ 全部被删路由均有模块版兜底' : '❌ 有 ' + missing + ' 条无兜底！');
process.exit(missing === 0 ? 0 : 1);