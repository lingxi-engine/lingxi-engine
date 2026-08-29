// 批次13a 补丁：内联 skills 路由 → createSkillsRoutes 模块挂载
import fs from 'fs';

const t = fs.readFileSync('index.ts', 'utf8');
const L = t.split(/\r?\n/);

// ── 断言区：任何一条不过就退出，不落刀 ──
const c1 = L.filter(l => l.includes('V5 P4: 技能 API'));
if (c1.length !== 1) { console.error('FAIL 注释头不唯一:' + c1.length); process.exit(1); }
const c2 = L.filter(l => l.includes("app.post('/api/skills/install'"));
if (c2.length !== 1) { console.error('FAIL install不唯一:' + c2.length); process.exit(1); }
const c3 = L.filter(l => /app\.(get|post|delete)\('\/api\/skills/.test(l));
if (c3.length !== 8) { console.error('FAIL skills路由数:' + c3.length); process.exit(1); }
const c4 = L.filter(l => l.includes("import { createMiscRoutes"));
if (c4.length !== 1) { console.error('FAIL import锚点:' + c4.length); process.exit(1); }
const c5 = L.filter(l => l.includes('createSkillsRoutes'));
if (c5.length !== 0) { console.error('FAIL 已有createSkillsRoutes引用:' + c5.length); process.exit(1); }

// ── 定位边界 ──
const s = L.findIndex(l => l.includes('V5 P4: 技能 API'));
let e = -1;
for (let i = L.findIndex(l => l.includes("app.post('/api/skills/install'")); i < L.length; i++) {
  if (L[i] === '  });') { e = i; break; }
}
if (s < 0 || e < 0 || e <= s) { console.error('FAIL 边界 s=' + s + ' e=' + e); process.exit(1); }
console.log('锚点OK: 切除行 ' + (s + 1) + '..' + (e + 1) + ' 共' + (e - s + 1) + '行');

// ── 替换 ──
const block = [
  '  // ── V5 P4: 技能 API ── 批次13a: 8条路由移交 src/routes/skills.ts',
  "  app.use('/api', createSkillsRoutes({ skillManager } as any));",
];
L.splice(s, e - s + 1, ...block);

// ── import ──
const ii = L.findIndex(l => l.includes("import { createMiscRoutes"));
L.splice(ii + 1, 0, "import { createSkillsRoutes } from './src/routes/skills.js';");

fs.writeFileSync('index.ts', L.join('\n'));
console.log('写入完成, 新行数:' + L.length);

// ── 自检 ──
const t2 = fs.readFileSync('index.ts', 'utf8');
console.log('残留内联skills路由: ' + (t2.match(/app\.(get|post|delete)\('\/api\/skills/g) || []).length);
console.log('createSkillsRoutes引用: ' + (t2.match(/createSkillsRoutes/g) || []).length);