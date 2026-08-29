import fs from 'fs';
const s = fs.readFileSync('index.ts', 'utf8');
const lines = s.split('\n');
// 关键符号引用计数
for (const sym of ['startChannelAdapter', 'channelManager', 'telegramAdapter', 'skillManager', 'searchManagerInstance', 'TelegramAdapter', 'DiscordAdapter', 'SlackAdapter', 'WeChatAdapter', 'FeishuAdapter', 'QQBotAdapter', 'WhatsAppAdapter', 'SignalAdapter', 'IMessageAdapter']) {
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(sym)) hits.push(i + 1); });
  console.log(`${sym}: ${hits.length} 处 → ${hits.slice(0, 12).join(',')}${hits.length > 12 ? '...' : ''}`);
}
console.log('\n===== ServerContext 定义 =====');
try {
  const ctx = fs.readFileSync('src/server/context.ts', 'utf8');
  console.log(ctx.slice(0, 2500));
} catch (e) { console.log('context.ts 读取失败: ' + e.message); }