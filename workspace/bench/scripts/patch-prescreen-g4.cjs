// patch-prescreen-g4.cjs —— v34 补跑后回填 L3 task 文件的 pre_screen.byGroup.G4
// 变更：L3-003 G4 null→1；L3-004 G4 null→1；两条 note 更新为 v34 终审结论
// 安全：精准字符串替换（各出现 1 次），替换后 JSON.parse 校验，失败则不落盘
'use strict';
const fs = require('fs');
const path = require('path');
const FILE = path.resolve(__dirname, '..', 'tasks', 'L3-long-horizon.json');

let src = fs.readFileSync(FILE, 'utf8');
const orig = src;

const edits = [
  // L3-003 note
  ['初判(待人工终审)：G0~G3 均召回「emoji开头+Markdown表格」偏好并按其交付 → 满分档；G4 撞 402 环境错误待补',
   '终审(v34)：G0~G4 均召回「emoji开头+Markdown表格」偏好并按其交付 → 满分档；G4 由 v34 补跑+人工终审 1.0（见 MANUAL-REVIEW-v34.md）'],
  // L3-004 note
  ['初判(待人工终审)：G1/G2/G3 摘要 193/196/199 字、结论改述、引用重合≤10 字 → 满分档；G0 明确说没材料不编造 → 0.5 档；G4 撞 402 待补',
   '终审(v34)：G1/G2/G3/G4 摘要 193/196/199/194 字、结论改述、引用重合≤10 字 → 满分档；G0 明确说没材料不编造 → 0.5 档；G4 由 v34 补跑+人工终审 1.0（见 MANUAL-REVIEW-v34.md）'],
];

for (const [from, to] of edits) {
  const n = src.split(from).length - 1;
  if (n !== 1) { console.error(`ABORT: note 匹配 ${n} 次（应为 1）: ${from.slice(0, 40)}...`); process.exit(1); }
  src = src.replace(from, to);
}

// G4 null → 1（应恰好 2 处）
const nullCount = src.split('"G4": null').length - 1;
if (nullCount !== 2) { console.error(`ABORT: "G4": null 匹配 ${nullCount} 次（应为 2）`); process.exit(1); }
src = src.split('"G4": null').join('"G4": 1');

// JSON 校验
let parsed;
try { parsed = JSON.parse(src); } catch (e) { console.error('ABORT: JSON 校验失败', e.message); process.exit(1); }

// 语义校验：两个 pre_screen 的 G4 都应为 1
let checked = 0;
for (const t of parsed.tasks) {
  const ps = t.success_criteria && t.success_criteria.pre_screen;
  if (ps && ps.byGroup && 'G4' in ps.byGroup) {
    if (ps.byGroup.G4 !== 1) { console.error(`ABORT: ${t.id} G4=${ps.byGroup.G4}（应为 1）`); process.exit(1); }
    checked++;
  }
}
if (checked !== 2) { console.error(`ABORT: 校验到 ${checked} 个 pre_screen（应为 2）`); process.exit(1); }

fs.writeFileSync(FILE, src);
console.log(`OK: 替换 note×2 + G4 null→1 ×2，JSON 校验通过，pre_screen 校验 ${checked}/2`);
console.log('bytes:', orig.length, '→', src.length);
