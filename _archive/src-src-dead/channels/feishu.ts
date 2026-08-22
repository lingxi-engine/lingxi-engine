/**
 * 飞书渠道适配器
 * 飞书机器人，支持群聊和私聊
 */

import { MessageRouter } from '../core/router.js';
import { AgentManager } from '../agents/manager.js';
import { DB } from '../storage/db.js';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
  defaultUserId?: string;
  defaultChatId?: string;
  enabled: boolean;
}

export class FeishuAdapter {
  private config: FeishuConfig;
  private router: MessageRouter;
  private manager: AgentManager;
  private db: DB;
  private tenantAccessToken: string | null = null;
  private tokenExpiry: number = 0;
  private running = false;

  constructor(config: FeishuConfig, router: MessageRouter, manager: AgentManager, db: DB) {
    this.config = config;
    this.router = router;
    this.manager = manager;
    this.db = db;
  }

  async start(): Promise<boolean> {
    if (!this.config.appId || !this.config.appSecret || !this.config.verificationToken) {
      console.error('[Feishu] 缺少 appId/appSecret/verificationToken');
      return false;
    }
    
    const ok = await this.refreshToken();
    if (!ok) {
      console.error('[Feishu] 获取 tenant_access_token 失败');
      return false;
    }
    
    this.running = true;
    console.log('[Feishu] 已启动');
    console.log('[Feishu] Webhook URL: https://your-domain:3456/api/channels/feishu/webhook');
    return true;
  }

  /**
   * 处理飞书事件回调
   */
  async handleEvent(body: any): Promise<any> {
    // URL 验证
    if (body.type === 'url_verification') {
      return { challenge: body.challenge };
    }
    
    // 验证 token
    if (body.header?.token && body.header.token !== this.config.verificationToken) {
      console.error('[Feishu] token 验证失败');
      return { error: 'invalid token' };
    }
    
    // 消息事件
    const event = body.event;
    if (!event) return { ok: true };
    
    const msgType = event.message?.message_type;
    const chatId = event.message?.chat_id;
    const senderId = event.sender?.sender_id?.open_id;
    
    if (msgType === 'text') {
      const content = JSON.parse(event.message?.content || '{}').text || '';
      if (!content) return { ok: true };
      
      console.log(`[Feishu] 消息 from ${senderId}: ${content}`);
      
      const userId = this.config.defaultUserId || 'user-feishu';
      const sessionChatId = this.config.defaultChatId || 'chat-feishu';
      
      const agent = this.db.getAgentByUserId(userId);
      if (!agent) return { ok: true };
      
      try {
        const reply = await this.router.generateReply(sessionChatId, agent.agent_id || agent.id, 'feishu-' + event.message?.message_id);
        if (reply && chatId) {
          await this.sendReply(chatId, reply, event.message?.message_id);
        }
      } catch (err: any) {
        console.error('[Feishu] 回复失败:', err.message);
      }
    }
    
    return { ok: true };
  }

  /**
   * 发送消息到飞书
   */
  private async sendReply(chatId: string, text: string, replyToMsgId?: string) {
    if (!this.tenantAccessToken || Date.now() > this.tokenExpiry) {
      await this.refreshToken();
    }
    
    try {
      const body: any = {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      };
      if (replyToMsgId) body.reply_in_thread = false;
      
      await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.tenantAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      console.error('[Feishu] 发送失败:', err.message);
    }
  }

  /**
   * 刷新 tenant_access_token
   */
  private async refreshToken(): Promise<boolean> {
    try {
      const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json() as any;
      if (data.code !== 0) {
        console.error('[Feishu] token 错误:', data.msg);
        return false;
      }
      this.tenantAccessToken = data.tenant_access_token;
      this.tokenExpiry = Date.now() + (data.expire - 300) * 1000;
      console.log('[Feishu] tenant_access_token 已刷新');
      return true;
    } catch (err: any) {
      console.error('[Feishu] 获取 token 失败:', err.message);
      return false;
    }
  }

  stop() {
    this.running = false;
    console.log('[Feishu] 已停止');
  }
}