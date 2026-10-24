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
 *
 * v4 修复（2026-10-21，复核 v3 修复时发现残留缺陷）：
 *  - P0-4 DST 回拨日死循环：小时跳跃用 "UTC 瞬时 + 1h"，回拨日墙钟原地
 *           踏步（01:00 EDT → 01:00 EST），迭代器永不前进。实测
 *           getNextCronRun 卡死 63.8 秒 → 整个 Node 事件循环冻结 1 分钟。
 *           修复：改用墙钟重建（advanceToNextHour / advanceToNextDay）。
 *  - P0-5 整点被跳过：getDelayMs 传 now+1000 作为搜索起点，当距目标整点
 *           不足 1 秒时整点被整段跳过（v3 "整点晚一小时" 的残留变种）。
 *           修复：起点改为 now 本身。
 *  - P1-5 闰年不可达：搜索窗口只有 366 天，"0 0 29 2 *" 永远算不出下次
 *           运行 → 任务创建成功但永不执行。修复：窗口扩到 4 年。
 *  - P1-6 不可达日期静默：getNextCronRun 返回 null 时静默不调度。
 *           修复：输出告警 + nextRunAt 置 undefined，状态可见。
 *  - P1-7 every 过期补跑：重启后落后多个周期的任务 1 秒就补跑一次。
 *           修复：从"现在"重新计时，不追赶历史周期。
 *  - P1-8 DST 日墙钟漂移：日期跳跃用 UTC +24h，DST 日墙钟偏 1 小时。
 *           修复：日期进位改用 Date.UTC + 目标时区重建。
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

  // ── 搜索窗口 ──
  // 必须是 4 年而不是 1 年：像 "0 0 29 2 *"（2 月 29 日）这种表达式，
  // 下一个匹配点最远在 4 年后（闰年间隔最多 8 年，但 4 年已覆盖绝大多数，
  // 且 8 年窗口会让不可达表达式的探测成本过高）。
  // v3 用 366 天窗口，导致 2026-10 之后创建的 2/29 任务永远算不出下次运行
  // → 任务"创建成功但永不执行"，正是本次审计要消灭的病根。
  const limit = new Date(after.getTime() + SEARCH_WINDOW_DAYS * 86400000);

