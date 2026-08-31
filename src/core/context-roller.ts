/**
 * context-roller.ts — 上下文滚动压缩持久化（防几十小时任务上下文爆掉）
 *
 * 架构升级核心组件之一：
 *  - 长任务运行几十小时，上下文窗口必然会被中间过程塞满
 *  - 本模块把每阶段的"历史对话"压缩成摘要落盘
 *  - 后续阶段只读摘要 + 目标任务 + 验收标准 + checkpoint，不读海量中间过程
 *  - 目标/验收标准/checkpoint 永不压缩（关键信息不丢），只压缩过程
 *
 * 设计：
 *  - 每阶段结束调用 roll() 生成阶段摘要并落盘
 *  - 下一阶段开始时用 loadSummary() 加载历史摘要
 *  - 摘要文件按目标隔离，互不干扰
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';

interface StageSummary {
  goalId: string;
  stage: number;          // 阶段序号
  createdAt: number;
  summary: string;        // 该阶段压缩摘要
  tokenEstimate: number;  // 估算节省的 token 数
}

export class ContextRoller {
  /** 阶段摘要存储目录 */
  private static dir(): string {
    const base = process.env.CONTEXT_ROLLER_DIR
      || path.join(process.cwd(), 'storage', 'context-rolls');
    if (!existsSync(base)) mkdirSync(base, { recursive: true });
    return base;
  }

  private static file(goalId: string): string {
    return path.join(ContextRoller.dir(), `${sanitize(goalId)}.rolls.json`);
  }

  /** 记录一个阶段摘要 */
  static roll(goalId: string, stage: number, summary: string, tokenEstimate = 0): void {
    const all = ContextRoller.loadAll(goalId);
    all.push({ goalId, stage, createdAt: Date.now(), summary, tokenEstimate });
    // 只保留最近 20 个阶段摘要，防止摘要本身堆积
    const slim = all.slice(-20);
    writeFileSync(ContextRoller.file(goalId), JSON.stringify(slim, null, 2), 'utf8');
  }

  /** 加载某目标所有阶段摘要（拼接成给后续阶段的"历史上下文"） */
  static loadAll(goalId: string): StageSummary[] {
    const f = ContextRoller.file(goalId);
    if (!existsSync(f)) return [];
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as StageSummary[];
    } catch { return []; }
  }

  /** 生成"历史摘要上下文"字符串——注入后续阶段的 system prompt */
  static buildHistoryContext(goalId: string, maxChars = 6000): string {
    const all = ContextRoller.loadAll(goalId);
    if (all.length === 0) return '';
    // 取最近几个阶段，倒序展示（越近越重要）
    const recent = all.slice(-5).reverse();
    let ctx = '\n## 之前阶段的工作摘要（压缩历史，勿重复已完成内容）\n';
    let used = 0;
    for (const s of recent) {
      const block = `\n[阶段${s.stage}] ${s.summary.slice(0, 1200)}`;
      if (used + block.length > maxChars) break;
      ctx += block;
      used += block.length;
    }
    ctx += '\n';
    return ctx;
  }

  /** 清除某目标的历史摘要（目标完成/删除时） */
  static clear(goalId: string): void {
    const f = ContextRoller.file(goalId);
    try { if (existsSync(f)) require('fs').unlinkSync(f); } catch { /* ignore */ }
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
