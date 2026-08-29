// 批次13c收尾：给 channel.ts 三处裸 req.params.id 补 String() 守卫
import fs from 'fs';
const F = 'src/routes/channel.ts';
let t = fs.readFileSync(F, 'utf8');
const before = t;

// 前置断言：恰好3处裸引用，0处已有守卫
const bare = (t.match(/(?<!String\()req\.params\.id/g) || []).length;
const guarded = (t.match(/String\(req\.params\.id\)/g) || []).length;
if (bare !== 3 || guarded !== 0) {
  console.error(`ABORT: bare=${bare} guarded=${guarded} (expect 3/0)`);
  process.exit(1);
}

t = t.replace(/(?<!String\()req\.params\.id/g, 'String(req.params.id)');

// 后置断言：裸引用清零，守卫恰好3处
const bare2 = (t.match(/(?<!String\()req\.params\.id/g) || []).length;
const guarded2 = (t.match(/String\(req\.params\.id\)/g) || []).length;
if (bare2 !== 0 || guarded2 !== 3) {
  console.error(`ABORT-POST: bare=${bare2} guarded=${guarded2}`);
  process.exit(1);
}

fs.writeFileSync(F, t);
console.log(`GUARD_OK bare 3->0, guarded=3, delta=${t.length - before.length} chars`);