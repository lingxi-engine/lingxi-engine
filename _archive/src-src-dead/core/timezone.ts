/**
 * 轻量 IANA 时区库（不依赖 moment-timezone 等大依赖）
 * 项目里大部分用户是 Asia/Shanghai；其余只支持常用 IANA → fixed offset。
 *
 * 注意：Node.js 20+ 内置 Intl.DateTimeFormat 支持时区缩写（Asia/Shanghai），
 * 所以我们用 Intl.DateTimeFormat 拿到目标时区的"墙钟"时间。
 */

const IANA_OFFSET_MIN: Record<string, number> = {
  // 标准 IANA 时区（够用即可，不全）
  'UTC': 0,
  'Asia/Shanghai': 8 * 60,
  'Asia/Hong_Kong': 8 * 60,
  'Asia/Tokyo': 9 * 60,
  'Asia/Singapore': 8 * 60,
  'Asia/Seoul': 9 * 60,
  'Asia/Taipei': 8 * 60,
  'Asia/Kolkata': 5 * 60 + 30,
  'Asia/Dubai': 4 * 60,
  'Europe/London': 0,
  'Europe/Paris': 1 * 60,
  'Europe/Berlin': 1 * 60,
  'America/New_York': -5 * 60,
  'America/Los_Angeles': -8 * 60,
  'America/Chicago': -6 * 60,
  'Australia/Sydney': 10 * 60,
};

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  weekday: number; // 0-6 (Sun=0)
  hour: number;  // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

/**
 * 把 Date 投影到指定 IANA 时区的"墙钟"部件。
 * 优先用 Intl.DateTimeFormat，无 fallback。
 */
export function getZonedParts(date: Date, tz: string): ZonedParts {
  if (!tz || tz === 'local' || tz === Intl.DateTimeFormat().resolvedOptions().timeZone) {
    // 本地时区直接用原生方法
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

  // 对内置表里的常用时区，用固定 offset 近似
  const offsetMin = IANA_OFFSET_MIN[tz];
  if (offsetMin !== undefined) {
    const utc = date.getTime() + date.getTimezoneOffset() * 60_000;
    const localMs = utc + offsetMin * 60_000;
    const d = new Date(localMs);
    return {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      weekday: d.getUTCDay(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
    };
  }

  // 兜底：尝试 Intl.DateTimeFormat，时区数有限但能 work
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
      weekday: 'short',
    });
    const parts = fmt.formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '0';
    const weekdayStr = get('weekday');
    const weekdayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return {
      year: Number(get('year')),
      month: Number(get('month')),
      day: Number(get('day')),
      weekday: weekdayMap[weekdayStr] ?? 0,
      hour: Number(get('hour')),
      minute: Number(get('minute')),
      second: Number(get('second')),
    };
  } catch {
    // 终极 fallback：用本地时区
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
}
