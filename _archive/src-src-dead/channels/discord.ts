/**
 * Discord 渠道适配器
 * Discord Bot，支持服务器频道和私聊
 */

import { MessageRouter } from '../core/router.js';
import { AgentManager } from '../agents/manager.js';
import { DB } from '../storage/db.js';

export interface DiscordConfig {
  botToken: string;
  prefix?: string;
  defaultUserId?: string;
  defaultChatId?: string;
  enabled: boolean;
}

interface DiscordGatewayPayload {
  op: number;
  t?: string;
  d?: any;
  s?: number;
}

export class DiscordAdapter {
  private config: DiscordConfig;
  private router: MessageRouter;
  private manager: AgentManager;
  private db: DB;
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private running = false;

  constructor(config: DiscordConfig, router: MessageRouter, manager: AgentManager, db: DB) {
    this.config = config;
    this.router = router;
    this.manager = manager;
    this.db = db;
  }

  async start(): Promise<boolean> {
    if (!this.config.botToken) {
      console.error('[Discord] 缺少 botToken');
      return false;
    }
    this.running = true;
    
    try {
      // 获取 Gateway URL
      const res = await fetch('https://discord.com/api/v10/gateway/bot', {
        headers: { 'Authorization': `Bot ${this.config.botToken}` },
      });
      if (!res.ok) {
        console.error('[Discord] 获取 Gateway 失败:', await res.text());
        return false;
      }
      const data = await res.json() as any;
      const gatewayUrl = data.url + '?v=10&encoding=json';
      
      this.ws = new WebSocket(gatewayUrl);
      this.ws.onopen = () => console.log('[Discord] Gateway 连接已建立');
      this.ws.onmessage = (event) => this.handleGatewayMessage(event.data);
      this.ws.onclose = () => {
        console.log('[Discord] Gateway 断开');
        if (this.running) setTimeout(() => this.start(), 5000);
      };
      this.ws.onerror = (err) => console.error('[Discord] Gateway 错误:', err);
      
      return true;
    } catch (err: any) {
      console.error('[Discord] 启动失败:', err.message);
      return false;
    }
  }

  private async handleGatewayMessage(data: string) {
    const payload: DiscordGatewayPayload = JSON.parse(data);
    
    switch (payload.op) {
      case 10: // Hello
        const interval = payload.d.heartbeat_interval;
        this.startHeartbeat(interval);
        await this.identify();
        break;
        
      case 0: // Dispatch
        this.lastSeq = payload.s ?? this.lastSeq;
        if (payload.t === 'READY') {
          this.sessionId = payload.d.session_id;
          console.log('[Discord] 已就绪: ' + payload.d.user.username);
        } else if (payload.t === 'MESSAGE_CREATE') {
          await this.handleMessage(payload.d);
        }
        break;
        
      case 11: // Heartbeat ACK
        break;
    }
  }

  private startHeartbeat(intervalMs: number) {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
      }
    }, intervalMs);
  }

  private async identify() {
    if (!this.ws) return;
    this.ws.send(JSON.stringify({
      op: 2,
      d: {
        token: this.config.botToken,
        intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
        properties: { os: 'linux', browser: 'lingxi', device: 'lingxi' },
      },
    }));
  }

  private async handleMessage(msg: any) {
    // 忽略自己的消息
    if (msg.author?.bot) return;
    
    const content = msg.content || '';
    if (!content) return;
    
    // 命令前缀检测
    const prefix = this.config.prefix || '!';
    if (!content.startsWith(prefix)) return;
    
    const text = content.slice(prefix.length).trim();
    const userId = this.config.defaultUserId || 'user-discord';
    const channelId = msg.channel_id;
    // 每个频道独立 chatId，避免不同频道消息混在一起
    const chatId = this.config.defaultChatId ? this.config.defaultChatId + '-' + channelId : 'chat-discord-' + channelId;
    
    console.log(`[Discord] 消息 from ${msg.author.username}: ${text}`);
    
    // 获取用户绑定的 Agent
    const agent = this.db.getAgentByUserId(userId);
    if (!agent) {
      await this.sendReply(channelId, '未绑定 AI 智能体');
      return;
    }
    
    // 路由消息
    try {
      const reply = await this.router.generateReply(chatId, agent.agent_id || agent.id, 'discord-' + msg.id);
      if (reply) {
        // Discord 消息限制 2000 字符
        const chunks = this.splitMessage(reply, 2000);
        for (const chunk of chunks) {
          await this.sendReply(channelId, chunk);
        }
      }
    } catch (err: any) {
      console.error('[Discord] 回复失败:', err.message);
    }
  }

  private async sendReply(channelId: string, content: string) {
    try {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.config.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      });
    } catch (err: any) {
      console.error('[Discord] 发送失败:', err.message);
    }
  }

  private splitMessage(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let current = '';
    for (const line of text.split('\n')) {
      if ((current + line + '\n').length > maxLen) {
        if (current) chunks.push(current.trim());
        current = line + '\n';
      } else {
        current += line + '\n';
      }
    }
    if (current) chunks.push(current.trim());
    return chunks;
  }

  stop() {
    this.running = false;
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log('[Discord] 已停止');
  }
}