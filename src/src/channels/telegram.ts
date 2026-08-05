/**
 * Telegram Bot 渠道适配器
 * 
 * 灵犀引擎的第一个外部 IM 渠道
 * 功能：
 *   - 收到 Telegram 消息 → 转发到灵犀引擎 Router → AI 回复
 *   - 灵犀引擎消息 → 推送到 Telegram
 *   - 群聊 @提及触发
 *   - 支持文字/图片/文件
 */

import type { MessageRouter } from '../core/router.js';
import type { AgentManager } from '../agents/manager.js';

export interface TelegramConfig {
  botToken: string;
  webhookUrl?: string;        // Webhook 模式（生产环境）
  enabled: boolean;
  allowedChats?: string[];   // 允许的聊天 ID（空列表=全部允许）
  requireMention?: boolean;  // 群聊是否需要 @提及
  defaultUserId?: string;     // 默认映射到的用户 ID
  defaultChatId?: string;     // 默认映射到的聊天 ID
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; username?: string };
  chat: { id: number; type: 'private' | 'group' | 'supergroup' };
  text?: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  document?: { file_id: string; file_name?: string };
  reply_to_message?: any;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Telegram Bot 适配器
 * 使用长轮询 (Long Polling) 模式
 */
export class TelegramAdapter {
  private config: TelegramConfig;
  private router: MessageRouter;
  private agentManager: AgentManager;
  private db: any;
  private running = false;
  private lastUpdateId = 0;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;
  private botUsername: string | null = null; // 缓存 bot username，避免每条消息调 getMe

  // 外部消息推送回调
  private onOutbound?: (chatId: number, text: string) => void;

  constructor(
    config: TelegramConfig,
    router: MessageRouter,
    agentManager: AgentManager,
    db: any,
  ) {
    this.config = config;
    this.router = router;
    this.agentManager = agentManager;
    this.db = db;
  }

  /** 设置出站消息回调（用于测试） */
  setOnOutbound(handler: (chatId: number, text: string) => void): void {
    this.onOutbound = handler;
  }

  /** 启动长轮询 */
  async start(): Promise<boolean> {
    if (!this.config.botToken || !this.config.enabled) {
      console.log('[Telegram] 未配置或未启用');
      return false;
    }

    // 验证 Token
    const me = await this.apiCall('getMe');
    if (!me?.ok) {
      console.error('[Telegram] Token 验证失败:', me?.description || 'unknown');
      return false;
    }

    console.log(`[Telegram] ✅ Bot 已连接: @${me.result.username} (${me.result.first_name})`);
    this.running = true;
    this.poll();
    return true;
  }

  /** 停止轮询 */
  stop(): void {
    this.running = false;
    if (this.pollingTimer) clearTimeout(this.pollingTimer);
    console.log('[Telegram] 已停止');
  }

  /** 发送消息到 Telegram */
  async sendMessage(chatId: number, text: string): Promise<boolean> {
    const result = await this.apiCall('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });

    if (this.onOutbound) this.onOutbound(chatId, text);
    return result?.ok || false;
  }

  // ── 长轮询 ──

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const updates = await this.apiCall('getUpdates', {
        offset: this.lastUpdateId + 1,
        timeout: 30,  // 长轮询 30 秒
        allowed_updates: ['message'],
      });

      if (updates?.ok && Array.isArray(updates.result)) {
        for (const update of updates.result) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          if (update.message) {
            await this.handleUpdate(update);
          }
        }
      }
    } catch (err: any) {
      console.error('[Telegram] 轮询错误:', err.message);
    }

    // 继续轮询
    if (this.running) {
      this.pollingTimer = setTimeout(() => this.poll(), 1000);
    }
  }

  /** 处理收到的 Telegram 消息 */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const tgChatId = msg.chat.id;
    const tgUserId = msg.from?.id;
    const tgUsername = msg.from?.username || msg.from?.first_name || 'unknown';
    const text = msg.text;

    // 权限检查
    if (this.config.allowedChats && this.config.allowedChats.length > 0) {
      if (!this.config.allowedChats.includes(String(tgChatId))) {
        console.log(`[Telegram] 拒绝来自 ${tgChatId} 的消息`);
        return;
      }
    }

    // 群聊 @提及检查
    if (msg.chat.type !== 'private' && this.config.requireMention) {
      // 用缓存的 botUsername，避免每条消息调一次 getMe API
      const botUsername = this.botUsername;
      if (botUsername && !text.includes(`@${botUsername}`)) {
        return; // 群聊中没 @提及，忽略
      }
    }

    // 映射到灵犀引擎用户
    const userId = this.config.defaultUserId || 'user-shen';
    const chatId = this.config.defaultChatId || 'chat-tg-' + tgChatId;

    console.log(`[Telegram] ← ${tgUsername}(${tgUserId}): ${text.slice(0, 80)}`);

    // 转发到灵犀引擎 Router
    try {
      const result = await this.router.handleIncoming({
        chatId,
        senderType: 'user',
        senderId: userId,
        content: text,
      });

      // 广播用户消息（不回发 Telegram，避免回音）
      for (const resp of result.responses) {
        // 生成 AI 回复
        const reply = await this.router.generateReply(chatId, resp.agentId, resp.triggerMessage.id);
        
        // 发送回 Telegram
        const cleanReply = reply.replace(/^\[.*?\]:\s*/, ''); // 去掉 [agentId]: 前缀
        await this.sendMessage(tgChatId, cleanReply);
        console.log(`[Telegram] → ${resp.agentId}: ${cleanReply.slice(0, 80)}`);
      }
    } catch (err: any) {
      console.error('[Telegram] 处理消息失败:', err.message);
      await this.sendMessage(tgChatId, '❌ 处理失败: ' + err.message.slice(0, 100));
    }
  }

  // ── Telegram API 调用 ──

  private async apiCall(method: string, params: Record<string, any> = {}): Promise<any> {
    const url = `https://api.telegram.org/bot${this.config.botToken}/${method}`;
    try {
      const isGet = method === 'getMe' || method === 'getUpdates';
      if (isGet && Object.keys(params).length > 0) {
        const qs = new URLSearchParams(params as any).toString();
        const response = await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(35000) });
        return await response.json();
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(35000),
      });
      return await response.json();
    } catch (err: any) {
      console.error(`[Telegram] API ${method} 失败:`, err.message);
      return null;
    }
  }
}
