// 临时探针2: 根 index.ts 挂载顺序 + /api/chats 冲突裁决分析
import { readFileSync } from 'fs';

const lines = readFileSync('index.ts', 'utf8').split(/\r?\n/);

console.log('=== register* 调用(按行号) ===');
lines.forEach((l, i) => {
  if (/register\w+Routes\(/.test(l)) console.log('L' + (i + 1) + ':', l.trim());
});

console.log('\n=== /api/chats 相关行 ===');
lines.forEach((l, i) => {
  if (/['"`]\/api\/chats/.test(l)) {
    const t = l.trim();
    console.log('L' + (i + 1) + ':', t.slice(0, 100));
  }
});

console.log('\n=== app.use / app.all 挂载点(前40) ===');
let n = 0;
for (let i = 0; i < lines.length && n < 40; i++) {
  const m = lines[i].match(/^\s*app\.(use|all)\((.*)$/);
  if (m) { console.log('L' + (i + 1) + ':', lines[i].trim().slice(0, 110)); n++; }
}