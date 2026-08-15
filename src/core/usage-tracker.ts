/**
 * Token 使用统计
 * 
 * 记录每次 AI 调用的 token 消耗和 API 调用次数，
 * 按模型/类型分类统计，给前端展示。
 */

interface UsageRecord {
  timestamp: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  type: 'tool' | 'reply' | 'compaction' | 'summary' | 'reflection';
}

class UsageTrackerClass {
  private records: UsageRecord[] = [];
  private maxRecords: number = 10000; // 最多保留 1 万条
  private totals: Map<string, { calls: number; promptTokens: number; completionTokens: number; totalTokens: number }> = new Map();

  /** 记录一次 AI 调用的 token 使用 */
  record(usage: {
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    type: 'tool' | 'reply' | 'compaction' | 'summary' | 'reflection';
  }) {
    const promptTokens = usage.promptTokens || 0;
    const completionTokens = usage.completionTokens || 0;
    const totalTokens = promptTokens + completionTokens;

    const record: UsageRecord = {
      timestamp: Date.now(),
      model: usage.model,
      promptTokens,
      completionTokens,
      totalTokens,
      type: usage.type,
    };

    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }

    // 更新按模型+类型的汇总
    const key = `${usage.model}::${usage.type}`;
    const existing = this.totals.get(key) || { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    existing.calls++;
    existing.promptTokens += promptTokens;
    existing.completionTokens += completionTokens;
    existing.totalTokens += totalTokens;
    this.totals.set(key, existing);
  }

  /** 获取统计概览 */
  getStats(): {
    total: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number };
    byModel: Record<string, { calls: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
    byType: Record<string, { calls: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
    recent24h: { calls: number; totalTokens: number };
    recent1h: { calls: number; totalTokens: number };
  } {
    const total = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const byModel: Record<string, any> = {};
    const byType: Record<string, any> = {};
    const now = Date.now();
    let recent24h = { calls: 0, totalTokens: 0 };
    let recent1h = { calls: 0, totalTokens: 0 };

    for (const r of this.records) {
      total.calls++;
      total.promptTokens += r.promptTokens;
      total.completionTokens += r.completionTokens;
      total.totalTokens += r.totalTokens;

      // 按模型汇总
      if (!byModel[r.model]) byModel[r.model] = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      byModel[r.model].calls++;
      byModel[r.model].promptTokens += r.promptTokens;
      byModel[r.model].completionTokens += r.completionTokens;
      byModel[r.model].totalTokens += r.totalTokens;

      // 按类型汇总
      if (!byType[r.type]) byType[r.type] = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      byType[r.type].calls++;
      byType[r.type].promptTokens += r.promptTokens;
      byType[r.type].completionTokens += r.completionTokens;
      byType[r.type].totalTokens += r.totalTokens;

      // 时间维度
      const age = now - r.timestamp;
      if (age < 3600000) { recent1h.calls++; recent1h.totalTokens += r.totalTokens; }
      if (age < 86400000) { recent24h.calls++; recent24h.totalTokens += r.totalTokens; }
    }

    return { total, byModel, byType, recent24h, recent1h };
  }

  /** 获取最近 N 条记录 */
  getRecentRecords(limit: number = 50): UsageRecord[] {
    return this.records.slice(-limit).reverse();
  }

  /** 清空统计 */
  reset() {
    this.records = [];
    this.totals.clear();
    try { writeFileSync(USAGE_FILE, '{"records":[],"totals":[]}'); } catch {}
  }
}

// 持久化到 data/usage.json
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

// P2-4 修复：使用 getDataDir() 保持路径一致
import { getDataDir } from '../storage/db.js';
const USAGE_FILE = join(getDataDir(), 'usage.json');

function loadUsage(): { records: UsageRecord[]; totals: [string, any][] } {
  try {
    if (existsSync(USAGE_FILE)) {
      const data = JSON.parse(readFileSync(USAGE_FILE, 'utf8'));
      return { records: data.records || [], totals: data.totals || [] };
    }
  } catch {}
  return { records: [], totals: [] };
}

function saveUsage(records: UsageRecord[], totals: Map<string, any>): void {
  try {
    const dir = join(getDataDir());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify({
      records: records.slice(-10000),
      totals: Array.from(totals.entries()),
      savedAt: Date.now(),
    }), 'utf8');
  } catch {}
}

export const UsageTracker = new UsageTrackerClass();

// 加载持久化数据
const _loaded = loadUsage();
if (_loaded.records.length > 0) {
  (UsageTracker as any).records = _loaded.records;
  for (const [key, val] of _loaded.totals) {
    (UsageTracker as any).totals.set(key, val);
  }
  console.log(`[Usage] 已加载 ${_loaded.records.length} 条历史记录`);
}

// 定时保存
setInterval(() => {
  saveUsage((UsageTracker as any).records, (UsageTracker as any).totals);
}, 30000); // 每30秒保存