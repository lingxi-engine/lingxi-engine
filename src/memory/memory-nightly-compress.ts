/**
 * 夜间记忆摘要压缩模块
 * 定时任务：每日凌晨运行，将低重要性 facts 压缩为摘要向量，释放存储空间
 * 保留高重要性 facts 完整存储，中等重要性生成语义摘要
 */

import { getDB } from '../storage/db.js';
import { globalImportanceScorer, ScoredFact, inferEntityType } from './memory-importance.js';
import { globalDedup } from './semantic-dedup.js';

export interface CompressionResult {
  agentId: string;
  chatId?: string;
  originalFactCount: number;
  compressedFactCount: number;
  hotCount: number;
  warmCount: number;
  coldCount: number;
  summaryVector: number[] | null;  // 压缩后的语义摘要向量
  removedKeys: string[];
  keptKeys: string[];
  summaryText: string;  // 人类可读的摘要文本
  timestamp: number;
}

export interface NightlyCompressionOptions {
  /** 最小事实数量，少于此数不压缩 */
  minFacts?: number;
  /** 冷事实压缩比例 (0-1) */
  coldCompressionRatio?: number;
  /** 温事实保留比例 (0-1) */
  warmRetentionRatio?: number;
  /** 是否真正写入数据库（false = dry run） */
  apply?: boolean;
  /** 自定义 LLM 摘要生成函数 */
  llmSummarize?: (facts: ScoredFact[]) => Promise<string>;
}

/**
 * 夜间压缩器
 */
export class NightlyCompressor {
  // [TS FIX] llmSummarize 是可选回调，用 Required<> 会让类型声称必填但值仍可能 undefined。
  // 这里显式排除它，保持可选语义。
  private options: Omit<Required<NightlyCompressionOptions>, 'llmSummarize'> & { llmSummarize?: (facts: ScoredFact[]) => Promise<string> };

  constructor(options: NightlyCompressionOptions = {}) {
    this.options = {
      minFacts: options.minFacts ?? 50,
      coldCompressionRatio: options.coldCompressionRatio ?? 0.8,  // 80% 的冷事实压缩
      warmRetentionRatio: options.warmRetentionRatio ?? 0.5,      // 50% 的温事实保留
      apply: options.apply ?? false,
      llmSummarize: options.llmSummarize,
    };
  }

  /**
   * 执行单个 agent（可选 chat）的夜间压缩
   */
  async compress(agentId: string, chatId?: string): Promise<CompressionResult> {
    const scoredFacts = await globalImportanceScorer.scoreFromDB(agentId, chatId);
    
    if (scoredFacts.length < this.options.minFacts) {
      return this.emptyResult(agentId, chatId, scoredFacts.length);
    }

    // 分层统计
    const hot = scoredFacts.filter(f => f.tier === 'hot');
    const warm = scoredFacts.filter(f => f.tier === 'warm');
    const cold = scoredFacts.filter(f => f.tier === 'cold');

    // 决定保留/压缩
    const keptKeys: string[] = [];
    const removedKeys: string[] = [];
    const factsToSummarize: ScoredFact[] = [];

    // Hot: 全部保留
    for (const f of hot) keptKeys.push(f.key);

    // Warm: 按比例保留（按重要性排序保留前 N 个）
    const warmSorted = [...warm].sort((a, b) => b.importance - a.importance);
    const warmKeepCount = Math.ceil(warmSorted.length * this.options.warmRetentionRatio);
    for (let i = 0; i < warmSorted.length; i++) {
      if (i < warmKeepCount) keptKeys.push(warmSorted[i].key);
      else { factsToSummarize.push(warmSorted[i]); removedKeys.push(warmSorted[i].key); }
    }

    // Cold: 大部分压缩，保留极少数最高分的
    const coldSorted = [...cold].sort((a, b) => b.importance - a.importance);
    const coldKeepCount = Math.ceil(coldSorted.length * (1 - this.options.coldCompressionRatio));
    for (let i = 0; i < coldSorted.length; i++) {
      if (i < coldKeepCount) keptKeys.push(coldSorted[i].key);
      else { factsToSummarize.push(coldSorted[i]); removedKeys.push(coldSorted[i].key); }
    }

    // 生成语义摘要
    const summaryText = await this.generateSummary(factsToSummarize, hot, warm);
    const summaryVector = this.generateSummaryVector(factsToSummarize);

    // 如果 apply=true，写入数据库
    if (this.options.apply) {
      await this.persistCompression(agentId, chatId, keptKeys, removedKeys, summaryText, summaryVector);
    }

    return {
      agentId,
      chatId,
      originalFactCount: scoredFacts.length,
      compressedFactCount: keptKeys.length,
      hotCount: hot.length,
      warmCount: warm.length,
      coldCount: cold.length,
      summaryVector,
      removedKeys,
      keptKeys,
      summaryText,
      timestamp: Date.now(),
    };
  }

