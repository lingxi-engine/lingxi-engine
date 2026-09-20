/**
 * Dreaming — 主动记忆整理 v1.7.0
 *
 * 空闲时 AI 主动重新审视记忆：合并重复、发现模式、生成洞察。
 * 对标 Anthropic 的 Memory Dreaming 机制。
 */

import { logger } from './logger.js';
import { getChatMemory, upsertChatMemory, listChatMemoryPairs } from '../storage/db.js';

// ─── 类型 ───

export interface DreamReport {
  chatId: string;
  agentId: string;
  timestamp: number;
  mergedFacts: number;        // 合并的重复事实
  newInsights: string[];       // 新洞察
  updatedPreferences: Record<string, string>;  // 更新的偏好
}

// ─── 配置 ───

const IDLE_TIMEOUT = 30_000;  // 30 秒空闲触发
const DREAM_COOLDOWN = 300_000; // 5 分钟内不重复 dream

// ─── Dreamer ───

export class Dreamer {
  private lastActivity = Date.now();
  private lastDream: Map<string, number> = new Map(); // chatId:agentId → timestamp
  private timer: ReturnType<typeof setInterval> | null = null;
  private aiClient: any;
  private aiModel: string;
  private dreaming = false; // 防止并发重入

  constructor(aiClient: any, aiModel: string) {
    this.aiClient = aiClient;
    this.aiModel = aiModel;
  }

  /** 记录活动，重置空闲计时 */
  touch() {
    this.lastActivity = Date.now();
  }

  /** 启动 dreaming 循环 */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAndDream(), 10_000);
    logger.info('Dreamer', 'Dreaming 循环已启动 (30s idle)');
  }

  /** 停止 */
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async checkAndDream() {
    const idle = Date.now() - this.lastActivity;
    if (idle < IDLE_TIMEOUT) return;
    if (this.dreaming) return; // 上一轮还没结束

    this.dreaming = true;
    try {
      // v29: 补上「遍历所有有记忆的群聊」—— 从 chat_memories 表拉出所有 (chat_id, agent_id) 对
      let pairs: Array<{ chat_id: string; agent_id: string }> = [];
      try {
        pairs = listChatMemoryPairs();
      } catch (err: any) {
        logger.warn('Dreamer', `列出记忆对失败: ${err.message}`);
        return;
      }

      if (pairs.length === 0) {
        // 没有可整理的记忆，诚实记录而不是假装在跑
        logger.debug('Dreamer', '无待整理记忆（chat_memories 为空）');
        return;
      }

      let dreamed = 0;
      for (const p of pairs) {
        if (!p?.chat_id || !p?.agent_id) continue;
        // 每处理完一个就刷新活动时间，避免长时间批量 dream 时被判定空闲
        try {
          const report = await this.dream(p.chat_id, p.agent_id);
          if (report) dreamed++;
        } catch (err: any) {
          logger.warn('Dreamer', `Dream ${p.chat_id}/${p.agent_id} 失败: ${err.message}`);
        }
      }
      if (dreamed > 0) {
        logger.audit('Dreamer', 'auto-dream', `本轮整理 ${dreamed}/${pairs.length} 组记忆`);
      }
    } finally {
      this.dreaming = false;
    }
  }

  /**
   * 对指定群聊的指定 Agent 执行 dreaming
   */
  async dream(chatId: string, agentId: string): Promise<DreamReport | null> {
    const key = `${chatId}:${agentId}`;
    const lastTime = this.lastDream.get(key) || 0;

    // 冷却检查
    if (Date.now() - lastTime < DREAM_COOLDOWN) return null;

    const mem = getChatMemory(chatId, agentId);
    if (!mem?.memory_summary || mem.memory_summary.length < 100) return null;

    logger.info('Dreamer', `Dreaming: ${chatId}/${agentId}`);

    try {
      // 解析现有事实
      let facts: Record<string, string> = {};
      try { facts = JSON.parse(mem.memory_facts || '{}'); } catch {}

      // 解析现有洞察
      let insights: string[] = [];
      try { insights = JSON.parse((mem as any).insights || '[]'); } catch {}

      // AI Dreaming
      const prompt = `你是一个记忆整理助手。请审视以下 AI 的记忆，完成三件事：

1. 合并重复的事实（如果多条事实说同一件事，合并为一条）
2. 发现隐藏的模式或洞察（例如"用户连续三次提到性能问题，可能优先级很高"）
3. 更新用户偏好（如果发现新偏好，记录下来）

当前记忆摘要：
${mem.memory_summary}

当前已知事实：
${JSON.stringify(facts, null, 2)}

已有洞察：
${insights.join('\n')}

请以 JSON 格式输出（不要有其他内容）：
{
  "mergedFacts": { "key": "value", ... },   // 合并后的事实（更新已有的）
  "newInsights": ["洞察1", "洞察2", ...],    // 新发现的模式
  "summaryUpdate": "优化后的记忆摘要"        // 如果摘要需要更新
}`;

      const resp = await this.aiClient.chat.completions.create({
        model: this.aiModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      });

      const text = resp.choices[0]?.message?.content || '';
      // 非贪婪匹配，支持 markdown 代码块
      let jsonStr = text.match(/```(?:json)?\s*\{([\s\S]*?)\}```/);
      let jsonMatch = jsonStr ? '{' + jsonStr[1] + '}' : null;
      if (!jsonMatch) jsonMatch = text.match(/\{([\s\S]*?)\}/)?.[0];
      if (!jsonMatch) { logger.warn('Dreamer', 'Dreaming 返回非 JSON'); return null; }

      let result: any;
      try { result = JSON.parse(jsonMatch); }
      catch { logger.warn('Dreamer', 'Dreaming JSON 解析失败'); return null; }
      const mergedCount = Object.keys(result.mergedFacts || {}).length;

      // 更新记忆
      const updatedFacts = { ...facts, ...(result.mergedFacts || {}) };
      const newSummary = result.summaryUpdate || mem.memory_summary;
      const allInsights = [...new Set([...insights, ...(result.newInsights || [])])].slice(-20); // 最多 20 条

      upsertChatMemory(chatId, agentId, newSummary, updatedFacts);

      // 存储 insights 到 metadata
      const db = (globalThis as any).__db;
      if (db) {
        try {
          db.run(
            `UPDATE chat_memories SET memory_facts = json_set(
              COALESCE(memory_facts, '{}'), '$.__insights', ?
            ) WHERE chat_id = ? AND agent_id = ?`,
            [JSON.stringify(allInsights), chatId, agentId]
          );
        } catch {}
      }

      this.lastDream.set(key, Date.now());

      logger.audit('Dreamer', 'dream', `${chatId}/${agentId}: merged=${mergedCount}, insights=${allInsights.length}`);

      return {
        chatId, agentId,
        timestamp: Date.now(),
        mergedFacts: mergedCount,
        newInsights: result.newInsights || [],
        updatedPreferences: result.mergedFacts || {},
      };
    } catch (err: any) {
      logger.error('Dreamer', `Dreaming 失败: ${err.message}`);
      return null;
    }
  }
}
