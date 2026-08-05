import type { Express } from 'express';
import { Dreamer } from './core/dreamer.js';
import { EntityExtractor } from './core/entity-extractor.js';

function getAIHubClient(deps: any) {
  const aiHub = deps?.aiHub;
  if (!aiHub) return null;
  if (!aiHub) return null;

  // 优先用 AIHub.listProviders（比全局变量 __aiHub_providers 可靠）
  const hubProviders = aiHub.listProviders?.() || [];
  for (const p of hubProviders) {
    if (p.models?.length > 0) {
      const client = aiHub.getClient(p.models[0]);
      if (client) return { client: client.client, resolvedModel: client.resolvedModel };
    }
  }

  // Fallback to listModels
  const models = aiHub.listModels?.() || [];
  for (const m of models) {
    const client = aiHub.getClient(m.id);
    if (client) return { client: client.client, resolvedModel: client.resolvedModel };
  }

  return null;
}

export function registerV17Routes(app: Express, _deps: any, auth?: any) {
  // v2.0.6 修复：auth 参数为 requireAuth 中间件，保护 V17 路由不被未认证访问
  const guard = auth || ((_req: any, _res: any, next: any) => next());
  let _dreamer: any = null;
  let _entityExtractor: any = null;

  function getDreamer() {
    if (!_dreamer) {
      const c = getAIHubClient(_deps);
      if (c) { _dreamer = new Dreamer(c.client, c.resolvedModel); _dreamer.start(); }
    }
    return _dreamer;
  }

  function getEntityExtractor() {
    if (!_entityExtractor) {
      const c = getAIHubClient(_deps);
      if (c) _entityExtractor = new EntityExtractor(c.client, c.resolvedModel);
    }
    return _entityExtractor;
  }

  app.post('/api/dream', guard, (req, res) => {
    const d = getDreamer();
    if (!d) return res.json({ok:false,error:'Dreamer未就绪：请配置可用模型与API Key'});
    const { chatId, agentId } = req.body;
    d.dream(chatId, agentId).then((r: any) => res.json({ok:true,report:r})).catch((e: any) => res.json({ok:false,error:e.message}));
  });

  app.get('/api/entities', guard, (req, res) => {
    const e = getEntityExtractor();
    res.json({ok:true, entities: e?.getEntities((req.query.chatId as string)||'', (req.query.agentId as string)||'')||[]});
  });

  // v2.0.6: /api/outcomes 已由 routes/goals-outcomes.ts 提供；/api/logs 已由 index.ts 以 adminAuth 注册（更严格）

  console.log('[v1.7] 路由已注册: /api/dream, /api/entities');
}
