#!/usr/bin/env node
// 灵犀引擎命令行测试工具
// 用法: node test-chat.js
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3456/ws?id=test-cli');

ws.on('open', () => {
  console.log('✅ WS 连接成功');
  ws.send(JSON.stringify({ type: 'subscribe', chatId: 'chat-demo-1' }));
  console.log('发送: 你好');
  ws.send(JSON.stringify({ type: 'message', chatId: 'chat-demo-1', content: '你好' }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'agent.streaming.start') {
    console.log('🤖 AI 开始回复...');
  } else if (msg.type === 'agent.streaming.chunk') {
    process.stdout.write(msg.chunk || '');
  } else if (msg.type === 'agent.streaming.end') {
    console.log('\n--- AI 回复结束 ---');
  } else if (msg.type === 'message.new' && msg.senderType === 'agent') {
    console.log('🤖 AI: ' + (msg.content || '(空)'));
    console.log('--- 完成 ---');
    ws.close();
    process.exit(0);
  } else if (msg.type === 'error') {
    console.log('❌ 错误: ' + (msg.message || JSON.stringify(msg)));
  } else if (msg.type === 'user.online' || msg.type === 'user.offline') {
    // 忽略
  } else {
    console.log('📨 ' + msg.type + ': ' + JSON.stringify(msg).slice(0, 200));
  }
});

ws.on('close', (code, reason) => {
  console.log('🔴 WS 关闭 code=' + code + ' reason=' + reason);
});

ws.on('error', (err) => {
  console.log('❌ WS 错误: ' + err.message);
});

setTimeout(() => {
  console.log('⏰ 30秒超时，AI 未回复');
  console.log('可能原因: API Key 无效 / 模型不可用 / 网络问题');
  ws.close();
  process.exit(1);
}, 30000);