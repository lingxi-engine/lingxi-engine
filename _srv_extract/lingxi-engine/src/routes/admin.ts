/**
 * 管理路由 — Cron、会话、子代理、收件箱、审批、Hook、技能、开发面板、日志、语音、视觉、推送
 */
import { Router } from 'express';
import { getDB } from '../storage/db.js';
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

  // ── 积分 + 评价 ──（profile 路由已由 profile.ts 提供）

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

  // v2.0.6: 一键升级接口 — 从公网下载最新 tarball 并自动重启
  router.post('/update', async (_req, res) => {
    try {
      const { execSync } = await import('child_process');
      const updateUrl = process.env.UPDATE_URL || 'http://47.93.157.83:8080/lingxi-engine.tar.gz';
      const installScript = process.env.UPDATE_SCRIPT || 'cd /opt/lingxi-engine && curl -fsSL ' + updateUrl + ' -o /tmp/lingxi-update.tar.gz && tar xzf /tmp/lingxi-update.tar.gz --overwrite && npm install --no-audit --no-fund 2>&1 | tail -3 && pm2 restart lingxi';
      
      res.json({ ok: true, message: '升级已触发，服务器将在几秒后重启', version: '2.0.6' });
      
      // 异步执行升级（先返回响应避免超时）
      setTimeout(() => {
        try {
          execSync(installScript, { timeout: 120000, stdio: 'pipe', cwd: '/opt/lingxi-engine' });
        } catch (e: any) {
          console.error('[Update] 升级失败:', e.message);
        }
      }, 1000);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}