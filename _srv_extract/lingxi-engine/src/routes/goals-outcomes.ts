/**
 * v1.7.2: 目标追踪 + 评分卡 REST API 路由
 * 
 * Bug #28 修复: GoalTracker 暴露 HTTP 端点
 * Bug #27 修复: OutcomeTracker 通过 REST API 可操作
 */
import { Router } from 'express';
import { GoalTracker } from '../core/goal-tracker.js';
import type { ServerContext } from '../server/context.js';

export function createGoalOutcomeRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { outcomeTracker } = ctx;

  // ══════ 目标追踪 API ══════

  /**
   * 列出项目的所有目标
   * GET /api/goals?projectId=project-xxx
   */
  router.get('/goals', (req, res) => {
    try {
      const projectId = req.query.projectId as string;
      if (!projectId) return res.status(400).json({ error: '需要 projectId 参数' });
      const goals = GoalTracker.list(projectId);
      res.json({ ok: true, goals, count: goals.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 获取进度摘要
   * GET /api/goals/progress?projectId=project-xxx
   */
  router.get('/goals/progress', (req, res) => {
    try {
      const projectId = req.query.projectId as string;
      if (!projectId) return res.status(400).json({ error: '需要 projectId 参数' });
      const summary = GoalTracker.getProgressSummary(projectId);
      const goals = GoalTracker.list(projectId);
      const doneCount = goals.filter(g => g.status === 'done').length;
      res.json({ ok: true, summary, total: goals.length, done: doneCount, active: GoalTracker.isActive(projectId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 获取单个目标
   * GET /api/goals/:id
   */
  router.get('/goals/:id', (req, res) => {
    try {
      const goal = GoalTracker.get(req.params.id);
      if (!goal) return res.status(404).json({ error: '目标不存在' });
      res.json({ ok: true, goal });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 创建目标
   * POST /api/goals
   * body: { projectId, title, acceptanceCriteria?, parentId? }
   */
  router.post('/goals', (req, res) => {
    try {
      const { projectId, title, acceptanceCriteria, parentId } = req.body || {};
      if (!projectId || !title) return res.status(400).json({ error: 'projectId 和 title 必填' });
      const goal = GoalTracker.create(projectId, title, acceptanceCriteria, parentId);
      res.json({ ok: true, goal });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 标记目标完成
   * POST /api/goals/:id/done
   */
  router.post('/goals/:id/done', (req, res) => {
    try {
      const ok = GoalTracker.markDone(req.params.id);
      if (!ok) return res.status(404).json({ error: '目标不存在' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 标记目标进行中
   * POST /api/goals/:id/in-progress
   */
  router.post('/goals/:id/in-progress', (req, res) => {
    try {
      const ok = GoalTracker.markInProgress(req.params.id);
      if (!ok) return res.status(404).json({ error: '目标不存在' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 取消目标
   * POST /api/goals/:id/cancel
   */
  router.post('/goals/:id/cancel', (req, res) => {
    try {
      GoalTracker.cancel(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 清除项目的所有目标
   * DELETE /api/goals?projectId=project-xxx
   */
  router.delete('/goals', (req, res) => {
    try {
      const projectId = req.query.projectId as string;
      if (!projectId) return res.status(400).json({ error: '需要 projectId 参数' });
      GoalTracker.clear(projectId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 获取当前进行中的目标
   * GET /api/goals/current?projectId=project-xxx
   */
  router.get('/goals/current', (req, res) => {
    try {
      const projectId = req.query.projectId as string;
      if (!projectId) return res.status(400).json({ error: '需要 projectId 参数' });
      const current = GoalTracker.getCurrent(projectId);
      res.json({ ok: true, goal: current });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ══════ 评分卡 API ══════

  /**
   * 列出评分卡
   * GET /api/outcomes?chatId=xxx
   */
  router.get('/outcomes', (req, res) => {
    try {
      const chatId = req.query.chatId as string;
      const cards = outcomeTracker.list(chatId || undefined);
      res.json({ ok: true, cards, count: cards.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 获取评分卡详情
   * GET /api/outcomes/:id
   */
  router.get('/outcomes/:id', (req, res) => {
    try {
      const card = outcomeTracker.getCard(req.params.id);
      if (!card) return res.status(404).json({ error: '评分卡不存在' });
      res.json({ ok: true, card });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 创建评分卡
   * POST /api/outcomes
   * body: { goal, chatId, agentId }
   */
  router.post('/outcomes', async (req, res) => {
    try {
      const { goal, chatId, agentId } = req.body || {};
      if (!goal || !chatId || !agentId) return res.status(400).json({ error: 'goal/chatId/agentId 必填' });
      const card = await outcomeTracker.createCard(goal, chatId, agentId);
      res.json({ ok: true, card });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 评估评分卡
   * POST /api/outcomes/:id/evaluate
   * body: { conversationSummary }
   */
  router.post('/outcomes/:id/evaluate', async (req, res) => {
    try {
      const { conversationSummary } = req.body || {};
      const card = await outcomeTracker.evaluate(req.params.id, conversationSummary || '');
      if (!card) return res.status(404).json({ error: '评分卡不存在' });
      res.json({ ok: true, card });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 删除评分卡
   * DELETE /api/outcomes/:id
   */
  router.delete('/outcomes/:id', (req, res) => {
    try {
      const ok = outcomeTracker.deleteCard(req.params.id);
      res.json({ ok });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}