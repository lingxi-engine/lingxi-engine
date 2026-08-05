/**
 * 微信渠道适配器
 * 支持微信公众号和企业微信两种模式
 */

import { MessageRouter } from '../core/router.js';
import { AgentManager } from '../agents/manager.js';
import { DB } from '../storage/db.js';
import { createHash } from 'crypto';

export interface WeChatConfig {
  mode: 'mp' | 'wecom';    // 公众号 or 企业微信
  appId: string;
  appSecret: string;
  token: string;            // 验证 Token
  encodingAESKey?: string;
  defaultUserId?: string;
  defaultChatId?: string;
  enabled: boolean;
}

export class WeChatAdapter {
  private config: WeChatConfig;
  private router: MessageRouter;
  private manager: AgentManager;
  private db: DB;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private running = false;

  constructor(config: WeChatConfig, router: MessageRouter, manager: AgentManager, db: DB) {
    this.config = config;
    this.router = router;
    this.manager = manager;
    this.db = db;
  }

  async start(): Promise<boolean> {
    if (!this.config.appId || !this.config.appSecret || !this.config.token) {
      console.error('[WeChat] 缺少 appId/appSecret/token');
      return false;
    }
    
    // 获取 access_token
    const ok = await this.refreshAccessToken();
    if (!ok) {
      console.error('[WeChat] 获取 access_token 失败');
      return false;
    }
    
    this.running = true;
    console.log(`[WeChat] ${this.config.mode === 'mp' ? '公众号' : '企业微信'} 已启动`);
    console.log('[WeChat] Webhook URL: https://your-domain:3456/api/channels/wechat/webhook');
    return true;
  }

  /**
   * 验证服务器地址（微信公众号接入验证）
   */
  verifySignature(signature: string, timestamp: string, nonce: string): boolean {
    const arr = [this.config.token, timestamp, nonce].sort();
    const sha1 = createHash('sha1').update(arr.join('')).digest('hex');
    return sha1 === signature;
  }

  /**
   * 处理微信消息回调
   */
  async handleMessage(body: any): Promise<string> {
    // 公众号消息
    if (this.config.mode === 'mp') {
      const msgType = body.MsgType;
      const fromUser = body.FromUserName;
      const content = body.Content || '';
      
      if (msgType === 'text' && content) {
        console.log(`[WeChat] 公众号消息 from ${fromUser}: ${content}`);
        
        const userId = this.config.defaultUserId || 'user-wechat';
        const chatId = this.config.defaultChatId || 'chat-wechat';
        
        const agent = this.db.getAgentByUserId(userId);
        if (!agent) return this.formatReply(fromUser, 'AI 智能体未配置');
        
        try {
          const reply = await this.router.generateReply(chatId, agent.agent_id || agent.id, 'wechat-' + body.MsgId);
          if (reply) return this.formatReply(fromUser, reply);
        } catch (err: any) {
          console.error('[WeChat] 回复失败:', err.message);
        }
      }
      
      return 'success';
    }
    
    // 企业微信消息
    if (this.config.mode === 'wecom') {
      const msgType = body.MsgType;
      const fromUser = body.FromUserName;
      const content = body.Content || body.text || '';
      
      if (msgType === 'text' && content) {
        console.log(`[WeChat] 企业微信消息 from ${fromUser}: ${content}`);
        
        const userId = this.config.defaultUserId || 'user-wechat';
        const chatId = this.config.defaultChatId || 'chat-wechat';
        
        const agent = this.db.getAgentByUserId(userId);
        if (!agent) return 'success';
        
        try {
          const reply = await this.router.generateReply(chatId, agent.agent_id || agent.id, 'wecom-' + body.MsgId);
          if (reply) await this.sendWecomReply(fromUser, reply);
        } catch (err: any) {
          console.error('[WeChat] 企业微信回复失败:', err.message);
        }
      }
      
      return 'success';
    }
    
    return 'success';
  }

  /**
   * 格式化公众号 XML 回复
   */
  private formatReply(toUser: string, content: string): string {
    const now = Math.floor(Date.now() / 1000);
    return `<xml>
<ToUserName><![CDATA[${toUser}]]></ToUserName>
<FromUserName><![CDATA[lingxi]]></FromUserName>
<CreateTime>${now}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
  }

  /**
   * 企业微信主动发消息
   */
  private async sendWecomReply(userId: string, content: string) {
    if (!this.accessToken) await this.refreshAccessToken();
    
    try {
      await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${this.accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          touser: userId,
          msgtype: 'text',
          agentid: parseInt(this.config.appId),
          text: { content },
        }),
      });
    } catch (err: any) {
      console.error('[WeChat] 企业微信发送失败:', err.message);
    }
  }

  /**
   * 刷新 access_token
   */
  private async refreshAccessToken(): Promise<boolean> {
    const url = this.config.mode === 'mp'
      ? `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${this.config.appId}&secret=${this.config.appSecret}`
      : `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.config.appId}&corpsecret=${this.config.appSecret}`;
    
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json() as any;
      if (data.errcode && data.errcode !== 0) {
        console.error('[WeChat] token 错误:', data.errmsg);
        return false;
      }
      this.accessToken = data.access_token;
      this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
      console.log('[WeChat] access_token 已刷新');
      return true;
    } catch (err: any) {
      console.error('[WeChat] 获取 token 失败:', err.message);
      return false;
    }
  }

  stop() {
    this.running = false;
    console.log('[WeChat] 已停止');
  }
}