/**
 * Agent 路由 — Agent CRUD、记忆、技能绑定
 */
import { Router } from 'express';
import { updateAgentMemoryWithChecks, upsertChatMemoryWithChecks } from '../memory/memory-write-integration.js';
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
  router.patch('/agents/:id', async (req, res) => {
    try {
      const updates = req.body;
      const agent = await manager.update(req.params.id, updates);
      res.json({ ok: true, agent });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Agent 记忆读取 ──
  router.get('/agents/:id/memory', (req, res) => {
    try {
      const agent = db.getAgent(req.params.id);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json({ ok: true, memory: agent.memory_summary || '', personality: agent.personality || '' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Agent 记忆更新（接入去重+冲突检测）──
  router.put('/agents/:id/memory', async (req, res) => {
    try {
      const { personality, memory, facts } = req.body || {};
      const agentId = req.params.id;

      // 如果有 facts 更新，走新接口
      if (facts && Object.keys(facts).length > 0) {
        const agent = db.getAgent(agentId);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });

        const result = await updateAgentMemoryWithChecks(agentId, agent.memory_summary || '', facts, {
          source: 'assistant',
          confidence: 0.8,
          skipConflictCheck: false,
          skipDedup: false,
        });

        if (!result.success) {
          return res.status(409).json({ ok: false, error: '记忆冲突', conflicts: result.conflicts, skippedKeys: result.skippedKeys });
        }
      }

      // personality / memory_summary 常规更新
      if (personality !== undefined || memory !== undefined) {
        db.updateAgent(agentId, {
          personality: personality || undefined,
          memory_summary: memory || undefined,
        });
      }

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Chat 级记忆更新（接入去重+冲突检测）──
  router.put('/chats/:chatId/agents/:agentId/memory', async (req, res) => {
    try {
      const { chatId, agentId } = req.params;
      const { summary, facts } = req.body || {};

      if (!facts || Object.keys(facts).length === 0) {
        return res.status(400).json({ error: 'facts 必填且非空' });
      }

      const result = await upsertChatMemoryWithChecks(chatId, agentId, summary || '', facts, {
        source: 'assistant',
        confidence: 0.8,
        skipConflictCheck: false,
        skipDedup: false,
      });

      if (!result.success) {
        return res.status(409).json({ ok: false, error: '记忆冲突', conflicts: result.conflicts, skippedKeys: result.skippedKeys });
      }

      res.json({ ok: true, skippedKeys: result.skippedKeys });
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