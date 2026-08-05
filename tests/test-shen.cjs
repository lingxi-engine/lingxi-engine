#!/usr/bin/env node
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3456/ws?id=user-shen');
ws.on('open', () => {
  console.log('✅ WS 连接成功 (user-shen)');
  ws.send(JSON.stringify({ type: 'subscribe', chatId: 'chat-demo-1' }));
  setTimeout(() => {
    console.log('发送: 你好');
    ws.send(JSON.stringify({ type: 'message', chatId: 'chat-demo-1', content: '你好' }));
  }, 500);
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'agent.streaming.start') console.log('🤖 AI 开始回复...');
  else if (msg.type === 'agent.streaming.chunk') process.stdout.write(msg.chunk || '');
  else if (msg.type === 'agent.streaming.end') console.log('\n--- 回复结束 ---');
  else if (msg.type === 'message.new' && msg.senderType === 'agent') { console.log('\n🤖 AI: ' + (msg.content||'(空)')); ws.close(); process.exit(0); }
  else if (msg.type === 'error') console.log('❌ ' + (msg.message||JSON.stringify(msg)));
  else if (msg.type !== 'user.online' && msg.type !== 'user.offline' && msg.type !== 'subscribed') console.log('📨 ' + msg.type);
});
ws.on('close', (c,r) => console.log('🔴 WS 关闭 code=' + c));
ws.on('error', (e) => console.log('❌ WS 错误: ' + e.message));
setTimeout(() => { console.log('\n⏰ 30秒超时'); ws.close(); process.exit(1); }, 30000);