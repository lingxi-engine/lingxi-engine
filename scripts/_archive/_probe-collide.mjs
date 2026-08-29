// 临时探针3: 前缀感知的重复路由检测(工厂挂载的模块路径要补 /api 前缀)
import { readFileSync, readdirSync } from 'fs';

const routeRe = /\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/g;

// 挂载顺序表(来自探针2): 行号 -> (模块, 挂载方式)
const mounts = [
  { line: 602, mod: 'auth-main', style: 'direct' },
  { line: 605, mod: 'agents', style: 'direct' },
  { line: 606, mod: 'subagents', style: 'direct' },
  { line: 609, mod: 'friends-chats', style: 'direct' },
  { line: 613, mod: 'workflows', style: 'direct' },
  { line: 967, mod: 'market', style: 'direct' },
  { line: 968, mod: 'wallet', style: 'direct' },
  { line: 969, mod: 'custom-providers', style: 'direct' },
  { line: 970, mod: 'lan', style: 'direct' },
  { line: 2278, mod: '../routes-v1.7', style: 'direct' },
  { line: 1522, mod: 'goal-outcome', style: 'api-prefix' },
  { line: 1523, mod: 'evaluation', style: 'api-prefix' },
  { line: 1526, mod: 'agi', style: 'api-prefix' },
  { line: 1529, mod: 'profile', style: 'api-prefix' },
  { line: 1532, mod: 'misc', style: 'api-prefix' },
  { line: 1535, mod: 'upload', style: 'api-prefix' },
];

const modulePaths = new Map(); // full path -> [{mod, line}]
for (const m of mounts) {
  const f = 'src/routes/' + m.mod + '.ts';
  let src;
  try { src = readFileSync(f, 'utf8'); } catch { console.log('!! 模块不存在:', f); continue; }
  for (const match of src.matchAll(routeRe)) {
    const p = m.style === 'api-prefix' ? '/api' + match[2] : match[2];
    const key = match[1].toUpperCase() + ' ' + p;
    if (!modulePaths.has(key)) modulePaths.set(key, []);
    modulePaths.get(key).push(m.mod + '@L' + m.line);
  }
}

// 根内联路由(带行号)
const lines = readFileSync('index.ts', 'utf8').split(/\r?\n/);
const inline = new Map(); // key -> first line
lines.forEach((l, i) => {
  const match = l.match(/app\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/);
  if (match) {
    const key = match[1].toUpperCase() + ' ' + match[2];
    if (!inline.has(key)) inline.set(key, i + 1);
  }
});

console.log('内联唯一端点:', inline.size, '| 模块唯一端点:', modulePaths.size);

// 冲突检测: 同 key 时, 行号小者先注册=生效, 另一方为死路由
console.log('\n=== 冲突端点(内联 vs 模块) ===');
let dead = 0;
for (const [key, iline] of inline) {
  if (modulePaths.has(key)) {
    for (const mref of modulePaths.get(key)) {
      const mline = parseInt(mref.split('@L')[1]);
      const winner = iline < mline ? '内联L' + iline : '模块' + mref;
      const loser = iline < mline ? '模块' + mref : '内联L' + iline;
      dead++;
      console.log(`⚡ ${key}\n   生效=${winner}  死路由=${loser}`);
    }
  }
}
if (!dead) console.log('(无)');

// 模块内部重复(同一路径被两个模块注册)
console.log('\n=== 跨模块重复 ===');
let cross = 0;
for (const [key, refs] of modulePaths) {
  const files = [...new Set(refs.map(r => r.split('@')[0]))];
  if (files.length > 1) { cross++; console.log('⚡', key, '→', refs.join(' + ')); }
}
if (!cross) console.log('(无)');

// 内联自身重复
console.log('\n=== 内联自身重复 ===');
const seen = new Map();
let selfDup = 0;
lines.forEach((l, i) => {
  const match = l.match(/app\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)['"`]/);
  if (match) {
    const key = match[1].toUpperCase() + ' ' + match[2];
    if (seen.has(key)) { selfDup++; console.log(`⚡ ${key}  L${seen.get(key)} vs L${i + 1}`); }
    else seen.set(key, i + 1);
  }
});
if (!selfDup) console.log('(无)');