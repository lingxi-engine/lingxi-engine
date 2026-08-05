import type { Express } from 'express';
import { Dreamer } from './core/dreamer.js';
import { EntityExtractor } from './core/entity-extractor.js';

function getAIHubClient(deps: any) {
  const aiHub = deps?.aiHub;
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

export function registerV17Routes(app: Express, _deps: any, _auth?: any) {
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

  app.post('/api/dream', (req, res) => {
    const d = getDreamer();
    if (!d) return res.json({ok:false,error:'Dreamer未就绪：请配置可用模型与API Key'});
    const { chatId, agentId } = req.body;
    d.dream(chatId, agentId).then((r: any) => res.json({ok:true,report:r})).catch((e: any) => res.json({ok:false,error:e.message}));
  });

  app.get('/api/entities', (req, res) => {
    const e = getEntityExtractor();
    res.json({ok:true, entities: e?.getEntities((req.query.chatId as string)||'', (req.query.agentId as string)||'')||[]});
  });

  // NOTE:
  // 1. /api/outcomes 系列路由已由 routes/goals-outcomes.ts 统一提供（ctx.outcomeTracker 单实例）。
  //    旧实现在此注册会先于 goals-outcomes.ts 命中，导致「创建/列表」与「查询/删除」操作两个不同的
  //    OutcomeTracker 实例（共享同一 data/outcome-cards.json 但内存互不感知）→ 创建的卡片在 DELETE 里永远 404。
  //    修复：移除本文件的重复注册，统一走 createGoalOutcomeRoutes。
  // 2. /api/logs 已由 index.ts 注册（带 requireAuth）。本文件不注册，避免无鉴权版本先命中绕过鉴权。
  // 保留: /api/dream, /api/entities

  console.log('[v1.7] 路由已注册: /api/dream, /api/entities (outcomes/logs 已移交 index.ts 路由)');
}
