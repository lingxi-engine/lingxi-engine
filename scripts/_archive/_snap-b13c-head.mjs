// HEAD vs 工作区 路由对比（13c）
import { execSync } from 'child_process';
const head = execSync('git show HEAD:index.ts', { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
import { readFileSync } from 'fs';
const work = readFileSync('index.ts', 'utf8');

const rx = /router\.(get|post|put|delete|patch)\s*\(\s*[`'"]([^`'"]+)/;
const grab = (t) => t.split('\n').map(l => l.trim()).filter(l => rx.test(l))
  .map(l => { const m = l.match(rx); return m ? m[1] + ' ' + m[2] : '?'; });

const h = grab(head), w = grab(work);
const hw = new Set(h), ww = new Set(w);
const removed = h.filter(x => !ww.has(x));
const added = w.filter(x => !hw.has(x));

console.log('HEAD routes=' + h.length + '  work routes=' + w.length);
console.log('--- removed (内联删除) ' + removed.length + ' ---');
removed.forEach(x => console.log('  - ' + x));
console.log('--- added (模块版挂载新增) ' + added.length + ' ---');
added.forEach(x => console.log('  + ' + x));

// 断言：删的应该全是 channels/webhook 系
const bad = removed.filter(x => !x.includes('/channels'));
console.log(bad.length === 0 ? 'ASSERT_OK: removed 全部属于 /channels 域' : 'ASSERT_FAIL: ' + bad.join(' | '));