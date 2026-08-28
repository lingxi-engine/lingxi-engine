/**
 * Agent 路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 6/N）
 *
 * 抽取范围: 原 index.ts 三段孤岛（迁移前坐标）
 *   A: L603-624  POST /api/agents/register（含 P0-5 越权防护 + syncAgentToPrivateChats 私聊同步）
 *   B: L762-781  GET/PUT /api/agents/:id/memory + GET /api/agents
 *   C: L996-1022 PATCH /api/agents/:id + POST /api/agents/:id/skills + POST /api/agents/:id/reflect
 * 共 7 条路由
 * 原则: 业务代码逐行保真，仅做依赖注入改造（db/manager/router/toolRegistry/requireAuth 由宿主传入，
 *       syncAgentToPrivateChats 从 storage/db.js 直接 import）
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查
 */
import type { Express, RequestHandler } from 'express';
import { syncAgentToPrivateChats } from '../storage/db.js';

export function registerAgentsRoutes(app: Express, deps: {
  db: any;
  manager: any;
  router: any;
  toolRegistry: any;
  requireAuth: RequestHandler;
}) {
  const { db, manager, router, toolRegistry, requireAuth } = deps;

  app.post('/api/agents/register', requireAuth, (req, res) => {
    try {
      const { userId, displayName, personality, autonomy } = req.body;
      if (!userId || !displayName) return res.status(400).json({ error: 'userId 和 displayName 必填' });
      // P0-5 修复: 越权防护 — 校验 userId 是否为 JWT 持有者
      const jwtUser = (req as any).user;
      const jwtUserId = jwtUser?.sub || jwtUser?.id || '';
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      if (jwtUserId && jwtUserId !== userId && jwtNumericId !== userId) {
        return res.status(403).json({ error: '无权为他人创建 agent' });
      }
      const agent = manager.register(userId, displayName, personality || '你是一个友好的 AI 助手', autonomy || 'semi');
      // 新 agent 补到已有私聊
      try {
        const synced = syncAgentToPrivateChats(userId);
        if (synced > 0) console.log('[Friends] agent synced to', synced, 'private chats');
      } catch(_e) {}
      res.json({ ok: true, agent });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/agents/:id/memory', requireAuth, (req, res) => {
    try {
      const agent = db.getAgent(String(req.params.id));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json({ ok: true, memory: agent.memory_summary || '', personality: agent.personality || '' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/agents/:id/memory', requireAuth, (req, res) => {
    try {
      const { personality, memory } = req.body || {};
      db.updateAgent(String(req.params.id), { personality: personality || undefined, memory_summary: memory || undefined });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/agents', requireAuth, (_req, res) => {
    try { res.json({ ok: true, agents: manager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── Agent 更新 API ──
  app.patch('/api/agents/:id', requireAuth, (req, res) => {
    try {
      const updates = req.body;
      const agent = manager.update(String(req.params.id), updates);
      res.json({ ok: true, agent });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── Agent 绑定技能 API ──
  app.post('/api/agents/:id/skills', requireAuth, (req, res) => {
    try {
      const { skillIds } = req.body;
      if (!Array.isArray(skillIds)) return res.status(400).json({ error: 'skillIds 必须是数组' });
      toolRegistry.bindSkills(String(req.params.id), skillIds);
      res.json({ ok: true, agentId: String(req.params.id), skills: skillIds });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  // 鈹€鈹€ 璁板繂鍙嶆€?API 鈹€鈹€锛堝墠绔?reflectMemory() 璋冪敤锛?
  app.post('/api/agents/:id/reflect', requireAuth, async (req, res) => {
    try {
      const agentId = String(req.params.id);
      const chatId = (req.body && req.body.chatId) ? String(req.body.chatId) : undefined;
      const result = await router.reflectAgent(agentId, chatId);
      res.json(result);
    } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });
}
