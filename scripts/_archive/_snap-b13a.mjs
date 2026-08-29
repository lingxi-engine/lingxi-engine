// 批次13a 路由快照对比：HEAD vs 工作区
import fs from 'fs';
import { execSync } from 'child_process';

function extractRoutes(src) {
  const out = [];
  const re = /app\.(get|post|delete|put|patch)\('([^']+)'/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1].toUpperCase() + ' ' + m[2]);
  return out;
}

const head = execSync('git show HEAD:index.ts', { encoding: 'utf8' });
const work = fs.readFileSync('index.ts', 'utf8');

const hr = extractRoutes(head);
const wr = extractRoutes(work);
console.log('HEAD 路由数: ' + hr.length + '  →  工作区: ' + wr.length);

const wset = new Set(wr);
const removed = hr.filter(r => !wset.has(r));
console.log('被删 ' + removed.length + ' 条:');

// 模块版路由（挂载在 /api 下）
const mod = fs.readFileSync('src/routes/skills.ts', 'utf8');
const mre = /router\.(get|post|delete|put|patch)\('([^']+)'/g;
const mset = new Set();
let mm;
while ((mm = mre.exec(mod))) mset.add(mm[1].toUpperCase() + ' /api' + mm[2]);

let ok = 0, miss = 0;
for (const r of removed) {
  const covered = mset.has(r);
  if (covered) ok++; else miss++;
  console.log((covered ? '  OK   ' : '  MISS ') + r);
}
console.log('兜底核验: ' + ok + '/' + removed.length + (miss === 0 ? ' 全绿' : ' 有缺口!'));
process.exit(miss === 0 ? 0 : 1);