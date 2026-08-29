// 批次13d: providers 内联9条 → src/routes/provider.ts 真合并
// 原则: 全部前置断言通过才写盘; 自底向上 splice 保持索引有效
import fs from 'fs';

const IX = 'index.ts';
const PT = 'src/routes/provider.ts';
const src = fs.readFileSync(IX, 'utf8');
const EOL = src.includes('\r\n') ? '\r\n' : '\n';
let ls = src.split(/\r?\n/);
const total0 = ls.length;
console.log('PRE total lines =', total0);
if (total0 !== 2103) { console.log('FAIL total-lines'); process.exit(1); }

// ── 锚点查找(要求唯一) ──
function findUnique(sub) {
  const hits = [];
  ls.forEach((l, i) => { if (l.includes(sub)) hits.push(i); });
  if (hits.length !== 1) { console.log('FAIL anchor not unique:', sub, hits); process.exit(1); }
  return hits[0];
}
function expect(idx, sub, tag) {
  if (!ls[idx].includes(sub)) { console.log('FAIL expect', tag, idx, JSON.stringify(ls[idx])); process.exit(1); }
}

const iImp = findUnique("registerCustomProviderRoutes } from");
const iC1 = findUnique("P2-3: Provider 管理 API");
const iPutAi = findUnique("app.put('/api/ai/config'");
const iDelAi = findUnique("app.delete('/api/ai/providers/:id'");
const iGetP = findUnique("app.get('/api/providers'");
const iPostP = findUnique("app.post('/api/providers'");
const iDelP = findUnique("app.delete('/api/providers/:id/models/:model'");

// 边界校验
expect(iC1, '──', 'c1-head');
const c1s = iC1, c1e = iDelAi + 6;          // L855..L917
expect(c1e, '});', 'c1-end');
const c2s = iGetP, c2e = iGetP + 31;        // L919..L950(含尾空行)
expect(c2e - 2, 'res.status(500)', 'c2-tail');
expect(c2e, '', 'c2-blank');
const c3s = iPostP, c3e = iDelP + 12;       // L1076..L1214(含尾空行)
expect(c3e - 3, 'res.json({ ok: true, removed', 'c3-tail');
expect(c3e, '', 'c3-blank');
console.log('anchors OK:', { iImp, c1s, c1e, c2s, c2e, c3s, c3e });

