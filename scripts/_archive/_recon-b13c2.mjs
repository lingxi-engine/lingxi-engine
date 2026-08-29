// 批次13c 侦察：定位 index.ts 中 channels 内联块边界 + startChannelAdapter 引用 + telegram 语义
import fs from 'fs';
const src = fs.readFileSync('index.ts', 'utf8');
const L = src.split(/\r?\n/);
console.log('total lines:', L.length);

const hits = [];
L.forEach((l, i) => {
  const s = l.trim();
  if (/channels?/i.test(s) && /(路由|webhook|管理|API|相关)/i.test(s)) hits.push(`CMT|L${i + 1}|${s.slice(0, 100)}`);
  if (/app\.(get|post|put|delete)\(['"`]\/api\/channels/i.test(s)) hits.push(`ROUTE|L${i + 1}|${s.slice(0, 110)}`);
  if (/router\.(get|post|put|delete)\(['"`]\/channels/i.test(s)) hits.push(`MODROUTE|L${i + 1}|${s.slice(0, 110)}`);
  if (/startChannelAdapter/.test(s)) hits.push(`SCA|L${i + 1}|${s.slice(0, 110)}`);
  if (/telegramAdapter/.test(s)) hits.push(`TG|L${i + 1}|${s.slice(0, 110)}`);
  if (/createChannelRoutes/.test(s)) hits.push(`MOUNT|L${i + 1}|${s.slice(0, 110)}`);
});
console.log(hits.join('\n'));