/**
 * 实体提取器 v1.7.0
 *
 * 从对话中自动识别结构化实体：人名、公司、日期、金额、文件、链接、决策。
 * 对标 Mem0 的实体链接能力。
 */

import { logger } from './logger.js';
import { getDB } from '../storage/db.js';

// ─── 类型 ───

export interface Entity {
  type: 'person' | 'company' | 'date' | 'amount' | 'file' | 'link' | 'decision' | 'topic';
  value: string;          // 实体值
  context?: string;       // 上下文
  confidence: number;     // 置信度 0-1
  firstSeen: number;      // 首次出现时间
  lastSeen: number;       // 最后出现时间
  count: number;          // 出现次数
}

export interface ExtractionResult {
  entities: Entity[];
  summary: string;        // 提取摘要
}

// ─── 提取器 ───

export class EntityExtractor {
  private aiClient: any;
  private aiModel: string;

  constructor(aiClient: any, aiModel: string) {
    this.aiClient = aiClient;
    this.aiModel = aiModel;
  }

  /**
   * 从对话消息中提取实体
   */
  async extract(messages: { role: string; content: string }[], chatId: string, agentId: string): Promise<ExtractionResult | null> {
    const text = messages.map(m => `${m.role}: ${m.content}`).join('\n');
    if (text.length < 50) return null;

    logger.info('EntityExtractor', `提取实体: ${chatId}/${agentId} (${messages.length} 条消息)`);

    try {
      const prompt = `从以下对话中提取结构化实体。只提取明确提到的，不要猜测。

实体类型：
- person: 人名
- company: 公司/组织名
- date: 日期/时间
- amount: 金额/数字指标
- file: 文件名/路径
- link: URL/链接
- decision: 做出的决定/结论
- topic: 讨论的主题

对话：
${text.slice(0, 4000)}

请以 JSON 数组格式输出（不要有其他内容）：
[{"type":"person","value":"申总","context":"提到Q3预算","confidence":0.95}, ...]`;

      const resp = await this.aiClient.chat.completions.create({
        model: this.aiModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1500,
      });

      const raw = resp.choices[0]?.message?.content || '';
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return null;

      const items = JSON.parse(jsonMatch[0]);

      // 写入数据库（持久化，省 token）
      const now = Date.now();
      let newCount = 0;

      for (const item of items) {
        const type = item.type || 'topic';
        const value = item.value || '';
        if (!value) continue;

        try {
          const stmt = getDB().prepare('SELECT id, count FROM entities WHERE chat_id=? AND agent_id=? AND type=? AND value=?');
          stmt.bind([chatId, agentId, type, value]);
          const existing = stmt.step() ? stmt.getAsObject() : null;
          stmt.free();
          if (existing) {
            const upStmt = getDB().prepare('UPDATE entities SET count=?, last_seen=?, context=? WHERE id=?');
            upStmt.bind([existing.count + 1, now, item.context || null, existing.id]);
            upStmt.step(); upStmt.free();
          } else {
            const insStmt = getDB().prepare('INSERT INTO entities (id, chat_id, agent_id, type, value, context, confidence, first_seen, last_seen, count) VALUES (?,?,?,?,?,?,?,?,?,1)');
            insStmt.bind(['ent-' + now + '-' + Math.random().toString(36).slice(2, 8), chatId, agentId, type, value, item.context || null, item.confidence || 0.8, now, now]);
            insStmt.step(); insStmt.free();
            newCount++;
          }
        } catch (e: any) {
          logger.warn('EntityExtractor', `写入实体失败: ${e.message}`);
        }
      }

      // 从数据库读取合并后的完整列表
      const allEntities = this.getEntities(chatId, agentId);

      logger.info('EntityExtractor', `提取完成: ${newCount} 新实体, 总计 ${allEntities.length} 个`);

      return {
        entities: allEntities,
        summary: `新增 ${newCount} 个实体，累计 ${allEntities.length} 个`,
      };
    } catch (err: any) {
      logger.error('EntityExtractor', `提取失败: ${err.message}`);
      return null;
    }
  }

  /** 获取实体（从数据库读取，持久化） */
  getEntities(chatId: string, agentId: string): Entity[] {
    try {
      const stmt = getDB().prepare('SELECT * FROM entities WHERE chat_id = ? AND agent_id = ? ORDER BY count DESC LIMIT 50');
      stmt.bind([chatId, agentId]);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows.map((r: any) => ({
        type: r.type, value: r.value, context: r.context,
        confidence: r.confidence, firstSeen: r.first_seen,
        lastSeen: r.last_seen, count: r.count,
      }));
    } catch { return []; }
  }

  /** 获取重要实体（出现次数最多的前5个） */
  getTopEntities(chatId: string, agentId: string, limit = 5): Entity[] {
    return this.getEntities(chatId, agentId).slice(0, limit);
  }

  /** 按类型筛选 */
  getByType(chatId: string, agentId: string, type: Entity['type']): Entity[] {
    return this.getEntities(chatId, agentId).filter(e => e.type === type);
  }
}