// ── provider.ts 新内容(9条内联逐行保真, 路径剥/api, 顺序含 default 被 :id 遮蔽的祖传序) ──
const L = [];
L.push('/**');
L.push(' * Provider 管理路由 — 巨石拆分 批次13d: 内联9条真合并');
L.push(' * 来源: 原 index.ts L857-917 / L919-949 / L1076-1213(迁移前坐标)');
L.push(' *   GET    /api/ai/config              (双源: AIHub 优先 + Registry 补充)');
L.push(' *   PUT    /api/ai/config              (含 __aiHub_providers 镜像)');
L.push(' *   DELETE /api/ai/providers/:id       (registry + aiHub 双删)');
L.push(' *   GET    /api/providers              (AIHub 优先 + allModels 展平)');
L.push(' *   POST   /api/providers              (DEFAULT_BASE_URLS 表 + id 自动生成 + v1.9.6 按 ID 替换 + Agent 自动切换)');
L.push(' *   DELETE /api/providers/:id');
L.push(' *   PUT    /api/providers/:id          (replace 语义, 先删后加)');
L.push(' *   PUT    /api/providers/default      (注意: 注册在 /:id 之后, 祖传遮蔽序, 保真保留)');
L.push(' *   DELETE /api/providers/:id/models/:model');
L.push(' * 孤儿旧版(弱化实现, 从未挂载)全部退役; custom-providers 域归 custom-providers.ts, 此处不含');
L.push(' */');
L.push("import { Router } from 'express';");
L.push("import type { RequestHandler } from 'express';");
L.push('');
L.push('export function createProviderRoutes(deps: {');
L.push('  aiHub: any; providerRegistry: any; manager: any; db: any; requireAuth: RequestHandler;');
L.push('}): Router {');
L.push('  const { aiHub, providerRegistry, manager, db, requireAuth } = deps;');
L.push('  const router = Router();');
L.push('');
// 1 GET /ai/config
L.push("  router.get('/ai/config', requireAuth, (_req, res) => {");
L.push('    try {');
L.push('      const seen = new Set<string>();');
L.push('      const providers: any[] = [];');
L.push('      for (const hp of (aiHub.listProviders?.() || []) as any[]) {');
L.push('        seen.add(hp.id);');
L.push('        providers.push(hp);');
L.push('      }');
L.push('      for (const p of providerRegistry.list() as any[]) {');
L.push('        if (!seen.has(p.id)) {');
L.push('          seen.add(p.id);');
L.push("          providers.push({ id: p.id, type: p.type, name: p.name, baseUrl: p.baseUrl, models: p.models, isLocal: p.isLocal, enabled: p.enabled, hasKey: !!(p.apiKey && p.apiKey.length > 8 && !p.apiKey.startsWith('your-')) });");
L.push('        }');
L.push('      }');
L.push("      res.json({ ok: true, defaultModel: process.env.DEFAULT_MODEL || 'deepseek-chat', providers });");
L.push("    } catch (err: any) { res.status(500).json({ error: err.message }); }");
L.push('  });');
L.push('');
// 2 PUT /ai/config
L.push("  router.put('/ai/config', requireAuth, (req, res) => {");
L.push('    try {');
L.push('      const { defaultModel, providers } = req.body || {};');
L.push('      if (defaultModel) {');
L.push('        process.env.DEFAULT_MODEL = defaultModel;');
L.push('        aiHub.setDefaultModel(defaultModel);');
L.push("        console.log('[Providers] 默认模型已切换为:', defaultModel);");
L.push('      }');
L.push('      if (providers && Array.isArray(providers)) {');
L.push('        for (const p of providers) {');
L.push('          const existing = providerRegistry.list().find((x: any) => x.id === p.id);');
L.push('          if (existing) {');
L.push('            providerRegistry.unregister(existing.id);');
L.push('          }');
L.push('          providerRegistry.register({');
L.push("            id: p.id, name: p.name || p.id, type: p.type || 'openai',");
L.push('            apiKey: p.apiKey, baseUrl: p.baseUrl,');
L.push('            models: p.models || [], isLocal: p.isLocal || false,');
L.push('            enabled: p.enabled !== false,');
L.push('          });');
L.push('          try {');
L.push('            aiHub.addProvider({');
L.push("              id: p.id, type: p.type || 'openai',");
L.push('              apiKey: p.apiKey, baseUrl: p.baseUrl,');
L.push('              models: p.models || [], isLocal: p.isLocal || false,');
L.push('            });');
L.push("          } catch(e) { /* 同步失败不影响 */ }");
L.push('          const existingIdx = (globalThis as any).__aiHub_providers.findIndex((x: any) => x.id === p.id);');
L.push('          if (existingIdx >= 0) (globalThis as any).__aiHub_providers[existingIdx] = p;');
L.push('          else (globalThis as any).__aiHub_providers.push(p);');
L.push('        }');
L.push('      }');
L.push('      res.json({ ok: true });');
L.push("    } catch (err: any) { res.status(500).json({ error: err.message }); }");
L.push('  });');
L.push('');
// 3 DELETE /ai/providers/:id
L.push("  router.delete('/ai/providers/:id', requireAuth, (req, res) => {");
L.push('    try {');
L.push('      providerRegistry.unregister(String(req.params.id));');
L.push('      aiHub.removeProvider(String(req.params.id));');
L.push('      res.json({ ok: true });');
L.push("    } catch (err: any) { res.status(500).json({ error: err.message }); }");
L.push('  });');
L.push('');
// 4 GET /providers
L.push("  router.get('/providers', requireAuth, (_req, res) => {");
L.push('    try {');
L.push('      const seen = new Set<string>();');
L.push('      const providers: any[] = [];');
L.push('      const allModels: any[] = [];');
L.push('      ');
L.push('      // 1. AIHub 优先（启动时从 .env 加载的，URL 正确）');
L.push('      for (const hp of (aiHub.listProviders?.() || []) as any[]) {');
L.push('        seen.add(hp.id);');
L.push('        providers.push(hp);');
L.push('        for (const m of hp.models || []) {');
L.push('          allModels.push({ id: m, provider: hp.id, isLocal: hp.isLocal });');
L.push('        }');
L.push('      }');
L.push('      ');
L.push('      // 2. ProviderRegistry 补充（用户通过设置 UI 添加的）');
L.push('      for (const p of providerRegistry.list() as any[]) {');
L.push('        if (!seen.has(p.id)) {');
L.push('          seen.add(p.id);');
L.push("          providers.push({ id: p.id, type: p.type, name: p.name, baseUrl: p.baseUrl, models: p.models, isLocal: p.isLocal, enabled: p.enabled, hasKey: !!(p.apiKey && p.apiKey.length > 8 && !p.apiKey.startsWith('your-')) });");
L.push('          for (const m of p.models || []) {');
L.push('            if (!allModels.some(x => x.id === m)) {');
L.push('              allModels.push({ id: m, provider: p.id, isLocal: p.isLocal });');
L.push('            }');
L.push('          }');
L.push('        }');
L.push('      }');
L.push('      ');
L.push("      res.json({ ok: true, providers, models: allModels, defaultModel: process.env.DEFAULT_MODEL || aiHub.getDefaultModel() || '' });");
L.push("    } catch (err: any) { res.status(500).json({ error: err.message }); }");
L.push('  });');
L.push('');
// 5 POST /providers
L.push("  router.post('/providers', requireAuth, (req, res) => {");
L.push('    try {');
L.push('      // 补全 id 和 baseUrl（前端可能没传）');
L.push('      const DEFAULT_BASE_URLS: Record<string, string> = {');
L.push("        deepseek: 'https://api.deepseek.com/v1',");
L.push("        openai: 'https://api.openai.com/v1',");
L.push("        anthropic: 'https://api.anthropic.com/v1',");
L.push("        google: 'https://generativelanguage.googleapis.com/v1beta/openai',");
L.push("        minimax: 'https://api.minimax.io/v1',");
L.push("        moonshot: 'https://api.moonshot.cn/v1',");
L.push("        zhipu: 'https://open.bigmodel.cn/api/paas/v4',");
L.push("        qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',");
L.push("        stepfun: 'https://api.stepfun.com/v1',");
L.push("        siliconflow: 'https://api.siliconflow.cn/v1',");
L.push("        groq: 'https://api.groq.com/openai/v1',");
L.push("        openrouter: 'https://openrouter.ai/api/v1',");
L.push("        nvidia: 'https://integrate.api.nvidia.com/v1',");
L.push("        ollama: 'http://localhost:11434/v1',");
L.push("        'llama-cpp': 'http://localhost:8080/v1',");
L.push("        vllm: 'http://localhost:8000/v1',");
L.push("        'lm-studio': 'http://localhost:1234/v1',");
L.push("        tgi: 'http://localhost:8080/v1',");
L.push("        'text-gen-webui': 'http://localhost:5000/v1',");
L.push("        baidu: 'https://qianfan.baidubce.com/v2',");
L.push("        yi: 'https://api.lingyiwanwu.com/v1',");
L.push("        baichuan: 'https://api.baichuan-ai.com/v1',");
L.push("        iflytek: 'https://spark-api-open.xf-yun.com/v1',");
L.push("        volcengine: 'https://ark.cn-beijing.volces.com/api/v3',");
L.push("        tencent: 'https://api.hunyuan.cloud.tencent.com/v1',");
L.push("        mistral: 'https://api.mistral.ai/v1',");
L.push("        together: 'https://api.together.xyz/v1',");
L.push("        fireworks: 'https://api.fireworks.ai/inference/v1',");
L.push("        perplexity: 'https://api.perplexity.ai',");
L.push("        xai: 'https://api.x.ai/v1',");
L.push('      };');
L.push('      const body = {');
L.push('        ...req.body,');
L.push("        id: req.body.id || req.body.type + '-' + Date.now().toString(36),");
L.push("        baseUrl: req.body.baseUrl || DEFAULT_BASE_URLS[req.body.type] || '',");
L.push('      };');
L.push('');
L.push('      // v1.9.6: 只按 ID 精确匹配同 provider，不再按 type 误杀（避免 local-ollama 覆盖 ollama-cloud）');
L.push('      const existing = providerRegistry.list().find((p: any) => p.id === body.id);');
L.push('      if (existing) {');
L.push('        providerRegistry.unregister(existing.id);');
L.push('        aiHub.removeProvider(existing.id);  // ← 同步删除 AIHub 旧 provider');
L.push('      }');
L.push('      providerRegistry.register(body);');
L.push('      // 同步到 AI Hub');
L.push('      try {');
L.push('        aiHub.addProvider({');
L.push("          id: body.id, type: body.type || 'custom',");
L.push('          apiKey: body.apiKey || "", baseUrl: body.baseUrl,');
L.push('          models: body.models || [], isLocal: body.isLocal || false,');
L.push('        });');
L.push("      } catch(e) { console.warn('[Providers] AIHub 同步失败:', (e as Error).message); /* 同步失败不影响注册 */ }");
L.push('      // 自动切换所有 Agent 到新 Provider 的第一个模型');
L.push('      if (req.body.models && req.body.models.length > 0) {');
L.push('        try {');
L.push('          const newModel = req.body.models[0];');
L.push('          const agents = db.listAgents();');
L.push('          for (const agent of agents) {');
L.push('            manager.update(agent.id || agent.agent_id, { model: newModel });');
L.push('          }');
L.push('          console.log(`[Providers] ${agents.length} 个 Agent 已切换到模型: ${newModel}`);');
L.push('        } catch(e) { /* 切换失败不影响 */ }');
L.push('      }');
L.push('      res.json({ ok: true, id: req.body.id });');
L.push("    } catch (err: any) { res.status(400).json({ error: err.message }); }");
L.push('  });');
L.push('');
// 6 DELETE /providers/:id
L.push("  router.delete('/providers/:id', requireAuth, (req, res) => {");
L.push('    try {');
L.push('      providerRegistry.unregister(String(req.params.id));');
L.push('      aiHub.removeProvider(String(req.params.id));');
L.push('      res.json({ ok: true });');
L.push("    } catch (err: any) { res.status(500).json({ error: err.message }); }");
L.push('  });');
L.push('');
// 7 PUT /providers/:id (在 /default 之前 — 祖传遮蔽序, 保真)
L.push('  // PUT: 更新 Provider（主要用于前端修改 API Key）');
L.push("  router.put('/providers/:id', requireAuth, (req, res) => {");
L.push('    try {');
L.push('      const id = String(req.params.id);');
L.push('      const existing = providerRegistry.get(id);');
L.push("      if (!existing) return res.status(404).json({ error: 'Provider 不存在' });");
L.push('      const { apiKey, name, baseUrl, models } = req.body || {};');
L.push('      // 构造更新后的配置');
L.push('      const updated = {');
L.push('        id: existing.id,');
L.push('        type: existing.type,');
L.push('        name: name || existing.name,');
L.push('        apiKey: apiKey !== undefined ? apiKey : existing.apiKey,');
L.push('        baseUrl: baseUrl || existing.baseUrl,');
L.push('        models: models || existing.models,');
L.push('        isLocal: existing.isLocal,');
L.push('        enabled: existing.enabled,');
L.push('      };');
L.push('      // 先删后加（replace 语义）');
L.push('      providerRegistry.unregister(id);');
L.push('      aiHub.removeProvider(id);');
L.push('      providerRegistry.register(updated);');
L.push('      try {');
L.push('        aiHub.addProvider({');
L.push('          id: updated.id, type: updated.type as any,');
L.push("          apiKey: updated.apiKey || '', baseUrl: updated.baseUrl,");
L.push('          models: updated.models, isLocal: updated.isLocal,');
L.push('        } as any);');
L.push("      } catch(e) { console.warn('[Providers] AIHub 同步失败:', (e as Error).message); }");
L.push('      console.log(`[Providers] 已更新: ${id}`);');
L.push('      res.json({ ok: true, id });');
L.push("    } catch (err: any) { res.status(500).json({ error: err.message }); }");
L.push('  });');
L.push('');
// 8 PUT /providers/default
L.push('  // PUT: set default model');
L.push("  router.put('/providers/default', requireAuth, (req, res) => {");
L.push('    try {');
L.push('      const { model } = req.body;');
L.push("      if (!model) return res.status(400).json({ error: 'model 必填' });");
L.push('      process.env.DEFAULT_MODEL = model;');
L.push('      aiHub.setDefaultModel(model);');
L.push("      console.log('[Providers] 默认模型已切换为:', model);");
L.push('      res.json({ ok: true, defaultModel: model });');
L.push("    } catch (err: any) { res.status(500).json({ error: err.message }); }");
L.push('  });');
L.push('');
// 9 DELETE /providers/:id/models/:model
L.push('  // DELETE: 移除 Provider 下的单个模型');
L.push("  router.delete('/providers/:id/models/:model', requireAuth, (req, res) => {");
L.push('    try {');
L.push('      const providerId = String(req.params.id);');
L.push('      const modelName = String(req.params.model);');
L.push('      const ok = providerRegistry.removeModel(providerId, modelName);');
L.push("      if (!ok) return res.status(404).json({ error: '模型不存在' });");
L.push('      // 同步 AIHub');
L.push('      try { aiHub.removeProvider(providerId); const p = providerRegistry.get(providerId); if (p) aiHub.addProvider({ id: p.id, type: p.type as any, apiKey: p.apiKey || \'\', baseUrl: p.baseUrl, models: p.models, isLocal: p.isLocal } as any); } catch(_e) {}');
L.push('      console.log(`[Providers] 已移除模型: ${providerId}/${modelName}`);');
L.push('      res.json({ ok: true, removed: modelName });');
L.push("    } catch (err: any) { res.status(500).json({ error: err.message }); }");
L.push('  });');
L.push('');
L.push('  return router;');
L.push('}');
const pContent = L.join(EOL) + EOL;

