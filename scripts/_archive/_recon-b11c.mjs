import { readFileSync } from 'fs';
const lines = readFileSync('index.ts', 'utf8').split('\n');

function dump(a, b, label) {
  console.log(`\n=== ${label} (L${a}-${b}) ===`);
  for (let i = a - 1; i < b; i++) console.log(`${i+1}: ${lines[i]}`);
}

dump(1515, 1540, '挂载区');