/**
 * 技能路由 — 技能管理 API（批次13a 自 index.ts 内联块迁出）
 */
import { Router } from 'express';
import { jwtAuth } from '../middleware/jwt-auth.js';
import type { ServerContext } from '../server/context.js';

export function createSkillsRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { skillManager } = ctx;
  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;

  // 列出已安装技能
  router.get('/skills', requireAuth, (_req, res) => {
    try { res.json({ ok: true, skills: skillManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 重新扫描本地技能目录
  router.post('/skills/scan', requireAuth, (_req, res) => {
    try { res.json({ ok: true, skills: skillManager.scanLocal() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 启用技能
  router.post('/skills/:id/enable', requireAuth, (req, res) => {
    try { skillManager.setEnabled(String(req.params.id), true); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 停用技能
  router.post('/skills/:id/disable', requireAuth, (req, res) => {
    try { skillManager.setEnabled(String(req.params.id), false); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 卸载技能
  router.delete('/skills/:id', requireAuth, (req, res) => {
    try { skillManager.uninstall(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 创建技能
  router.post('/skills/create', requireAuth, (req, res) => {
    try {
      const { id, name, description, content } = req.body;
      if (!id || !name || !content) return res.status(400).json({ error: 'id/name/content 必填' });
      skillManager.createSkill(id, name, description || '', content);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 浏览技能市场
  router.get('/skills/market', requireAuth, async (_req, res) => {
    try {
      const items = await skillManager.browseMarket();
      res.json({ ok: true, items });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 从市场安装技能
  router.post('/skills/install', requireAuth, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name 必填' });
      const ok = await skillManager.installFromMarket(name);
      res.json({ ok });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}