// provider.ts 自检
const pChecks = [
  [/router\.get\(/g, 2], [/router\.post\(/g, 1], [/router\.put\(/g, 3], [/router\.delete\(/g, 3],
  [/requireAuth/g, 11], [/DEFAULT_BASE_URLS/g, 2], // 1 声明 + 1 使用
];
for (const [re, n] of pChecks) {
  const c = (pContent.match(re) || []).length;
  if (c !== n) { console.log('FAIL provider self-check', re, c, '!=', n); process.exit(1); }
}
if (pContent.indexOf("router.put('/providers/:id'") > pContent.indexOf("router.put('/providers/default'")) {
  console.log('FAIL shadow-order'); process.exit(1);
}
console.log('provider.ts self-check OK,', L.length, 'lines');

// ── index.ts 自底向上 splice ──
const mountBlock = [
  '  // ── P2-3: Provider 管理 API（批次13d: 9条迁移至 src/routes/provider.ts，挂载时拼回 /api 前缀）──',
  "  app.use('/api', createProviderRoutes({ aiHub, providerRegistry, manager, db, requireAuth } as any));",
];
const importLine = "import { createProviderRoutes } from './src/routes/provider.js';";
ls.splice(c3s, c3e - c3s + 1);
ls.splice(c2s, c2e - c2s + 1);
ls.splice(c1s, c1e - c1s + 1, ...mountBlock);
ls.splice(iImp + 1, 0, importLine);

// ── 后置断言 ──
const out = ls.join(EOL);
const post = [
  ["createProviderRoutes", 2],
  ["app.use('/api', createProviderRoutes", 1],
  ["app.post('/api/multi-ai'", 1],
  ["DEFAULT_BASE_URLS", 0],
  ["app.get('/api/ai/config'", 0],
  ["app.put('/api/ai/config'", 0],
  ["app.delete('/api/ai/providers/:id'", 0],
  ["app.get('/api/providers'", 0],
  ["app.post('/api/providers'", 0],
  ["app.delete('/api/providers/:id'", 0],
  ["app.put('/api/providers/:id'", 0],
  ["app.put('/api/providers/default'", 0],
];
let fail = false;
for (const [sub, n] of post) {
  const c = out.split(sub).length - 1;
  const ok = c === n;
  if (!ok) fail = true;
  console.log((ok ? 'PASS' : 'FAIL'), JSON.stringify(sub), '=', c, '(expect', n + ')');
}
const expectLines = 2103 - (c1e - c1s + 1) - (c2e - c2s + 1) - (c3e - c3s + 1) + mountBlock.length + 1;
console.log('lines:', ls.length, '(expect', expectLines + ')');
if (ls.length !== expectLines) fail = true;

if (fail) { console.log('*** ASSERTIONS FAILED — NO WRITE ***'); process.exit(1); }
fs.writeFileSync(PT, pContent);
fs.writeFileSync(IX, out);
console.log('WROTE', PT, 'and', IX, '— B13D PATCH OK');