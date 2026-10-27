/**
 * 记忆重要性打分模块
 * 基于多维度信号给 fact 打分，用于：
 * - 夜间摘要压缩时的保留决策
 * - 检索时的优先级排序
 * - 存储分层（热/温/冷）的分流依据
 */

import { getDB } from '../storage/db.js';

export interface ImportanceSignal {
  // 访问频率信号
  accessCount: number;        // 被检索/命中的次数
  lastAccessAt: number;       // 最后访问时间
  // 时间信号
  createdAt: number;          // 创建时间
  updatedAt: number;          // 最后更新时间
  // 来源信号
  source: 'user' | 'assistant' | 'system' | 'inferred';
  confidence: number;         // 0-1
  // 内容信号
  keyLength: number;          // key 长度（越具体越重要）
  valueLength: number;        // value 长度
  // 实体类型信号
  entityType?: string;        // 'identity' | 'preference' | 'skill' | 'fact' | 'temporal'
  // 关联信号
  linkedFacts: number;        // 被其他 fact 引用/关联的次数
}

export interface ScoredFact {
  key: string;
  value: string;
  importance: number;         // 0-1，越大越重要
  signals: ImportanceSignal;
  tier: 'hot' | 'warm' | 'cold';  // 存储分层建议
}

/**
 * 重要性打分器
 * 采用加权组合模型，权重可通过环境变量调整
 */
export class ImportanceScorer {
  // 权重配置（可通过环境变量覆盖）
  private weights = {
    // 访问频率权重（归一化后）
    accessFrequency: parseFloat(process.env.MEMORY_WEIGHT_ACCESS || '0.30'),
    // 近期性权重（指数衰减）
    recency: parseFloat(process.env.MEMORY_WEIGHT_RECENCY || '0.20'),
    // 来源可信度权重
    sourceConfidence: parseFloat(process.env.MEMORY_WEIGHT_SOURCE || '0.15'),
    // 实体类型权重
    entityType: parseFloat(process.env.MEMORY_WEIGHT_ENTITY || '0.15'),
    // 内容丰富度权重
    contentRichness: parseFloat(process.env.MEMORY_WEIGHT_CONTENT || '0.10'),
    // 关联度权重
    linkage: parseFloat(process.env.MEMORY_WEIGHT_LINK || '0.10'),
  };

  // 分层阈值
  private hotThreshold = parseFloat(process.env.MEMORY_HOT_THRESHOLD || '0.75');
  private warmThreshold = parseFloat(process.env.MEMORY_WARM_THRESHOLD || '0.40');

  /**
   * 计算单个 fact 的重要性分数
   */
  score(signals: ImportanceSignal): ScoredFact {
    const now = Date.now();
    
    // 1. 访问频率归一化（对数缩放，避免极值主导）
    const accessScore = Math.min(1, Math.log10(signals.accessCount + 1) / 3); // 1000次 ≈ 1.0
    
    // 2. 近期性：指数衰减，半衰期 30 天
    const daysSinceAccess = (now - signals.lastAccessAt) / (1000 * 60 * 60 * 24);
    const recencyScore = Math.exp(-daysSinceAccess / 30);
    
    // 3. 来源可信度
    const sourceWeight = { user: 1.0, system: 0.9, assistant: 0.7, inferred: 0.4 };
    const sourceScore = sourceWeight[signals.source] * signals.confidence;
    
    // 4. 实体类型重要性
    const typeWeight: Record<string, number> = {
      identity: 1.0,      // 姓名、身份证、联系方式等
      preference: 0.8,    // 偏好、过敏等
      skill: 0.7,         // 技能、擅长领域
      fact: 0.6,          // 一般事实
      temporal: 0.4,      // 临时状态、时效性信息
    };
    const entityScore = typeWeight[signals.entityType || 'fact'] || 0.5;
    
    // 5. 内容丰富度（key+value 长度，对数归一化）
    const contentLen = signals.keyLength + signals.valueLength;
    const contentScore = Math.min(1, Math.log10(contentLen + 1) / 4); // 10000字符 ≈ 1.0
    
    // 6. 关联度
    const linkScore = Math.min(1, signals.linkedFacts / 10); // 10个关联 ≈ 1.0
    
    // 加权求和
    const importance = 
      this.weights.accessFrequency * accessScore +
      this.weights.recency * recencyScore +
      this.weights.sourceConfidence * sourceScore +
      this.weights.entityType * entityScore +
      this.weights.contentRichness * contentScore +
      this.weights.linkage * linkScore;
    
    // 确定存储分层
    let tier: 'hot' | 'warm' | 'cold';
    if (importance >= this.hotThreshold) tier = 'hot';
    else if (importance >= this.warmThreshold) tier = 'warm';
    else tier = 'cold';
    
    return {
      key: '',
      value: '',
      importance: Math.max(0, Math.min(1, importance)),
      signals,
      tier,
    };
  }

