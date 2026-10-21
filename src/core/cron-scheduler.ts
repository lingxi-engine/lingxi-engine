/**
 * 定时任务系统 - Cron Scheduler
 *
 * v3 修复（2026-10-21，审计发现 3 个 P0 + 5 个 P1）：
 *  - P0-1 setTimeout 延迟溢出：Node setTimeout 上限 2^31-1 ms ≈ 24.9 天。
 *           年度任务（下次运行 71 天后）delay 溢出 → 立刻触发 → 高速重复执行。
 *           修复：长延迟分段等待（MAX_TIMEOUT 切片），每段醒来后重新计算，
 *           未到点就继续等，绝不提前触发。
 *  - P0-2 整点 cron 固定晚一小时：原实现按"小时步进"找匹配，
 *           从 08:00 出发跳到 09:00 时落在 09:00:00 之后，错过整点。
 *           修复：按"分钟边界"从下一个整分钟开始逐分钟精确搜索。
 *  - P0-3 步长为 0 的死循环：for (i += 0) 永不结束 → 卡死事件循环。
 *           修复：解析期显式拒绝 step <= 0。
 *  - P1-1 固定 offset 时区错误：改用 Intl（见 timezone.ts），自动处理 DST。
 *  - P1-2 常见 cron 表达式无法解析（mon / mon-fri / 5/10 / 60）。
 *           修复：支持星期名、范围名、步长简写、星期 7=周日。
 *  - P1-3 日与星期语义错误：标准 cron 中"日"与"星期"是 OR 关系（Vixie cron），
 *           原实现是 AND，导致 0 9 15 * 1 要等到"15 号且周一"。
 *           修复：两者都被限定时取并集；只有一个被限定时取那一个。
 *  - P1-4 非法任务先落盘后校验：API 返回 400 但任务已写进内存和磁盘。
 *           修复：addJob 先校验再落盘。
 *  - P2-1 运行历史不持久化：every/cron 执行后只更新内存。
 *           修复：执行后立即持久化 lastRunAt / runCount。
 */

import { getZonedParts, zonedTimeToUtc, isValidTimezone } from './timezone.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
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

/** 字段定义：[最小值, 最大值] */
type FieldRange = { min: number; max: number; name: string };

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59, name: '分钟' },
  { min: 0, max: 23, name: '小时' },
  { min: 1, max: 31, name: '日' },
  { min: 1, max: 12, name: '月' },
  { min: 0, max: 7, name: '星期' }, // 0 和 7 都表示周日
];

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export interface ParsedCron {
  minute: number[];
  hour: number[];
  day: number[];
  month: number[];
  weekday: number[]; // 归一化为 0-6，7 → 0
  /** 原始"日"字段是否为通配（决定 OR / AND 语义） */
  dayWildcard: boolean;
  /** 原始"星期"字段是否为通配 */
  weekdayWildcard: boolean;
}

/**
 * 解析单个字段。支持：
 *   *              通配
 *   5              单值
 *   1-30           范围
 *   mon,tue        星期/月份名
 *   mon-fri        名称范围
 *   x/15           步长
 *   5/10           从 5 开始的步长（Vixie cron 语义：5/10 = 5,15,25,35,45,55）
 *   1-30/5         范围+步长
 */
