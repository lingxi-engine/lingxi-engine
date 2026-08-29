// 临时探针: 对比根目录 index.ts 内联路由 与 src/routes/*.ts 模块路由, 找重复注册
import { readFileSync, readdirSync } from 'fs';

const routeRe = /\.(get|post|put|delete|patch)\(\s*(['"`])([^'"`]+)\2/g;

function extract(text) {
  const out = [];
  for (const m of text.matchAll(routeRe)) out.push({ method: m[1].toUpperCase(), path: m[3] });
  return out;
}

const rootSrc = readFileSync('index.ts', 'utf8');
const rootRoutes = extract(rootSrc);
console.log('root index.ts 内联端点数:', rootRoutes.length);

const byPrefix = {};
for (const r of rootRoutes) {
  const parts = r.path.split('/').filter(Boolean);
  const prefix = '/' + (parts[0] || '') + (parts[1] ? '/' + parts[1] : '');
  byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
}
console.log('按前缀分布:', JSON.stringify(byPrefix, null, 0));

const modPaths = new Map();
for (const f of readdirSync('src/routes')) {
  if (!f.endsWith('.ts')) continue;
  const src = readFileSync('src/routes/' + f, 'utf8');
  for (const m of extract(src)) {
    if (!modPaths.has(m.path)) modPaths.set(m.path, f);
  }
}
console.log('routes模块唯一路径数:', modPaths.size);

const rootUnique = [...new Set(rootRoutes.map(r => r.path))];
const dup = rootUnique.filter(p => modPaths.has(p));
console.log('重复路径(根内联 ∩ 模块):', JSON.stringify(dup));

// src/index.ts 断链验证
const srcIdx = readFileSync('src/index.ts', 'utf8');
const badImports = [...srcIdx.matchAll(/from\s+['"](\.\/src\/[^'"]+)['"]/g)].map(m => m[1]);
console.log('src/index.ts 中以 ./src/ 开头的import数(从src/出发全部断链):', badImports.length);
console.log('样例:', badImports.slice(0, 3));