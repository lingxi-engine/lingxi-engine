const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3456/ws?id=user-shen');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe', chatId: 'chat-demo-1' }));
  setTimeout(() => {
    console.log('发送: 今天藁城天气');
    ws.send(JSON.stringify({ type: 'message', chatId: 'chat-demo-1', content: '今天藁城天气' }));
  }, 500);
});
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'agent.streaming.start') console.log('AI开始回复...');
  else if (msg.type === 'agent.streaming.chunk') process.stdout.write(msg.chunk || '');
  else if (msg.type === 'agent.streaming.end') console.log('\n---结束---');
  else if (msg.type === 'message.new' && msg.senderType === 'agent') {
    console.log('\nAI: ' + (msg.content || '(空)'));
    ws.close();
    process.exit(0);
  } else if (msg.type === 'error') console.log('错误: ' + (msg.message || JSON.stringify(msg)));
});
ws.on('close', (c) => console.log('\n关闭 ' + c));
setTimeout(() => { console.log('\n超时'); ws.close(); process.exit(1); }, 30000);