const WS = require('ws');
const c = new WS('ws://localhost:3456/ws?id=autotest001');
c.on('open', () => {
  console.log('LOCAL WS OPEN OK');
  // 尝试发消息
  c.send(JSON.stringify({ type: 'message', chatId: 'test-chat-001', content: '自动化链路测试' }));
});
c.on('message', d => {
  const s = d.toString();
  console.log('MSG: ' + s.slice(0, 200));
});
c.on('error', e => { console.log('LOCAL WS ERROR ' + e.message); process.exit(1); });
c.on('close', (code, reason) => {
  console.log('LOCAL CLOSED ' + code + ' ' + (reason || '').toString());
  if (code === 4001) process.exit(1); else setTimeout(()=>process.exit(0),500);
});
setTimeout(() => { console.log('timeout 3s'); process.exit(0); }, 3000);
