import fs from 'fs';
const s = fs.readFileSync('index.ts', 'utf8');
const lines = s.split('\n');

// 1. startChannelAdapter 完整范围 + 后续内容
console.log('===== L2055-2260 (startChannelAdapter 尾部+后续) =====');
for (let i = 2054; i < 2260 && i < lines.length; i++) {
  console.log(`${i + 1}: ${lines[i]}`);
}