/**
 * WhatsApp Business API 渠道适配器
 */

import { MessageRouter } from '../core/router.js';
import { AgentManager } from '../agents/manager.js';
import { DB } from '../storage/db.js';

export interface WhatsAppConfig {
  apiToken: string;
  phoneNumberId: string;
  verifyToken: string;
  defaultUserId?: string;
  defaultChatId?: string;
  enabled: boolean;
}

export class WhatsAppAdapter {
  private config: WhatsAppConfig;
  private router: MessageRouter;
  private manager: AgentManager;
  private db: DB;
  private running = false;

  constructor(config: WhatsAppConfig, router: MessageRouter, manager: AgentManager, db: DB) {
    this.config = config;
    this.router = router;
    this.manager = manager;
    this.db = db;
  }

  async start(): Promise<boolean> {
    if (!this.config.apiToken || !this.config.phoneNumberId) {
      console.error('[WhatsApp] 缺少 apiToken/phoneNumberId');
      return false;
    }
    this.running = true;
    console.log('[WhatsApp] 已启动');
    console.log('[WhatsApp] Webhook URL: https://your-domain:3456/api/channels/whatsapp/webhook');
    return true;
  }

  /**
   * 验证 webhook（GET 请求）
   */
  verifyWebhook(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === this.config.verifyToken) {
      return challenge;
    }
    return null;
  }

  /**
   * 处理 webhook 回调（POST 请求）
   */
  async handleEvent(body: any): Promise<any> {
    if (!body.entry) return { ok: true };
    
    for (const entry of body.entry) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;
        const messages = change.value?.messages || [];
        for (const msg of messages) {
          if (msg.type === 'text') {
            const text = msg.text?.body || '';
            const from = msg.from;
            
            if (!text) continue;
            console.log(`[WhatsApp] 消息 from ${from}: ${text}`);
            
            const userId = this.config.defaultUserId || 'user-whatsapp';
            const chatId = this.config.defaultChatId || 'chat-whatsapp';
            
            const agent = this.db.getAgentByUserId(userId);
            if (!agent) continue;
            
            try {
              const reply = await this.router.generateReply(chatId, agent.agent_id || agent.id, 'whatsapp-' + msg.id);
              if (reply && from) {
                await this.sendReply(from, reply);
              }
            } catch (err: any) {
              console.error('[WhatsApp] 回复失败:', err.message);
            }
          }
        }
      }
    }
    return { ok: true };
  }

  private async sendReply(to: string, text: string) {
    try {
      await fetch(`https://graph.facebook.com/v18.0/${this.config.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text.slice(0, 4096) },
        }),
      });
    } catch (err: any) {
      console.error('[WhatsApp] 发送失败:', err.message);
    }
  }

  stop() {
    this.running = false;
    console.log('[WhatsApp] 已停止');
  }
}