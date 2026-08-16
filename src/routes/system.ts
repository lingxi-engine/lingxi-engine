/**
 * 系统路由 — 健康检查、版本、用量、模型路由配置、搜索
 */
import { Router } from 'express';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { adminAuth } from '../middleware/admin-auth.js';
import { jwtAuth } from '../middleware/jwt-auth.js';
const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;
import { UsageTracker } from '../core/usage-tracker.js';
import type { ServerContext } from '../server/context.js';

export function createSystemRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { manager, aiHub, searchManager } = ctx;

  const now = new Date();
  const Y = now.getFullYear();
  const M = now.getMonth() + 1;
  const D = now.getDate();
  const HH = now.getHours();
  const mm = now.getMinutes();
  const APP_VERSION = `v${Y}.${M}.${D}-${HH}.${mm}`;

  router.get('/health', (_req, res) => {
    try {
      res.json({ status: 'ok', agents: manager.list().length, time: Date.now(), version: APP_VERSION });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/version', (_req, res) => {
    res.json({ version: APP_VERSION });
  });

  router.get('/search/providers', requireAuth, (_req, res) => {
    try {
      res.json({ ok: true, providers: searchManager.listProviders() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/usage', requireAuth, (_req, res) => {
    try {
      res.json({ ok: true, stats: UsageTracker.getStats(), recent: UsageTracker.getRecentRecords(50) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/usage/reset', adminAuth, (_req, res) => {
    try {
      UsageTracker.reset();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 模型路由配置持久化：写回 .env（read-modify-write，保留原内容与注释）
  function persistEnvVar(key: string, value: string): void {
    try {
      const envPath = path.join(process.cwd(), '.env');
      let text = '';
      if (existsSync(envPath)) text = readFileSync(envPath, 'utf8');
      const re = new RegExp('^(' + key + '\\s*=).*$', 'm');
      if (re.test(text)) {
        text = text.replace(re, '$1' + value);
      } else {
        text += (text.endsWith('\n') || text === '' ? '' : '\n') + key + '=' + value + '\n';
      }
      writeFileSync(envPath, text, 'utf8');
    } catch (e: any) {
      console.warn('[Config] 写入 .env 失败:', e.message);
    }
  }

  // ── 模型路由配置 ──
  router.get('/model-route', requireAuth, (_req, res) => {
    res.json({
      ok: true,
      toolModel: process.env.TOOL_MODEL || '',
      replyModel: process.env.REPLY_MODEL || '',
      defaultModel: process.env.DEFAULT_MODEL || '',
      enabled: process.env.ROUTE_ENABLED !== 'false' ? 'true' : 'false',
    });
  });

  router.put('/model-route', requireAuth, (req, res) => {
    try {
      const { toolModel, replyModel, enabled } = req.body;
      if (toolModel !== undefined) { process.env.TOOL_MODEL = toolModel; persistEnvVar('TOOL_MODEL', toolModel); }
      if (replyModel !== undefined) { process.env.REPLY_MODEL = replyModel; persistEnvVar('REPLY_MODEL', replyModel); }
      if (enabled !== undefined) { process.env.ROUTE_ENABLED = String(enabled); persistEnvVar('ROUTE_ENABLED', String(enabled)); }
      res.json({
        ok: true,
        toolModel: process.env.TOOL_MODEL,
        replyModel: process.env.REPLY_MODEL,
        enabled: process.env.ROUTE_ENABLED !== 'false' ? 'true' : 'false',
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/models', (_req, res) => {
    try {
      res.json({ ok: true, models: aiHub.listModels() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}