/**
 * 定时任务系统 - Cron Scheduler
 *
 * v2 修复：
 *  - 时区支持：getNextCronRun 现在用 getZonedParts 正确计算指定时区的触发时间
 *  - 持久化：任务列表保存到 data/cron-jobs.json，重启恢复
 *
 * v2.1 修复：
 *  - BUG-3: cron 表达式中 day-of-month 与 day-of-week 同时受限时改为 OR 语义（标准 cron）；
 *           同时修复内层分钟搜索起点——必须从命中小时的整点开始（分钟/秒/毫秒归零），否则整点触发会被算错
 *  - BUG-4: "at" 一次性任务过期后补执行一次并标记完成，不再静默卡死
 *  - BUG-7: persistToDisk 保存 nextRunAt；且 addJob/setEnabled 改为先调度再持久化；
 *           nextRunAt 在 getDelayMs 内用同一时间基准计算，避免两次 Date.now() 引入毫秒漂移
 */

import { getZonedParts } from './timezone.js';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

export type ScheduleKind = 'at' | 'every' | 'cron';

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: ScheduleConfig;
  payload: JobPayload;
  lastRunAt?: number;
  nextRunAt?: number;
  runCount: number;
  createdAt: number;
}

export interface ScheduleConfig {
  kind: ScheduleKind;
  at?: string;
  everyMs?: number;
  expr?: string;
  tz?: string;
}

export interface JobPayload {
  kind: 'agentMessage' | 'systemEvent' | 'toolCall' | 'standingOrder';
  prompt?: string;
  chatId?: string;
  message?: string;
  agentId?: string;
  text?: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
}

// ── Cron 表达式解析器 ──

