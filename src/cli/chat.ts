#!/usr/bin/env node
/**
 * 灵犀引擎 CLI 入口
 * npx lingxi chat - 终端聊天
 * npx lingxi inbox - 查看收件箱
 * npx lingxi skills - 技能管理
 * npx lingxi approve <id> - 批准操作
 */

import readline from 'readline';
import { WebSocket } from 'ws';

const BASE_URL = process.env.LINGXI_URL || 'http://localhost:3456';
const WS_URL = BASE_URL.replace('http', 'ws');

const args = process.argv.slice(2);
const command = args[0] || 'chat';

// ── chat 命令 ──

async function chat() {
  const userId = getArg('--user') || 'cli-user';
  const chatId = getArg('--chat') || 'chat-cli';
  const model = getArg('--model') || '';

  console.log(`\n🐿️ 灵犀引擎 CLI - 连接 ${BASE_URL}\n`);

  // 测试连接
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log('✅ 已连接\n');
  } catch (err: any) {
    console.error(`❌ 连接失败: ${err.message}`);
    console.error(`   确保灵犀引擎正在运行: npm start`);
    process.exit(1);
  }

  // WebSocket 连接
  const clientId = `cli_${Date.now()}`;
  const ws = new WebSocket(`${WS_URL}/ws?id=${clientId}`);
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  let connected = false;
  let streaming = false;

  ws.on('open', () => {
    connected = true;
    // 注册客户端
    ws.send(JSON.stringify({
      type: 'register',
      clientId,
      userId,
    }));
    rl.prompt();
  });

  ws.on('message', (data: string) => {
    try {
      const msg = JSON.parse(data.toString());
      
      switch (msg.type) {
        case 'stream':
          // 流式输出
          if (!streaming) {
            process.stdout.write('🤖 ');
            streaming = true;
          }
          process.stdout.write(msg.content || '');
          break;
          
        case 'stream_end':
          process.stdout.write('\n\n');
          streaming = false;
          rl.prompt();
          break;

        case 'message':
          if (msg.userId !== userId) {
            const sender = msg.agentId ? '🤖' : '👤';
            process.stdout.write(`\n${sender} ${msg.content}\n\n`);
            rl.prompt();
          }
          break;

        case 'notification':
          process.stdout.write(`\n📢 ${msg.content}\n\n`);
          rl.prompt();
          break;
      }
    } catch {}
  });

  ws.on('close', () => {
    if (connected) {
      console.log('\n\n🔌 连接断开');
    }
    process.exit(0);
  });

  ws.on('error', (err: any) => {
    console.error(`\n❌ WebSocket 错误: ${err.message}`);
    process.exit(1);
  });

  // 输入处理
  rl.on('line', (line: string) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }

    // 特殊命令
    if (text.startsWith('/')) {
      handleCommand(text, ws, rl);
      return;
    }

    // 发送消息
    ws.send(JSON.stringify({
      type: 'chat',
      userId,
      chatId,
      content: text,
      model: model || undefined,
    }));
  });

  rl.on('close', () => {
    ws.close();
    process.exit(0);
  });
}

// ── inbox 命令 ──

async function inbox() {
  try {
    const res = await fetch(`${BASE_URL}/api/inbox`);
    const items = await res.json() as any[];
    
    if (items.length === 0) {
      console.log('\n📦 收件箱为空\n');
      return;
    }

    console.log(`\n📦 收件箱 (${items.length} 条)\n`);
    console.log('─'.repeat(60));
    
    for (const item of items) {
      const status = item.read ? '✅' : '🔵';
      const time = new Date(item.createdAt).toLocaleString('zh-CN');
      console.log(`${status} [${item.type}] ${item.title}`);
      console.log(`   ${time} | ID: ${item.id}`);
      if (item.content) {
        const preview = item.content.slice(0, 100);
        console.log(`   ${preview}${item.content.length > 100 ? '...' : ''}`);
      }
      console.log();
    }
  } catch (err: any) {
    console.error(`❌ 获取收件箱失败: ${err.message}`);
  }
}

// ── skills 命令 ──

async function skills() {
  try {
    const res = await fetch(`${BASE_URL}/api/skills`);
    const list = await res.json() as any[];
    
    if (list.length === 0) {
      console.log('\n🏪 暂无技能\n');
      return;
    }

    console.log(`\n🏪 已安装技能 (${list.length} 个)\n`);
    for (const s of list) {
      const status = s.enabled ? '✅' : '⬜';
      console.log(`${status} ${s.name} - ${s.description}`);
    }
    console.log();
  } catch (err: any) {
    console.error(`❌ 获取技能列表失败: ${err.message}`);
  }
}

// ── approve 命令 ──

async function approve(id: string) {
  try {
    const res = await fetch(`${BASE_URL}/api/approval/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`✅ 已批准 ${id}`);
    } else {
      console.log(`❌ 批准失败: ${data.error || '未知错误'}`);
    }
  } catch (err: any) {
    console.error(`❌ 批准失败: ${err.message}`);
  }
}

// ── 命令处理 ──

function handleCommand(text: string, ws: WebSocket, rl: readline.Interface) {
  const parts = text.slice(1).split(' ');
  const cmd = parts[0];
  const rest = parts.slice(1).join(' ');

  switch (cmd) {
    case 'exit':
    case 'quit':
      ws.close();
      process.exit(0);
      break;
      
    case 'inbox':
      inbox();
      break;
      
    case 'skills':
      skills();
      break;
      
    case 'approve':
      if (parts[1]) approve(parts[1]);
      else console.log('用法: /approve <id>');
      rl.prompt();
      break;
      
    case 'help':
      console.log('\n命令:');
      console.log('  /inbox     查看收件箱');
      console.log('  /skills    技能列表');
      console.log('  /approve <id>  批准操作');
      console.log('  /exit      退出');
      console.log();
      rl.prompt();
      break;
      
    default:
      console.log(`未知命令: /${cmd}，输入 /help 查看帮助`);
      rl.prompt();
  }
}

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

// ── 入口 ──

switch (command) {
  case 'chat':
    chat();
    break;
  case 'inbox':
    inbox();
    break;
  case 'skills':
    skills();
    break;
  case 'approve':
    if (args[1]) approve(args[1]);
    else console.log('用法: lingxi approve <id>');
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log('\n🐿️ 灵犀引擎 CLI\n');
    console.log('用法:');
    console.log('  lingxi chat [--user <id>] [--chat <id>] [--model <name>]  聊天');
    console.log('  lingxi inbox                  查看收件箱');
    console.log('  lingxi skills                 技能列表');
    console.log('  lingxi approve <id>           批准操作');
    console.log('  lingxi help                    帮助\n');
    break;
  default:
    console.log(`未知命令: ${command}，输入 lingxi help 查看帮助`);
}