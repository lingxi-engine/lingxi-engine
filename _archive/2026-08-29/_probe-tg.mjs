import fs from 'fs';
const lines = fs.readFileSync('index.ts', 'utf8').split('\n');
lines.forEach((l, i) => {
  if (/app\.(get|post|put|delete)\(\s*[`'"]\/api\/telegram/.test(l)) {
    console.log('HIT L' + (i + 1) + ': ' + l.trim());
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 10); j++) {
      console.log('  ' + (j + 1) + ': ' + lines[j]);
    }
  }
});