/**
 * 灵犀 MVP 闭环 — HTTP 路由
 *
 * 全部端点：
 *   POST   /api/mvp/tasks                      创建任务（雇主）
 *   GET    /api/mvp/tasks                      浏览任务（公开，登录可选）
 *   GET    /api/mvp/tasks/:id                  任务详情 + 报价列表
 *   POST   /api/mvp/tasks/:id/cancel           取消任务（雇主）
 *   POST   /api/mvp/quotes                     提交报价
 *   POST   /api/mvp/quotes/:id/withdraw        撤回报价
 *   POST   /api/mvp/quotes/:id/accept          接受报价 → 生成合同（雇主）
 *   GET    /api/mvp/quotes/mine                我的报价
 *   GET    /api/mvp/contracts                  我的合同
 *   GET    /api/mvp/contracts/:id              合同详情
 *   POST   /api/mvp/contracts/:id/confirm      确认合同（承包方）
 *   POST   /api/mvp/contracts/:id/deliveries   提交交付物（承包方）
 *   POST   /api/mvp/deliveries/:id/accept      验收（雇主）
 *   POST   /api/mvp/deliveries/:id/revision    要求修改（雇主）
 *   GET    /api/mvp/contracts/:id/deliveries   交付物列表
 *   POST   /api/mvp/contracts/:id/rate         评价（雇主）
 *   POST   /api/mvp/contracts/:id/disputes     发起争议
 *   GET    /api/mvp/disputes                   争议列表（管理员全部 / 用户自己的）
 *   POST   /api/mvp/disputes/:id/resolve       处理争议（管理员）
 *   GET    /api/mvp/settlements                结算记录
 *   GET    /api/mvp/notifications              通知列表
 *   POST   /api/mvp/notifications/read         标记已读
 *   GET    /api/mvp/audit-logs                 审计日志
 *   PUT    /api/mvp/agents/:agentId/budget     设置智能体预算
 *   GET    /api/mvp/agents/:agentId/budget     查看智能体预算
 *   POST   /api/mvp/agents/:agentId/budget/spend  智能体花费记账
 *   POST   /api/mvp/agents/:agentId/suggestions   生成任务建议
 *   GET    /api/mvp/agents/:agentId/suggestions   查看任务建议
 *
 * 安全设计：
 *  - 所有写操作强制 jwtAuth({required:true})
 *  - 身份一律取自 req.user.sub，绝不信任 req.body.userId
 *  - 资源归属校验在 service 层完成（越权返回 403）
 *  - 管理员操作校验 roles 包含 admin
 */

import { Router } from 'express';
import { MvpMarketService, MvpMarketError } from '../core/mvp-market/service.js';

interface Ctx {
  db: any;
  requireAuth: any;
  optAuth: any;
  adminAuth: any;
}

