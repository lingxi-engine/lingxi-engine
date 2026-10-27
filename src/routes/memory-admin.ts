/**
 * 记忆管理 API 路由
 * 提供显式遗忘、修正、查询、压缩触发等管理接口
 * 供用户、管理员、前端调用
 */

import { Router, Request, Response } from 'express';
import { getDB } from '../storage/db.js';
import { globalDedup } from '../memory/semantic-dedup.js';
import { globalConflictDetector } from '../memory/fact-conflict-detector.js';
import { globalNightlyCompressor, NightlyCompressionOptions } from '../memory/memory-nightly-compress.js';
import { globalImportanceScorer } from '../memory/memory-importance.js';
import { revokeMemoryPattern, listRevokedPatterns, applyRevocations } from '../storage/db.js';

const router = Router();

/**
 * 认证中间件（复用现有的 requireAuth）
 * 实际使用时在 index.ts 中挂载前加上
 */
function requireAuth(req: Request, res: Response, next: Function) {
  // 这里假设前面已经有 auth 中间件挂载了 req.user
  if (!(req as any).user) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/**
 * 获取当前用户的 agentId
 */
function getAgentId(req: Request): string {
  const user = (req as any).user;
  // 优先用用户关联的 agent，兜底用默认
  return user?.agentId || `agent-u-${user?.id || 'unknown'}`;
}

/**
 * ==================== 显式遗忘/修正 API ====================
 */

/**
 * POST /api/memory/forget
 * 显式遗忘：从记忆中移除指定 key（软删除，留痕可审计）
 * Body: { keys: string[], chatId?: string, reason?: string }
 */
router.post('/forget', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = getAgentId(req);
    const { keys, chatId, reason = '用户主动遗忘' } = req.body as {
      keys: string[];
      chatId?: string;
      reason?: string;
    };

    if (!keys || !Array.isArray(keys) || keys.length === 0) {
      return res.status(400).json({ error: 'keys 必须是非空数组' });
    }

    const db = getDB();
    const results: Array<{ key: string; success: boolean; error?: string }> = [];

    for (const key of keys) {
      try {
        // 1. 从去重索引移除
        globalDedup.remove(key);

        // 2. 写入作废记录（软删除留痕）
        revokeMemoryPattern(chatId || null, agentId, key, reason);

        // 3. 从 facts 物理移除（可选：这里只做软删除，物理清理由夜间压缩处理）
        if (chatId) {
          const row = db.exec(
            `SELECT memory_facts FROM chat_memories WHERE chat_id = ? AND agent_id = ?`,
            [chatId, agentId]
          );
          if (row[0]?.values?.[0]?.[0]) {
            const facts = JSON.parse(String(row[0].values[0][0]));
            if (facts[key]) {
              delete facts[key];
              db.run(
                `UPDATE chat_memories SET memory_facts = ?, updated_at = ? WHERE chat_id = ? AND agent_id = ?`,
                [JSON.stringify(facts), Date.now(), chatId, agentId]
              );
            }
          }
        } else {
          const agent = db.exec(`SELECT memory_facts FROM agents WHERE id = ?`, [agentId]);
          if (agent[0]?.values?.[0]?.[0]) {
            const facts = JSON.parse(String(agent[0].values[0][0]));
            if (facts[key]) {
              delete facts[key];
              db.run(
                `UPDATE agents SET memory_facts = ? WHERE id = ?`,
                [JSON.stringify(facts), agentId]
              );
            }
          }
        }

        results.push({ key, success: true });
      } catch (e: any) {
        results.push({ key, success: false, error: e.message });
      }
    }

    res.json({ success: true, results });
  } catch (e: any) {
    console.error('[MemoryAdmin] forget error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/memory/correct
 * 显式修正：替换/更新指定 key 的值，自动触发冲突检测
 * Body: { key: string, newValue: string, chatId?: string, source?: 'user'|'assistant', confidence?: number }
 */
router.post('/correct', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = getAgentId(req);
    const { key, newValue, chatId, source = 'user', confidence = 1.0 } = req.body as {
      key: string;
      newValue: string;
      chatId?: string;
      source?: 'user' | 'assistant' | 'system' | 'inferred';
      confidence?: number;
    };

    if (!key || newValue === undefined) {
      return res.status(400).json({ error: 'key 和 newValue 必填' });
    }

    const db = getDB();
    const { updateAgentMemoryWithChecks, upsertChatMemoryWithChecks } = await import('../memory/memory-write-integration.js');

    let result;
    if (chatId) {
      result = await upsertChatMemoryWithChecks(chatId, agentId, '', { [key]: newValue }, {
        source,
        confidence,
        skipDedup: true,  // 修正操作跳过去重
        skipConflictCheck: false,  // 但要做冲突检测
      });
    } else {
      result = await updateAgentMemoryWithChecks(agentId, '', { [key]: newValue }, {
        source,
        confidence,
        skipDedup: true,
        skipConflictCheck: false,
      });
    }

    if (!result.success && result.conflicts) {
      return res.status(409).json({
        error: '检测到冲突',
        conflicts: result.conflicts,
        action: 'conflict_detected',
      });
    }

    res.json({ success: true, key, newValue, skippedKeys: result.skippedKeys });
  } catch (e: any) {
    console.error('[MemoryAdmin] correct error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/memory/facts
 * 查询当前用户的所有 facts（支持分页、分层筛选）
 * Query: chatId?, tier?, limit?, offset?
 */
router.get('/facts', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = getAgentId(req);
    const { chatId, tier, limit = '100', offset = '0' } = req.query;

    const db = getDB();
    let facts: Record<string, string> = {};

    if (chatId) {
      const row = db.exec(
        `SELECT memory_facts FROM chat_memories WHERE chat_id = ? AND agent_id = ?`,
        [chatId, agentId]
      );
      if (row[0]?.values?.[0]?.[0]) {
        facts = JSON.parse(String(row[0].values[0][0]));
      }
    } else {
      const agent = db.exec(`SELECT memory_facts FROM agents WHERE id = ?`, [agentId]);
      if (agent[0]?.values?.[0]?.[0]) {
        facts = JSON.parse(String(agent[0].values[0][0]));
      }
    }

    // 如果指定了 tier，需要打分后筛选
    let entries = Object.entries(facts);
    
    if (tier) {
      const scored = globalImportanceScorer.scoreBatch(
        entries.map(([key, value]) => ({ key, value }))
      );
      entries = scored
        .filter(f => f.tier === tier)
        .map(f => [f.key, f.value]);
    }

    const start = parseInt(offset as string);
    const lim = parseInt(limit as string);
    const paginated = entries.slice(start, start + lim);

    res.json({
      total: entries.length,
      facts: Object.fromEntries(paginated),
      tierDistribution: tier ? undefined : (() => {
        const scored = globalImportanceScorer.scoreBatch(
          entries.map(([key, value]) => ({ key, value }))
        );
        return {
          hot: scored.filter(f => f.tier === 'hot').length,
          warm: scored.filter(f => f.tier === 'warm').length,
          cold: scored.filter(f => f.tier === 'cold').length,
        };
      })(),
    });
  } catch (e: any) {
    console.error('[MemoryAdmin] facts query error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/memory/revoked
 * 查询已作废的记忆模式
 */
router.get('/revoked', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = getAgentId(req);
    const { chatId } = req.query;

    const patterns = listRevokedPatterns(chatId as string || null, agentId);
    res.json({ patterns });
  } catch (e: any) {
    console.error('[MemoryAdmin] revoked query error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * ==================== 压缩管理 API ====================
 */

/**
 * POST /api/memory/compress
 * 手动触发夜间压缩（干运行或实运行）
 * Body: { chatId?: string, apply?: boolean, options?: NightlyCompressionOptions }
 */
router.post('/compress', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = getAgentId(req);
    const { chatId, apply = false, options = {} } = req.body as {
      chatId?: string;
      apply?: boolean;
      options?: NightlyCompressionOptions;
    };

    const compressor = new (await import('../memory/memory-nightly-compress.js')).NightlyCompressor({
      ...options,
      apply,
    });

    const result = await compressor.compress(agentId, chatId);
    res.json({ success: true, result });
  } catch (e: any) {
    console.error('[MemoryAdmin] compress error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/memory/compress/all
 * 管理员触发全量压缩
 */
router.post('/compress/all', requireAuth, async (req: Request, res: Response) => {
  try {
    // 简单的管理员检查（实际应用更严格的 RBAC）
    const user = (req as any).user;
    if (user?.role !== 'admin') {
      return res.status(403).json({ error: '需要管理员权限' });
    }

    const { apply = false, options = {} } = req.body as {
      apply?: boolean;
      options?: NightlyCompressionOptions;
    };

    const compressor = new (await import('../memory/memory-nightly-compress.js')).NightlyCompressor({
      ...options,
      apply,
    });

    const results = await compressor.compressAll();
    res.json({ success: true, count: results.length, results });
  } catch (e: any) {
    console.error('[MemoryAdmin] compress all error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/memory/stats
 * 获取记忆统计信息
 */
router.get('/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = getAgentId(req);
    const { chatId } = req.query;

    const db = getDB();
    let factCount = 0;
    let summaryLen = 0;

    if (chatId) {
      const row = db.exec(
        `SELECT memory_facts, memory_summary FROM chat_memories WHERE chat_id = ? AND agent_id = ?`,
        [chatId, agentId]
      );
      if (row[0]?.values?.[0]?.[0]) {
        factCount = Object.keys(JSON.parse(String(row[0].values[0][0]))).length;
        summaryLen = String(row[0].values[0][1] || '').length;
      }
    } else {
      const agent = db.exec(`SELECT memory_facts, memory_summary FROM agents WHERE id = ?`, [agentId]);
      if (agent[0]?.values?.[0]?.[0]) {
        factCount = Object.keys(JSON.parse(String(agent[0].values[0][0]))).length;
        summaryLen = String(agent[0].values[0][1] || '').length;
      }
    }

    // 去重索引统计
    const dedupStats = (globalDedup as any).lsh ? {
      indexedKeys: (globalDedup as any).lsh.signatures.size,
      buckets: (globalDedup as any).lsh.buckets.size,
    } : { indexedKeys: 0, buckets: 0 };

    // 作废记录统计
    const revokedPatterns = listRevokedPatterns(chatId as string || null, agentId);

    res.json({
      agentId,
      chatId: chatId || null,
      factCount,
      summaryLength: summaryLen,
      dedupIndex: dedupStats,
      revokedCount: revokedPatterns.length,
      revokedPatterns: revokedPatterns.slice(0, 20), // 只返回前20个
    });
  } catch (e: any) {
    console.error('[MemoryAdmin] stats error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/memory/rebuild-dedup
 * 重建去重索引（迁移/修复时使用）
 */
router.post('/rebuild-dedup', requireAuth, async (req: Request, res: Response) => {
  try {
    const agentId = getAgentId(req);
    const { chatId } = req.body as { chatId?: string };

    const { rebuildDedupIndexFromDB } = await import('../memory/memory-write-integration.js');
    rebuildDedupIndexFromDB();

    res.json({ success: true, message: '去重索引已重建' });
  } catch (e: any) {
    console.error('[MemoryAdmin] rebuild-dedup error:', e);
    res.status(500).json({ error: e.message });
  }
});

export function createMemoryAdminRoutes() {
  return router;
}

export default router;