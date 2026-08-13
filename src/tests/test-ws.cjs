// Quick WS test: send a message and listen for AI reply
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3456/ws?id=user-shen');

ws.on('open', () => {
  console.log('[TEST] Connected as user-shen');
  // Subscribe to demo chat
  ws.send(JSON.stringify({ type: 'subscribe', chatId: 'chat-demo-1' }));
  // Send a message
  ws.send(JSON.stringify({ type: 'message', chatId: 'chat-demo-1', content: '你好松仔，你在吗？' }));
  console.log('[TEST] Message sent, waiting for AI reply...');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[TEST] Received:', msg.type, msg.content || msg.message || '');
  if (msg.type === 'message.new' && msg.senderType === 'agent') {
    console.log('[TEST] ✅ AI replied:', msg.content);
    ws.close();
  }
});

ws.on('error', (err) => console.error('[TEST] Error:', err.message));
ws.on('close', () => { console.log('[TEST] Closed'); process.exit(0); });

// Timeout after 30s
setTimeout(() => { console.log('[TEST] ⏰ Timeout - no AI reply in 30s'); ws.close(); }, 30000);
