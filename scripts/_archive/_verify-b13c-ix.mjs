// 13c Part2 后置自检: 以文件实际状态为准
import fs from 'fs';
const L = fs.readFileSync('index.ts', 'utf8').split(/\r?\n/);
const cnt = (s) => L.filter(l => l.includes(s)).length;
console.log('total lines:', L.length, '(期望 2103)');
console.log('内联 channels 路由残留:', (L.join('\n').match(/app\.(get|post|delete)\('\/api\/channels/g) || []).length, '(期望 0)');
console.log('createChannelRoutes:', cnt('createChannelRoutes'), '(期望 2: import+挂载)');
console.log('startChannelAdapter 全部出现行:');
L.forEach((l, i) => { if (l.includes('startChannelAdapter')) console.log('  L' + (i + 1) + '| ' + l.trim().slice(0, 100)); });
console.log('孤儿 import 残留:', ['discord', 'slack', 'wechat', 'feishu', 'qqbot', 'whatsapp', 'signal', 'imessage'].map(a => "channels/" + a + ".js").filter(x => cnt(x) > 0).length, '(期望 0)');
console.log('telegram import:', cnt("channels/telegram.js"), '(期望 1)');
console.log('telegramAdapter 引用:', cnt('telegramAdapter'), '(期望 >=5)');
console.log('channelCtx getter:', cnt('get telegramAdapter()'), '(期望 1)');
console.log('启动循环:', cnt('getEnabledChannels'), '(期望 1)');
console.log('\n===== 挂载区上下文 =====');
const m = L.findIndex(l => l.includes("createChannelRoutes(channelCtx)"));
L.slice(m - 4, m + 8).forEach((l, i) => console.log('L' + (m - 3 + i) + '| ' + l));