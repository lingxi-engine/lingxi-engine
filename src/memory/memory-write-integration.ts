/**
 * 记忆写入集成层：在写入 memory_facts 前接入语义去重 + 冲突检测
 * 用法：替换原有的 updateAgentMemory / upsertChatMemory 调用
 */

import { getDB, updateAgentMemory as rawUpdateAgentMemory, upsertChatMemory as rawUpsertChatMemory, getAgent, getChatMemory } from '../storage/db.js';
import { globalDedup, SemanticDedup } from './semantic-dedup.js';
import { globalConflictDetector, FactEntry, FactConflictDetector } from './fact-conflict-detector.js';

/**
 * 从数据库加载现有 facts 到 Map（供冲突检测和去重索引重建）
 */
export async function loadExistingFacts(agentId: string, chatId?: string): Promise<Map<string, FactEntry>> {
  const db = getDB();
  const factsMap = new Map<string, FactEntry>();

  if (chatId) {
    // chat 级记忆
    const row = db.exec(
      `SELECT memory_facts FROM chat_memories WHERE chat_id = ? AND agent_id = ?`,
      [chatId, agentId]
    );
    if (row[0]?.values?.[0]?.[0]) {
      try {
        const facts = JSON.parse(String(row[0].values[0][0]));
        for (const [key, value] of Object.entries(facts)) {
          factsMap.set(key, {
            key,
            value: String(value),
            source: 'assistant',
            confidence: 0.8,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      } catch {}
    }
  } else {
    // agent 级记忆
    const agent = getAgent(agentId);
    if (agent?.memory_facts) {
      try {
        const facts = JSON.parse(agent.memory_facts);
        for (const [key, value] of Object.entries(facts)) {
          factsMap.set(key, {
            key,
            value: String(value),
            source: 'assistant',
            confidence: 0.8,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
      } catch {}
    }
  }

  return factsMap;
}

/**
 * 重建去重索引（启动时或批量导入后调用）
 */
export function rebuildDedupIndex(entries: Array<{ key: string; value: string }>): void {
  globalDedup.rebuild(entries);
}

/**
 * 带去重和冲突检测的 agent 级 facts 更新
 */
export async function updateAgentMemoryWithChecks(
  agentId: string,
  summary: string,
  newFacts: Record<string, string>,
  options: {
    source?: 'user' | 'assistant' | 'system' | 'inferred';
    confidence?: number;
    skipConflictCheck?: boolean;
    skipDedup?: boolean;
  } = {}
): Promise<{ success: boolean; conflicts?: any; skippedKeys?: string[] }> {
  const { source = 'assistant', confidence = 0.8, skipConflictCheck = false, skipDedup = false } = options;

  // 1. 加载现有 facts
  const existingFacts = await loadExistingFacts(agentId);

  // 2. 语义去重：过滤掉与现有 facts 语义相似的新 facts
  const dedupedFacts: Record<string, string> = {};
  const skippedKeys: string[] = [];

  for (const [key, value] of Object.entries(newFacts)) {
    if (skipDedup) {
      dedupedFacts[key] = value;
      continue;
    }

    const isDup = await globalDedup.checkAndAdd(key, value);
    if (isDup) {
      skippedKeys.push(key);
      console.log(`[MemoryDedup] 跳过重复 fact: ${key} = ${value.slice(0, 50)}`);
    } else {
      dedupedFacts[key] = value;
    }
  }

  // 如果全被去重了，直接返回
  if (Object.keys(dedupedFacts).length === 0) {
    return { success: true, skippedKeys };
  }

  // 3. 冲突检测
  if (!skipConflictCheck) {
    for (const [key, value] of Object.entries(dedupedFacts)) {
      const newFact: FactEntry = {
        key,
        value,
        source,
        confidence,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const conflictResult = await globalConflictDetector.detect(newFact, existingFacts);
      
      if (conflictResult.hasConflict) {
        // 高严重冲突：阻止写入，返回冲突信息供上层决策
        if (conflictResult.action === 'ask_user' || conflictResult.action === 'block') {
          return {
            success: false,
            conflicts: conflictResult.conflicts,
            skippedKeys,
          };
        }
        // 中低严重：按建议处理
        for (const c of conflictResult.conflicts) {
          if (c.suggestion === 'replace_old') {
            // 标记旧 fact 为 superseded（实际删除由上层决定）
            console.log(`[MemoryConflict] 标记替换旧 fact: ${c.existingKey} -> ${c.newKey}`);
          } else if (c.suggestion === 'replace_new') {
            // 丢弃新 fact
            delete dedupedFacts[key];
          }
          // keep_both：保留双方，不处理
        }
      }
    }
  }

  // 4. 写入数据库（合并去重后的新 facts 到现有 facts）
  // 将 Map<string, FactEntry> 转为 Record<string, string>
  const existingFactsRecord: Record<string, string> = {};
  for (const [key, fact] of existingFacts) {
    existingFactsRecord[key] = fact.value;
  }
  const mergedFacts = { ...existingFactsRecord, ...dedupedFacts };
  rawUpdateAgentMemory(agentId, summary, mergedFacts);

  return { success: true, skippedKeys };
}

/**
 * 带去重和冲突检测的 chat 级 facts 更新
 */
export async function upsertChatMemoryWithChecks(
  chatId: string,
  agentId: string,
  summary: string,
  newFacts: Record<string, string>,
  options: {
    source?: 'user' | 'assistant' | 'system' | 'inferred';
    confidence?: number;
    skipConflictCheck?: boolean;
    skipDedup?: boolean;
  } = {}
): Promise<{ success: boolean; conflicts?: any; skippedKeys?: string[] }> {
  const { source = 'assistant', confidence = 0.8, skipConflictCheck = false, skipDedup = false } = options;

  // 1. 加载现有 facts
  const existingFacts = await loadExistingFacts(agentId, chatId);

  // 2. 语义去重
  const dedupedFacts: Record<string, string> = {};
  const skippedKeys: string[] = [];

  for (const [key, value] of Object.entries(newFacts)) {
    if (skipDedup) {
      dedupedFacts[key] = value;
      continue;
    }

    const isDup = await globalDedup.checkAndAdd(key, value);
    if (isDup) {
      skippedKeys.push(key);
      console.log(`[MemoryDedup] 跳过重复 chat fact: ${key} = ${value.slice(0, 50)}`);
    } else {
      dedupedFacts[key] = value;
    }
  }

  if (Object.keys(dedupedFacts).length === 0) {
    return { success: true, skippedKeys };
  }

  // 3. 冲突检测
  if (!skipConflictCheck) {
    for (const [key, value] of Object.entries(dedupedFacts)) {
      const newFact: FactEntry = {
        key,
        value,
        source,
        confidence,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const conflictResult = await globalConflictDetector.detect(newFact, existingFacts);
      
      if (conflictResult.hasConflict) {
        if (conflictResult.action === 'ask_user' || conflictResult.action === 'block') {
          return {
            success: false,
            conflicts: conflictResult.conflicts,
            skippedKeys,
          };
        }
        for (const c of conflictResult.conflicts) {
          if (c.suggestion === 'replace_old') {
            console.log(`[MemoryConflict] Chat 标记替换旧 fact: ${c.existingKey} -> ${c.newKey}`);
          } else if (c.suggestion === 'replace_new') {
            delete dedupedFacts[key];
          }
        }
      }
    }
  }

  // 4. 写入数据库
  const existingFactsRecord: Record<string, string> = {};
  for (const [key, fact] of existingFacts) {
    existingFactsRecord[key] = fact.value;
  }
  const mergedFacts = { ...existingFactsRecord, ...dedupedFacts };
  rawUpsertChatMemory(chatId, agentId, summary, mergedFacts);

  return { success: true, skippedKeys };
}

/**
 * 批量导入 facts（迁移/初始化时用），自动重建去重索引
 */
export async function bulkImportFacts(
  agentId: string,
  facts: Record<string, string>,
  chatId?: string
): Promise<void> {
  const entries = Object.entries(facts).map(([key, value]) => ({ key, value }));
  rebuildDedupIndex(entries);
  
  if (chatId) {
    const existing = await loadExistingFacts(agentId, chatId);
    const existingFactsRecord: Record<string, string> = {};
    for (const [key, fact] of existing) {
      existingFactsRecord[key] = fact.value;
    }
    const merged = { ...existingFactsRecord, ...facts };
    rawUpsertChatMemory(chatId, agentId, '', merged);
  } else {
    const existing = await loadExistingFacts(agentId);
    const existingFactsRecord: Record<string, string> = {};
    for (const [key, fact] of existing) {
      existingFactsRecord[key] = fact.value;
    }
    const merged = { ...existingFactsRecord, ...facts };
    const agent = getAgent(agentId);
    rawUpdateAgentMemory(agentId, agent?.memory_summary || '', merged);
  }
}

/**
 * 删除 fact（软删除：标记 superseded，从去重索引移除）
 */
export function forgetFact(agentId: string, key: string, chatId?: string): void {
  globalDedup.remove(key);
  
  // 实际删除由上层决定是否物理移除，这里只演示标记
  // 可扩展：在 facts 中添加 _deleted: true 标记
}

export { globalDedup, globalConflictDetector, FactConflictDetector, SemanticDedup };