/**
 * 工作流/协作缓存路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 3/N）
 *
 * 抽取范围: 原 index.ts L627-693，共 6 条路由
 *   - /api/workflows GET/GET:id/POST/PUT:id/DELETE:id（5 条）
 *   - /api/collab-cache/:chatId DELETE（协作模式缓存清理）
 * 原则: 业务代码逐行保真，仅做依赖注入改造（requireAuth 由宿主传入）
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查
 */
import type { Express, RequestHandler } from 'express';
import { getDB } from '../storage/db.js';

export interface WorkflowsRouteDeps {
  requireAuth: RequestHandler;
}

export function registerWorkflowsRoutes(app: Express, deps: WorkflowsRouteDeps): void {
  const { requireAuth } = deps;

  // ── 工作流编排 API ──
  app.get('/api/workflows', requireAuth, (req, res) => {
    try {
      const stmt = getDB().prepare('SELECT id, name, created_at, updated_at FROM workflows ORDER BY updated_at DESC');
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json({ ok: true, workflows: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/workflows/:id', requireAuth, (req, res) => {
    try {
      const stmt = getDB().prepare('SELECT * FROM workflows WHERE id = ?');
      stmt.bind([req.params.id]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '工作流不存在' });
      res.json({ ok: true, workflow: { ...row, data: JSON.parse(row.data) } });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/workflows', requireAuth, (req, res) => {
    try {
      const { id, name, data } = req.body || {};
      if (!id || !name || !data) return res.status(400).json({ error: 'id/name/data 必填' });
      const now = Date.now();
      const stmt = getDB().prepare('INSERT OR REPLACE INTO workflows (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
      stmt.bind([id, name, JSON.stringify(data), now, now]);
      stmt.step(); stmt.free();
      res.json({ ok: true, id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/workflows/:id', requireAuth, (req, res) => {
    try {
      const { name, data } = req.body || {};
      const now = Date.now();
      if (name) {
        const stmt = getDB().prepare('UPDATE workflows SET name = ?, data = ?, updated_at = ? WHERE id = ?');
        stmt.bind([name, data ? JSON.stringify(data) : null, now, req.params.id]);
        stmt.step(); stmt.free();
      }
      if (data) {
        const stmt = getDB().prepare('UPDATE workflows SET data = ?, updated_at = ? WHERE id = ?');
        stmt.bind([JSON.stringify(data), now, req.params.id]);
        stmt.step(); stmt.free();
      }
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/workflows/:id', requireAuth, (req, res) => {
    try {
      const stmt = getDB().prepare('DELETE FROM workflows WHERE id = ?');
      stmt.bind([req.params.id]);
      stmt.step(); stmt.free();
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 清理协作模式缓存
  app.delete('/api/collab-cache/:chatId', requireAuth, (req, res) => {
    (globalThis as any).__chatModes?.delete(req.params.chatId);
    (globalThis as any).__roundRobinIdx?.delete(req.params.chatId);
    res.json({ ok: true });
  });
}
