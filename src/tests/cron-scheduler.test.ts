/**
 * Cron 调度器回归测试 —— 钉死 v3 修复的 8 个缺陷
 *
 * 覆盖：
 *  P0-1 setTimeout 延迟溢出 → 长延迟分段等待，绝不提前触发
 *  P0-2 整点 cron 固定晚一小时 → 精确命中整点
 *  P0-3 步长为 0 死循环 → 解析期拒绝
 *  P1-1 固定 offset 时区错误 → Intl + DST
 *  P1-2 常见 cron 表达式无法解析 → mon / mon-fri / 5/10
 *  P1-3 日与星期语义错误 → OR 语义
 *  P1-4 非法任务先落盘后校验 → 先校验再落盘
 *  P2-1 运行历史不持久化 → 执行后落盘
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CronScheduler,
  parseCronExpr,
  getNextCronRun,
  validateSchedule,
  createCronJob,
  type CronJob,
} from '../core/cron-scheduler.js';
import { getZonedParts, getTimezoneOffsetMinutes, isValidTimezone } from '../core/timezone.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cron-test-'));
});
afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** 取某个时区下的墙钟字符串，便于断言 */
function wallClock(date: Date, tz: string): string {
  const z = getZonedParts(date, tz);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')} ` +
    `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}

// ════════════════════════════════════════════
// P0-3: 步长为 0 死循环
// ════════════════════════════════════════════
describe('P0-3 步长为 0 的死循环', () => {
  it('*/0 必须抛错而不是死循环', () => {
    expect(() => parseCronExpr('*/0 * * * *')).toThrow(/步长/);
  });

  it('任意字段的 0 步长都被拒绝', () => {
    expect(() => parseCronExpr('0 */0 * * *')).toThrow(/步长/);
    expect(() => parseCronExpr('0 0 */0 * *')).toThrow(/步长/);
    expect(() => parseCronExpr('0 0 1 */0 *')).toThrow(/步长/);
    expect(() => parseCronExpr('0 0 * * */0')).toThrow(/步长/);
  });

  it('负步长被拒绝', () => {
    expect(() => parseCronExpr('0 0 * * 1/-2')).toThrow(/步长/);
  });

  it('正常步长正常工作', () => {
    const p = parseCronExpr('*/15 * * * *');
    expect(p.minute).toEqual([0, 15, 30, 45]);
  });
});

// ════════════════════════════════════════════
// P1-2: 常见 cron 表达式解析
// ════════════════════════════════════════════
describe('P1-2 常见 cron 表达式解析', () => {
  it('支持星期名 mon', () => {
    const p = parseCronExpr('0 9 * * mon');
    expect(p.weekday).toEqual([1]);
  });

  it('支持星期名范围 mon-fri', () => {
    const p = parseCronExpr('0 9 * * mon-fri');
    expect(p.weekday).toEqual([1, 2, 3, 4, 5]);
  });

  it('支持月份名', () => {
    const p = parseCronExpr('0 0 1 jan *');
    expect(p.month).toEqual([1]);
  });

  it('支持 5/10 步长简写（Vixie 语义）', () => {
    const p = parseCronExpr('5/10 * * * *');
    expect(p.minute).toEqual([5, 15, 25, 35, 45, 55]);
  });

  it('支持范围+步长', () => {
    const p = parseCronExpr('0-30/10 * * * *');
    expect(p.minute).toEqual([0, 10, 20, 30]);
  });

  it('星期 7 归一化为 0（周日）', () => {
    const p = parseCronExpr('0 9 * * 7');
    expect(p.weekday).toEqual([0]);
  });

  it('越界的 60 分钟被拒绝而不是静默丢弃', () => {
    expect(() => parseCronExpr('60 * * * *')).toThrow(/越界/);
  });

  it('非法表达式报错', () => {
    expect(() => parseCronExpr('* * * *')).toThrow(/5 位/);
    expect(() => parseCronExpr('* * * * * *')).toThrow(/5 位/);
    expect(() => parseCronExpr('abc * * * *')).toThrow();
    expect(() => parseCronExpr('')).toThrow();
  });

  it('范围倒置被拒绝', () => {
    expect(() => parseCronExpr('30-10 * * * *')).toThrow(/倒置/);
  });
});

// ════════════════════════════════════════════
// P0-2: 整点 cron 固定晚一小时
// ════════════════════════════════════════════
describe('P0-2 整点 cron 精确命中', () => {
  it('0 9 * * * 精确命中 09:00（不是 10:00）', () => {
    // 2026-07-15 08:00:00 Asia/Shanghai
    const after = new Date('2026-07-15T00:00:00Z');
    const next = getNextCronRun('0 9 * * *', after, 'Asia/Shanghai');
    expect(next).not.toBeNull();
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-07-15 09:00');
    // 必须是整点，秒和毫秒为 0
    expect(next!.getSeconds()).toBe(0);
    expect(next!.getMilliseconds()).toBe(0);
  });

  it('半小时表达式 30 8 * * * 正确', () => {
    const after = new Date('2026-07-15T00:00:00Z');
    const next = getNextCronRun('30 8 * * *', after, 'Asia/Shanghai');
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-07-15 08:30');
  });

  it('当前时间已过目标点时顺延到明天', () => {
    // 2026-07-15 10:00:00 上海时间
    const after = new Date('2026-07-15T02:00:00Z');
    const next = getNextCronRun('0 9 * * *', after, 'Asia/Shanghai');
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-07-16 09:00');
  });

  it('每 15 分钟的表达式按 15 分钟步进', () => {
    const after = new Date('2026-07-15T00:00:00Z');
    const next = getNextCronRun('*/15 * * * *', after, 'Asia/Shanghai');
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-07-15 08:15');
  });
});

// ════════════════════════════════════════════
// P1-3: 日与星期的 OR 语义
// ════════════════════════════════════════════
describe('P1-3 日与星期的 OR 语义（Vixie cron 标准）', () => {
  it('0 9 15 * 1 表示"15号 或 周一"，不是"15号且周一"', () => {
    // 起点 2026-07-15 00:00Z = 上海 08:00（当天 09:00 尚未到）
    // OR 语义：7-15（15号）即命中，不必等到下周一
    const after = new Date('2026-07-15T00:00:00Z');
    const next = getNextCronRun('0 9 15 * 1', after, 'Asia/Shanghai');
    expect(next).not.toBeNull();
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-07-15 09:00');

    // 从 7-16 之后开始：15号已过 → 应命中下一个周一 7-20
    const after2 = new Date('2026-07-16T00:00:00Z');
    const next2 = getNextCronRun('0 9 15 * 1', after2, 'Asia/Shanghai');
    expect(wallClock(next2!, 'Asia/Shanghai')).toBe('2026-07-20 09:00');

    // 关键回归：AND 语义会一直跳到"15号且周一"，可能跳到 2027 年
    // OR 语义下 7-20 必须在同一年内命中
    expect(next2!.getUTCFullYear()).toBe(2026);
  });

  it('AND 语义的错误实现会跳到下一年，OR 语义不会', () => {
    // 15 号是每月一次，OR 语义最晚 31 天内必然命中
    const after = new Date('2026-07-15T02:00:00Z');
    const next = getNextCronRun('0 9 15 * 1', after, 'Asia/Shanghai');
    const days = (next!.getTime() - after.getTime()) / 86400000;
    expect(days).toBeLessThan(32);
  });

  it('仅限定"日"时按日匹配', () => {
    const after = new Date('2026-07-15T00:00:00Z');
    const next = getNextCronRun('0 9 20 * *', after, 'Asia/Shanghai');
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-07-20 09:00');
  });

  it('仅限定"星期"时按星期匹配', () => {
    const after = new Date('2026-07-15T00:00:00Z');
    const next = getNextCronRun('0 9 * * 3', after, 'Asia/Shanghai'); // 周三
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-07-15 09:00');
  });

  it('两者都通配时每天匹配', () => {
    const after = new Date('2026-07-15T00:00:00Z');
    const next = getNextCronRun('0 9 * * *', after, 'Asia/Shanghai');
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-07-15 09:00');
  });
});

// ════════════════════════════════════════════
// P1-1: 时区与 DST
// ════════════════════════════════════════════
describe('P1-1 时区计算与 DST', () => {
  it('纽约 7 月（EDT, UTC-4）正确', () => {
    const d = new Date('2026-07-15T12:00:00Z');
    const z = getZonedParts(d, 'America/New_York');
    expect(z.hour).toBe(8);
    expect(getTimezoneOffsetMinutes(d, 'America/New_York')).toBe(-240);
  });

  it('纽约 1 月（EST, UTC-5）正确 —— 固定 offset 表会错', () => {
    const d = new Date('2026-01-15T12:00:00Z');
    const z = getZonedParts(d, 'America/New_York');
    expect(z.hour).toBe(7);
    expect(getTimezoneOffsetMinutes(d, 'America/New_York')).toBe(-300);
  });

  it('伦敦 7 月（BST, UTC+1）正确', () => {
    const d = new Date('2026-07-15T12:00:00Z');
    const z = getZonedParts(d, 'Europe/London');
    expect(z.hour).toBe(13);
  });

  it('东京 7 月正确', () => {
    const d = new Date('2026-07-15T12:00:00Z');
    const z = getZonedParts(d, 'Asia/Tokyo');
    expect(z.hour).toBe(21);
  });

  it('上海 7 月正确', () => {
    const d = new Date('2026-07-15T12:00:00Z');
    const z = getZonedParts(d, 'Asia/Shanghai');
    expect(z.hour).toBe(20);
  });

  it('午夜不会变成 24 点', () => {
    const d = new Date('2026-07-15T16:00:00Z'); // 上海次日 00:00
    const z = getZonedParts(d, 'Asia/Shanghai');
    expect(z.hour).toBe(0);
    expect(z.day).toBe(16);
  });

  it('无效时区被识别', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });

  it('cron 在不同时区算出不同的触发时刻', () => {
    const after = new Date('2026-07-15T00:00:00Z');
    const sh = getNextCronRun('0 9 * * *', after, 'Asia/Shanghai')!;
    const ny = getNextCronRun('0 9 * * *', after, 'America/New_York')!;
    expect(sh.getTime()).not.toBe(ny.getTime());
    expect(wallClock(sh, 'Asia/Shanghai')).toBe('2026-07-15 09:00');
    expect(wallClock(ny, 'America/New_York')).toBe('2026-07-15 09:00');
  });
});

// ════════════════════════════════════════════
// P0-1: setTimeout 延迟溢出
// ════════════════════════════════════════════
describe('P0-1 setTimeout 延迟溢出', () => {
  it('年度任务（>24.9 天）不会立即触发', () => {
    // 0 0 1 1 * —— 每年 1 月 1 日
    const after = new Date('2026-10-21T00:00:00Z');
    const next = getNextCronRun('0 0 1 1 *', after, 'Asia/Shanghai');
    expect(next).not.toBeNull();
    const days = (next!.getTime() - after.getTime()) / 86400000;
    expect(days).toBeGreaterThan(60); // 确实是远期任务
    expect(days).toBeLessThan(366);
  });

  it('年度任务实际调度时不会立刻执行（分段等待）', async () => {
    let executed = 0;
    const sched = new CronScheduler(async () => { executed++; }, tmpDir);
    sched.start();

    const job: CronJob = {
      id: 'yearly', name: '年度任务', enabled: true,
      schedule: { kind: 'cron', expr: '0 0 1 1 *', tz: 'Asia/Shanghai' },
      payload: { kind: 'systemEvent', text: 'x' },
      runCount: 0, createdAt: Date.now(),
    };
    sched.addJob(job);

    // 等待 1.2 秒 —— 旧实现会在这段时间内触发 40+ 次
    await new Promise(r => setTimeout(r, 1200));
    sched.stop();

    expect(executed).toBe(0); // 绝不能执行
  });

  it('every 类型超过上限被拒绝', () => {
    expect(() => validateSchedule({ kind: 'every', everyMs: 2 ** 31 })).toThrow(/上限/);
  });

  it('every 类型 0 或负数被拒绝', () => {
    expect(() => validateSchedule({ kind: 'every', everyMs: 0 })).toThrow(/正数/);
    expect(() => validateSchedule({ kind: 'every', everyMs: -100 })).toThrow(/正数/);
  });
});

// ════════════════════════════════════════════
// P1-4: 先校验后落盘
// ════════════════════════════════════════════
describe('P1-4 非法任务不落盘', () => {
  it('addJob 遇到非法 cron 抛错且不写入磁盘', () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    expect(() => sched.addJob({
      id: 'bad', name: '坏任务', enabled: true,
      schedule: { kind: 'cron', expr: '*/0 * * * *' },
      payload: { kind: 'systemEvent' },
      runCount: 0, createdAt: Date.now(),
    })).toThrow(/步长/);

    expect(sched.listJobs().length).toBe(0);
    const file = join(tmpDir, 'cron-jobs.json');
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      expect(data.length).toBe(0);
    }
    sched.stop();
  });

  it('非法时区被拒绝', () => {
    expect(() => validateSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'Bad/Zone' })).toThrow(/时区/);
  });

  it('at 类型时间非法被拒绝', () => {
    expect(() => validateSchedule({ kind: 'at', at: 'not-a-date' })).toThrow(/无法解析/);
  });

  it('未知调度类型被拒绝', () => {
    expect(() => validateSchedule({ kind: 'weekly' as any })).toThrow(/未知/);
  });

  it('合法任务正常落盘', () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    sched.addJob({
      id: 'good', name: '好任务', enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      payload: { kind: 'systemEvent' },
      runCount: 0, createdAt: Date.now(),
    });
    const file = join(tmpDir, 'cron-jobs.json');
    expect(existsSync(file)).toBe(true);
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(data.length).toBe(1);
    expect(data[0].id).toBe('good');
    sched.stop();
  });
});

// ════════════════════════════════════════════
// P2-1: 运行历史持久化
// ════════════════════════════════════════════
describe('P2-1 运行历史持久化', () => {
  it('runNow 后 lastRunAt / runCount 立即落盘', async () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    sched.addJob({
      id: 'j1', name: '任务1', enabled: true,
      schedule: { kind: 'every', everyMs: 3600000 },
      payload: { kind: 'systemEvent' },
      runCount: 0, createdAt: Date.now(),
    });
    const ok = await sched.runNow('j1');
    expect(ok).toBe(true);

    const file = join(tmpDir, 'cron-jobs.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(data[0].runCount).toBe(1);
    expect(typeof data[0].lastRunAt).toBe('number');
    sched.stop();
  });

  it('磁盘上的非法任务在加载时被跳过，不影响其他任务', () => {
    const file = join(tmpDir, 'cron-jobs.json');
    writeFileSync(file, JSON.stringify([
      { id: 'ok', name: '正常', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'systemEvent' }, runCount: 0, createdAt: Date.now() },
      { id: 'bad', name: '非法', enabled: true, schedule: { kind: 'cron', expr: '*/0 * * * *' }, payload: { kind: 'systemEvent' }, runCount: 0, createdAt: Date.now() },
    ]), 'utf8');

    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    expect(sched.listJobs().length).toBe(1);
    expect(sched.getJob('ok')).toBeDefined();
    expect(sched.getJob('bad')).toBeUndefined();
    sched.stop();
  });
});

// ════════════════════════════════════════════
// 其它基础行为
// ════════════════════════════════════════════
describe('基础行为', () => {
  it('createCronJob 生成唯一 id', () => {
    const a = createCronJob({ name: 'a', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent' } });
    const b = createCronJob({ name: 'b', schedule: { kind: 'every', everyMs: 1000 }, payload: { kind: 'systemEvent' } });
    expect(a.id).not.toBe(b.id);
    expect(a.runCount).toBe(0);
  });

  it('every 类型按 everyMs 间隔触发', async () => {
    let count = 0;
    const sched = new CronScheduler(async () => { count++; }, tmpDir);
    sched.start();
    sched.addJob({
      id: 'every', name: '每 300ms', enabled: true,
      schedule: { kind: 'every', everyMs: 300 },
      payload: { kind: 'systemEvent' },
      runCount: 0, createdAt: Date.now() - 250, // 让它立即到期
    });
    await new Promise(r => setTimeout(r, 1000));
    sched.stop();
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThan(10); // 不该爆炸式重复
  });

  it('setEnabled(false) 停止任务', async () => {
    let count = 0;
    const sched = new CronScheduler(async () => { count++; }, tmpDir);
    sched.start();
    sched.addJob({
      id: 'e2', name: '可禁用', enabled: true,
      schedule: { kind: 'every', everyMs: 200 },
      payload: { kind: 'systemEvent' },
      runCount: 0, createdAt: Date.now() - 150,
    });
    await new Promise(r => setTimeout(r, 300));
    const before = count;
    sched.setEnabled('e2', false);
    await new Promise(r => setTimeout(r, 500));
    sched.stop();
    expect(count).toBe(before);
  });

  it('removeJob 删除任务并落盘', () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    sched.addJob({
      id: 'r1', name: '待删除', enabled: true,
      schedule: { kind: 'every', everyMs: 1000 },
      payload: { kind: 'systemEvent' },
      runCount: 0, createdAt: Date.now(),
    });
    expect(sched.removeJob('r1')).toBe(true);
    expect(sched.listJobs().length).toBe(0);
    sched.stop();
  });

  it('未注册的任务 runNow 返回 false', async () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    expect(await sched.runNow('nope')).toBe(false);
    sched.stop();
  });
});
