import fs from 'fs';
const lines = fs.readFileSync('index.ts', 'utf8').split('\n');
const ranges = [
  ['providers-mid (L1060-1195)', 1060, 1195],
  ['scan-workspace tail (L920-960)', 920, 960],
  ['searchManagerInstance (L270-290)', 270, 290],
  ['telegramAdapter boot (L505-530)', 505, 530],
  ['channelManager init (L480-495)', 480, 495],
];
for (const [name, a, b] of ranges) {
  console.log(`\n===== ${name} =====`);
  for (let i = a - 1; i < b && i < lines.length; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}