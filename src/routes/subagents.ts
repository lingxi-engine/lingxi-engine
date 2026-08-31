/**
 * 子代理/多智能体协作路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 7/N）
 *
 * 抽取范围: 原 index.ts L1610-L1691（迁移前坐标）
 *   P1-3 子代理 API: GET /api/subagents | POST /api/subagents/spawn
 *                    POST /api/subagents/:id/steer | DELETE /api/subagents/:id
 *   v2.1 协作 API:   POST/GET /api/subagents/collab
 *                    GET /api/subagents/collab/:id | POST /api/subagents/collab/:id/cancel
 * 共 8 条路由
 * 原则: 业务代码逐行保真，仅做依赖注入改造（subAgentManager/broadcast/requireAuth 由宿主传入）
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查
 */
import type { Express, RequestHandler } from 'express';

export function registerSubAgentRoutes(app: Express, deps: {
  subAgentManager: any;
  broadcast: (event: any) => void;
  requireAuth: RequestHandler;
}) {
  const { subAgentManager, broadcast, requireAuth } = deps;

  // ── P1-3: 子代理 API ──
  app.get('/api/subagents', requireAuth, (req, res) => {
    try {
      const parentId = (req.query.parentId as string) || '';
      res.json({ ok: true, tasks: subAgentManager.list(parentId || undefined) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/subagents/spawn', requireAuth, async (req, res) => {
    try {
      const { objective, parentId, chatId, model, timeoutSeconds } = req.body;
      if (!objective || !parentId) return res.status(400).json({ error: 'objective/parentId 必填' });
      const taskId = await subAgentManager.spawn({
        objective,
        parentId,
        chatId: chatId || 'chat-default',
        model,
        timeoutSeconds,
      });
      res.json({ ok: true, taskId });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/subagents/:id/steer', requireAuth, (req, res) => {
    try {
      const ok = subAgentManager.steer(String(req.params.id), req.body.message);
      res.json({ ok });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/subagents/:id', requireAuth, (req, res) => {
    try {
      const ok = subAgentManager.kill(String(req.params.id));
      res.json({ ok });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  // ── v2.1: 多智能体协作 API ──
  app.post('/api/subagents/collab', requireAuth, async (req, res) => {
    try {
      const { mode, question, models, rounds, parentId, chatId, maxSpeakSeconds } = req.body;
      if (!mode || !question) return res.status(400).json({ error: 'mode/question 必填' });
      const validModes = ['voting', 'debate', 'roundtable', 'pipeline', 'review', 'orchestrator'];
      if (!validModes.includes(mode)) return res.status(400).json({ error: 'mode 必须是 ' + validModes.join('/') });
      const sessionId = await subAgentManager.collab({
        mode, question, models,
        rounds: typeof rounds === 'number' && rounds > 0 ? rounds : undefined,
        parentId: parentId || 'api-caller',
        chatId: chatId || 'chat-default',
        maxSpeakSeconds,
        onEvent: (evt: any) => {
          try {
            broadcast({
              type: 'collab.' + evt.type, chatId: evt.chatId, sessionId: evt.sessionId,
              mode: evt.mode, status: evt.status, round: evt.round, model: evt.model,
              transcript: evt.transcript, conclusion: evt.conclusion, error: evt.error,
            });
          } catch { /* ignore */ }
        },
      });
      res.json({ ok: true, sessionId });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/subagents/collab', requireAuth, (req, res) => {
    try { res.json({ ok: true, sessions: subAgentManager.listCollabs(50) }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/subagents/collab/:id', requireAuth, (req, res) => {
    try {
      const s = subAgentManager.getCollab(String(req.params.id));
      if (!s) return res.status(404).json({ error: '协作会话不存在' });
      res.json({ ok: true, session: s });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/subagents/collab/:id/cancel', requireAuth, (req, res) => {
    try { res.json({ ok: subAgentManager.killCollab(String(req.params.id)) }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}
