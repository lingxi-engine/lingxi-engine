import fs from 'fs';
const lines = fs.readFileSync('index.ts', 'utf8').split('\n');
const ranges = [
  ['search-providers', 670, 700],
  ['rag-block', 840, 920],
  ['providers-block-a', 1020, 1060],
  ['providers-block-b', 1185, 1335],
  ['skills-block', 1700, 1770],
  ['channels-block', 1935, 2065],
];
for (const [name, a, b] of ranges) {
  console.log(`\n===== ${name} (L${a}-${b}) =====`);
  for (let i = a - 1; i < b && i < lines.length; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}