/**
 * v5 修复：给 getNextCronRun 的"月进位"路径加单调性兜底
 *
 * 背景：v4 给 advanceToNextHour / advanceToNextDay 都加了单调性兜底，
 * 但**月进位路径**（月份不匹配时跳到"下月 1 号 00:00"）没有。
 * 该路径直接用 zonedTimeToUtc 的返回值，且没有"必须严格前进"的检查。
 *
 * 根因虽已在 timezone.ts 修复（zonedTimeToUtc 改为显式顺延），
 * 但纵深防御原则下，任何跳转路径都应自带单调性保证 ——
 * 否则将来任何一个新的边界（历史时区规则、非整点 offset 变更）
 * 都可能重新引入"跳回过去 → 永不前进 → 死循环"的 P0。
 */

  // ── 起点：after 的下一个整分钟 ──
  // 注意：不能用 "after + 1000ms" 作为起点，那会把"整点前 1 秒内触发"的
  // 场景直接推到整点之后，导致整点被整段跳过（v3 残留 bug）。
  let d = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000);

  let iterations = 0;
  const MAX_ITER = SEARCH_WINDOW_DAYS * 24 * 60;

  while (d.getTime() < limit.getTime() && iterations++ < MAX_ITER) {
    const z = getZonedParts(d, tz);

    if (!parsed.month.includes(z.month)) {
      // 月份不匹配 → 跳到下个月 1 号 00:00（目标时区墙钟）
      // 跨年时年份必须 +1，否则会跳回过去的时间点（2026-12 → 2026-01）
      const nextYear = z.month === 12 ? z.year + 1 : z.year;
      const nextMonth = z.month === 12 ? 1 : z.month + 1;
      // v5 修复：月进位必须严格前进。
      // 原实现直接用 zonedTimeToUtc 的返回值，无单调性保证。
      // 当时区规则变更使"1 号 00:00"不存在时（如 America/Asuncion 2023-10），
      // 该值会落到"上个月" → 迭代器跳回过去 → 重新落入同一个月 → 永不前进。
      // 实测 getNextCronRun 卡死 275 秒，事件循环完全冻结。
      const candidate = zonedTimeToUtc(nextYear, nextMonth, 1, 0, 0, 0, tz);
      const nextTs = candidate > d.getTime() ? candidate : d.getTime() + 86400000;
      d = new Date(nextTs);
      continue;
    }

    // 日/星期 OR 语义：两者都被限定 → 并集；只有一个被限定 → 那一个；都通配 → 全匹配
    const dayMatch = parsed.dayWildcard ? true : parsed.day.includes(z.day);
    const dowMatch = parsed.weekdayWildcard ? true : parsed.weekday.includes(z.weekday);
    const dateMatch = (parsed.dayWildcard && parsed.weekdayWildcard)
      ? true
      : (parsed.dayWildcard ? dowMatch : (parsed.weekdayWildcard ? dayMatch : (dayMatch || dowMatch)));

    if (!dateMatch) {
      // 跳到"明天同一墙钟时刻"——必须用墙钟重建，不能用 UTC +24h。
      // UTC +24h 在 DST 切换日会让墙钟漂移 1 小时（春季少一小时，秋季多一小时）。
      d = advanceToNextDay(z, tz, d.getTime());
      continue;
    }

    if (!parsed.hour.includes(z.hour)) {
      // 小时不匹配 → 跳到"下一个整点"（按目标时区墙钟重建）
      // v3 用 "zonedTimeToUtc(墙钟) + 3600000"（UTC 瞬时 +1h），在 DST 回拨日
      // 墙钟会原地踏步（01:00 EDT → 01:00 EST）→ 迭代器永不前进 → 死循环
      // 63.8 秒卡死整个 Node 事件循环。必须用墙钟重建。
      d = advanceToNextHour(z, tz, d.getTime());
      continue;
    }

    if (parsed.minute.includes(z.minute)) {
      return d;
    }

    // 当前小时但分钟不匹配 → 跳到下一分钟
    d = new Date(d.getTime() + 60000);
  }

  console.warn(`[Cron] 表达式 "${expr}" 在 ${SEARCH_WINDOW_DAYS} 天内无匹配时间点`);
  return null;
}

/**
 * 把"目标时区的当前墙钟"推进到"下一个整点"。
 *
 * 关键：全程用墙钟语义重建时间戳，绝不用 "UTC 瞬时 + 1 小时"。
 * DST 回拨日两者结果相同（墙钟不变），但春季跳变日会差 1 小时；
 * 而回拨日的"墙钟不变"正是用 UTC+1h 死循环的根因 —— 用墙钟重建则
 * 无论 DST 如何变化都保证严格前进。
 *
 * 单调性保证：目标墙钟时刻可能落在 DST 空档里（春季跳变日不存在的时刻），
 * 此时 zonedTimeToUtc 会反向解析回上一个存在的时刻，导致时间不前进。
 * 因此这里循环尝试"下一个存在的整点"，并最终用真实时间 +1 小时兜底，
 * 确保返回的��间戳严格大于 currentTs —— 这是防止死循环的最后一道防线。
 */
function advanceToNextHour(
  z: { year: number; month: number; day: number; hour: number },
  tz: string,
  currentTs: number,
): Date {
  let y = z.year, m = z.month, d = z.day;
  let targetHour = z.hour + 1;

  if (targetHour > 23) {
    targetHour = 0;
    // 天数进位：用 Date.UTC 处理月末/年末，天然支持月长与闰年
    const nd = new Date(Date.UTC(z.year, z.month - 1, z.day) + 86400000);
    y = nd.getUTCFullYear();
    m = nd.getUTCMonth() + 1;
    d = nd.getUTCDate();
  }

  // 最多尝试 4 个整点（覆盖单次 DST 跳变的空档长度）
  for (let guard = 0; guard < 4; guard++) {
    const ts = zonedTimeToUtc(y, m, d, targetHour, 0, 0, tz);
    if (ts > currentTs) return new Date(ts);

    // 目标墙钟时刻不存在（DST 空档）→ 顺延到下一个整点
    targetHour++;
    if (targetHour > 23) {
      targetHour = 0;
      const nd = new Date(Date.UTC(y, m - 1, d) + 86400000);
      y = nd.getUTCFullYear();
      m = nd.getUTCMonth() + 1;
      d = nd.getUTCDate();
    }
  }

  // 兜底：按真实时间前进 1 小时，保证严格单调（死循环的最后防线）
  return new Date(currentTs + 3600000);
}

