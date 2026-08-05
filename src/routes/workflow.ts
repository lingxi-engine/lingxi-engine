/**
 * 工作流路由 — 工作流编排 CRUD
 */
import { Router } from 'express';
import { getDB } from '../storage/db.js';
import type { ServerContext } from '../server/context.js';

export function createWorkflowRoutes(_ctx: ServerContext): Router {
  const router = Router();

  router.get('/workflows', (_req, res) => {
    try {
      const stmt = getDB().prepare('SELECT id, name, created_at, updated_at FROM workflows ORDER BY updated_at DESC');
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json({ ok: true, workflows: rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/workflows/:id', (req, res) => {
    try {
      const stmt = getDB().prepare('SELECT * FROM workflows WHERE id = ?');
      stmt.bind([req.params.id]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '工作流不存在' });
      res.json({ ok: true, workflow: { ...row, data: JSON.parse(row.data) } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/workflows', (req, res) => {
    try {
      const { id, name, data } = req.body || {};
      if (!id || !name || !data) return res.status(400).json({ error: 'id/name/data 必填' });
      const now = Date.now();
      const stmt = getDB().prepare('INSERT OR REPLACE INTO workflows (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
      stmt.bind([id, name, JSON.stringify(data), now, now]);
      stmt.step();
      stmt.free();
      res.json({ ok: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/workflows/:id', (req, res) => {
    try {
      const { name, data } = req.body || {};
      const now = Date.now();
      if (name) {
        const stmt = getDB().prepare('UPDATE workflows SET name = ?, data = ?, updated_at = ? WHERE id = ?');
        stmt.bind([name, data ? JSON.stringify(data) : null, now, req.params.id]);
        stmt.step();
        stmt.free();
      }
      if (data) {
        const stmt = getDB().prepare('UPDATE workflows SET data = ?, updated_at = ? WHERE id = ?');
        stmt.bind([JSON.stringify(data), now, req.params.id]);
        stmt.step();
        stmt.free();
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/workflows/:id', (req, res) => {
    try {
      const stmt = getDB().prepare('DELETE FROM workflows WHERE id = ?');
      stmt.bind([req.params.id]);
      stmt.step();
      stmt.free();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}