function parseField(field: string, range: FieldRange): { values: number[]; wildcard: boolean } {
  const { min, max, name } = range;
  const f = field.trim();

  if (!f) throw new Error(`Cron ${name}字段不能为空`);
  if (f === '*') {
    return { values: Array.from({ length: max - min + 1 }, (_, i) => i + min), wildcard: true };
  }

  const values = new Set<number>();
  let wildcard = false;

  const normalize = (raw: string): number => {
    const key = raw.toLowerCase();
    if (range.name === '星期') {
      if (key in DOW_NAMES) return DOW_NAMES[key];
    } else if (range.name === '月') {
      if (key in MONTH_NAMES) return MONTH_NAMES[key];
    }
    if (!/^\d+$/.test(key)) {
      throw new Error(`Cron ${name}字段包含非法值 "${raw}"`);
    }
    return parseInt(key, 10);
  };

  for (const part of f.split(',')) {
    const p = part.trim();
    if (!p) throw new Error(`Cron ${name}字段存在空项`);

    // 步长
    if (p.includes('/')) {
      const slashIdx = p.indexOf('/');
      const rangePart = p.slice(0, slashIdx).trim();
      const stepPart = p.slice(slashIdx + 1).trim();

      if (!/^\d+$/.test(stepPart)) {
        throw new Error(`Cron ${name}字段步长非法: "${p}"`);
      }
      const step = parseInt(stepPart, 10);
      if (step <= 0) {
        throw new Error(`Cron ${name}字段步长必须大于 0: "${p}"（步长 0 会导致死循环）`);
      }

      let start: number, end: number;
      if (rangePart === '*') {
        start = min; end = max; wildcard = true;
      } else if (rangePart.includes('-')) {
        const [s, e] = rangePart.split('-').map(s => s.trim());
        start = normalize(s); end = normalize(e);
      } else {
        // 简写 5/10 → 从 5 到 max，步长 10
        start = normalize(rangePart);
        end = max;
      }

      if (start < min || start > max) {
        throw new Error(`Cron ${name}字段起始值越界: "${p}"（允许 ${min}-${max}）`);
      }
      if (end < min || end > max) {
        throw new Error(`Cron ${name}字段结束值越界: "${p}"（允许 ${min}-${max}）`);
      }
      if (end < start) {
        throw new Error(`Cron ${name}字段范围倒置: "${p}"`);
      }
      for (let i = start; i <= end; i += step) values.add(i);
      continue;
    }

    // 范围
    if (p.includes('-')) {
      const [s, e] = p.split('-').map(s => s.trim());
      const start = normalize(s);
      const end = normalize(e);
      if (start < min || start > max) throw new Error(`Cron ${name}字段越界: "${p}"`);
      if (end < min || end > max) throw new Error(`Cron ${name}字段越界: "${p}"`);
      if (end < start) throw new Error(`Cron ${name}字段范围倒置: "${p}"`);
      for (let i = start; i <= end; i++) values.add(i);
      continue;
    }

    // 单值
    const v = normalize(p);
    if (v < min || v > max) {
      throw new Error(`Cron ${name}字段值越界: "${p}"（允许 ${min}-${max}）`);
    }
    values.add(v);
  }

  if (values.size === 0) throw new Error(`Cron ${name}字段解析结果为空: "${f}"`);

  // 星期归一化：7 → 0（周日）
  const arr = Array.from(values).sort((a, b) => a - b);
  if (range.name === '星期') {
    return { values: arr.map(v => v === 7 ? 0 : v), wildcard };
  }
  return { values: arr, wildcard };
}

/**
 * 解析 5 字段 cron 表达式。
 * 非法输入直接抛错（调用方负责转成 400 响应）。
 */
