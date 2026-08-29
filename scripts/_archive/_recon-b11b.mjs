import { readFileSync } from 'fs';
const lines = readFileSync('index.ts', 'utf8').split('\n');

// import 区 L85-100
console.log('=== import 区 (L85-100) ===');
for (let i = 84; i < 100; i++) console.log(`${i+1}: ${lines[i]}`);

// 搜索所有可能的挂载模式
console.log('\n=== 挂载模式搜索 ===');
const pats = ["misc", "profileRoutes", "uploadRoutes", "miscRoutes", "app.use("];
pats.forEach(p => {
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(p) && i > 100) hits.push(i+1); });
  console.log(`"${p}" ->`, hits.slice(0, 20).join(', ') || '无');
});

// ratings 和 update 用宽松匹配
console.log('\n=== 宽松匹配 ===');
["ratings", "/api/update", "update"].forEach(p => {
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(p)) hits.push(i+1); });
  console.log(`"${p}" ->`, hits.slice(0, 15).join(', ') || '无');
});