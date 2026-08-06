/**
 * Provider 管理路由 — AI Provider 配置、模型管理
 */
import { Router } from 'express';
import type { ServerContext } from '../server/context.js';
import { INFERENCE_BACKENDS } from '../ai/custom-providers.js';

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
        // 清洗：只返回安全字段，加 hasKey
        const { client, ...safe } = hp;
        providers.push({ ...safe, hasKey: !!(safe.apiKey && safe.apiKey.length > 5) });
      }
      for (const p of providerRegistry.list() as any[]) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          const { client, ...safe } = p;
          providers.push({
            ...safe,
            hasKey: !!(safe.apiKey && safe.apiKey.length > 5),
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
      // 清洗掉 OpenAI client 实例（含循环引用，无法 JSON 序列化）
      const providers = (providerRegistry.list() as any[]).map(({ client, ...rest }) => ({
        ...rest,
        hasKey: !!(rest.apiKey && rest.apiKey.length > 5),
      }));
      res.json({ ok: true, providers });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 删除 Provider（前端调 /api/providers/:id）──
  router.delete('/providers/:id', (req, res) => {
    try {
      providerRegistry.unregister(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 删除 Provider 下指定模型 ──
  router.delete('/providers/:id/models/:modelName', (req, res) => {
    try {
      const ok = providerRegistry.removeModel(req.params.id, decodeURIComponent(req.params.modelName));
      res.json({ ok });
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
  router.get('/custom-providers/backends', (_req, res) => {
    try { res.json({ ok: true, backends: INFERENCE_BACKENDS }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

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

  // 从 admin.ts 迁移：测试自定义 Provider 连通性
  router.post('/custom-providers/test', async (req, res) => {
    try { const { baseURL, apiKey, models } = req.body; const result = await customProviderManager.testConnection({ id: 'test', name: 'test', baseURL, apiKey, models }); res.json({ ok: result.ok, models: result.models, error: result.error }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 从 admin.ts 迁移：自动检测 Provider 可用模型
  router.post('/custom-providers/:id/detect', async (req, res) => {
    try { const p = customProviderManager.get(req.params.id); if (!p) return res.status(404).json({ error: '不存在' }); const models = await customProviderManager.detectModels(p.baseURL, p.apiKey); res.json({ ok: true, models }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  return router;
}