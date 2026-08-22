/**
 * AGI P0: 评测体系查询接口接线补丁
 * 1) router.ts 增加公开查询方法（getEvaluationSummary/getRecentEvaluations/getLastEvaluation）
 * 2) 新建 src/routes/evaluation.ts
 * 3) index.ts 注册挂载
 * 统一处理 CRLF：读入转 LF → 替换 → 写回转 CRLF
 */
const fs = require('fs');
const path = require('path');

const ROOT = 'C:/Users/Administrator/lingxi-engine';
const toLF = s => s.replace(/\r\n/g, '\n');
const toCRLF = s => s.replace(/\n/g, '\r\n');

function patchFile(rel, fn) {
  const p = path.join(ROOT, rel);
  const raw = fs.readFileSync(p, 'utf8');
  const lf = toLF(raw);
  const out = fn(lf);
  if (out === lf) {
    console.log(`[SKIP] ${rel}: 无变化`);
    return false;
  }
  fs.writeFileSync(p, toCRLF(out), 'utf8');
  console.log(`[OK] ${rel}: 已修补`);
  return true;
}

// ─── 1) router.ts ───
patchFile('src/core/router.ts', (src) => {
  let out = src;

  // 1a) 扩展类型导入
  const impOld = `import { Evaluator } from "./evaluator.js";`;
  const impNew = `import { Evaluator, type EvaluationSummary, type EvaluationRecord } from "./evaluator.js";`;
  if (out.includes(impOld) && !out.includes(impNew)) {
    out = out.replace(impOld, impNew);
  } else if (!out.includes(impNew)) {
    console.log('[WARN] router.ts 未找到 import 锚点');
  }

  // 1b) 类末尾追加公开查询方法（锚定 getRagContextForReply 结尾 + 类结束）
  const methodBlock = `
  // ─── AGI P0: 评测体系对外查询接口（供 /api/evaluations/* 使用）───
  /** 评测聚合统计 */
  getEvaluationSummary(filter: { agentId?: string; chatId?: string; model?: string; since?: number } = {}): EvaluationSummary {
    return this.evaluator.summary(filter);
  }

  /** 最近评测记录 */
  getRecentEvaluations(limit = 50): EvaluationRecord[] {
    return this.evaluator.recent(limit);
  }

  /** 最近一次评测 */
  getLastEvaluation(): EvaluationRecord | null {
    return this.evaluator.last();
  }
`;
  const anchor = `    } catch {\n      return '';\n    }\n  }\n}`;
  if (out.includes(anchor) && !out.includes('getEvaluationSummary')) {
    out = out.replace(anchor, `    } catch {\n      return '';\n    }\n  }${methodBlock}\n}`);
  } else if (!out.includes('getEvaluationSummary')) {
    console.log('[WARN] router.ts 未找到类结尾锚点');
  }

  return out;
});

// ─── 2) 新建 src/routes/evaluation.ts ───
const evalRoute = `/**
 * Evaluations 路由 — AGI P0: 评测体系对外查询接口
 *
 * 之前只记录了评测数据（evaluation-records.json），但没有任何出口能看到。
 * 本路由把"尺子"亮出来：聚合统计 / 最近记录 / 最近一条。
 *
 * GET /api/evaluations/summary?agentId=&chatId=&model=&since=
 * GET /api/evaluations/recent?limit=50
 * GET /api/evaluations/last
 */
import { Router } from 'express';
import type { ServerContext } from '../server/context.js';

export function createEvaluationRoutes(ctx: ServerContext): Router {
  const router = Router();

  /** 聚合统计：总分/通过率/修正率/问题分布/Top Agent/Top Model */
  router.get('/evaluations/summary', (req, res) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const summary = ctx.router.getEvaluationSummary({
        agentId: q.agentId || undefined,
        chatId: q.chatId || undefined,
        model: q.model || undefined,
        since: q.since ? Number(q.since) : undefined,
      });
      res.json({ ok: true, summary });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'summary failed' });
    }
  });

  /** 最近评测记录（倒序） */
  router.get('/evaluations/recent', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      res.json({ ok: true, records: ctx.router.getRecentEvaluations(limit) });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'recent failed' });
    }
  });

  /** 最近一条评测（快速验证用） */
  router.get('/evaluations/last', (_req, res) => {
    try {
      res.json({ ok: true, record: ctx.router.getLastEvaluation() });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'last failed' });
    }
  });

  return router;
}
`;
fs.writeFileSync(path.join(ROOT, 'src/routes/evaluation.ts'), evalRoute, 'utf8');
console.log('[OK] src/routes/evaluation.ts: 已创建');

// ─── 3) index.ts ───
patchFile('src/index.ts', (src) => {
  let out = src;

  // 3a) import
  const impOld = `import { createMiscRoutes } from './src/routes/misc.js';`;
  const impNew = `import { createMiscRoutes } from './src/routes/misc.js';\nimport { createEvaluationRoutes } from './src/routes/evaluation.js';`;
  if (out.includes(impOld) && !out.includes('createEvaluationRoutes')) {
    out = out.replace(impOld, impNew);
  }

  // 3b) 挂载：紧跟 misc 路由之后
  const mountOld = `app.use('/api', requireAuth, createMiscRoutes(ctx));`;
  const mountNew = `app.use('/api', requireAuth, createMiscRoutes(ctx));\n  app.use('/api', requireAuth, createEvaluationRoutes(ctx));  // AGI P0: 评测体系查询接口`;
  if (out.includes(mountOld) && !out.includes('createEvaluationRoutes(ctx)')) {
    out = out.replace(mountOld, mountNew);
  } else if (!out.includes('createEvaluationRoutes(ctx)')) {
    console.log('[WARN] index.ts 未找到挂载锚点');
  }

  return out;
});

console.log('DONE');
