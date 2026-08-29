import { readFileSync } from 'fs';
const lines = readFileSync('index.ts', 'utf8').split('\n');

function dump(a, b) {
  for (let i = a - 1; i < b; i++) console.log(`${i+1}: ${lines[i]}`);
}

// mesh 块前边界
console.log('=== L2375-2395 (mesh 开头) ===');
dump(2375, 2395);
// mesh 尾 + profile 头
console.log('\n=== L2418-2440 (mesh尾->profile头) ===');
dump(2418, 2440);
// profile 尾 + ratings 区
console.log('\n=== L2550-2575 (profile尾->fed头) ===');
dump(2550, 2575);
// fed 尾 + ws-mode + update + tags/time
console.log('\n=== L2625-2700 (fed尾->tags尾) ===');
dump(2625, 2700);