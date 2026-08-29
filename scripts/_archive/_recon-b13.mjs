import fs from 'fs';
const s = fs.readFileSync('index.ts', 'utf8');
const lines = s.split('\n');
const targets = ['channels', 'skills', 'rag', 'providers'];
const out = [];
lines.forEach((l, i) => {
  const m = l.match(/app\.(get|post|put|delete)\(\s*['"`](\/api\/[^'"`]+)['"`]/);
  if (m && targets.some(t => m[2].includes('/' + t))) {
    out.push(`${i + 1}: ${m[1].toUpperCase()} ${m[2]}`);
  }
});
console.log('匹配到 ' + out.length + ' 条内联路由:');
console.log(out.join('\n'));

// 顺带统计这些区块的挂载情况
console.log('\n--- 模块挂载检查 ---');
const mounts = lines.filter(l => /app\.use\(['"`]\/api/.test(l) || /create\w+Routes\(/.test(l));
mounts.forEach(l => console.log(l.trim().slice(0, 120)));