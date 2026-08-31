/**
 * AGI 能力路由 — 暴露进化方案里的核心智能能力
 *
 * POST /api/agi/debate        → 多智能体辩论 { topic, maxRounds }
 * POST /api/agi/thought-tree  → 白盒思考树 { question }
 * POST /api/agi/world-model   → 世界模型断言 { input, context }
 * GET  /api/agi/personality   → 查看某 Agent 的人格维度 { agentId }
 */
import { Router } from 'express';
import type { ServerContext } from '../server/context.js';

export function createAgiRoutes(ctx: ServerContext): Router {
  const router = Router();

  /** 多智能体辩论 */
  router.post('/agi/debate', async (req, res) => {
    try {
      const { topic, maxRounds } = req.body || {};
      if (!topic || typeof topic !== 'string' || topic.trim().length < 3) {
        return res.status(400).json({ ok: false, error: 'topic 必填（至少3字）' });
      }
      const result = await ctx.router.debate(topic.trim(), Math.min(maxRounds || 3, 5));
      res.json({ ok: true, result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** 白盒思考树 */
  router.post('/agi/thought-tree', async (req, res) => {
    try {
      const { question } = req.body || {};
      if (!question || typeof question !== 'string' || question.trim().length < 3) {
        return res.status(400).json({ ok: false, error: 'question 必填（至少3字）' });
      }
      const tree = await ctx.router.buildThoughtTree(question.trim());
      res.json({ ok: true, tree });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** 世界模型断言 */
  router.post('/agi/world-model', async (req, res) => {
    try {
      const { input, context } = req.body || {};
      if (!input || typeof input !== 'string' || input.trim().length < 3) {
        return res.status(400).json({ ok: false, error: 'input 必填（至少3字）' });
      }
      const assertions = await ctx.router.assertWorld(input.trim(), context);
      res.json({ ok: true, assertions });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /** 查看人格维度 */
  router.get('/agi/personality', (req, res) => {
    try {
      const agentId = (req.query.agentId as string) || '';
      if (!agentId) {
        return res.status(400).json({ ok: false, error: 'agentId 必填' });
      }
      const agent = ctx.manager?.get(agentId);
      if (!agent) {
        return res.status(404).json({ ok: false, error: 'Agent 不存在' });
      }
      res.json({
        ok: true,
        agentId,
        personalityDims: agent.personalityDims || {},
        personality: agent.personality || '',
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
