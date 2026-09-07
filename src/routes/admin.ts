/**
 * 管理路由 — Cron、会话、子代理、收件箱、审批、Hook、技能、开发面板、日志、语音、视觉、推送
 */
import { Router } from 'express';
import { getDB, deleteUser } from '../storage/db.js';
import { createCronJob } from '../core/cron-scheduler.js';
import { INFERENCE_BACKENDS } from '../ai/custom-providers.js';
import { UsageTracker } from '../core/usage-tracker.js';
import { logger } from '../core/logger.js';
import type { ServerContext } from '../server/context.js';

export function createAdminRoutes(ctx: ServerContext): Router {
  const router = Router();
  const {
    cronScheduler, sessionManager, subAgentManager,
    approvalManager, hookManager, inboxManager,
    skillManager, debugPanel, ttsManager, sttManager,
    visionManager, pushManager, customProviderManager,
    telegramAdapter, toolRegistry, mcpManager, pluginManager,
    browserManager,
  } = ctx;

  // ── Cron 定时任务 ──
  router.get('/cron', (_req, res) => {
    try { res.json({ ok: true, jobs: cronScheduler.listJobs() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/cron', (req, res) => {
    try {
      const { name, schedule, payload, enabled } = req.body;
      if (!name || !schedule || !payload) return res.status(400).json({ error: 'name/schedule/payload 必填' });
      const job = createCronJob({ name, schedule, payload, enabled: enabled ?? true });
      cronScheduler.addJob(job);
      res.json({ ok: true, job });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  router.delete('/cron/:id', (req, res) => {
    try { const ok = cronScheduler.removeJob(req.params.id); res.json({ ok }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/cron/:id/run', async (req, res) => {
    try { const ok = await cronScheduler.runNow(req.params.id); res.json({ ok }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.patch('/cron/:id', (req, res) => {
    try { const { enabled } = req.body; if (enabled !== undefined) cronScheduler.setEnabled(req.params.id, enabled); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Standing Orders ──
  router.post('/standing-orders', (req, res) => {
    try {
      const { name, cron, prompt, chatId, timezone } = req.body || {};
      if (!name || !cron || !prompt) return res.status(400).json({ error: 'name/cron/prompt 必填' });
      const jobId = 'so-' + Date.now().toString(36);
      cronScheduler.addJob({ id: jobId, name: 'SO: ' + name, enabled: true, schedule: { kind: 'cron', expr: cron, tz: timezone || 'Asia/Shanghai' }, payload: { kind: 'standingOrder', prompt, chatId: chatId || '', text: prompt }, runCount: 0, createdAt: Date.now() });
      res.json({ ok: true, id: jobId });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/standing-orders', (_req, res) => {
    try { const jobs = cronScheduler.listJobs().filter((j: any) => j.id?.startsWith('so-')); res.json({ ok: true, jobs }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/standing-orders/:id', (req, res) => {
    try { cronScheduler.removeJob(req.params.id); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 会话管理 ──
  router.get('/sessions', (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      const sessions = userId ? sessionManager.listByUser(userId) : sessionManager.listAll();
      res.json({ ok: true, sessions, activeId: sessionManager.getActive()?.id || null });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/sessions', (req, res) => {
    try {
      const { id, label, chatId, userId, agentIds } = req.body;
      if (!id || !chatId || !userId) return res.status(400).json({ error: 'id/chatId/userId 必填' });
      const session = sessionManager.create({ id, label: label || id, chatId, userId, agentIds: agentIds || [] });
      res.json({ ok: true, session });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  router.patch('/sessions/:id', (req, res) => {
    try { const session = sessionManager.update(req.params.id, req.body); if (!session) return res.status(404).json({ error: '会话不存在' }); res.json({ ok: true, session }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/sessions/:id', (req, res) => {
    try { const ok = sessionManager.delete(req.params.id); res.json({ ok }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/sessions/:id/activate', (req, res) => {
    try { sessionManager.setActive(req.params.id); res.json({ ok: true, activeId: req.params.id }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 子代理 ──
  router.get('/subagents', (req, res) => {
    try { const parentId = (req.query.parentId as string) || ''; res.json({ ok: true, tasks: subAgentManager.list(parentId || undefined) }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/subagents/spawn', async (req, res) => {
    try {
      const { objective, parentId, chatId, model, timeoutSeconds } = req.body;
      if (!objective || !parentId) return res.status(400).json({ error: 'objective/parentId 必填' });
      const taskId = await subAgentManager.spawn({ objective, parentId, chatId: chatId || 'chat-default', model, timeoutSeconds });
      res.json({ ok: true, taskId });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  router.post('/subagents/:id/steer', (req, res) => {
    try { const ok = subAgentManager.steer(req.params.id, req.body.message); res.json({ ok }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/subagents/:id', (req, res) => {
    try { const ok = subAgentManager.kill(req.params.id); res.json({ ok }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Telegram 状态 ──
  router.get('/telegram/status', (_req, res) => {
    try { res.json({ ok: true, connected: !!telegramAdapter, token: process.env.TELEGRAM_BOT_TOKEN ? '***configured' : 'not set' }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 收件箱 ──
  router.get('/inbox', (req, res) => {
    try { const unreadOnly = req.query.unread === 'true'; const limit = parseInt(req.query.limit as string) || 50; res.json({ ok: true, items: inboxManager.list(limit, unreadOnly), unread: inboxManager.unreadCount() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/inbox/:id', (req, res) => {
    try { const item = inboxManager.get(req.params.id); if (!item) return res.status(404).json({ error: '不存在' }); const fullContent = inboxManager.getFullContent(req.params.id); res.json({ ok: true, item, fullContent }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/inbox/:id/read', (req, res) => {
    try { inboxManager.markRead(req.params.id); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/inbox/:id', (req, res) => {
    try { inboxManager.delete(req.params.id); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 审批 ──
  router.get('/approval/pending', (_req, res) => {
    try { res.json({ ok: true, pending: approvalManager.getPending() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/approval/:id', (req, res) => {
    try { const { action, by } = req.body; if (action === 'approve') approvalManager.approve(req.params.id, by); else if (action === 'reject') approvalManager.reject(req.params.id, by, req.body.reason); else return res.status(400).json({ error: 'action 只能是 approve 或 reject' }); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/approval/history', (req, res) => {
    try { const limit = parseInt(req.query.limit as string) || 50; res.json({ ok: true, history: approvalManager.getHistory(limit) }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Hook ──
  router.get('/hooks', (_req, res) => {
    try { res.json({ ok: true, hooks: hookManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/hooks', (req, res) => {
    try { const { event, name, action, priority, filter } = req.body; if (!event || !name || !action) return res.status(400).json({ error: 'event/name/action 必填' }); const hook = hookManager.register(event, name, action, priority || 0, filter); res.json({ ok: true, hook }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/hooks/:id', (req, res) => {
    try { hookManager.remove(req.params.id); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/hooks/:id/enable', (req, res) => {
    try { hookManager.setEnabled(req.params.id, req.body.enabled ?? true); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 技能 ──
  router.get('/skills', (_req, res) => {
    try { res.json({ ok: true, skills: skillManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/skills/scan', (_req, res) => {
    try { res.json({ ok: true, skills: skillManager.scanLocal() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/skills/:id/enable', (req, res) => {
    try { skillManager.setEnabled(req.params.id, true); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/skills/:id/disable', (req, res) => {
    try { skillManager.setEnabled(req.params.id, false); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/skills/:id', (req, res) => {
    try { skillManager.uninstall(req.params.id); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/skills/create', (req, res) => {
    try { const { id, name, description, content } = req.body; if (!id || !name || !content) return res.status(400).json({ error: 'id/name/content 必填' }); skillManager.createSkill(id, name, description || '', content); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/skills/market', async (_req, res) => {
    try { const items = await skillManager.browseMarket(); res.json({ ok: true, items }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/skills/install', async (req, res) => {
    try { const { name } = req.body; if (!name) return res.status(400).json({ error: 'name 必填' }); const ok = await skillManager.installFromMarket(name); res.json({ ok }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── MCP ──
  router.get('/mcp/servers', (_req, res) => {
    try { res.json({ ok: true, servers: mcpManager.listServers(), tools: mcpManager.getAllToolDefinitions() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/mcp/servers', async (req, res) => {
    try {
      const config = req.body;
      const client = await mcpManager.addServer(config);
      for (const tool of client.getTools()) {
        const bridgedDef: any = { name: tool.name, description: tool.description, parameters: tool.inputSchema };
        try { toolRegistry.registerTool(bridgedDef, (args: any) => mcpManager.callTool(tool.name, args)); } catch { /* skip */ }
      }
      res.json({ ok: true, serverId: config.id, toolCount: client.getTools().length });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/mcp/servers/:id', async (req, res) => {
    try { await mcpManager.removeServer(req.params.id); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 插件 ──
  router.get('/plugins', (_req, res) => {
    try { res.json({ ok: true, plugins: pluginManager.listPlugins() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/plugins/:id/enable', (req, res) => {
    try { pluginManager.setEnabled(req.params.id, true); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/plugins/:id/disable', (req, res) => {
    try { pluginManager.setEnabled(req.params.id, false); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/plugins/reload', async (_req, res) => {
    try { const result = await pluginManager.loadAll(); res.json({ ok: true, ...result }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 浏览器状态 ──
  router.get('/browser/status', (_req, res) => {
    try { res.json({ ok: true, available: browserManager.isAvailable() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 自定义 Provider ──
  router.get('/custom-providers/backends', (_req, res) => {
    try { res.json({ ok: true, backends: INFERENCE_BACKENDS }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/custom-providers', (_req, res) => {
    try { res.json({ ok: true, providers: customProviderManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/custom-providers', (req, res) => {
    try { const { id, name, baseURL, apiKey, models, autoDetect } = req.body; if (!id || !baseURL) return res.status(400).json({ error: 'id/baseURL 必填' }); customProviderManager.add({ id, name: name || id, baseURL, apiKey, models, autoDetect }); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/custom-providers/:id', (req, res) => {
    try { customProviderManager.remove(req.params.id); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/custom-providers/test', async (req, res) => {
    try { const { baseURL, apiKey, models } = req.body; const result = await customProviderManager.testConnection({ id: 'test', name: 'test', baseURL, apiKey, models }); res.json({ ok: result.ok, models: result.models, error: result.error }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/custom-providers/:id/detect', async (req, res) => {
    try { const p = customProviderManager.get(req.params.id); if (!p) return res.status(404).json({ error: '不存在' }); const models = await customProviderManager.detectModels(p.baseURL, p.apiKey); res.json({ ok: true, models }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Vision ──
  router.get('/vision/status', (_req, res) => {
    try { res.json({ ok: true, ...visionManager.getStatus() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/vision/analyze', async (req, res) => {
    try { const { image, mimeType, question } = req.body; if (!image) return res.status(400).json({ error: 'image 必填' }); const result = await visionManager.analyze(image, mimeType || 'image/jpeg', question); if (!result.ok) return res.status(400).json({ error: result.error }); res.json({ ok: true, description: result.description }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 推送通知 ──
  router.get('/push/status', (_req, res) => {
    try { res.json({ ok: true, ...pushManager.getStatus() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/push/vapid-key', (_req, res) => {
    try { const key = pushManager.getVapidPublicKey(); if (!key) return res.json({ ok: true, available: false }); res.json({ ok: true, available: true, vapidPublicKey: key }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/push/subscribe', (req, res) => {
    try { const { userId, endpoint, keys, platform } = req.body; if (!userId || !endpoint || !platform) return res.status(400).json({ error: 'userId/endpoint/platform 必填' }); const sub = pushManager.subscribe(userId, { endpoint, keys, platform }); res.json({ ok: true, id: sub.id }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.delete('/push/:id', (req, res) => {
    try { pushManager.unsubscribe(req.params.id); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/push/send', async (req, res) => {
    try { const { userId, title, body, data } = req.body; if (!userId || !title) return res.status(400).json({ error: 'userId/title 必填' }); const sent = await pushManager.sendToUser(userId, title, body, data); res.json({ ok: true, sent }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 开发者模式 ──
  router.get('/dev/status', (_req, res) => {
    try { res.json({ ok: true, ...debugPanel.getStats() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/dev/enable', (req, res) => {
    try { debugPanel.setEnabled(req.body.enabled ?? true); debugPanel.setWSLog(req.body.wsLog ?? false); res.json({ ok: true, ...debugPanel.getStats() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/dev/logs', (req, res) => {
    try { const limit = parseInt(req.query.limit as string) || 100; const type = req.query.type as string; res.json({ ok: true, logs: debugPanel.getLogs(limit, type) }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/dev/clear', (_req, res) => {
    try { debugPanel.clear(); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 运行日志 ──
  router.get('/logs', (req, res) => {
    try { const limit = Math.min(parseInt(req.query.limit as string) || 200, 2000); const content = logger.getTodayLog(); const lines = content.split('\n').filter(Boolean); res.json({ ok: true, total: lines.length, lines: lines.slice(-limit) }); }
    catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── 语音 ──
  router.get('/voice/status', (_req, res) => {
    try { res.json({ ok: true, tts: ttsManager.getStatus(), stt: sttManager.getStatus() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/voice/tts', async (req, res) => {
    try { const { text } = req.body; if (!text) return res.status(400).json({ error: 'text 必填' }); const result = await ttsManager.synthesize(text); if (!result.ok) return res.status(400).json({ error: result.error }); res.json({ ok: true, audio: result.audioBase64, mimeType: result.mimeType, duration: result.duration }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/voice/stt', async (req, res) => {
    try { const { audio, mimeType } = req.body; if (!audio) return res.status(400).json({ error: 'audio 必填' }); const result = await sttManager.transcribe(audio, mimeType || 'audio/mpeg'); if (!result.ok) return res.status(400).json({ error: result.error }); res.json({ ok: true, text: result.text, language: result.language }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 个人中心 + 积分 + 评价 ──
  router.get('/profile', async (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      const user = ctx.db.getUserByEmail(userId) || ctx.db.getUser(userId);
      if (!user) return res.status(404).json({ error: '用户不存在' });
      const credits = getDB().prepare('SELECT * FROM user_credits WHERE user_id = ?');
      credits.bind([user.id]);
      const creditRow = credits.step() ? credits.getAsObject() : null;
      credits.free();
      const usage = UsageTracker.getStats();
      const ratingStmt = getDB().prepare('SELECT COUNT(*) as count, AVG(rating) as avg FROM message_ratings WHERE user_id = ?');
      ratingStmt.bind([user.id]);
      const ratingRow = ratingStmt.step() ? ratingStmt.getAsObject() : { count: 0, avg: 0 };
      ratingStmt.free();
      res.json({ ok: true, profile: { id: user.id, numeric_id: user.numeric_id, display_name: user.display_name, email: user.email, status: user.status, created_at: user.created_at }, credits: creditRow?.credits || 1000, totalEarned: creditRow?.total_earned || 0, totalSpent: creditRow?.total_spent || 0, usage: usage.total, ratings: { count: ratingRow.count || 0, avgRating: ratingRow.avg || 0 } });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/credits/deduct', (req, res) => {
    try {
      const { userId, amount } = req.body || {};
      if (!userId || !amount) return res.status(400).json({ error: 'userId/amount 必填' });
      const now = Date.now();
      const stmt = getDB().prepare('UPDATE user_credits SET credits = credits - ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ? AND credits >= ?');
      stmt.bind([amount, amount, now, userId, amount]);
      stmt.step();
      const changes = getDB().getRowsModified();
      stmt.free();
      if (changes === 0) { const checkStmt = getDB().prepare('SELECT credits FROM user_credits WHERE user_id = ?'); checkStmt.bind([userId]); const row = checkStmt.step() ? checkStmt.getAsObject() : null; checkStmt.free(); return res.status(400).json({ error: '积分不足', current: row?.credits || 0 }); }
      const balStmt = getDB().prepare('SELECT credits FROM user_credits WHERE user_id = ?'); balStmt.bind([userId]); const balRow = balStmt.step() ? balStmt.getAsObject() : null; balStmt.free();
      res.json({ ok: true, balance: balRow?.credits || 0 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/credits/award', (req, res) => {
    try {
      const { userId, amount } = req.body || {};
      if (!userId || !amount) return res.status(400).json({ error: 'userId/amount 必填' });
      const now = Date.now();
      const stmt = getDB().prepare('INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(user_id) DO UPDATE SET credits = credits + ?, total_earned = total_earned + ?, updated_at = ?');
      stmt.bind([userId, 1000 + amount, amount, now, amount, amount, now]);
      stmt.step(); stmt.free();
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.post('/ratings', (req, res) => {
    try {
      const { messageId, userId, rating, comment } = req.body || {};
      if (!messageId || !userId || !rating) return res.status(400).json({ error: 'messageId/userId/rating 必填' });
      if (rating < 1 || rating > 5) return res.status(400).json({ error: '评分 1-5' });
      const id = 'rating-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const stmt = getDB().prepare('INSERT INTO message_ratings (id, message_id, user_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      stmt.bind([id, messageId, userId, rating, comment || null, Date.now()]);
      stmt.step(); stmt.free();
      res.json({ ok: true, id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  router.get('/ratings', (req, res) => {
    try {
      const userId = req.query.userId as string;
      const stmt = getDB().prepare('SELECT * FROM message_ratings WHERE user_id = ? ORDER BY created_at DESC LIMIT 50');
      stmt.bind([userId]);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json({ ok: true, ratings: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 一键升级接口 ──
  // v2.0.7 安全加固：该端点会在服务器上执行下载+安装脚本，必须显式携带 ADMIN_TOKEN，
  // admin-auto 免登录兜底不授权此操作（公网/内网都一样），未配置 ADMIN_TOKEN 时端点直接禁用
  // v2.0.13 跨平台：安装目录与默认升级脚本按平台分流（win 桌面 / mac 桌面 ~/lingxi-engine / linux 服务器 /opt + pm2）
  router.post('/update', async (req, res) => {
    try {
      const adminToken = process.env.ADMIN_TOKEN;
      const authHeader = (req.headers['authorization'] as string) || '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ((req.headers['x-admin-token'] as string) || '');
      if (!adminToken || provided !== adminToken) {
        console.warn('[Update] 拒绝未授权升级请求, 来源:', (req.socket?.remoteAddress || ''));
        return res.status(401).json({ ok: false, error: '升级需要 ADMIN_TOKEN 授权' });
      }
      const { execSync } = await import('child_process');
      const updateUrl = process.env.UPDATE_URL || '';
      const isWin = process.platform === 'win32';
      const isMac = process.platform === 'darwin';
      const installDir = process.env.LINGXI_INSTALL_DIR
        || (isWin ? ((process.env.USERPROFILE || 'C:\\Users') + '\\lingxi-engine')
          : isMac ? ((process.env.HOME || '/tmp') + '/lingxi-engine')
          : '/opt/lingxi-engine');
      // 默认升级脚本：下载 tarball → 解压（strip-components 与 deploy.sh 对齐）→ npm install；
      // linux 服务器场景追加 pm2 重启（失败不阻断，文件已更新）；mac 桌面版由桌面壳守护自动拉起新版
      const defaultScript = isWin
        ? 'cd /d "' + installDir + '" && curl -fsSL ' + updateUrl + ' -o lingxi-update.tar.gz && tar xzf lingxi-update.tar.gz --strip-components=1 && npm install --no-audit --no-fund'
        : 'cd "' + installDir + '" && curl -fsSL ' + updateUrl + ' -o /tmp/lingxi-update.tar.gz && tar xzf /tmp/lingxi-update.tar.gz --strip-components=1 && npm install --no-audit --no-fund 2>&1 | tail -3' + (isMac ? '' : ' && (pm2 restart lingxi 2>/dev/null || true)');
      const installScript = process.env.UPDATE_SCRIPT || defaultScript;

      res.json({ ok: true, message: '升级已触发，服务器将在几秒后重启', version: process.env.npm_package_version || '2.0.13' });

      setTimeout(() => {
        try {
          execSync(installScript, { timeout: 120000, stdio: 'pipe', cwd: installDir });
        } catch (e: any) {
          console.error('[Update] 升级失败:', e.message);
        }
      }, 1000);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  // ==================== User Management ====================

  // GET /dashboard - admin dashboard with user list and stats
  router.get('/dashboard', async (req, res) => {
    try {
      const db = getDB();
      const totalUsers = db.exec('SELECT COUNT(*) as c FROM users')[0].values[0][0];
      const bannedUsers = db.exec("SELECT COUNT(*) as c FROM users WHERE status = 'banned'")[0].values[0][0];
      const usersResult = db.exec('SELECT id, numeric_id, email, nickname, status, points, total_earned, total_spent, created_at, last_active_at FROM users ORDER BY created_at DESC LIMIT 100');
      const cols = usersResult[0].columns;
      const users = usersResult[0].values.map((row: any[]) => {
        const obj: any = {};
        cols.forEach((col: string, i: number) => { obj[col] = row[i]; });
        return obj;
      });
      const totalAgents = db.exec('SELECT COUNT(*) as c FROM agents')[0].values[0][0];
      const marketListings = db.exec('SELECT COUNT(*) as c FROM agent_market')[0].values[0][0];
      const totalOrders = db.exec('SELECT COUNT(*) as c FROM market_orders')[0].values[0][0];
      const totalChats = db.exec('SELECT COUNT(*) as c FROM chats')[0].values[0][0];
      const usage = UsageTracker.getStats();
      // invite codes
      let inviteCodes = [];
      try {
        const inviteResult = db.exec('SELECT code, used_count, max_uses, created_at, expires_at FROM invite_codes ORDER BY created_at DESC LIMIT 50');
        if (inviteResult.length) {
          const ic = inviteResult[0].columns;
          inviteCodes = inviteResult[0].values.map((row: any[]) => {
            const obj: any = {};
            ic.forEach((col: string, i: number) => { obj[col] = row[i]; });
            return obj;
          });
        }
      } catch {}
      res.json({ ok: true, data: { totalUsers, bannedUsers, totalAgents, marketListings, totalOrders, totalChats, users, usage, inviteCodes, agentCount: totalAgents, chatCount: totalChats, sessionCount: 0, msgCount: 0 } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /usage - usage statistics and recent calls
  router.get('/usage', async (req, res) => {
    try {
      const limit = parseInt(String(req.query.limit || '50'));
      const recent = UsageTracker.getRecentRecords(limit);
      res.json({ ok: true, recent });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /users/:id/ban - ban a user
  router.post('/users/:id/ban', (req, res) => {
    try {
      const db = getDB();
      const userId = req.params.id;
      db.run("UPDATE users SET status = 'banned' WHERE id = ?", [userId]);
      db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
      res.json({ ok: true, message: 'User banned' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /users/:id/unban - unban a user
  router.post('/users/:id/unban', (req, res) => {
    try {
      const db = getDB();
      const userId = req.params.id;
      db.run("UPDATE users SET status = 'active' WHERE id = ?", [userId]);
      res.json({ ok: true, message: 'User unbanned' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /users/:id - cascade delete a user (requires confirm=true in body)
  router.delete('/users/:id', (req, res) => {
    try {
      if (req.body && req.body.confirm !== true) {
        res.status(400).json({ error: 'Confirmation required: send { confirm: true } in body' });
        return;
      }
      const userId = req.params.id;
      deleteUser(userId);
      res.json({ ok: true, message: 'User deleted with all related data' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}