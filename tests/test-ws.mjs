import { WebSocket } from 'ws';
const ws = new WebSocket('ws://127.0.0.1:3456/ws');
ws.on('open', () => {
  console.log('[OPEN]');
  ws.send(JSON.stringify({ type: 'message', chatId: 'chat-demo-verify', content: 'ping test ' + Date.now() }));
});
ws.on('message', d => console.log('[MSG]:', d.toString()));
ws.on('error', e => console.log('[ERR]:', e.message));
ws.on('close', (code, reason) => console.log('[CLOSE] code=' + code + ' reason=' + reason));
setTimeout(() => { ws.close(); process.exit(0); }, 4000);