  /**
   * 批量打分
   */
  scoreBatch(facts: Array<{ key: string; value: string } & Partial<ImportanceSignal>>): ScoredFact[] {
    return facts.map(f => {
      const signals: ImportanceSignal = {
        accessCount: f.accessCount || 0,
        lastAccessAt: f.lastAccessAt || f.createdAt || Date.now(),
        createdAt: f.createdAt || Date.now(),
        updatedAt: f.updatedAt || f.createdAt || Date.now(),
        source: f.source || 'assistant',
        confidence: f.confidence || 0.8,
        keyLength: f.key.length,
        valueLength: f.value.length,
        entityType: f.entityType,
        linkedFacts: f.linkedFacts || 0,
      };
      const scored = this.score(signals);
      scored.key = f.key;
      scored.value = f.value;
      return scored;
    });
  }

  /**
   * 从数据库加载 facts 并打分（用于夜间任务）
   */
  async scoreFromDB(agentId: string, chatId?: string): Promise<ScoredFact[]> {
    const db = getDB();
    const facts: Array<{ key: string; value: string } & Partial<ImportanceSignal>> = [];
    
    if (chatId) {
      const row = db.exec(
        `SELECT memory_facts, updated_at FROM chat_memories WHERE chat_id = ? AND agent_id = ?`,
        [chatId, agentId]
      );
      if (row[0]?.values?.[0]?.[0]) {
        const factsObj = JSON.parse(String(row[0].values[0][0]));
        const updatedAt = Number(row[0].values[0][1]) || Date.now();
        for (const [key, value] of Object.entries(factsObj)) {
          facts.push({ key, value: String(value), updatedAt, createdAt: updatedAt });
        }
      }
    } else {
      const agent = db.exec(`SELECT memory_facts, memory_summary FROM agents WHERE id = ?`, [agentId]);
      if (agent[0]?.values?.[0]?.[0]) {
        const factsObj = JSON.parse(String(agent[0].values[0][0]));
        for (const [key, value] of Object.entries(factsObj)) {
          facts.push({ key, value: String(value) });
        }
      }
    }
    
    // 补充访问统计（从实体表或访问日志推导）
    // 这里简化处理，实际可接入更完善的访问追踪
    return this.scoreBatch(facts);
  }
}

// 导出单例
export const globalImportanceScorer = new ImportanceScorer();

/**
 * 根据 key 推断实体类型（用于打分）
 */
export function inferEntityType(key: string, value: string): ImportanceSignal['entityType'] {
  const k = key.toLowerCase();
  const v = value.toLowerCase();
  
  // 身份类
  if (/(姓名|名字|叫|身份证|手机|邮箱|地址|微信|qq|电话)/.test(k)) return 'identity';
  // 偏好类
  if (/(喜欢|偏好|爱吃|讨厌|不吃|过敏|忌口|口味)/.test(k)) return 'preference';
  // 技能类
  if (/(技能|会|擅长|精通|熟悉|掌握|证书|资格)/.test(k)) return 'skill';
  // 时效性状态
  if (/(状态|情况|心情|进度|阶段|当前|正在|最近)/.test(k)) return 'temporal';
  
  return 'fact';
}