  /**
   * 批量压缩所有 agent
   */
  async compressAll(): Promise<CompressionResult[]> {
    const db = getDB();
    const agents = db.exec(`SELECT id FROM agents WHERE memory_facts IS NOT NULL AND memory_facts != '{}'`);
    const results: CompressionResult[] = [];

    if (agents[0]?.values) {
      for (const row of agents[0].values) {
        const agentId = String(row[0]);
        try {
          const result = await this.compress(agentId);
          results.push(result);
        } catch (e) {
          console.error(`[NightlyCompress] agent ${agentId} failed:`, e);
        }
      }
    }

    // 处理 chat 级记忆
    const chatMems = db.exec(`SELECT DISTINCT chat_id, agent_id FROM chat_memories WHERE memory_facts IS NOT NULL AND memory_facts != '{}'`);
    if (chatMems[0]?.values) {
      for (const row of chatMems[0].values) {
        const chatId = String(row[0]);
        const agentId = String(row[1]);
        try {
          const result = await this.compress(agentId, chatId);
          results.push(result);
        } catch (e) {
          console.error(`[NightlyCompress] chat ${chatId} agent ${agentId} failed:`, e);
        }
      }
    }

    return results;
  }

  /**
   * 生成人类可读的摘要文本
   */
  private async generateSummary(
    compressed: ScoredFact[],
    hot: ScoredFact[],
    warm: ScoredFact[]
  ): Promise<string> {
    if (compressed.length === 0) return '';

    // 如果有 LLM 摘要函数，优先使用
    if (this.options.llmSummarize) {
      try {
        return await this.options.llmSummarize(compressed);
      } catch (e) {
        console.warn('[NightlyCompress] LLM summarize failed, fallback to template:', e);
      }
    }

    // 模板式摘要生成
    const byType = new Map<string, ScoredFact[]>();
    for (const f of compressed) {
      const type = inferEntityType(f.key, f.value) || 'fact';
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(f);
    }

    const parts: string[] = [];
    parts.push(`[夜间压缩摘要 ${new Date().toISOString().slice(0,10)}]`);
    parts.push(`保留完整: ${hot.length} 热 + ${warm.length} 温事实`);
    parts.push(`压缩归档: ${compressed.length} 事实 → 语义向量`);

    for (const [type, facts] of byType) {
      const samples = facts.slice(0, 3).map(f => `${f.key}: ${f.value.slice(0, 40)}`).join('; ');
      parts.push(`  ${type}(${facts.length}): ${samples}${facts.length > 3 ? '...' : ''}`);
    }

    return parts.join('\n');
  }

  /**
   * 生成语义摘要向量（简单平均池化，实际可用 embedding 模型）
   */
  private generateSummaryVector(facts: ScoredFact[]): number[] | null {
    if (facts.length === 0) return null;
    
    // 使用 MinHash 签名的平均作为轻量级语义向量
    const signatures = facts.map(f => globalDedup['lsh'].getSignature(f.key)).filter(Boolean) as number[][];
    if (signatures.length === 0) return null;

    const dim = signatures[0].length;
    const avg = new Array(dim).fill(0);
    for (const sig of signatures) {
      for (let i = 0; i < dim; i++) avg[i] += sig[i];
    }
    for (let i = 0; i < dim; i++) avg[i] = Math.round(avg[i] / signatures.length);
    
    return avg;
  }

