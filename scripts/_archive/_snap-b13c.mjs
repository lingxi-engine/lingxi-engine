// 批次13c 路由快照：HEAD(内联残留) vs 工作区(模块版)
import fs from 'fs';
const ix = fs.readFileSync('index.ts', 'utf8');
const ch = fs.readFileSync('src/routes/channel.ts', 'utf8');

const inline = ix.split('\n').map((l, i) => ({ l: l.trim(), n: i + 1 }))
  .filter(x => /router\.(get|post|put|delete|patch)\s*\(\s*[`'"]/.test(x.l));

const mod = ch.split('\n').map((l, i) => ({ l: l.trim(), n: i + 1 }))
  .filter(x => /(msgRouter|router)\.(get|post|put|delete|patch)\s*\(\s*[`'"]/.test(x.l));

const pathOf = (l) => {
  const m = l.match(/\.(?:get|post|put|delete|patch)\s*\(\s*[`'"]([^`'"]+)/);
  return m ? m[1] : '?';
};

console.log('=== HEAD 内联残留（期望 0）===');
console.log(inline.length === 0 ? 'CLEAN' : inline.map(x => `L${x.n}: ${pathOf(x.l)}`).join('\n'));

console.log('=== 模块版 channel.ts 路由 ===');
mod.forEach(x => console.log(`L${x.n}: ${x.l.replace(/\s+/g, ' ').slice(0, 90)}`));
console.log('module count = ' + mod.length);