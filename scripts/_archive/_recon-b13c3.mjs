// 13c 侦察2：内联 startChannelAdapter 全文 + 启动循环 + 挂载模式 + telegram 状态路由
import fs from 'fs';
const L = fs.readFileSync('index.ts', 'utf8').split(/\r?\n/);
const show = (a, b, tag) => {
  console.log(`===== ${tag} L${a}-${b} =====`);
  for (let i = a - 1; i < b && i < L.length; i++) console.log(`L${i + 1}|${L[i]}`);
};
show(1500, 1512, 'TG-STATUS-ROUTE');
show(1895, 1935, 'SCA-HEAD');
show(1975, 2035, 'SCA-TAIL+LOOP');
show(90, 100, 'IMPORTS');
show(1595, 1615, 'MOUNTS');