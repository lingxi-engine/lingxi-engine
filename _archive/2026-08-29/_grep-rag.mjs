import fs from 'node:fs';
const idx = fs.readFileSync('index.ts', 'utf8');
const lines = idx.split('\n');
lines.forEach((l, i) => {
  if (/rag/i.test(l)) console.log('L' + (i + 1) + ': ' + l.trim());
});