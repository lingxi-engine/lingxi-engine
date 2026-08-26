/**
 * v1.7.2: 目标追踪 + 评分卡 REST API 路由
 * 
 * Bug #28 修复: GoalTracker 暴露 HTTP 端点
 * Bug #27 修复: OutcomeTracker 通过 REST API 可操作
 * v1.7.3 修复:
 *  - BUG-2: /goals/current 路由被 /goals/:id 遮蔽（注册顺序错误），已移到 :id 之前
 *  - BUG-6: 注册 GoalTracker 项目完成回调 → 自动生成评分卡（之前只打了 console.log）
 *  - BUG-8: /goals/:id/cancel 不校验目标存在，现在不存在返回 404
 * v1.7.4 修复（前后端协议对齐）:
 *  - BUG-9: 前端 removeGoal() 调 DELETE /api/goals/:id，但后端没有该路由 → 删除必 404（方法 GoalTracker.remove 一直存在，只是没暴露）
 *  - BUG-10: 前端 setGoalStatus() 调 PATCH /api/goals/:id {status}，但后端只有 POST /done|/in-progress|/cancel → 状态切换必 404
 *  - BUG-11: 前端 loadGoals()/addGoal() 不传 projectId（admin 面板无项目概念），后端强制要求 → 列表/添加必 400；addRightGoal 用 body.project 字段后端读 projectId → 400
 */
import { Router } from 'express';
import { GoalTracker } from '../core/goal-tracker.js';
import { processUserMessage } from '../core/ws-handler.js';
import type { ServerContext } from '../server/context.js';

/** 前端 admin 面板不传 projectId 时的默认项目 */
const DEFAULT_PROJECT = 'default';