/**
 * 把"目标时区的当前墙钟"推进到"明天同一墙钟时刻"。
 *
 * 用 Date.UTC 做日进位（自动处理月末、年末、闰年），再用目标时区重建，
 * 避免 UTC +24h 在 DST 日造成的墙钟漂移。
 */
function advanceToNextDay(
  z: { year: number; month: number; day: number; hour: number; minute: number },
  tz: string,
  currentTs: number,
): Date {
  const nd = new Date(Date.UTC(z.year, z.month - 1, z.day) + 86400000);
  const ts = zonedTimeToUtc(
    nd.getUTCFullYear(), nd.getUTCMonth() + 1, nd.getUTCDate(),
    z.hour, z.minute, 0, tz,
  );
  // 单调性兜底（明天同一墙钟在 DST 空档中不存在时可能反向）
  return ts > currentTs ? new Date(ts) : new Date(currentTs + 3600000);
}

// ── Cron 调度器 ──

/** Node setTimeout 最大延迟（2^31-1 ms ≈ 24.9 天） */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * cron 下次运行时间的搜索窗口（天）。
 * 必须 ≥ 4 年，否则 "0 0 29 2 *"（2/29）这类表达式在非闰年算不出下次运行。
 */
const SEARCH_WINDOW_DAYS = 366 * 4;

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
    // v4 修复：先调度再落盘。
    // 原顺序（先落盘后调度）会让第一次落盘的 nextRunAt 为 null —— 因为
    // nextRunAt 是 scheduleJob 里算出来的，内存里算完但磁盘上还是旧的。
    // 后果：API 返回的 job.nextRunAt 有值，磁盘上却是 null；
    //      重启后从磁盘恢复的任务也拿不到 nextRunAt。
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
    if (delay < 0) {
      // P1-6 修复：不可达日期 → 明确标记 nextRunAt = undefined，
      // 让前端/接口能看出"这个任务永远不会触发"，而不是看起来一切正常。
      job.nextRunAt = undefined;
      return;
    }

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
        // P1-7 修复：过期任务（落后多个周期）不再"立即补跑"。
        // v3 用 Math.max(next - now, 1000)，意味着落后 30 分钟的 every 任务
        // 重启后 1 秒就触发一次 —— 进程重启风暴会造成任务集中爆发。
        // 正确语义：从"现在"重新计时，固定周期继续，不追赶历史周期。
        if (next <= now) return every;
        return next - now;
      }
      case 'cron': {
        // P0-5 修复：起点必须是 now 本身，不能是 now + 1000。
        // 用 now+1000 时，若当前时刻距目标整点不足 1 秒，搜索会直接跳过该整点
        // （08:59:59.9 触发 → 整点被跳过 → 下次是明天 09:00）。
        // getNextCronRun 内部已对齐到"下一个整分钟"，传 now 即可。
        const next = getNextCronRun(job.schedule.expr!, new Date(now), job.schedule.tz);
        if (!next) {
          // P1-6 修复：不可达日期必须给出明确告警，不能静默返回 -1
          // （否则任务看起来"已启用"却永远不会运行，用户完全无从察觉）。
          console.warn(
            `[Cron] 任务 ${job.id} (${job.name}) 的表达式 "${job.schedule.expr}" ` +
            `在未来 ${SEARCH_WINDOW_DAYS} 天内无匹配时间点，该任务不会触发`,
          );
          return -1;
        }
        return Math.max(next.getTime() - now, 1000);
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
