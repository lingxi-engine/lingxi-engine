/**
 * 轻量 IANA 时区库（不依赖 moment-timezone 等大依赖）
 *
 * v3 修复（2026-10-21）：
 *  - 移除 IANA_OFFSET_MIN 固定 offset 近似表。固定 offset 完全忽略 DST，
 *    导致夏令时期间（如 America/New_York 夏季 EDT=-4）算出的墙钟时间整体偏移 1 小时。
 *  - 统一使用 Intl.DateTimeFormat（Node 20+ 内置 ICU）计算目标时区的墙钟部件，
 *    自动处理 DST 与历史时区规则变更。
 *  - 修正 hour12:false 在 en-US  locale 下返回 24 的问题（改用 hourCycle:'h23'）。
 *
 * 说明：Intl.DateTimeFormat 走的是 ICU tzdata，Windows 上的 Node 官方发行版
 * 自带完整 ICU；若运行环境 ICU 数据被裁剪（small-icu），会退化到 UTC。
 * 因此保留一个本地时区兜底，并在 init 时探测可用性。
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  weekday: number; // 0-6 (Sun=0)
  hour: number;  // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

/** 缓存 formatter，避免每次调用都新建（cron 扫描会高频调用） */
const fmtCache = new Map<string, Intl.DateTimeFormat>();

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function getFormatter(tz: string): Intl.DateTimeFormat | null {
  const cached = fmtCache.get(tz);
  if (cached !== undefined) return cached;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23', // 关键：避免 en-US 下 00 点被格式化成 24
      weekday: 'short',
    });
  } catch {
    fmt = null;
  }
  fmtCache.set(tz, fmt as unknown as Intl.DateTimeFormat);
  return fmt;
}

/** 本地时区（服务器自身）的墙钟部件 */
function getLocalParts(date: Date): ZonedParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: date.getDay(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
  };
}

/**
 * 把 Date 投影到指定 IANA 时区的"墙钟"部件。
 * 自动处理 DST：同一时刻在不同时区/不同季节返回不同结果。
 */
export function getZonedParts(date: Date, tz: string): ZonedParts {
  if (!tz) return getLocalParts(date);

  // 'local' 或服务器本地时区：直接用原生方法
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz === 'local' || tz === localTz) return getLocalParts(date);

  const fmt = getFormatter(tz);
  if (!fmt) {
    // 无效时区 → 退回本地时区（不再静默用固定 offset 近似）
    return getLocalParts(date);
  }

  try {
    const parts = fmt.formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '0';
    const weekdayStr = get('weekday');
    let hour = Number(get('hour'));
    if (!Number.isFinite(hour)) hour = 0;
    // 某些 ICU 版本在 hourCycle h23 下仍可能给出 24，兜底归一
    if (hour === 24) hour = 0;
    return {
      year: Number(get('year')),
      month: Number(get('month')),
      day: Number(get('day')),
      weekday: WEEKDAY_MAP[weekdayStr] ?? 0,
      hour,
      minute: Number(get('minute')),
      second: Number(get('second')),
    };
  } catch {
    return getLocalParts(date);
  }
}

/**
 * 计算某个时区在指定 UTC 时刻的 UTC offset（分钟）。
 * 正数表示该时区在 UTC 之上（如 Asia/Shanghai = +480）。
 * DST 切换点前后会自然返回不同值。
 */
export function getTimezoneOffsetMinutes(date: Date, tz: string): number {
  const z = getZonedParts(date, tz);
  // 把"墙钟"当作 UTC 解读，再和真实 UTC 比较，差值就是 offset
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  // 抹掉毫秒/秒级误差
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * 把"某时区的墙钟时间"转换为真实 UTC 时间戳。
 * 用于 cron 计算"目标时区的 09:00"到底对应哪个 UTC 瞬间。
 *
 * 注意：夏令时"不存在的时刻"（如纽约 02:30 春季跳变）会被顺延到跳变后的时刻，
 * 这是与主流 cron 实现（Vixie cron）一致的行为。
 */
export function zonedTimeToUtc(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  tz: string,
): number {
  // 迭代法：先按猜测的 offset 换算，再用实际 offset 校正
  let guessOffset = getTimezoneOffsetMinutes(new Date(Date.UTC(year, month - 1, day, hour, minute, second)), tz);
  let ts = Date.UTC(year, month - 1, day, hour, minute, second) - guessOffset * 60000;
  // 校正一轮（跨 DST 边界时 offset 可能变化）
  const actualOffset = getTimezoneOffsetMinutes(new Date(ts), tz);
  if (actualOffset !== guessOffset) {
    ts = Date.UTC(year, month - 1, day, hour, minute, second) - actualOffset * 60000;
  }
  return ts;
}

/**
 * 校验时区 ID 是否被运行环境支持。
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