export function createMvpMarketRoutes(ctx: Ctx): Router {
  const router = Router();
  const svc = new MvpMarketService(ctx.db);
  const requireAuth = ctx.requireAuth;
  const optAuth = ctx.optAuth;
  const adminAuth = ctx.adminAuth;

  const uid = (req: any): string => String(req.user?.sub ?? req.user?.id ?? '');
  const isAdmin = (req: any): boolean => {
    const roles: string[] = req.user?.roles ?? [];
    return roles.includes('admin') || roles.includes('superadmin') || uid(req) === 'admin';
  };
  const ip = (req: any): string => String(req.ip ?? req.headers?.['x-forwarded-for'] ?? '');
  const wrap = (fn: (req: any, res: any) => void) => (req: any, res: any) => {
    try { fn(req, res); } catch (e: any) {
      if (e instanceof MvpMarketError) {
        return res.status(e.status).json({ ok: false, error: { code: e.code, message: e.message } });
      }
      console.error('[mvp] 未处理异常:', e);
      return res.status(500).json({ ok: false, error: { code: 'internal', message: e?.message || '服务器内部错误' } });
    }
  };

  // ══════════════════ 任务 ══════════════════

  router.post('/tasks', requireAuth, wrap((req, res) => {
    const task = svc.createTask({
      employerId: uid(req),
      title: req.body?.title,
      description: req.body?.description,
      category: req.body?.category,
      budget: req.body?.budget,
      currency: req.body?.currency,
      deadlineAt: req.body?.deadlineAt ?? null,
    });
    res.status(201).json({ ok: true, task });
  }));

  router.get('/tasks', optAuth, wrap((req, res) => {
    const tasks = svc.listTasks({
      status: req.query.status as string | undefined,
      category: req.query.category as string | undefined,
      employerId: req.query.employerId as string | undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ ok: true, tasks });
  }));

  router.get('/tasks/:id', optAuth, wrap((req, res) => {
    const task = svc.getTask(String(req.params.id));
    const quotes = svc.listQuotesByTask(task.id);
    // 非任务发布者看不到他人报价金额（防价格串通）
    const isOwner = uid(req) === task.employer_id;
    res.json({
      ok: true,
      task,
      quotes: isOwner ? quotes : quotes.map((q) => ({ ...q, amount: undefined, message: q.message })),
      quoteCount: quotes.length,
    });
  }));

  router.post('/tasks/:id/cancel', requireAuth, wrap((req, res) => {
    const task = svc.cancelTask(uid(req), String(req.params.id));
    res.json({ ok: true, task });
  }));

  // ══════════════════ 报价 ══════════════════

  router.post('/quotes', requireAuth, wrap((req, res) => {
    const quote = svc.submitQuote({
      taskId: String(req.body?.taskId ?? ''),
      bidderId: uid(req),
      amount: req.body?.amount,
      message: req.body?.message,
      deliveryDays: req.body?.deliveryDays,
    });
    res.status(201).json({ ok: true, quote });
  }));

  router.get('/quotes/mine', requireAuth, wrap((req, res) => {
    res.json({ ok: true, quotes: svc.listQuotesByBidder(uid(req)) });
  }));

  router.post('/quotes/:id/withdraw', requireAuth, wrap((req, res) => {
    const quote = svc.withdrawQuote(uid(req), String(req.params.id));
    res.json({ ok: true, quote });
  }));

  router.post('/quotes/:id/accept', requireAuth, wrap((req, res) => {
    const contract = svc.acceptQuote(uid(req), String(req.params.id), req.body?.terms);
    res.status(201).json({ ok: true, contract });
  }));

  // ══════════════════ 合同 ══════════════════

  router.get('/contracts', requireAuth, wrap((req, res) => {
    const all = svc.listContractsByUser(uid(req));
    res.json({ ok: true, contracts: all });
  }));

  router.get('/contracts/:id', requireAuth, wrap((req, res) => {
    const contract = svc.getContract(String(req.params.id));
    const me = uid(req);
    if (contract.employer_id !== me && contract.contractor_id !== me && !isAdmin(req)) {
      return res.status(403).json({ ok: false, error: { code: 'forbidden', message: '无权查看该合同' } });
    }
    res.json({
      ok: true,
      contract,
      deliveries: svc.listDeliveries(contract.id),
      ratings: svc.listRatingsForUser(contract.contractor_id),
    });
  }));

  router.post('/contracts/:id/confirm', requireAuth, wrap((req, res) => {
    const contract = svc.confirmContract(uid(req), String(req.params.id));
    res.json({ ok: true, contract });
  }));

  router.get('/contracts/:id/deliveries', requireAuth, wrap((req, res) => {
    const contract = svc.getContract(String(req.params.id));
    const me = uid(req);
    if (contract.employer_id !== me && contract.contractor_id !== me && !isAdmin(req)) {
      return res.status(403).json({ ok: false, error: { code: 'forbidden', message: '无权查看该合同交付物' } });
    }
    res.json({ ok: true, deliveries: svc.listDeliveries(contract.id) });
  }));

  router.post('/contracts/:id/deliveries', requireAuth, wrap((req, res) => {
    const delivery = svc.submitDelivery({
      contractId: String(req.params.id),
      submitterId: uid(req),
      content: req.body?.content,
    });
    res.status(201).json({ ok: true, delivery });
  }));

  router.post('/contracts/:id/rate', requireAuth, wrap((req, res) => {
    const rating = svc.rateContract(uid(req), String(req.params.id), req.body?.rating, req.body?.comment);
    res.status(201).json({ ok: true, rating });
  }));

  router.post('/contracts/:id/disputes', requireAuth, wrap((req, res) => {
    const dispute = svc.openDispute({
      contractId: String(req.params.id),
      initiatorId: uid(req),
      reason: req.body?.reason,
      evidence: req.body?.evidence,
      deliveryId: req.body?.deliveryId ?? null,
    });
    res.status(201).json({ ok: true, dispute });
  }));

  // ══════════════════ 交付物 ══════════════════

  router.post('/deliveries/:id/accept', requireAuth, wrap((req, res) => {
    const result = svc.acceptDelivery(uid(req), String(req.params.id));
    res.json({ ok: true, ...result });
  }));

  router.post('/deliveries/:id/revision', requireAuth, wrap((req, res) => {
    const delivery = svc.requestRevision(uid(req), String(req.params.id), req.body?.note);
    res.json({ ok: true, delivery });
  }));

  // ══════════════════ 争议 ══════════════════

  router.get('/disputes', requireAuth, wrap((req, res) => {
    if (isAdmin(req)) {
      return res.json({ ok: true, disputes: svc.listDisputes({ status: req.query.status as string | undefined }) });
    }
    // 普通用户只能看自己合同相关的争议
    const me = uid(req);
    const mine = svc.listContractsByUser(me).map((c) => c.id);
    const all = svc.listDisputes({ status: req.query.status as string | undefined, limit: 500 });
    res.json({ ok: true, disputes: all.filter((d) => mine.includes(d.contract_id) || d.initiator_id === me) });
  }));

  router.post('/disputes/:id/resolve', requireAuth, adminAuth, wrap((req, res) => {
    const decision = String(req.body?.decision ?? '');
    if (!['release', 'refund', 'partial'].includes(decision)) {
      return res.status(400).json({ ok: false, error: { code: 'invalid_decision', message: 'decision 必须是 release/refund/partial' } });
    }
    const result = svc.resolveDispute({
      adminId: uid(req),
      disputeId: String(req.params.id),
      decision: decision as any,
      resolution: req.body?.resolution,
      refundAmount: req.body?.refundAmount,
    });
    res.json({ ok: true, ...result });
  }));

  // ══════════════════ 结算 ══════════════════

  router.get('/settlements', requireAuth, wrap((req, res) => {
    res.json({
      ok: true,
      settlements: svc.listSettlements({
        userId: isAdmin(req) ? (req.query.userId as string | undefined) : uid(req),
        contractId: req.query.contractId as string | undefined,
      }),
    });
  }));

  // ══════════════════ 通知 ══════════════════

  router.get('/notifications', requireAuth, wrap((req, res) => {
    const me = uid(req);
    res.json({
      ok: true,
      notifications: svc.listNotifications(me, req.query.unread === '1'),
      unread: svc.unreadCount(me),
    });
  }));

  router.post('/notifications/read', requireAuth, wrap((req, res) => {
    const me = uid(req);
    if (req.body?.id) {
      svc.markNotificationRead(me, String(req.body.id));
      return res.json({ ok: true, unread: svc.unreadCount(me) });
    }
    if (req.body?.all) {
      svc.markAllNotificationsRead(me);
      return res.json({ ok: true, unread: svc.unreadCount(me) });
    }
    res.status(400).json({ ok: false, error: { code: 'invalid_request', message: '需要 id 或 all=true' } });
  }));

  // ══════════════════ 审计日志 ══════════════════

  router.get('/audit-logs', requireAuth, wrap((req, res) => {
    const me = uid(req);
    // 普通用户只能看自己的审计记录；管理员可查全部
    if (isAdmin(req) && req.query.actorId) {
      return res.json({ ok: true, logs: svc.listAuditLogs({ actorId: String(req.query.actorId), limit: req.query.limit ? Number(req.query.limit) : undefined }) });
    }
    res.json({
      ok: true,
      logs: svc.listAuditLogs({ actorId: me, limit: req.query.limit ? Number(req.query.limit) : undefined }),
    });
  }));

  // ══════════════════ 智能体预算 ══════════════════

  router.put('/agents/:agentId/budget', requireAuth, wrap((req, res) => {
    const budget = svc.setAgentBudget({
      agentId: String(req.params.agentId),
      ownerId: uid(req),
      totalBudget: req.body?.totalBudget,
      currency: req.body?.currency,
      period: req.body?.period,
    });
    res.json({ ok: true, budget });
  }));

  router.get('/agents/:agentId/budget', requireAuth, wrap((req, res) => {
    const budget = svc.getAgentBudget(String(req.params.agentId));
    if (!budget) return res.status(404).json({ ok: false, error: { code: 'not_found', message: '预算未设置' } });
    if (budget.owner_id !== uid(req) && !isAdmin(req)) {
      return res.status(403).json({ ok: false, error: { code: 'forbidden', message: '无权查看该智能体预算' } });
    }
    res.json({ ok: true, budget });
  }));

  router.post('/agents/:agentId/budget/spend', requireAuth, wrap((req, res) => {
    const budget = svc.spendAgentBudget({
      agentId: String(req.params.agentId),
      ownerId: uid(req),
      amount: req.body?.amount,
      reason: req.body?.reason ?? '',
    });
    res.json({ ok: true, budget });
  }));

  // ══════════════════ 智能体任务建议 ══════════════════

  router.post('/agents/:agentId/suggestions', requireAuth, wrap((req, res) => {
    const suggestions = svc.generateTaskSuggestions({
      agentId: String(req.params.agentId),
      ownerId: uid(req),
      skills: req.body?.skills,
      limit: req.body?.limit,
    });
    res.status(201).json({ ok: true, suggestions });
  }));

  router.get('/agents/:agentId/suggestions', requireAuth, wrap((req, res) => {
    res.json({
      ok: true,
      suggestions: svc.listTaskSuggestions(String(req.params.agentId), uid(req)),
    });
  }));

  return router;
}
