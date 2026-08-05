/**
 * 渠道管理器 - Channel Manager
 * 统一管理所有消息渠道，用户自主配置启用
 * 
 * 支持渠道：Telegram, 微信, 飞书, Discord, Slack, WhatsApp, Signal, iMessage, QQ
 */

import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * 渠道管理器 - Channel Manager
 * 统一管理所有消息渠道，用户自主配置启用
 * 
 * 支持渠道：Telegram, 微信, 飞书, Discord, Slack, WhatsApp, Signal, iMessage, QQ
 * 每个渠道可独立启用/禁用，用户在设置页填入 Token 即可启用
 */

export interface ChannelConfig {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  config: Record<string, any>;
  connected: boolean;
}

export type ChannelType = 
  | 'telegram' 
  | 'wechat' 
  | 'feishu' 
  | 'discord' 
  | 'slack' 
  | 'whatsapp' 
  | 'signal' 
  | 'imessage' 
  | 'qqbot';

export interface ChannelDefinition {
  type: ChannelType;
  name: string;
  icon: string;
  description: string;
  requiredConfig: ChannelConfigField[];
  optional?: boolean;
}

export interface ChannelConfigField {
  key: string;
  label: string;
  type: 'string' | 'password' | 'boolean' | 'select';
  placeholder?: string;
  default?: string;
  options?: { value: string; label: string }[];
  required: boolean;
  help?: string;
}

// ── 渠道定义（所有支持的渠道）──

export const CHANNEL_DEFINITIONS: ChannelDefinition[] = [
  {
    type: 'telegram',
    name: 'Telegram',
    icon: '✈️',
    description: 'Telegram Bot，长轮询模式，支持 @提及',
    requiredConfig: [
      { key: 'botToken', label: 'Bot Token', type: 'password', placeholder: '123456:ABC-DEF...', required: true, help: '从 @BotFather 获取' },
      { key: 'requireMention', label: '需要 @提及才回复', type: 'boolean', default: 'true', required: false },
      { key: 'defaultUserId', label: '默认用户ID', type: 'string', placeholder: 'user-shen', required: false },
      { key: 'defaultChatId', label: '默认聊天ID', type: 'string', placeholder: 'chat-telegram', required: false },
    ],
  },
  {
    type: 'wechat',
    name: '微信',
    icon: '💬',
    description: '微信公众号 / 企业微信机器人',
    requiredConfig: [
      { key: 'mode', label: '模式', type: 'select', required: true, options: [
        { value: 'mp', label: '公众号' },
        { value: 'wecom', label: '企业微信' },
      ], default: 'mp' },
      { key: 'appId', label: 'AppID', type: 'string', placeholder: 'wx...', required: true, help: '公众号/企业微信的 AppID' },
      { key: 'appSecret', label: 'AppSecret', type: 'password', required: true },
      { key: 'token', label: 'Token', type: 'string', placeholder: '验证 Token', required: true },
      { key: 'encodingAESKey', label: 'EncodingAESKey', type: 'string', required: false, help: '消息加解密密钥（可选）' },
      { key: 'defaultUserId', label: '默认用户ID', type: 'string', placeholder: 'user-shen', required: false },
    ],
  },
  {
    type: 'feishu',
    name: '飞书',
    icon: '📧',
    description: '飞书机器人，支持群聊和私聊',
    requiredConfig: [
      { key: 'appId', label: 'App ID', type: 'string', required: true, help: '飞书开放平台应用 App ID' },
      { key: 'appSecret', label: 'App Secret', type: 'password', required: true },
      { key: 'verificationToken', label: 'Verification Token', type: 'string', required: true, help: '事件订阅验证 Token' },
      { key: 'encryptKey', label: 'Encrypt Key', type: 'string', required: false, help: '事件加密密钥（可选）' },
      { key: 'defaultUserId', label: '默认用户ID', type: 'string', placeholder: 'user-shen', required: false },
    ],
  },
  {
    type: 'discord',
    name: 'Discord',
    icon: '🎯',
    description: 'Discord Bot，支持服务器和频道',
    requiredConfig: [
      { key: 'botToken', label: 'Bot Token', type: 'password', required: true, help: '从 Discord Developer Portal 获取' },
      { key: 'prefix', label: '命令前缀', type: 'string', default: '!', required: false },
      { key: 'defaultUserId', label: '默认用户ID', type: 'string', placeholder: 'user-shen', required: false },
    ],
  },
  {
    type: 'slack',
    name: 'Slack',
    icon: '💼',
    description: 'Slack Bot，支持频道和私聊',
    requiredConfig: [
      { key: 'botToken', label: 'Bot Token (xoxb-)', type: 'password', required: true },
      { key: 'appToken', label: 'App Token (xapp-)', type: 'password', required: false, help: 'Socket Mode 需要' },
      { key: 'signingSecret', label: 'Signing Secret', type: 'password', required: false },
      { key: 'defaultUserId', label: '默认用户ID', type: 'string', placeholder: 'user-shen', required: false },
    ],
  },
  {
    type: 'whatsapp',
    name: 'WhatsApp',
    icon: '📱',
    description: 'WhatsApp Business API',
    requiredConfig: [
      { key: 'apiToken', label: 'API Token', type: 'password', required: true, help: 'WhatsApp Business API Token' },
      { key: 'phoneNumberId', label: 'Phone Number ID', type: 'string', required: true },
      { key: 'verifyToken', label: 'Webhook Verify Token', type: 'string', required: true },
      { key: 'defaultUserId', label: '默认用户ID', type: 'string', placeholder: 'user-shen', required: false },
    ],
  },
  {
    type: 'signal',
    name: 'Signal',
    icon: '📡',
    description: 'Signal Bot（需 signal-cli）',
    requiredConfig: [
      { key: 'phoneNumber', label: '手机号', type: 'string', placeholder: '+86...', required: true },
      { key: 'signalCliPath', label: 'signal-cli 路径', type: 'string', placeholder: '/usr/local/bin/signal-cli', required: false },
      { key: 'defaultUserId', label: '默认用户ID', type: 'string', placeholder: 'user-shen', required: false },
    ],
  },
  {
    type: 'imessage',
    name: 'iMessage',
    icon: '💌',
    description: 'iMessage Bot（仅 macOS）',
    optional: true,
    requiredConfig: [
      { key: 'appleScript', label: 'AppleScript 路径', type: 'string', placeholder: '/path/to/send.scpt', required: true },
      { key: 'defaultUserId', label: '默认用户ID', type: 'string', placeholder: 'user-shen', required: false },
    ],
  },
  {
    type: 'qqbot',
    name: 'QQ 机器人',
    icon: '🐧',
    description: 'QQ 机器人（官方 Bot API）',
    requiredConfig: [
      { key: 'appId', label: 'App ID', type: 'string', required: true, help: 'QQ 开放平台 Bot AppID' },
      { key: 'appSecret', label: 'App Secret', type: 'password', required: true },
      { key: 'defaultUserId', label: '默认用户ID', type: 'string', placeholder: 'user-shen', required: false },
    ],
  },
];

