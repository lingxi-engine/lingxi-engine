import type { Express } from 'express';
import { Dreamer } from './core/dreamer.js';
import { EntityExtractor } from './core/entity-extractor.js';
import { OutcomeTracker } from './core/outcome-tracker.js';
import { logger } from './core/logger.js';

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

export function registerV17Routes(app: Express, _deps: any) {
  let _dreamer: any = null;
  let _entityExtractor: any = null;
  let _outcomeTracker: any = null;

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

  function getOutcomeTracker() {
    if (!_outcomeTracker) {
      const c = getAIHubClient(_deps);
      if (c) _outcomeTracker = new OutcomeTracker(c.client, c.resolvedModel);
    }
    return _outcomeTracker;
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

  app.post('/api/outcomes', async (req, res) => {
    const o = getOutcomeTracker();
    if (!o) return res.json({ok:false,error:'OutcomeTracker未就绪：请配置可用模型与API Key'});
    try {
      const c = await o.createCard(req.body.goal, req.body.chatId, req.body.agentId);
      res.json({ok:true, card:c});
    } catch(e: any) { res.json({ok:false,error:e.message}); }
  });

  app.get('/api/outcomes', (req, res) => {
    const o = getOutcomeTracker();
    res.json({ok:true, cards: o?.list(req.query.chatId as string)||[]});
  });

  console.log('[v1.7] 路由已注册: /api/dream, /api/entities, /api/outcomes');
}