function parseCronExpr(expr: string): { minute: number[]; hour: number[]; day: number[]; month: number[]; weekday: number[] } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron 表达式必须是 5 位: "${expr}"`);

  const parseField = (field: string, min: number, max: number): number[] => {
    if (field === '*') return Array.from({ length: max - min + 1 }, (_, i) => i + min);
    const values: number[] = [];
    for (const part of field.split(',')) {
      if (part.includes('/')) {
        const [range, step] = part.split('/');
        const stepN = parseInt(step);
        let start = min, end = max;
        if (range !== '*') {
          const [s, e] = range.split('-').map(Number);
          start = s; end = e;
        }
        for (let i = start; i <= end; i += stepN) values.push(i);
      } else if (part.includes('-')) {
        const [s, e] = part.split('-').map(Number);
        for (let i = s; i <= e; i++) values.push(i);
      } else {
        values.push(parseInt(part));
      }
    }
    return values.filter(v => v >= min && v <= max);
  };

  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    day: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    weekday: parseField(parts[4], 0, 6),
  };
}

/**
 * v2 修复：计算下一次 cron 触发时间，尊重 tz 时区
 * v2.1 修复：day-of-month 与 day-of-week 同时受限时用 OR 语义（标准 cron）
 *           + 内层分钟搜索从命中小时的整点开始（分钟/秒/毫秒归零）
 */
function getNextCronRun(expr: string, after: Date, tz: string = 'Asia/Shanghai'): Date | null {
  const parsed = parseCronExpr(expr);
  const start = new Date(after.getTime() + 60_000);
  const limit = new Date(after.getTime() + 365 * 86400000);
  let d = new Date(start);

  // 是否受限：字段值个数 < 全范围 → 被显式限制
  const dayRestricted = parsed.day.length < 31;
  const weekdayRestricted = parsed.weekday.length < 7;

  // 优化：先按小时步进找到匹配的 月/日/星期/小时，再按分钟精确匹配
  while (d < limit) {
    const z = getZonedParts(d, tz);
    const monthOk = parsed.month.includes(z.month);

    // 标准 cron 语义：
    //  - DOM 和 DOW 都受限时 → 二者是 OR（任一匹配即触发）
    //  - 只有一方受限 → 用受限的那一方
    //  - 都未受限 → 每天
    let dayOk: boolean;
    if (dayRestricted && weekdayRestricted) {
      dayOk = parsed.day.includes(z.day) || parsed.weekday.includes(z.weekday);
    } else if (dayRestricted) {
      dayOk = parsed.day.includes(z.day);
    } else if (weekdayRestricted) {
      dayOk = parsed.weekday.includes(z.weekday);
    } else {
      dayOk = true;
    }

    if (!monthOk || !dayOk) {
      // 月/日不匹配 → 跳到下一小时（省掉全天逐分钟扫描）
      d = new Date(d.getTime() + 3600000); // 跳 1 小时
      continue;
    }

    if (!parsed.hour.includes(z.hour)) {
      // 小时不匹配 → 跳到下一小时
      d = new Date(d.getTime() + 3600000);
      continue;
    }

    // 月/日/小时都匹配了 → 从当前小时的整点开始按分钟搜索（最多 60 次）
    // v2.1 修复：必须回退到小时起点（分钟/秒/毫秒归零），否则从 d 的当前分钟（如 09:41）
    // 开始找 0 分钟，会错误地命中下一小时的 00 分（把 09:00 的 cron 算成 10:00）。
    const hourStartMs = d.getTime() - z.minute * 60_000 - z.second * 1000 - (d.getTime() % 1000);
    d = new Date(hourStartMs);
    for (let m = 0; m < 60; m++) {
      const mz = getZonedParts(d, tz);
      if (parsed.minute.includes(mz.minute)) {
        return d;
      }
      d = new Date(d.getTime() + 60_000);
    }
    // 当前小时没匹配 → 继续外层循环（d 已到下一小时整点，hour 匹配会重新从整点搜，不匹配则跳小时）
  }
  console.warn(`[Cron] 表达式 "${expr}" 在 365 天内无匹配，可能不可达`);
  return null;
}

// ── Cron 调度器 ──

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  private handler: (job: CronJob) => Promise<void>;
  private running = false;
  private persistPath: string;

  constructor(handler: (job: CronJob) => Promise<void>, dataDir?: string) {
    this.handler = handler;
    this.persistPath = join(dataDir || process.cwd(), 'cron-jobs.json');
  }

  start(): void {
    this.running = true;
    this.loadFromDisk();
    this.scheduleAll();
    console.log(`[Cron] 调度器已启动, ${this.jobs.size} 个任务`);
  }

  stop(): void {
    this.running = false;
    for (const [, timer] of this.timers) clearTimeout(timer);
    this.timers.clear();
    console.log('[Cron] 调度器已停止');
  }

  addJob(job: CronJob): void {
    this.jobs.set(job.id, job);
    // v2.1: 先调度（会计算 nextRunAt），再持久化，确保 nextRunAt 落盘
    if (this.running && job.enabled) {
      this.scheduleJob(job);
    }
    this.persistToDisk();
  }

  removeJob(id: string): boolean {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const ok = this.jobs.delete(id);
    if (ok) this.persistToDisk();
    return ok;
  }

  setEnabled(id: string, enabled: boolean): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.enabled = enabled;
    // v2.1: 先调度/取消调度（更新 nextRunAt），再持久化
    if (enabled && this.running) {
      this.scheduleJob(job);
    } else {
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
      job.nextRunAt = undefined;
    }
    this.persistToDisk();
  }

  getJob(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  async runNow(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job) return false;
    try {
      await this.handler(job);
      job.lastRunAt = Date.now();
      job.runCount++;
      return true;
    } catch (err: any) {
      console.error(`[Cron] 任务 ${id} 执行失败:`, err.message);
      return false;
    }
  }

  // ── 持久化 ──

  private persistToDisk(): void {
    try {
      const data = this.listJobs().map(j => ({
        id: j.id, name: j.name, enabled: j.enabled,
        schedule: j.schedule,
        payload: j.payload ? JSON.parse(JSON.stringify(j.payload, (key, val) =>
          typeof val === 'undefined' ? null : val
        )) : j.payload,
        lastRunAt: j.lastRunAt, nextRunAt: j.nextRunAt, runCount: j.runCount, createdAt: j.createdAt,
      }));
      const tmpPath = this.persistPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(data, (key, val) => typeof val === 'undefined' ? null : val, 2), 'utf8');
      renameSync(tmpPath, this.persistPath); // 原子替换
    } catch (err: any) {
      console.error('[Cron] 持久化失败:', err.message);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = readFileSync(this.persistPath, 'utf8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) { console.warn('[Cron] 持久化文件格式异常，跳过'); return; }
      for (const j of data) {
        const job: CronJob = {
          id: j.id, name: j.name, enabled: j.enabled ?? true,
          schedule: j.schedule, payload: j.payload,
          lastRunAt: j.lastRunAt, nextRunAt: j.nextRunAt, runCount: j.runCount, createdAt: j.createdAt,
        };
        this.jobs.set(job.id, job);
      }
      console.log(`[Cron] 从磁盘恢复 ${this.jobs.size} 个任务`);
    } catch (err: any) {
      console.error('[Cron] 加载持久化数据失败:', err.message);
    }
  }

  // ── 内部调度 ──

  private scheduleAll(): void {
    for (const [, job] of this.jobs) {
      if (job.enabled) this.scheduleJob(job);
    }
  }

  private scheduleJob(job: CronJob): void {
    const oldTimer = this.timers.get(job.id);
    if (oldTimer) clearTimeout(oldTimer);

    const delay = this.getDelayMs(job); // 内部会同步更新 job.nextRunAt
    if (delay < 0) return; // 仅 cron 不可达日期返回 -1

    const timer = setTimeout(async () => {
      if (!this.running || !job.enabled) return;
      try {
        await this.handler(job);
        job.lastRunAt = Date.now();
        job.runCount++;
      } catch (err: any) {
        console.error(`[Cron] 任务 ${job.id} (${job.name}) 执行失败:`, err.message);
      }

      if (job.schedule.kind === 'at') {
        job.enabled = false;
        job.nextRunAt = undefined;
        this.timers.delete(job.id);
        this.persistToDisk();
        return;
      }

      if (this.running && job.enabled) {
        this.scheduleJob(job);
      }
    }, delay);

    this.timers.set(job.id, timer);
    if (timer && typeof timer === 'object' && 'unref' in timer) (timer as any).unref();
  }

  private getDelayMs(job: CronJob): number {
    const now = Date.now();
    switch (job.schedule.kind) {
      case 'at': {
        const target = new Date(job.schedule.at!).getTime();
        // v2.1 修复: 已过期的一次性任务延迟 0 立即补执行一次（执行后会被标记禁用并持久化），
        // 避免之前 delay < 0 → scheduleJob 直接 return 导致任务永久卡死
        job.nextRunAt = Math.max(target, now);
        return Math.max(target - now, 0);
      }
      case 'every': {
        const every = job.schedule.everyMs || 60000;
        const last = job.lastRunAt || job.createdAt;
        const next = last + every;
        job.nextRunAt = next;
        return Math.max(next - now, 1000);
      }
      case 'cron': {
        const next = getNextCronRun(job.schedule.expr!, new Date(now + 1000), job.schedule.tz);
        if (!next) return -1; // 不可达日期
        // v2.1: nextRunAt 直接用 next 精确值，避免 scheduleJob 里再取一次 Date.now() 产生毫秒漂移
        job.nextRunAt = next.getTime();
        return next.getTime() - now;
      }
      default:
        return -1;
    }
  }
}

// ── 辅助：创建任务 ──

export function createCronJob(opts: {
  name: string;
  schedule: ScheduleConfig;
  payload: JobPayload;
  enabled?: boolean;
}): CronJob {
  const id = 'cron-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  return {
    id,
    name: opts.name,
    enabled: opts.enabled ?? true,
    schedule: opts.schedule,
    payload: opts.payload,
    runCount: 0,
    createdAt: Date.now(),
  };
}