// ── 渠道管理器 ──

export class ChannelManager {
  private channels: Map<string, ChannelConfig> = new Map();
  private adapters: Map<string, any> = new Map();
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * 获取所有渠道定义（前端渲染表单用）
   */
  getDefinitions(): ChannelDefinition[] {
    return CHANNEL_DEFINITIONS;
  }

  /**
   * 列出所有已配置的渠道
   */
  list(): ChannelConfig[] {
    return Array.from(this.channels.values());
  }

  /**
   * 获取渠道配置
   */
  get(id: string): ChannelConfig | undefined {
    return this.channels.get(id);
  }

  /**
   * 配置渠道（用户填写 Token 后调用）
   */
  configure(id: string, type: ChannelType, config: Record<string, any>): ChannelConfig {
    const def = CHANNEL_DEFINITIONS.find(d => d.type === type);
    if (!def) throw new Error(`未知渠道类型: ${type}`);

    const channel: ChannelConfig = {
      id,
      type,
      name: def.name,
      enabled: config.enabled ?? true,
      config,
      connected: false,
    };
    this.channels.set(id, channel);
    this.save();
    return channel;
  }

  /**
   * 启用/禁用渠道
   */
  setEnabled(id: string, enabled: boolean) {
    const ch = this.channels.get(id);
    if (!ch) throw new Error(`渠道不存在: ${id}`);
    ch.enabled = enabled;
    this.save();
  }

  /**
   * 删除渠道
   */
  remove(id: string) {
    this.channels.delete(id);
    this.adapters.delete(id);
    this.save();
  }

  /**
   * 注册运行中的适配器实例
   */
  setAdapter(id: string, adapter: any) {
    this.adapters.set(id, adapter);
    const ch = this.channels.get(id);
    if (ch) ch.connected = true;
  }

  /**
   * 获取适配器
   */
  getAdapter(id: string): any {
    return this.adapters.get(id);
  }

  /**
   * 保存到 data/channels.json
   */
  private save() {
    const data = Array.from(this.channels.values());
    const file = join(this.dataDir, 'channels.json');
    try {
      writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error('[Channels] 保存失败:', err.message);
    }
  }

  /**
   * 从 data/channels.json 加载
   */
  load(): ChannelConfig[] {
    const file = join(this.dataDir, 'channels.json');
    try {
      if (!existsSync(file)) return [];
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      for (const ch of data) {
        this.channels.set(ch.id, { ...ch, connected: false });
      }
      return this.list();
    } catch (err: any) {
      console.error('[Channels] 加载失败:', err.message);
      return [];
    }
  }

  /**
   * 获取所有启用的渠道
   */
  getEnabledChannels(): ChannelConfig[] {
    return this.list().filter(c => c.enabled);
  }

  /**
   * 关闭所有适配器
   */
  async closeAll() {
    for (const [id, adapter] of this.adapters) {
      try {
        if (adapter.stop) await adapter.stop();
      } catch (err: any) {
        console.error(`[Channels] 关闭 ${id} 失败:`, err.message);
      }
    }
    this.adapters.clear();
  }
}