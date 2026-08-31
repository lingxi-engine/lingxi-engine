/**
 * 自定义 Provider 路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 8/N）
 *
 * 抽取范围: 原 index.ts L1760-L1800（迁移前坐标）
 *   V5 P6 自定义 Provider API:
 *     GET    /api/custom-providers/backends
 *     GET    /api/custom-providers
 *     POST   /api/custom-providers
 *     DELETE /api/custom-providers/:id
 *     POST   /api/custom-providers/test
 *     POST   /api/custom-providers/:id/detect
 * 共 6 条路由
 * 原则: 业务代码逐行保真，仅做依赖注入改造（INFERENCE_BACKENDS/customProviderManager/requireAuth 由宿主传入）
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查
 */
import type { Express, RequestHandler } from 'express';
import type { CustomProviderManager } from '../ai/custom-providers.js';

export function registerCustomProviderRoutes(app: Express, deps: {
  INFERENCE_BACKENDS: readonly any[];
  customProviderManager: CustomProviderManager;
  requireAuth: RequestHandler;
}) {
  const { INFERENCE_BACKENDS, customProviderManager, requireAuth } = deps;

  // ── V5 P6: 自定义 Provider API ──
  app.get('/api/custom-providers/backends', requireAuth, (_req, res) => {
    try { res.json({ ok: true, backends: INFERENCE_BACKENDS }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/custom-providers', requireAuth, (_req, res) => {
    try { res.json({ ok: true, providers: customProviderManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/custom-providers', requireAuth, (req, res) => {
    try {
      const { id, name, baseURL, apiKey, models, autoDetect } = req.body;
      if (!id || !baseURL) return res.status(400).json({ error: 'id/baseURL 必填' });
      customProviderManager.add({ id, name: name || id, baseURL, apiKey, models, autoDetect });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/custom-providers/:id', requireAuth, (req, res) => {
    try { customProviderManager.remove(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/custom-providers/test', requireAuth, async (req, res) => {
    try {
      const { baseURL, apiKey, models } = req.body;
      const result = await customProviderManager.testConnection({ id: 'test', name: 'test', baseURL, apiKey, models });
      res.json({ ok: result.ok, models: result.models, error: result.error });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/custom-providers/:id/detect', requireAuth, async (req, res) => {
    try {
      const p = customProviderManager.get(String(req.params.id));
      if (!p) return res.status(404).json({ error: '不存在' });
      const models = await customProviderManager.detectModels(p.baseURL, p.apiKey);
      res.json({ ok: true, models });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}