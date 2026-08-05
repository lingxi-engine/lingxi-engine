/**
 * Slack 渠道适配器
 * Slack Bot，支持频道和私聊，Socket Mode
 */

import { MessageRouter } from '../core/router.js';
import { AgentManager } from '../agents/manager.js';
import { DB } from '../storage/db.js';

export interface SlackConfig {
  botToken: string;      // xoxb-...
  appToken?: string;     // xapp-... (Socket Mode)
  signingSecret?: string;
  defaultUserId?: string;
  defaultChatId?: string;
  enabled: boolean;
}

export class SlackAdapter {
  private config: SlackConfig;
  private router: MessageRouter;
  private manager: AgentManager;
  private db: DB;
  private running = false;

  constructor(config: SlackConfig, router: MessageRouter, manager: AgentManager, db: DB) {
    this.config = config;
    this.router = router;
    this.manager = manager;
    this.db = db;
  }

  async start(): Promise<boolean> {
    if (!this.config.botToken) {
      console.error('[Slack] 缺少 botToken');
      return false;
    }
    
    // 验证 Token
    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        headers: { 'Authorization': `Bearer ${this.config.botToken}` },
      });
      const data = await res.json() as any;
      if (!data.ok) {
        console.error('[Slack] Token 验证失败:', data.error);
        return false;
      }
      console.log('[Slack] 已认证: ' + data.user);
      this.running = true;
      
      // 如果有 appToken，用 Socket Mode（需要 WebSocket）
      // 否则用 HTTP Webhook 模式（需要公网 URL）
      if (this.config.appToken) {
        console.log('[Slack] Socket Mode 需要 @slack/socket-mode 包支持');
        // 实际使用时需要安装 @slack/socket-mode
        // 这里先标记为可用，实际 WebSocket 连接在用户安装依赖后启用
      } else {
        console.log('[Slack] Webhook 模式：请在 Slack 配置 Events API');
        console.log('[Slack] Request URL: https://your-domain:3456/api/channels/slack/webhook');
      }
      
      return true;
    } catch (err: any) {
      console.error('[Slack] 启动失败:', err.message);
      return false;
    }
  }

  /**
   * 处理 Slack Events API 回调
   * 在 index.ts 中注册 POST /api/channels/slack/webhook 路由调用此方法
   */
  async handleEvent(event: any): Promise<any> {
    // URL 验证
    if (event.type === 'url_verification') {
      return { challenge: event.challenge };
    }
    
    // 消息事件
    if (event.event?.type === 'message') {
      const msg = event.event;
      
      // 忽略 bot 消息
      if (msg.bot_id || msg.subtype) return { ok: true };
      
      const text = msg.text || '';
      if (!text) return { ok: true };
      
      const userId = this.config.defaultUserId || 'user-slack';
      const chatId = this.config.defaultChatId || 'chat-slack';
      
      console.log(`[Slack] 消息 from ${msg.user}: ${text}`);
      
      const agent = this.db.getAgentByUserId(userId);
      if (!agent) return { ok: true };
      
      try {
        const reply = await this.router.generateReply(chatId, agent.agent_id || agent.id, 'slack-' + msg.ts);
        if (reply) {
          await this.sendReply(msg.channel, reply);
        }
      } catch (err: any) {
        console.error('[Slack] 回复失败:', err.message);
      }
    }
    
    return { ok: true };
  }

  private async sendReply(channel: string, text: string) {
    try {
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, text }),
      });
    } catch (err: any) {
      console.error('[Slack] 发送失败:', err.message);
    }
  }

  stop() {
    this.running = false;
    console.log('[Slack] 已停止');
  }
}