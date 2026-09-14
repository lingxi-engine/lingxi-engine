/**
 * task-store.ts — 任务级 checkpoint 持久化存储（断点续传唯一真相源）
 *
 * 架构升级核心组件之一：
 *  - 目标任务不再是"内存里的会话循环"，而是落盘的任务对象
 *  - 每完成一个原子步骤即把完整状态写入 checkpoint 文件
 *  - 进程崩溃/重启后，从 checkpoint 精确恢复，不丢进度
 *  - 与 SQLite(project_goals) 互补：SQLite 存目标定义，checkpoint 文件存执行状态
 *
 * 设计原则：
 *  - 状态即真相：任何时刻重启都能精确恢复
 *  - 原子写：先写临时文件再 rename，避免写一半损坏
 *  - 幂等：resume 时只补做未完成步骤
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync } from 'fs';
import * as path from 'path';
import { getDB } from '../storage/db.js';

// ── 类型定义 ──────────────────────────────────────────────

export type TaskStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface TaskStep {
  id: string;            // 原子步骤唯一 ID（幂等键）
  name: string;          // 步骤名
  status: TaskStepStatus;
  startedAt?: number;
  finishedAt?: number;
  result?: string;       // 步骤产出摘要（落盘，供断点恢复）
  error?: string;        // 失败原因
  retries: number;       // 已重试次数
}

export interface TaskCheckpoint {
  goalId: string;        // 关联目标 ID
  title: string;         // 目标任务标题
  createdAt: number;
  updatedAt: number;
  status: 'pending' | 'in_progress' | 'done' | 'failed' | 'stopped';
  currentStepIndex: number;   // 当前执行到的步骤下标
  steps: TaskStep[];          // 全部原子步骤清单
  progress: number;           // 0-100
  round: number;              // 监督循环轮次
  lastError?: string;
  forceComplete: boolean;     // 是否开启强制完成模式
  meta?: Record<string, any>; // 扩展元数据
}

// ── 存储路径 ──────────────────────────────────────────────

/** 获取 checkpoint 根目录（默认 site_inner/storage/checkpoints） */
function getCheckpointDir(): string {
  const base = process.env.CHECKPOINT_DIR
    || path.join(process.cwd(), 'storage', 'checkpoints');
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return base;
}

function checkpointPath(goalId: string): string {
  return path.join(getCheckpointDir(), `${sanitize(goalId)}.checkpoint.json`);
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── 核心 API ──────────────────────────────────────────────

export class TaskStore {
  /** 创建任务清单（原子步骤分解后调用） */
  static create(goalId: string, title: string, stepNames: string[], opts?: { forceComplete?: boolean; meta?: Record<string, any> }): TaskCheckpoint {
    const steps: TaskStep[] = stepNames.map((name, i) => ({
      id: `step-${i + 1}`,
      name,
      status: 'pending',
      retries: 0,
    }));
    const cp: TaskCheckpoint = {
      goalId,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'in_progress',
      currentStepIndex: 0,
      steps,
      progress: 0,
      round: 0,
      forceComplete: opts?.forceComplete ?? false,
      meta: opts?.meta,
    };
    TaskStore.save(cp);
    return cp;
  }

  /** 读取 checkpoint（不存在返回 null） */
  static load(goalId: string): TaskCheckpoint | null {
    const p = checkpointPath(goalId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as TaskCheckpoint;
    } catch (e: any) {
      console.error(`[TaskStore] checkpoint 读取失败 ${p}:`, e?.message || e);
      return null;
    }
  }

  /** 原子保存 checkpoint */
  static save(cp: TaskCheckpoint): void {
    cp.updatedAt = Date.now();
    const p = checkpointPath(cp.goalId);
    const tmp = p + '.tmp';
    try {
      writeFileSync(tmp, JSON.stringify(cp, null, 2), 'utf8');
      renameSync(tmp, p);
    } catch (e: any) {
      console.error(`[TaskStore] checkpoint 保存失败 ${p}:`, e?.message || e);
      try { writeFileSync(p, JSON.stringify(cp, null, 2), 'utf8'); } catch (e2: any) {
        console.error(`[TaskStore] checkpoint 兜底保存也失败:`, e2?.message || e2);
      }
    }
  }

  /** 标记某步骤完成 */
  static markStepDone(goalId: string, stepIndex: number, result?: string): TaskCheckpoint | null {
    const cp = TaskStore.load(goalId);
    if (!cp) return null;
    const step = cp.steps[stepIndex];
    if (step) {
      step.status = 'done';
      step.finishedAt = Date.now();
      if (result !== undefined) step.result = result;
      // 推进当前步骤
      if (cp.currentStepIndex <= stepIndex) cp.currentStepIndex = stepIndex + 1;
    }
    cp.progress = Math.round((cp.steps.filter(s => s.status === 'done').length / cp.steps.length) * 100);
    if (cp.steps.every(s => s.status === 'done')) cp.status = 'done';
    TaskStore.save(cp);
    return cp;
  }

  /** 标记某步骤失败（记录错误，自动重试计数） */
  static markStepFailed(goalId: string, stepIndex: number, error: string): TaskCheckpoint | null {
    const cp = TaskStore.load(goalId);
    if (!cp) return null;
    const step = cp.steps[stepIndex];
    if (step) {
      step.status = 'failed';
      step.error = error;
      step.retries += 1;
    }
    cp.lastError = error;
    TaskStore.save(cp);
    return cp;
  }

  /** 重置失败步骤为 pending（供重试） */
  static resetStep(goalId: string, stepIndex: number): TaskCheckpoint | null {
    const cp = TaskStore.load(goalId);
    if (!cp) return null;
    const step = cp.steps[stepIndex];
    if (step) {
      step.status = 'pending';
      step.error = undefined;
    }
    TaskStore.save(cp);
    return cp;
  }

  /** 更新整体状态（done/failed/stopped/in_progress） */
  static setStatus(goalId: string, status: TaskCheckpoint['status'], message?: string): void {
    const cp = TaskStore.load(goalId);
    if (!cp) return;
    cp.status = status;
    if (message) cp.lastError = message;
    if (status === 'done') cp.progress = 100;
    TaskStore.save(cp);
  }

  /** 更新强推完成模式 */
  static setForceComplete(goalId: string, on: boolean): void {
    const cp = TaskStore.load(goalId);
    if (!cp) return;
    cp.forceComplete = on;
    TaskStore.save(cp);
  }

  /** 更新轮次 */
  static setRound(goalId: string, round: number): void {
    const cp = TaskStore.load(goalId);
    if (!cp) return;
    cp.round = round;
    TaskStore.save(cp);
  }

  /** 删除 checkpoint */
  static remove(goalId: string): void {
    const p = checkpointPath(goalId);
    try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  }

  /** 列出所有未完成的 checkpoint（启动时断点恢复用） */
  static listIncomplete(): TaskCheckpoint[] {
    const dir = getCheckpointDir();
    const all: TaskCheckpoint[] = [];
    try {
      const files = readdirSync(dir).filter((f: string) => f.endsWith('.checkpoint.json'));
      for (const f of files) {
        try {
          const cp = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as TaskCheckpoint;
          if (cp.status === 'in_progress' || cp.status === 'pending') all.push(cp);
        } catch { /* ignore bad file */ }
      }
    } catch { /* ignore */ }
    return all;
  }

  /** 是否存在 checkpoint */
  static has(goalId: string): boolean {
    return existsSync(checkpointPath(goalId));
  }
}
