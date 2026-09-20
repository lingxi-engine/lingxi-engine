// merge-v34.cjs —— 把 v34 补跑数据（G4-L3 全 10 题 + L2-001 重验）合并进 v32 基线
// 原则：v32-ALL/raw.json 是冻结原件，只读不改；产物写 v34-ALL/raw.json
// 合并键：group|taskId（补跑覆盖旧记录）
'use strict';
const fs = require('fs');
const path = require('path');
const WS = path.resolve(__dirname, '..');

const base = JSON.parse(fs.readFileSync(path.join(WS, 'results/v32-ALL/raw.json'), 'utf8'));
const p1 = JSON.parse(fs.readFileSync(path.join(WS, 'results/v34-G4L3/raw.json'), 'utf8'));
const p2 = JSON.parse(fs.readFileSync(path.join(WS, 'results/v34-L2001/raw.json'), 'utf8'));

const patch = {};
for (const r of [...p1, ...p2]) patch[r.group + '|' + r.taskId] = r;

let replaced = 0;
const merged = base.map((r) => {
  const k = r.group + '|' + r.taskId;
  if (patch[k]) { replaced++; return patch[k]; }
  return r;
});

const outDir = path.join(WS, 'results/v34-ALL');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify(merged, null, 2));

console.log('base:', base.length, 'patchKeys:', Object.keys(patch).length, 'replaced:', replaced, 'merged:', merged.length);
console.log('replaced list:', Object.keys(patch).join(', '));
