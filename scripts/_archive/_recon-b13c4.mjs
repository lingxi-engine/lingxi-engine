// 13c 侦察3：telegram env 时序 + webhook 全文 + adapter 引用 + requireAuth 模板
import fs from 'fs';
const L = fs.readFileSync('index.ts', 'utf8').split(/\r?\n/);
const show = (a, b, tag) => {
  console.log(`===== ${tag} L${a}-${b} =====`);
  for (let i = a - 1; i < b && i < L.length; i++) console.log(`L${i + 1}|${L[i]}`);
};
show(505, 532, 'TG-ENV-INIT');
show(1778, 1786, 'BEFORE-FIRST-ROUTE');
show(1812, 1860, 'WEBHOOKS-PART1');
show(1860, 1900, 'WEBHOOKS-PART2');
// adapter 引用统计
const adapters = ['DiscordAdapter', 'SlackAdapter', 'WeChatAdapter', 'FeishuAdapter', 'QQBotAdapter', 'WhatsAppAdapter', 'SignalAdapter', 'IMessageAdapter', 'TelegramAdapter'];
for (const a of adapters) {
  const lines = L.map((l, i) => l.includes(a) ? i + 1 : 0).filter(Boolean);
  console.log(`ADAPTER ${a}: lines ${lines.join(',') || '(none)'}`);
}
// import 行
L.forEach((l, i) => { if (/from '\.\/src\/channels\//.test(l)) console.log(`IMP|L${i + 1}|${l.trim()}`); });