  /**
   * 持久化压缩结果到数据库
   */
  private async persistCompression(
    agentId: string,
    chatId: string | undefined,
    keptKeys: string[],
    removedKeys: string[],
    summaryText: string,
    summaryVector: number[] | null
  ): Promise<void> {
    const db = getDB();
    
    if (chatId) {
      // Chat 级记忆压缩
      const row = db.exec(
        `SELECT memory_facts, memory_summary FROM chat_memories WHERE chat_id = ? AND agent_id = ?`,
        [chatId, agentId]
      );
      if (!row[0]?.values?.[0]?.[0]) return;
      
      const facts = JSON.parse(String(row[0].values[0][0]));
      const existingSummary = String(row[0].values[0][1] || '');
      
      // 只保留 keptKeys
      const newFacts: Record<string, string> = {};
      for (const key of keptKeys) {
        if (facts[key]) newFacts[key] = facts[key];
      }
      
      // 追加摘要到 memory_summary
      const newSummary = existingSummary 
        ? existingSummary + '\n\n' + summaryText
        : summaryText;
      
      db.run(
        `UPDATE chat_memories SET memory_facts = ?, memory_summary = ?, updated_at = ? WHERE chat_id = ? AND agent_id = ?`,
        [JSON.stringify(newFacts), newSummary, Date.now(), chatId, agentId]
      );
      
      // 从去重索引移除被压缩的 keys
      for (const key of removedKeys) {
        globalDedup.remove(key);
      }
    } else {
      // Agent 级记忆压缩
      const agent = db.exec(`SELECT memory_facts, memory_summary FROM agents WHERE id = ?`, [agentId]);
      if (!agent[0]?.values?.[0]?.[0]) return;
      
      const facts = JSON.parse(String(agent[0].values[0][0]));
      const existingSummary = String(agent[0].values[0][1] || '');
      
      const newFacts: Record<string, string> = {};
      for (const key of keptKeys) {
        if (facts[key]) newFacts[key] = facts[key];
      }
      
      const newSummary = existingSummary 
        ? existingSummary + '\n\n' + summaryText
        : summaryText;
      
      db.run(
        `UPDATE agents SET memory_facts = ?, memory_summary = ? WHERE id = ?`,
        [JSON.stringify(newFacts), newSummary, agentId]
      );
      
      for (const key of removedKeys) {
        globalDedup.remove(key);
      }
    }
  }

  private emptyResult(agentId: string, chatId: string | undefined, count: number): CompressionResult {
    return {
      agentId,
      chatId,
      originalFactCount: count,
      compressedFactCount: count,
      hotCount: 0,
      warmCount: 0,
      coldCount: 0,
      summaryVector: null,
      removedKeys: [],
      keptKeys: [],
      summaryText: '',
      timestamp: Date.now(),
    };
  }
}

// 导出单例
export const globalNightlyCompressor = new NightlyCompressor();

/**
 * 注册夜间压缩定时任务（在 index.ts 启动时调用）
 * 默认每天凌晨 3:00 运行
 */
let nightlyTimer: ReturnType<typeof setTimeout> | null = null;

function msUntilHour(hour: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

async function runNightlyCompression(): Promise<void> {
  console.log("[NightlyCompress] Starting scheduled compression...");
  const compressor = new NightlyCompressor({ apply: true, minFacts: 20 });
  const results = await compressor.compressAll();
  let totalRemoved = 0;
  let totalKept = 0;
  for (const r of results) {
    totalRemoved += r.removedKeys.length;
    totalKept += r.keptKeys.length;
  }
  console.log(`[NightlyCompress] Done: ${results.length} scopes, ${totalKept} kept, ${totalRemoved} compressed`);
}

/**
 * 在主进程启动夜间压缩。
 * 不走 CronScheduler：那条执行器只认识 agentMessage/toolCall，
 * 塞一个自定义 handler 会被当成普通系统事件，压缩函数不会跑。
 * 默认每天本地 03:00，真正落库（apply=true）。少于 20 条事实的会话不动。
 */
export function registerNightlyCompressionJob(hour: number = 3): void {
  if (nightlyTimer) return;
  const arm = () => {
    const delay = msUntilHour(hour);
    nightlyTimer = setTimeout(async () => {
      try {
        await runNightlyCompression();
      } catch (e) {
        console.warn("[NightlyCompress] run failed:", e);
      } finally {
        arm();
      }
    }, delay);
    const at = new Date(Date.now() + delay).toLocaleString("zh-CN");
    console.log(`[NightlyCompress] next run at ${at}`);
  };
  arm();
}

export function stopNightlyCompressionJob(): void {
  if (nightlyTimer) {
    clearTimeout(nightlyTimer);
    nightlyTimer = null;
  }
}
