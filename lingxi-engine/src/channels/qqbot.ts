/**
 * QQ 机器人渠道适配器
 * 基于 QQ 开放平台 Bot API
 */

import { MessageRouter } from '../core/router.js';
import { AgentManager } from '../agents/manager.js';
import { DB } from '../storage/db.js';

export interface QQBotConfig {
  appId: string;
  appSecret: string;
  defaultUserId?: string;
  defaultChatId?: string;
  enabled: boolean;
}

export class QQBotAdapter {
  private config: QQBotConfig;
  private router: MessageRouter;
  private manager: AgentManager;
  private db: DB;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private ws: WebSocket | null = null;
  private running = false;

  constructor(config: QQBotConfig, router: MessageRouter, manager: AgentManager, db: DB) {
    this.config = config;
    this.router = router;
    this.manager = manager;
    this.db = db;
  }

  async start(): Promise<boolean> {
    if (!this.config.appId || !this.config.appSecret) {
      console.error('[QQBot] 缺少 appId/appSecret');
      return false;
    }
    
    const ok = await this.refreshToken();
    if (!ok) {
      console.error('[QQBot] 获取 access_token 失败');
      return false;
    }
    
    this.running = true;
    console.log('[QQBot] 已启动');
    console.log('[QQBot] Webhook URL: https://your-domain:3456/api/channels/qqbot/webhook');
    return true;
  }

  /**
   * 处理 QQ 事件回调
   */
  async handleEvent(body: any): Promise<any> {
    // 验证事件
    if (body.type === 'url_verification') {
      return { challenge: body.challenge };
    }
    
    // 群消息事件
    if (body.eventType === 'GROUP_AT_MESSAGE_CREATE' || body.eventType === 'GROUP_MESSAGE_CREATE') {
      const content = body.content || '';
      const groupId = body.groupOpenId;
      const msgId = body.msgId;
      
      // 去掉 @ 机器人部分
      const text = content.replace(/<@!\d+>/g, '').trim();
      if (!text) return { ok: true };
      
      console.log(`[QQBot] 群消息: ${text}`);
      
      const userId = this.config.defaultUserId || 'user-qqbot';
      const chatId = this.config.defaultChatId || 'chat-qqbot';
      
      const agent = this.db.getAgentByUserId(userId);
      if (!agent) return { ok: true };
      
      try {
        const reply = await this.router.generateReply(chatId, agent.agent_id || agent.id, 'qqbot-' + msgId);
        if (reply && groupId) {
          await this.sendGroupReply(groupId, reply, msgId);
        }
      } catch (err: any) {
        console.error('[QQBot] 回复失败:', err.message);
      }
    }
    
    // 私聊消息
    if (body.eventType === 'C2C_MESSAGE_CREATE') {
      const content = body.content || '';
      const openId = body.authorOpenId || body.userOpenId;
      const msgId = body.msgId;
      
      if (!content) return { ok: true };
      
      console.log(`[QQBot] 私聊: ${content}`);
      
      const userId = this.config.defaultUserId || 'user-qqbot';
      const chatId = this.config.defaultChatId || 'chat-qqbot';
      
      const agent = this.db.getAgentByUserId(userId);
      if (!agent) return { ok: true };
      
      try {
        const reply = await this.router.generateReply(chatId, agent.agent_id || agent.id, 'qqbot-' + msgId);
        if (reply && openId) {
          await this.sendPrivateReply(openId, reply, msgId);
        }
      } catch (err: any) {
        console.error('[QQBot] 回复失败:', err.message);
      }
    }
    
    return { ok: true };
  }

  /**
   * 发送群消息
   */
  private async sendGroupReply(groupOpenId: string, content: string, msgId: string) {
    if (!this.accessToken || Date.now() > this.tokenExpiry) {
      await this.refreshToken();
    }
    
    try {
      await fetch(`https://api.sgroup.qq.com/v2/groups/${groupOpenId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `QQBot ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: content.slice(0, 2000),
          msg_type: 0,
          msg_id: msgId,
        }),
      });
    } catch (err: any) {
      console.error('[QQBot] 群消息发送失败:', err.message);
    }
  }

  /**
   * 发送私聊消息
   */
  private async sendPrivateReply(openId: string, content: string, msgId: string) {
    if (!this.accessToken || Date.now() > this.tokenExpiry) {
      await this.refreshToken();
    }
    
    try {
      await fetch(`https://api.sgroup.qq.com/v2/users/${openId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `QQBot ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          content: content.slice(0, 2000),
          msg_type: 0,
          msg_id: msgId,
        }),
      });
    } catch (err: any) {
      console.error('[QQBot] 私聊发送失败:', err.message);
    }
  }

  /**
   * 刷新 access_token
   */
  private async refreshToken(): Promise<boolean> {
    try {
      const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: this.config.appId,
          clientSecret: this.config.appSecret,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json() as any;
      if (!data.access_token) {
        console.error('[QQBot] token 错误:', data.message || data.error);
        return false;
      }
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      console.log('[QQBot] access_token 已刷新');
      return true;
    } catch (err: any) {
      console.error('[QQBot] 获取 token 失败:', err.message);
      return false;
    }
  }

  stop() {
    this.running = false;
    if (this.ws) this.ws.close();
    console.log('[QQBot] 已停止');
  }
}