/**
 * 渠道路由 — 渠道管理、Webhook、渠道适配器启动
 * 批次13c: 4条管理路由补鉴权锁; telegram分支增加全局实例防重复启动检查
 */
import { Router } from 'express';
import type { ServerContext } from '../server/context.js';
import { jwtAuth } from '../middleware/jwt-auth.js';
import { TelegramAdapter } from '../channels/telegram.js';
import { DiscordAdapter } from '../channels/discord.js';
import { SlackAdapter } from '../channels/slack.js';
import { WeChatAdapter } from '../channels/wechat.js';
import { FeishuAdapter } from '../channels/feishu.js';
import { QQBotAdapter } from '../channels/qqbot.js';
import { WhatsAppAdapter } from '../channels/whatsapp.js';
import { SignalAdapter } from '../channels/signal.js';
import { IMessageAdapter } from '../channels/imessage.js';

export function createChannelRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { channelManager, router: msgRouter, manager, db, telegramAdapter } = ctx;
  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;

  router.get('/channels', requireAuth, (_req, res) => {
    try { res.json({ ok: true, definitions: channelManager.getDefinitions(), channels: channelManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/channels', requireAuth, (req, res) => {
    try { const { id, type, config } = req.body; if (!id || !type) return res.status(400).json({ error: 'id/type 必填' }); const channel = channelManager.configure(id, type, config || {}); res.json({ ok: true, channel }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/channels/:id/enable', requireAuth, async (req, res) => {
    try { channelManager.setEnabled(String(req.params.id), req.body.enabled ?? true); const ch = channelManager.get(String(req.params.id)); if (ch && ch.enabled) await startChannelAdapter(ch, ctx); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/channels/:id', requireAuth, (req, res) => {
    try { channelManager.remove(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Webhook 路由 ──
  router.post('/channels/slack/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find((c: any) => c.type === 'slack');
      if (!ch) return res.status(404).json({ error: 'Slack 渠道未配置' });
      const adapter = channelManager.getAdapter(ch.id) as SlackAdapter;
      if (!adapter) return res.status(500).json({ error: 'adapter not started' });
      if ((adapter as any).verifySignature) {
        const sig = req.headers['x-slack-signature'] as string;
        const ts = req.headers['x-slack-request-timestamp'] as string;
        const body = JSON.stringify(req.body);
        if (!(adapter as any).verifySignature(sig, ts, body)) return res.status(403).json({ error: '签名验证失败' });
      }
      const result = await adapter.handleEvent(req.body);
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/channels/wechat/webhook', (req, res) => {
    try {
      const ch = channelManager.list().find((c: any) => c.type === 'wechat');
      if (!ch) return res.status(404).send('Not configured');
      const adapter = channelManager.getAdapter(ch.id) as WeChatAdapter;
      if (!adapter) return res.status(500).send('Adapter not started');
      const { signature, timestamp, nonce, echostr } = req.query as any;
      if (adapter.verifySignature(signature, timestamp, nonce)) res.send(echostr);
      else res.status(403).send('Invalid signature');
    } catch (err: any) { res.status(500).send(err.message); }
  });

  router.post('/channels/wechat/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find((c: any) => c.type === 'wechat');
      if (!ch) return res.status(404).send('Not configured');
      const adapter = channelManager.getAdapter(ch.id) as WeChatAdapter;
      const result = adapter ? await adapter.handleMessage(req.body) : 'adapter not started';
      res.type('text/xml').send(result);
    } catch (err: any) { res.status(500).send(err.message); }
  });

  router.post('/channels/feishu/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find((c: any) => c.type === 'feishu');
      if (!ch) return res.status(404).json({ error: 'Feishu 渠道未配置' });
      const adapter = channelManager.getAdapter(ch.id) as FeishuAdapter;
      const result = adapter ? await adapter.handleEvent(req.body) : { ok: false, error: 'adapter not started' };
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/channels/qqbot/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find((c: any) => c.type === 'qqbot');
      if (!ch) return res.status(404).json({ error: 'QQBot 渠道未配置' });
      const adapter = channelManager.getAdapter(ch.id) as QQBotAdapter;
      const result = adapter ? await adapter.handleEvent(req.body) : { ok: false, error: 'adapter not started' };
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/channels/whatsapp/webhook', (req, res) => {
    const ch = channelManager.list().find((c: any) => c.type === 'whatsapp');
    if (!ch) return res.status(404).send('Not configured');
    const adapter = channelManager.getAdapter(ch.id) as WhatsAppAdapter;
    if (!adapter) return res.status(500).send('Adapter not started');
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query as any;
    const result = adapter.verifyWebhook(mode, token, challenge);
    if (result !== null) res.send(result);
    else res.status(403).send('Invalid token');
  });

  router.post('/channels/whatsapp/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find((c: any) => c.type === 'whatsapp');
      if (!ch) return res.status(404).json({ error: 'WhatsApp 渠道未配置' });
      const adapter = channelManager.getAdapter(ch.id) as WhatsAppAdapter;
      const result = adapter ? await adapter.handleEvent(req.body) : { ok: false };
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}

/**
 * 启动渠道适配器
 */
export async function startChannelAdapter(ch: any, ctx: ServerContext) {
  if (!ch.enabled) return;
  const { channelManager, router, manager, db } = ctx;
  try {
    switch (ch.type) {
      case 'telegram': {
        if (!channelManager.getAdapter(ch.id) && !ctx.telegramAdapter && ch.config.botToken) {
          const tg = new TelegramAdapter({ botToken: ch.config.botToken, enabled: true, requireMention: ch.config.requireMention !== false, defaultUserId: ch.config.defaultUserId || 'user-shen', defaultChatId: ch.config.defaultChatId || 'chat-telegram' }, router, manager, db);
          if (await tg.start()) channelManager.setAdapter(ch.id, tg);
        }
        break;
      }
      case 'discord': {
        if (!channelManager.getAdapter(ch.id) && ch.config.botToken) {
          const dc = new DiscordAdapter({ botToken: ch.config.botToken, prefix: ch.config.prefix || '!', enabled: true, defaultUserId: ch.config.defaultUserId || 'user-discord', defaultChatId: ch.config.defaultChatId || 'chat-discord' }, router, manager, db);
          if (await dc.start()) channelManager.setAdapter(ch.id, dc);
        }
        break;
      }
      case 'slack': {
        if (!channelManager.getAdapter(ch.id) && ch.config.botToken) {
          const sk = new SlackAdapter({ botToken: ch.config.botToken, appToken: ch.config.appToken, signingSecret: ch.config.signingSecret, enabled: true, defaultUserId: ch.config.defaultUserId || 'user-slack', defaultChatId: ch.config.defaultChatId || 'chat-slack' }, router, manager, db);
          if (await sk.start()) channelManager.setAdapter(ch.id, sk);
        }
        break;
      }
      case 'wechat': {
        if (!channelManager.getAdapter(ch.id) && ch.config.appId) {
          const wx = new WeChatAdapter({ mode: ch.config.mode || 'mp', appId: ch.config.appId, appSecret: ch.config.appSecret, token: ch.config.token, encodingAESKey: ch.config.encodingAESKey, enabled: true, defaultUserId: ch.config.defaultUserId || 'user-wechat', defaultChatId: ch.config.defaultChatId || 'chat-wechat' }, router, manager, db);
          if (await wx.start()) channelManager.setAdapter(ch.id, wx);
        }
        break;
      }
      case 'feishu': {
        if (!channelManager.getAdapter(ch.id) && ch.config.appId) {
          const fs = new FeishuAdapter({ appId: ch.config.appId, appSecret: ch.config.appSecret, verificationToken: ch.config.verificationToken, encryptKey: ch.config.encryptKey, enabled: true, defaultUserId: ch.config.defaultUserId || 'user-feishu', defaultChatId: ch.config.defaultChatId || 'chat-feishu' }, router, manager, db);
          if (await fs.start()) channelManager.setAdapter(ch.id, fs);
        }
        break;
      }
      case 'qqbot': {
        if (!channelManager.getAdapter(ch.id) && ch.config.appId) {
          const qq = new QQBotAdapter({ appId: ch.config.appId, appSecret: ch.config.appSecret, enabled: true, defaultUserId: ch.config.defaultUserId || 'user-qqbot', defaultChatId: ch.config.defaultChatId || 'chat-qqbot' }, router, manager, db);
          if (await qq.start()) channelManager.setAdapter(ch.id, qq);
        }
        break;
      }
      case 'whatsapp': {
        if (!channelManager.getAdapter(ch.id) && ch.config.apiToken) {
          const wa = new WhatsAppAdapter({ apiToken: ch.config.apiToken, phoneNumberId: ch.config.phoneNumberId, verifyToken: ch.config.verifyToken, enabled: true, defaultUserId: ch.config.defaultUserId || 'user-whatsapp', defaultChatId: ch.config.defaultChatId || 'chat-whatsapp' }, router, manager, db);
          if (await wa.start()) channelManager.setAdapter(ch.id, wa);
        }
        break;
      }
      case 'signal': {
        if (!channelManager.getAdapter(ch.id) && ch.config.phoneNumber) {
          const sg = new SignalAdapter({ phoneNumber: ch.config.phoneNumber, signalCliPath: ch.config.signalCliPath, enabled: true, defaultUserId: ch.config.defaultUserId || 'user-signal', defaultChatId: ch.config.defaultChatId || 'chat-signal' }, router, manager, db);
          if (await sg.start()) channelManager.setAdapter(ch.id, sg);
        }
        break;
      }
      case 'imessage': {
        if (!channelManager.getAdapter(ch.id) && ch.config.appleScript) {
          const im = new IMessageAdapter({ appleScript: ch.config.appleScript, enabled: true, defaultUserId: ch.config.defaultUserId || 'user-imessage', defaultChatId: ch.config.defaultChatId || 'chat-imessage' }, router, manager, db);
          if (await im.start()) channelManager.setAdapter(ch.id, im);
        }
        break;
      }
    }
  } catch (err: any) {
    console.error(`[Channels] 启动 ${ch.type} 失败:`, err.message);
  }
}