// 13c 侦察4：rag.ts requireAuth 模板 + Config 类型残留引用检查
import fs from 'fs';
const rag = fs.readFileSync('src/routes/rag.ts', 'utf8').split(/\r?\n/);
console.log('===== RAG.TS L1-40 =====');
rag.slice(0, 40).forEach((l, i) => console.log(`L${i + 1}|${l}`));

const L = fs.readFileSync('index.ts', 'utf8').split(/\r?\n/);
console.log('\n===== CONFIG USAGE (排除import行和SCA块L1901-2023) =====');
const configs = ['DiscordConfig', 'SlackConfig', 'WeChatConfig', 'FeishuConfig', 'QQBotConfig', 'WhatsAppConfig', 'SignalConfig', 'IMessageConfig', 'TelegramConfig'];
for (const c of configs) {
  const lines = L.map((l, i) => l.includes(c) ? i + 1 : 0).filter(Boolean).filter(n => !(n >= 1901 && n <= 2023));
  console.log(`${c}: ${lines.join(',') || '(none)'}`);
}
// channelManager 在删块外(非1785-2029)的引用
const cm = L.map((l, i) => l.includes('channelManager') ? i + 1 : 0).filter(Boolean).filter(n => !(n >= 1785 && n <= 2029));
console.log(`\nchannelManager(块外): ${cm.join(',')}`);