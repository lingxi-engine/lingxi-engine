import { readFileSync, readdirSync } from 'fs';
const rx = /app\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)/g;
const rx2 = /router\.(get|post|put|delete|patch|all)\(\s*['"`]([^'"`]+)/g;
function scan(f, r){ const s = readFileSync(f,'utf8'); const set = new Set(); let m; while((m=r.exec(s))) set.add(m[2]); return set; }
const mono = scan('index.ts', rx);
const oldE = scan('src/index.ts', rx);
let rf = []; try { rf = readdirSync('src/routes').filter(f=>f.endsWith('.ts')); } catch {}
const rd = new Set();
for (const f of rf){ const s = readFileSync('src/routes/'+f,'utf8'); let m; while((m=rx2.exec(s))) rd.add(m[2]); }
console.log('monolith unique paths:', mono.size, '| old-entry:', oldE.size, '| routes-dir:', rd.size, '(', rf.length, 'files )');
const onlyMono = [...mono].filter(p=>!oldE.has(p));
const onlyOld = [...oldE].filter(p=>!mono.has(p));
console.log('--- only in monolith (' + onlyMono.length + '):'); console.log(onlyMono.slice(0,80).join('\n'));
console.log('--- only in old entry (' + onlyOld.length + '):'); console.log(onlyOld.slice(0,80).join('\n'));