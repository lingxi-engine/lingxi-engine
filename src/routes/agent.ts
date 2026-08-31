/**
 * Agent 路由 — Agent CRUD、记忆、技能绑定
 */
import { Router } from 'express';
import type { ServerContext } from '../server/context.js';

export function createAgentRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { db, manager, toolRegistry } = ctx;

  // ── Agent 注册 ──
  router.post('/agents/register', (req, res) => {
    try {
      const { userId, displayName, personality, autonomy } = req.body;
      if (!userId || !displayName) return res.status(400).json({ error: 'userId 和 displayName 必填' });
      const agent = manager.register(userId, displayName, personality || '你是一个友好的 AI 助手', autonomy || 'semi');
      res.json({ ok: true, agent });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Agent 列表 ──
  router.get('/agents', (_req, res) => {
    try {
      res.json({ ok: true, agents: manager.list() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Agent 更新 ──
  router.patch('/agents/:id', (req, res) => {
    try {
      const updates = req.body;
      const agent = manager.update(req.params.id, updates);
      res.json({ ok: true, agent });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Agent 记忆 ──
  router.get('/agents/:id/memory', (req, res) => {
    try {
      const agent = db.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json({ ok: true, memory: agent.memory_summary || '', personality: agent.personality || '' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/agents/:id/memory', (req, res) => {
    try {
      const { personality, memory } = req.body || {};
      db.updateAgent(req.params.id, { personality: personality || undefined, memory_summary: memory || undefined });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Agent 绑定技能 ──
  router.post('/agents/:id/skills', (req, res) => {
    try {
      const { skillIds } = req.body;
      if (!Array.isArray(skillIds)) return res.status(400).json({ error: 'skillIds 必须是数组' });
      toolRegistry.bindSkills(req.params.id, skillIds);
      res.json({ ok: true, agentId: req.params.id, skills: skillIds });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 工具列表 ──
  router.get('/tools', (_req, res) => {
    try {
      res.json({ ok: true, tools: toolRegistry.listTools(), skills: toolRegistry.listSkills() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}