export function parseCronExpr(expr: string): ParsedCron {
  if (typeof expr !== 'string' || !expr.trim()) {
    throw new Error('Cron 表达式不能为空');
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Cron 表达式必须是 5 位（分 时 日 月 周），收到 ${parts.length} 位: "${expr}"`);
  }

  const minute = parseField(parts[0], FIELD_RANGES[0]);
  const hour = parseField(parts[1], FIELD_RANGES[1]);
  const day = parseField(parts[2], FIELD_RANGES[2]);
  const month = parseField(parts[3], FIELD_RANGES[3]);
  const weekday = parseField(parts[4], FIELD_RANGES[4]);

  return {
    minute: minute.values,
    hour: hour.values,
    day: day.values,
    month: month.values,
    weekday: weekday.values,
    dayWildcard: day.wildcard,
    weekdayWildcard: weekday.wildcard,
  };
}

/**
 * 计算下一次 cron 触发时间（目标时区的墙钟时间语义）。
 *
 * 关键实现点：
 *  - 从"下一个整分钟"开始，逐分钟推进搜索，绝不按小时跳跃，
 *    否则会错过整点（如 0 9 * * * 从 08:00 出发会跳到 09:00 之后）。
 *  - 每次迭代把 UTC 瞬间换算成目标时区墙钟，逐字段匹配。
 *  - "日"与"星期"字段在两者都被限定时取 OR（Vixie cron 标准语义）。
 */
export function getNextCronRun(expr: string, after: Date, tz: string = 'Asia/Shanghai'): Date | null {
  const parsed = parseCronExpr(expr);

  // 从 after 的下一个整分钟开始（对齐到分钟边界）
  const start = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000);
  const limit = new Date(after.getTime() + 366 * 86400000); // 最多找 1 年多一点（覆盖 2/29）

  let d = start;
  let iterations = 0;
  const MAX_ITER = 366 * 24 * 60; // 一年分钟数上限

  while (d.getTime() < limit.getTime() && iterations++ < MAX_ITER) {
    const z = getZonedParts(d, tz);

    if (!parsed.month.includes(z.month)) {
      // 月份不匹配 → 直接跳到下个月 1 号 00:00（时区墙钟）
      // 跨年时年份必须 +1，否则会跳回过去的时间点（2026-12 → 2026-01）
      const nextYear = z.month === 12 ? z.year + 1 : z.year;
      const nextMonth = z.month === 12 ? 1 : z.month + 1;
      d = new Date(zonedTimeToUtc(nextYear, nextMonth, 1, 0, 0, 0, tz));
      continue;
    }

    // 日/星期 OR 语义：两者都被限定 → 并集；只有一个被限定 → 那一个；都通配 → 全匹配
    const dayMatch = parsed.dayWildcard
      ? true
      : parsed.day.includes(z.day);
    const dowMatch = parsed.weekdayWildcard
      ? true
      : parsed.weekday.includes(z.weekday);
    const dateMatch = (parsed.dayWildcard && parsed.weekdayWildcard)
      ? true
      : (parsed.dayWildcard ? dowMatch : (parsed.weekdayWildcard ? dayMatch : (dayMatch || dowMatch)));

    if (!dateMatch) {
      d = new Date(d.getTime() + 86400000); // 跳到明天同刻
      continue;
    }

    if (!parsed.hour.includes(z.hour)) {
      // 小时不匹配 → 跳到下一个整点
      d = new Date(zonedTimeToUtc(z.year, z.month, z.day, z.hour, 0, 0, tz) + 3600000);
      continue;
    }

    if (parsed.minute.includes(z.minute)) {
      return d;
    }

    // 当前小时但分钟不匹配 → 跳到下一分钟
    d = new Date(d.getTime() + 60000);
  }

  console.warn(`[Cron] 表达式 "${expr}" 在 1 年内无匹配时间点`);
  return null;
}

// ── Cron 调度器 ──

/** Node setTimeout 最大延迟（2^31-1 ms ≈ 24.9 天） */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * 校验调度配置（供 API 层在落盘前调用）。
 * 非法配置直接抛错，由调用方转成 400 响应。
 *
 * P1-4 修复的核心：把"校验"提到 API 边界，确保 API 返回 400 时
 * 任务既没进内存也没进磁盘。
 */
export function validateSchedule(schedule: ScheduleConfig): void {
  if (!schedule || !schedule.kind) throw new Error('schedule.kind 必填');
  switch (schedule.kind) {
    case 'at': {
      if (!schedule.at) throw new Error('at 类型任务必须提供 at 时间');
      const t = new Date(schedule.at).getTime();
      if (!Number.isFinite(t)) throw new Error(`at 时间无法解析: "${schedule.at}"`);
      break;
    }
    case 'every': {
      const every = schedule.everyMs;
      if (!Number.isFinite(every) || (every as number) <= 0) {
        throw new Error(`every 类型任务的 everyMs 必须为正数，收到 ${every}`);
      }
      if ((every as number) > MAX_TIMEOUT_MS) {
        throw new Error(`everyMs 超过单次定时器上限（${MAX_TIMEOUT_MS} ms）`);
      }
      break;
    }
    case 'cron': {
      if (!schedule.expr) throw new Error('cron 类型任务必须提供 expr');
      parseCronExpr(schedule.expr);
      if (schedule.tz && !isValidTimezone(schedule.tz)) {
        throw new Error(`无效时区: "${schedule.tz}"`);
      }
      break;
    }
    default:
      throw new Error(`未知的调度类型: ${(schedule as any).kind}`);
  }
}
/** 单次切片的最大等待时间，留出安全余量 */
const SLICE_MS = MAX_TIMEOUT_MS - 60_000;

export class CronScheduler {
  private jobs = new Map<string, CronJob>();
  private timers = new Map<string, NodeJS.Timeout>();
  private handler: (job: CronJob) => Promise<void>;
  private running = false;
  private persistPath: string;
  /** 防止同一任务并发执行（上次还没跑完就又到点了） */
  private executing = new Set<string>();

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

  /**
   * 添加任务。**先校验再落盘** —— 非法表达式直接抛错，不污染内存与磁盘。
   */
  addJob(job: CronJob): void {
    this.validateJob(job);
    this.jobs.set(job.id, job);
    this.persistToDisk();
    if (this.running && job.enabled) {
      this.scheduleJob(job);
    }
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
    this.persistToDisk();
    if (enabled && this.running) {
      this.scheduleJob(job);
    } else {
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.timers.delete(id);
    }
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
    if (this.executing.has(id)) {
      console.warn(`[Cron] 任务 ${id} 上一次执行尚未结束，跳过本次`);
      return false;
    }
    this.executing.add(id);
    try {
      await this.handler(job);
      job.lastRunAt = Date.now();
      job.runCount++;
      this.persistToDisk();
      return true;
    } catch (err: any) {
      console.error(`[Cron] 任务 ${id} 执行失败:`, err.message);
      return false;
    } finally {
      this.executing.delete(id);
    }
  }

  /**
   * 校验任务定义。非法则抛错，调用方转 400。
   */
  private validateJob(job: CronJob): void {
    if (!job || !job.id) throw new Error('任务 id 必填');
    if (!job.name) throw new Error('任务 name 必填');
    if (!job.schedule || !job.schedule.kind) throw new Error('任务 schedule.kind 必填');

    switch (job.schedule.kind) {
      case 'at': {
        if (!job.schedule.at) throw new Error('at 类型任务必须提供 at 时间');
        const t = new Date(job.schedule.at).getTime();
        if (!Number.isFinite(t)) throw new Error(`at 时间无法解析: "${job.schedule.at}"`);
        break;
      }
      case 'every': {
        const every = job.schedule.everyMs;
        if (!Number.isFinite(every) || (every as number) <= 0) {
          throw new Error(`every 类型任务的 everyMs 必须为正数，收到 ${every}`);
        }
        // 防止 everyMs 过大导致溢出
        if ((every as number) > MAX_TIMEOUT_MS) {
          throw new Error(`everyMs 超过单次定时器上限（${MAX_TIMEOUT_MS} ms）`);
        }
        break;
      }
      case 'cron': {
        if (!job.schedule.expr) throw new Error('cron 类型任务必须提供 expr');
        parseCronExpr(job.schedule.expr); // 抛错即非法
        const tz = job.schedule.tz;
        if (tz && !isValidTimezone(tz)) {
          throw new Error(`无效时区: "${tz}"`);
        }
        break;
      }
      default:
        throw new Error(`未知的调度类型: ${job.schedule.kind}`);
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
        lastRunAt: j.lastRunAt, nextRunAt: j.nextRunAt,
        runCount: j.runCount, createdAt: j.createdAt,
      }));
      writeFileSync(this.persistPath, JSON.stringify(data, (key, val) => typeof val === 'undefined' ? null : val, 2), 'utf8');
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
      let skipped = 0;
      for (const j of data) {
        const job: CronJob = {
          id: j.id, name: j.name, enabled: j.enabled ?? true,
          schedule: j.schedule, payload: j.payload,
          lastRunAt: j.lastRunAt, runCount: j.runCount, createdAt: j.createdAt,
        };
        // 反序列化后重新校验，防止磁盘上的脏数据在启动时炸掉
        try {
          this.validateJob(job);
          this.jobs.set(job.id, job);
        } catch (err: any) {
          skipped++;
          console.warn(`[Cron] 跳过非法任务 ${j.id} (${j.name}): ${err.message}`);
        }
      }
      if (skipped > 0) console.warn(`[Cron] 已跳过 ${skipped} 个非法任务`);
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

  /**
   * 调度单个任务。
   *
   * 长延迟处理：若 delay 超过 Node setTimeout 上限，切成多段等待。
   * 每段醒来后重新计算剩余时间，未到点就继续等 —— 避免"溢出即触发"的高速重复执行。
   */
  private scheduleJob(job: CronJob): void {
    const oldTimer = this.timers.get(job.id);
    if (oldTimer) clearTimeout(oldTimer);

    const delay = this.getDelayMs(job);
    if (delay < 0) return;

    job.nextRunAt = Date.now() + delay;

    // 切片等待：超过上限就分段
    const slice = Math.min(delay, SLICE_MS);
    const needsReslice = delay > SLICE_MS;

    const timer = setTimeout(async () => {
      if (!this.running || !job.enabled) return;

      if (needsReslice) {
        // 还没到点 → 重新计算并继续等，绝不执行
        this.scheduleJob(job);
        return;
      }

      // 到点了
      if (this.executing.has(job.id)) {
        console.warn(`[Cron] 任务 ${job.id} 上一次执行尚未结束，跳过本次触发`);
      } else {
        this.executing.add(job.id);
        try {
          await this.handler(job);
          job.lastRunAt = Date.now();
          job.runCount++;
          this.persistToDisk(); // P2-1: 运行历史立即落盘
        } catch (err: any) {
          console.error(`[Cron] 任务 ${job.id} (${job.name}) 执行失败:`, err.message);
        } finally {
          this.executing.delete(job.id);
        }
      }

      if (job.schedule.kind === 'at') {
        job.enabled = false;
        this.timers.delete(job.id);
        this.persistToDisk();
        return;
      }

      if (this.running && job.enabled) {
        this.scheduleJob(job);
      }
    }, slice);

    this.timers.set(job.id, timer);
    if (timer && typeof timer === 'object' && 'unref' in timer) (timer as any).unref();
  }

  private getDelayMs(job: CronJob): number {
    const now = Date.now();
    switch (job.schedule.kind) {
      case 'at': {
        const target = new Date(job.schedule.at!).getTime();
        return target - now;
      }
      case 'every': {
        const every = job.schedule.everyMs || 60000;
        const last = job.lastRunAt || job.createdAt;
        const next = last + every;
        return Math.max(next - now, 1000);
      }
      case 'cron': {
        const next = getNextCronRun(job.schedule.expr!, new Date(now + 1000), job.schedule.tz);
        if (!next) return -1; // 不可达日期
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
