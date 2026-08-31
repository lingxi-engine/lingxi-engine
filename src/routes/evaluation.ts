/**
 * Evaluations 路由 — AGI P0: 评测体系对外查询接口
 *
 * 之前只记录了评测数据（evaluation-records.json），但没有任何出口能看到。
 * 本路由把"尺子"亮出来：聚合统计 / 最近记录 / 最近一条。
 *
 * GET /api/evaluations/summary?agentId=&chatId=&model=&since=
 * GET /api/evaluations/recent?limit=50
 * GET /api/evaluations/last
 */
import { Router } from 'express';
import type { ServerContext } from '../server/context.js';

export function createEvaluationRoutes(ctx: ServerContext): Router {
  const router = Router();

  /** 聚合统计：总分/通过率/修正率/问题分布/Top Agent/Top Model */
  router.get('/evaluations/summary', (req, res) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const summary = ctx.router.getEvaluationSummary({
        agentId: q.agentId || undefined,
        chatId: q.chatId || undefined,
        model: q.model || undefined,
        since: q.since ? Number(q.since) : undefined,
      });
      res.json({ ok: true, summary });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'summary failed' });
    }
  });

  /** 最近评测记录（倒序） */
  router.get('/evaluations/recent', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      res.json({ ok: true, records: ctx.router.getRecentEvaluations(limit) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'recent failed' });
    }
  });

  /** 最近一条评测（快速验证用） */
  router.get('/evaluations/last', (_req, res) => {
    try {
      res.json({ ok: true, record: ctx.router.getLastEvaluation() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'last failed' });
    }
  });

  return router;
}
