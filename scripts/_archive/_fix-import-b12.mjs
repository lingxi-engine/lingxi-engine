import { readFileSync, writeFileSync } from 'fs';
let s = readFileSync('index.ts', 'utf8');
const from = "import { startInstanceMesh, setPeerMessageHandler, setPeerTaskHandler, sendPeerMessage, getMeshInfo, getInstanceId, type PeerMessage } from './src/core/instance-mesh.js';";
const to = "import { getInstanceId, type PeerMessage } from './src/core/instance-mesh.js';";
if (!s.includes(from)) { console.error('❌ import 锚点未命中'); process.exit(1); }
writeFileSync('index.ts', s.replace(from, to));
const after = readFileSync('index.ts', 'utf8');
console.log('✅ import 已精简，行数:', after.split('\n').length);
for (const sym of ['startInstanceMesh', 'setPeerMessageHandler', 'setPeerTaskHandler', 'sendPeerMessage', 'getMeshInfo']) {
  const n = after.split(sym).length - 1;
  console.log((n === 0 ? '✓ 已清除 ' : '⚠️ 仍出现 ') + `${sym}: ${n}`);
}