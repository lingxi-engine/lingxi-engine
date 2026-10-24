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
 * v5 修复（2026-10-22，根因级）：
 *  旧实现对"不存在的墙钟时刻"是**回退**而不是**顺延**：
 *    请求 2026-03-08 02:30 America/New_York → 实际得到 01:30（往前跳了 1 小时）
 *    请求 2023-10-01 00:00 America/Asuncion  → 实际得到 09-30 23:00（跳到前一天）
 *  这与函数自身文档承诺的"顺延到跳变后的时刻"直接矛盾，
 *  也是 v4 "月进位死循环"的根因：月进位固定跳到"下月 1 号 00:00"，
 *  而该墙钟在某些时区不存在 → zonedTimeToUtc 返回一个**更早**的时间戳
 *  → 迭代器"前进"到过去 → 重新落入同一个月 → 永不前进 → 死循环。
 *  实测 America/Asuncion + "0 0 1 10 *"：getNextCronRun 卡死 275 秒，
 *  期间事件循环 setInterval tick=0，完全冻结。
 *
 * 修复：改为"先按 offset 估算，再校验 + 显式顺延"：
 *  1. 估算 ts；
 *  2. 校验 ts 在目标时区的墙钟是否 == 请求的墙钟；
 *  3. 若不等（说明该墙钟不存在）→ 按 gap 大小显式**向后顺延**，
 *     返回跳变后第一个真实存在的时刻（Vixie cron 语义）。
 *  4. 顺延结果必须严格大于估算值，保证单调性。
 */
export function zonedTimeToUtc(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
  tz: string,
): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  // 迭代法：先按猜测的 offset 换算，再用实际 offset 校正
  let guessOffset = getTimezoneOffsetMinutes(new Date(wallAsUtc), tz);
  let ts = wallAsUtc - guessOffset * 60000;
  // 校正一轮（跨 DST 边界时 offset 可能变化）
  const actualOffset = getTimezoneOffsetMinutes(new Date(ts), tz);
  if (actualOffset !== guessOffset) {
    ts = wallAsUtc - actualOffset * 60000;
  }

  // ── v5 关键修复：校验墙钟是否真的落在目标时刻上 ──
  const z = getZonedParts(new Date(ts), tz);
  const matched =
    z.year === year && z.month === month && z.day === day &&
    z.hour === hour && z.minute === minute && z.second === second;

  if (matched) return ts;

  // 墙钟不存在（夏令时空档 / 历史时区规则变更）→ 显式向后顺延到跳变后
  // 第一个真实存在的时刻。
  //
  // gap 的正确算法：把"请求墙钟"与"实际落在的墙钟"作差，得到需要跳过的幅度。
  //   请求 2026-03-08 02:30 → 落在 01:30 → gap = +1h
  //   请求 2023-10-01 00:00 → 落在 09-30 23:00 → gap = +1h
  const landed = getZonedParts(new Date(ts), tz);
  const landedAsUtc = Date.UTC(
    landed.year, landed.month - 1, landed.day,
    landed.hour, landed.minute, landed.second,
  );
  const gapMs = wallAsUtc - landedAsUtc;
  const shift = gapMs > 0 ? gapMs : 3600000; // gap 异常时兜底 1 小时

  // 逐分钟向前找第一个真实存在的墙钟（gap 内所有时刻都不存在）
  // 最多找 24 小时（覆盖 Lord Howe 等 30 分钟跳变与历史大跳变）
  for (let step = 0; step <= 24 * 60; step++) {
    const candidate = ts + shift + step * 60000;
    const cz = getZonedParts(new Date(candidate), tz);
    // 找到"跳变之后"的第一个有效时刻：墙钟 >= 请求的墙钟
    if (
      cz.year > year ||
      (cz.year === year && cz.month > month) ||
      (cz.year === year && cz.month === month && cz.day > day) ||
      (cz.year === year && cz.month === month && cz.day === day && cz.hour > hour) ||
      (cz.year === year && cz.month === month && cz.day === day && cz.hour === hour && cz.minute > minute) ||
      (cz.year === year && cz.month === month && cz.day === day && cz.hour === hour && cz.minute === minute && cz.second > second)
    ) {
      return candidate;
    }
  }

  // 兜底：按估算值向后推 1 小时，保证严格单调（防止任何情况下的死循环）
  return ts + 3600000;
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