export function createGoalOutcomeRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { outcomeTracker } = ctx;

  // ══════ 目标追踪 API ══════

  /**
   * 列出项目的所有目标
   * GET /api/goals?projectId=project-xxx
   * v1.7.4 修复: projectId 可选，缺省用 DEFAULT_PROJECT（前端 admin 面板调用时不带参数）
   */
  router.get('/goals', (req, res) => {
    try {
      const projectId = (req.query.projectId as string) || DEFAULT_PROJECT;
      const goals = GoalTracker.list(projectId);
      const done = goals.filter(g => g.status === 'done').length;
      res.json({ ok: true, goals, count: goals.length, progress: { done, total: goals.length } });
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
      const projectId = (req.query.projectId as string) || DEFAULT_PROJECT;
      const summary = GoalTracker.getProgressSummary(projectId);
      const goals = GoalTracker.list(projectId);
      const doneCount = goals.filter(g => g.status === 'done').length;
      res.json({ ok: true, summary, total: goals.length, done: doneCount, active: GoalTracker.isActive(projectId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 获取当前进行中的目标
   * GET /api/goals/current?projectId=project-xxx
   * v1.7.3 修复: 必须注册在 /goals/:id 之前，否则 "current" 会被当成目标 id 匹配 :id 路由导致 404
   */
  router.get('/goals/current', (req, res) => {
    try {
      const projectId = (req.query.projectId as string) || DEFAULT_PROJECT;
      const current = GoalTracker.getCurrent(projectId);
      res.json({ ok: true, goal: current });
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
   * body: { projectId?, title, acceptanceCriteria?, parentId? }
   * v1.7.4 修复: projectId 可选（兼容 body.project 字段），缺省用 DEFAULT_PROJECT
   */
  router.post('/goals', (req, res) => {
    try {
      const body = req.body || {};
      const projectId = body.projectId || body.project || DEFAULT_PROJECT;
      const { title, acceptanceCriteria, parentId } = body;
      if (!title) return res.status(400).json({ error: 'title 必填' });
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
   * v1.7.3 修复: 校验目标存在，不存在返回 404（与 done/in-progress 语义一致）
   */
  router.post('/goals/:id/cancel', (req, res) => {
    try {
      const ok = GoalTracker.cancel(req.params.id);
      if (!ok) return res.status(404).json({ error: '目标不存在' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 更新目标状态（前端 setGoalStatus 用 PATCH）
   * PATCH /api/goals/:id
   * body: { status: 'pending' | 'in_progress' | 'done' | 'cancelled' }
   * v1.7.4 新增: 前端只调 PATCH，后端之前没有该路由 → 状态切换必 404
   */
  router.patch('/goals/:id', (req, res) => {
    try {
      const { status } = req.body || {};
      const id = req.params.id;
      let ok = false;
      switch (status) {
        case 'done': ok = GoalTracker.markDone(id); break;
        case 'in_progress': ok = GoalTracker.markInProgress(id); break;
        case 'cancelled': ok = GoalTracker.cancel(id); break;
        case 'pending': ok = GoalTracker.markPending(id); break;
        default: return res.status(400).json({ error: 'status 必须是 pending/in_progress/done/cancelled 之一' });
      }
      if (!ok) return res.status(404).json({ error: '目标不存在' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * 删除单个目标（前端 removeGoal 调 DELETE /api/goals/:id）
   * DELETE /api/goals/:id
   * v1.7.4 新增: 之前只有 DELETE /api/goals?projectId=（清空整个项目），单目标删除路由缺失 → 前端 🗑️ 必 404「删除失败」
   */
  router.delete('/goals/:id', (req, res) => {
    try {
      const ok = GoalTracker.remove(req.params.id);
      if (!ok) return res.status(404).json({ error: '目标不存在' });
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
      const projectId = (req.query.projectId as string) || DEFAULT_PROJECT;
      GoalTracker.clear(projectId);
      res.json({ ok: true });
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
   * v1.7.3 修复: 依赖的 OutcomeTracker.deleteCard 方法已补上；目标不存在返回 404
   */
  router.delete('/outcomes/:id', (req, res) => {
    try {
      const ok = (outcomeTracker as any).deleteCard(req.params.id);
      if (!ok) return res.status(404).json({ error: '评分卡不存在' });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ══════ 反向提问：AI 针对目标提澄清问题 ══════
  router.post('/goals/:id/ask', (req, res) => {
    try {
      const goal = GoalTracker.get(req.params.id);
      if (!goal) return res.status(404).json({ error: '目标不存在' });
      const { chatId, extra } = req.body || {};
      if (!chatId) return res.status(400).json({ error: '需要 chatId' });
      const msgId = 'goal-ask-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      let content = `请针对目标任务「${goal.title}」进行结构化分析。请严格使用半角冒号（Q:、A:、B:），不要使用全角冒号，不要加Markdown加粗，不要输出除问题列表外的任何其他内容。

要求输出格式（严格遵循）：
Q: 问题1？
A: 选项A描述
B: 选项B描述
C: 选项C描述（可选）

Q: 问题2？
A: 选项A描述
B: 选项B描述

（输出2-3个最关键的问题，每个问题2-3个选项。问题要帮助明确目标范围、验收标准、优先级、资源需求等。）`;
      // 如果有额外上下文（继续反问时传入用户已选选项），附加到提示中
      if (extra && typeof extra === 'string' && extra.length > 0) {
        content += `\n\n用户已选的上下文信息：${extra}\n请基于以上信息提出更深入、更具体的追问。`;
      }
      ctx.db.addMessage({ id: msgId, chatId, senderType: 'user', senderId: 'goal-tracker', content, type: 'text', timestamp: Date.now() });
      ctx.broadcast({ type: 'message.new', chatId, from: 'goal-tracker', senderId: 'goal-tracker', senderType: 'user', content, timestamp: Date.now() });
      // 触发 AI 审查目标
      try { processUserMessage(chatId, 'goal-tracker', content, undefined, ctx.router, ctx.broadcast); } catch (_) {}
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 目标完善：根据用户勾选的选项更新/创建目标 ──
  router.post('/goals/:id/refine', (req, res) => {
    try {
      const goal = GoalTracker.get(req.params.id);
      if (!goal) return res.status(404).json({ error: '目标不存在' });
      const { selections, action } = req.body || {};
      if (!selections || !selections.length) return res.status(400).json({ error: '需要 selections' });
      const selectedText = selections.join("；");
      if (action === 'create') {
        const newTitle = goal.title + "（" + selectedText.slice(0, 30) + "）";
        const newGoal = GoalTracker.create(goal.projectId, newTitle, selectedText);
        res.json({ ok: true, goal: newGoal, action: 'create' });
      } else if (action === 'criteria') {
        const updated = (goal.acceptanceCriteria ? goal.acceptanceCriteria + '\n' : '') + selectedText;
        GoalTracker.update(goal.id, { acceptanceCriteria: updated });
        res.json({ ok: true, goal: GoalTracker.get(goal.id), action: 'criteria' });
      } else {
        GoalTracker.update(goal.id, { acceptanceCriteria: selectedText });
        res.json({ ok: true, goal: GoalTracker.get(goal.id), action: 'refine' });
      }
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ══════ 项目完成 → 自动评分卡（v1.7.3 BUG-6 修复）══════
  // GoalTracker.markDone 里项目全部完成时会调用此回调。
  // 静态回调只注册一次（判空防重复），异步创建评分卡，不阻塞主流程。
  if (!GoalTracker.onProjectCompleted) {
    GoalTracker.onProjectCompleted = (projectId: string) => {
      try {
        const goals = GoalTracker.list(projectId);
        if (goals.length === 0) return;
        const summary = GoalTracker.getProgressSummary(projectId);
        const goalText = summary
          .replace(/## 项目目标进度.*\n/, '')
          .trim()
          .split('\n')
          .map(line => line.replace(/^\s*[✅❌⏳🔄]\s*/, '').trim())
          .filter(Boolean)
          .join('；') || `项目 ${projectId} 的目标全部完成`;
        // 异步创建评分卡，失败不抛到调用方
        outcomeTracker.createCard(goalText, projectId, 'goal-tracker').then((card) => {
          console.log(`[GoalTracker] 项目 ${projectId} 全部完成 → 已自动生成评分卡 ${card.id}`);
        }).catch((e: any) => {
          console.error(`[GoalTracker] 自动生成评分卡失败:`, e?.message || e);
        });
      } catch (e: any) {
        console.error(`[GoalTracker] 完成回调异常:`, e?.message || e);
      }
    };
    console.log('[GoalTracker] 已注册「项目完成 → 自动评分卡」回调');
  }

  return router;
}
