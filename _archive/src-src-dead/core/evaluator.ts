/**
 * Evaluator — 评测体系 v1.0.0 (AGI P0)
 *
 * AGI 方案的核心缺口："没有评测体系——拿什么证明'变聪明了'？"
 * 本模块对每次 AI 回复记录质量评测数据（Critic 分数 + 问题清单），
 * 持久化到磁盘，支持按 Agent/模型/时间聚合统计。
 *
 * 让每一次进化都有可量化的证据，而不是修辞。
 */
import { logger } from './logger.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../storage/db.js';
import type { CritiqueIssue } from './critic.js';

// ─── 类型 ───

export interface EvaluationRecord {
  id: string;
  timestamp: number;
  agentId: string;
  chatId: string;
  model: string;
  triggerLen: number;       // 触发消息长度
  replyLen: number;         // 回复长度
  score: number;            // Critic 分数 0-100（100 表示未校验/通过）
  issues: CritiqueIssue[];
  revised: boolean;         // 是否被修正
  latencyMs: number;        // 生成耗时
  rounds: number;           // 校验轮次
}

export interface EvaluationSummary {
  total: number;
  avgScore: number;
  passRate: number;         // score >= 70 的比例
  reviseRate: number;       // 修正比例
  issueBreakdown: Record<string, number>;  // 问题类型统计
  topAgents: { agentId: string; count: number; avgScore: number }[];
  topModels: { model: string; count: number; avgScore: number }[];
  since: number;
}

export interface EvaluationFilter {
  agentId?: string;
  chatId?: string;
  model?: string;
  since?: number;
  limit?: number;
}

const MAX_RECORDS = 5000;  // 内存 + 磁盘最多保留 5000 条

/**
 * 评测记录器
 */
export class Evaluator {
  private records: EvaluationRecord[] = [];
  private readonly path: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.path = join(getDataDir(), 'evaluation-records.json');
    this.load();
    logger.info('Evaluator', `评测体系已就绪: ${this.records.length} 条历史记录`);
  }

  /** 记录一次评测 */
  record(data: Omit<EvaluationRecord, 'id' | 'timestamp'>): EvaluationRecord {
    const rec: EvaluationRecord = {
      ...data,
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };
    this.records.push(rec);

    // 超限裁剪：保留最近的
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(-MAX_RECORDS);
    }

    // 防抖落盘（1 秒内合并写）
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 1000);
    if (this.saveTimer.unref) this.saveTimer.unref();

    return rec;
  }

  /** 聚合统计 */
  summary(filter: EvaluationFilter = {}): EvaluationSummary {
    const { agentId, chatId, model, since } = filter;
    const filtered = this.records.filter(r => {
      if (agentId && r.agentId !== agentId) return false;
      if (chatId && r.chatId !== chatId) return false;
      if (model && r.model !== model) return false;
      if (since && r.timestamp < since) return false;
      return true;
    });

    const issueBreakdown: Record<string, number> = {};
    for (const r of filtered) {
      for (const i of r.issues) {
        issueBreakdown[i.type] = (issueBreakdown[i.type] || 0) + 1;
      }
    }

    const byAgent = new Map<string, { count: number; sum: number }>();
    const byModel = new Map<string, { count: number; sum: number }>();
    for (const r of filtered) {
      const a = byAgent.get(r.agentId) || { count: 0, sum: 0 };
      a.count++; a.sum += r.score;
      byAgent.set(r.agentId, a);
      const m = byModel.get(r.model) || { count: 0, sum: 0 };
      m.count++; m.sum += r.score;
      byModel.set(r.model, m);
    }

    const topAgents = Array.from(byAgent.entries())
      .map(([agentId, v]) => ({ agentId, count: v.count, avgScore: Math.round(v.sum / v.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topModels = Array.from(byModel.entries())
      .map(([model, v]) => ({ model, count: v.count, avgScore: Math.round(v.sum / v.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const avgScore = filtered.length > 0
      ? Math.round(filtered.reduce((s, r) => s + r.score, 0) / filtered.length)
      : 0;
    const passRate = filtered.length > 0
      ? filtered.filter(r => r.score >= 70).length / filtered.length
      : 1;
    const reviseRate = filtered.length > 0
      ? filtered.filter(r => r.revised).length / filtered.length
      : 0;

    return {
      total: filtered.length,
      avgScore,
      passRate: Math.round(passRate * 1000) / 10,
      reviseRate: Math.round(reviseRate * 1000) / 10,
      issueBreakdown,
      topAgents,
      topModels,
      since: since || 0,
    };
  }

  /** 最近 N 条评测 */
  recent(limit = 50): EvaluationRecord[] {
    return this.records.slice(-limit).reverse();
  }

  /** 最近一次评测（用于快速验证） */
  last(): EvaluationRecord | null {
    return this.records.length > 0 ? this.records[this.records.length - 1] : null;
  }

  /** 持久化到磁盘 */
  private persist(): void {
    try {
      mkdirSync(join(getDataDir()), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.records), 'utf8');
    } catch (err: any) {
      logger.warn('Evaluator', `评测记录落盘失败: ${err.message}`);
    }
  }

  /** 从磁盘加载 */
  private load(): void {
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.records = parsed.slice(-MAX_RECORDS);
      }
    } catch (err: any) {
      logger.warn('Evaluator', `评测记录加载失败: ${err.message}`);
    }
  }
}
