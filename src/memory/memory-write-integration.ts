/**
 * 记忆写入集成层：在写入 memory_facts 前接入语义去重 + 冲突检测
 * 用法：替换原有的 updateAgentMemory / upsertChatMemory 调用
 */

import { getDB, updateAgentMemory as rawUpdateAgentMemory, upsertChatMemory as rawUpsertChatMemory, getAgent, getChatMemory } from '../storage/db.js';
import { globalDedup, SemanticDedup } from './semantic-dedup.js';
import { globalConflictDetector, FactEntry, FactConflictDetector } from './fact-conflict-detector.js';

/**
 * 去重索引的命名空间（scope）。
 *
 * [多用户隔离 FIX] 旧实现所有用户共用一个全局索引，key 只有 fact 名，
 * 导致 A 用户的 "city=上海" 会让 B 用户的同名事实被判为重复而丢弃。
 * 现在按 agentId / chatId:agentId 隔离，不同用户互不影响。
 */
export function dedupScopeFor(agentId: string, chatId?: string): string {
  return chatId ? `chat:${chatId}:${agentId}` : `agent:${agentId}`;
}

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
          if (key.startsWith('__')) continue; // 跳过内部元字段（__insights 等）
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
          if (key.startsWith('__')) continue;
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
 * [P1-4 FIX] 初始化去重签名持久化表（启动时调用一次）
 */
export function initDedupSignaturesTable(): void {
  const db = getDB();
  db.run(`
    CREATE TABLE IF NOT EXISTS dedup_signatures (
      scope_key TEXT PRIMARY KEY,
      signature TEXT NOT NULL,  -- JSON array of numbers
      created_at INTEGER NOT NULL
    );
  `);
  // ★ FIX-DEDUP(2026-11-09): 老库（sql.js 时代）建的是 key 列，新代码读写 scope_key，
  //   导致每次持久化都报 "table dedup_signatures has no column named scope_key"，
  //   去重签名永远存不进库。这里做一次幂等重建：key → scope_key 并保留数据。
  try {
    const cols = (db.exec('PRAGMA table_info(dedup_signatures)') as any[])[0]?.values?.map((r: any[]) => String(r[1])) || [];
    if (cols.length && !cols.includes('scope_key')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS dedup_signatures_new (
          scope_key TEXT PRIMARY KEY,
          signature TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      if (cols.includes('key')) {
        db.exec(`INSERT OR REPLACE INTO dedup_signatures_new (scope_key, signature, created_at)
                 SELECT key, signature, created_at FROM dedup_signatures`);
      }
      db.exec('DROP TABLE dedup_signatures');
      db.exec('ALTER TABLE dedup_signatures_new RENAME TO dedup_signatures');
      console.log('[MemoryDedup] dedup_signatures 已迁移：key → scope_key');
    }
  } catch (e: any) {
    console.warn('[MemoryDedup] dedup_signatures 迁移失败:', e.message);
  }
}

/**
 * [P1-4 FIX] 从持久化表重建去重索引（启动时调用）
 */
export function rebuildDedupIndexFromDB(): void {
  initDedupSignaturesTable();

  const entries: Array<{ key: string; value: string; scope: string }> = [];

  // agent 级
  for (const [agentId, raw] of dbExec(`SELECT id, memory_facts FROM agents WHERE memory_facts IS NOT NULL AND memory_facts != '{}'`)) {
    const scope = dedupScopeFor(String(agentId));
    for (const [key, value] of parseFactPairs(raw)) {
      entries.push({ key, value, scope });
    }
  }

  // chat 级
  for (const [chatId, agentId, raw] of dbExec(`SELECT chat_id, agent_id, memory_facts FROM chat_memories WHERE memory_facts IS NOT NULL AND memory_facts != '{}'`)) {
    const scope = dedupScopeFor(String(agentId), String(chatId));
    for (const [key, value] of parseFactPairs(raw)) {
      entries.push({ key, value, scope });
    }
  }

  globalDedup.rebuild(entries);
  console.log(`[MemoryDedup] 去重索引已从 DB 重建：${entries.length} 条事实`);
}

/** 解析 memory_facts JSON 为 [key, value] 数组，跳过内部字段与数组形态 */
function parseFactPairs(raw: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) {
      for (const f of parsed) {
        if (f && typeof f === 'object' && f.key && !String(f.key).startsWith('__')) {
          out.push([String(f.key), String(f.value ?? '')]);
        }
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (key.startsWith('__')) continue;
        out.push([key, String(value ?? '')]);
      }
    }
  } catch {}
  return out;
}

