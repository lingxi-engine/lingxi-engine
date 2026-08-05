/**
 * Provider 管理路由 — AI Provider 配置、模型管理
 */
import { Router } from 'express';
import type { ServerContext } from '../server/context.js';

export function createProviderRoutes(ctx: ServerContext): Router {
  const router = Router();
  const { aiHub, providerRegistry, customProviderManager } = ctx;

  // ── Provider 配置 ──
  router.get('/ai/config', (_req, res) => {
    try {
      const seen = new Set<string>();
      const providers: any[] = [];
      for (const hp of (aiHub.listProviders?.() || []) as any[]) {
        seen.add(hp.id);
        providers.push(hp);
      }
      for (const p of providerRegistry.list() as any[]) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          providers.push({
            id: p.id, type: p.type, name: p.name,
            baseUrl: p.baseUrl, models: p.models,
            isLocal: p.isLocal, enabled: p.enabled,
          });
        }
      }
      res.json({ ok: true, defaultModel: process.env.DEFAULT_MODEL || 'deepseek-chat', providers });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.put('/ai/config', (req, res) => {
    try {
      const { defaultModel, providers } = req.body || {};
      if (defaultModel) {
        process.env.DEFAULT_MODEL = defaultModel;
        aiHub.setDefaultModel(defaultModel);
        console.log('[Providers] 默认模型已切换为:', defaultModel);
      }
      if (providers && Array.isArray(providers)) {
        for (const p of providers) {
          const existing = providerRegistry.list().find((x: any) => x.id === p.id);
          if (existing) {
            providerRegistry.unregister(existing.id);
          }
          providerRegistry.register({
            id: p.id, name: p.name || p.id, type: p.type || 'openai',
            apiKey: p.apiKey, baseUrl: p.baseUrl,
            models: p.models || [], isLocal: p.isLocal || false,
            enabled: p.enabled !== false,
          });
          try {
            aiHub.addProvider({
              id: p.id, type: p.type || 'openai',
              apiKey: p.apiKey, baseUrl: p.baseUrl,
              models: p.models || [], isLocal: p.isLocal || false,
            });
          } catch (e) { /* 同步失败不影响 */ }
        }
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/ai/providers/:id', (req, res) => {
    try {
      providerRegistry.unregister(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Provider 列表 ──
  router.get('/providers', (_req, res) => {
    try {
      res.json({ ok: true, providers: providerRegistry.list() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/providers', (req, res) => {
    try {
      const { id, name, type, apiKey, baseUrl, models, isLocal, enabled } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id 必填' });
      providerRegistry.register({
        id, name: name || id, type: type || 'openai',
        apiKey, baseUrl, models: models || [],
        isLocal: isLocal || false, enabled: enabled !== false,
      });
      try {
        aiHub.addProvider({
          id, type: type || 'openai', apiKey, baseUrl,
          models: models || [], isLocal: isLocal || false,
        });
      } catch (e) { /* ignore */ }
      res.json({ ok: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Provider 模型列表 ──
  router.get('/providers/models', (_req, res) => {
    try {
      res.json({ ok: true, models: providerRegistry.listModels() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 自定义 Provider ──
  router.get('/custom-providers', (_req, res) => {
    try {
      res.json({ ok: true, providers: customProviderManager.list() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/custom-providers', (req, res) => {
    try {
      const { id, name, baseURL, apiKey, models, autoDetect } = req.body || {};
      if (!id || !name || !baseURL) return res.status(400).json({ error: 'id, name 和 baseURL 必填' });
      customProviderManager.add({ id, name, baseURL, apiKey, models, autoDetect });
      res.json({ ok: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/custom-providers/:id', (req, res) => {
    try {
      customProviderManager.remove(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}