/** 执行查询并返回行数组（统一处理 sql.js 的 exec 返回结构） */
function dbExec(sql: string): any[][] {
  try {
    const db = getDB();
    const res = db.exec(sql);
    return (res[0]?.values || []) as any[][];
  } catch {
    return [];
  }
}

/**
 * [P1-4 FIX] 重建去重索引（启动时或批量导入后调用）
 */
export function rebuildDedupIndex(entries: Array<{ key: string; value: string; scope?: string }>): void {
  globalDedup.rebuild(entries);

  // [P1-4 FIX] 持久化签名到数据库
  const db = getDB();
  initDedupSignaturesTable();

  for (const { key, value, scope } of entries) {
    const scopeKey = scope ? `${scope}::${key}` : key;
    const sig = globalDedup['lsh'].getSignature(scopeKey);
    if (sig) {
      db.run(
        `INSERT OR REPLACE INTO dedup_signatures (scope_key, signature, created_at) VALUES (?, ?, ?)`,
        [scopeKey, JSON.stringify(sig), Date.now()]
      );
    }
  }
}

/** 持久化单个 fact 的去重签名（scope 隔离） */
function persistSignature(scope: string, key: string): void {
  try {
    const db = getDB();
    initDedupSignaturesTable();
    const sig = globalDedup['lsh'].getSignature(`${scope}::${key}`);
    if (sig) {
      db.run(
        `INSERT OR REPLACE INTO dedup_signatures (scope_key, signature, created_at) VALUES (?, ?, ?)`,
        [`${scope}::${key}`, JSON.stringify(sig), Date.now()]
      );
    }
  } catch {}
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
  const scope = dedupScopeFor(agentId);

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

    const isDup = await globalDedup.checkAndAdd(key, value, scope);
    if (isDup) {
      skippedKeys.push(key);
      console.log(`[MemoryDedup] 跳过重复 fact: ${key} = ${value.slice(0, 50)}`);
    } else {
      dedupedFacts[key] = value;
      persistSignature(scope, key);
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
  const scope = dedupScopeFor(agentId, chatId);

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

    const isDup = await globalDedup.checkAndAdd(key, value, scope);
    if (isDup) {
      skippedKeys.push(key);
      console.log(`[MemoryDedup] 跳过重复 chat fact: ${key} = ${value.slice(0, 50)}`);
    } else {
      dedupedFacts[key] = value;
      persistSignature(scope, key);
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

  // 2026-11-12 FIX-DREAM-COST：记忆真的写进去了 → 通知 Dreamer 解除该对的「成功抑制」，
  // 否则新事实会被 24 小时抑制期挡在外面，等于对新内容失效。
  try {
    const g: any = globalThis as any;
    g.__dreamer?.touchMemoryPair?.(chatId, agentId);
  } catch { /* Dreamer 未启动时忽略 */ }

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
  const scope = dedupScopeFor(agentId, chatId);
  const entries = Object.entries(facts).map(([key, value]) => ({ key, value, scope }));
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
  const scope = dedupScopeFor(agentId, chatId);
  globalDedup.remove(key, scope);

  // [P1-4 FIX] 从持久化表删除签名（scope 隔离）
  try {
    const db = getDB();
    initDedupSignaturesTable();
    db.run(`DELETE FROM dedup_signatures WHERE scope_key = ?`, [`${scope}::${key}`]);
  } catch {}
  
  // 实际删除由上层决定是否物理移除，这里只演示标记
  // 可扩展：在 facts 中添加 _deleted: true 标记
}

export { globalDedup, globalConflictDetector, FactConflictDetector, SemanticDedup };