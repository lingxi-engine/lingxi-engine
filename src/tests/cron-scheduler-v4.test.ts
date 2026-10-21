/**
 * Cron 调度器回归测试 —— v4 修复
 *
 * v3 修复（8 个缺陷）见 cron-scheduler.test.ts。
 * 本文件钉死 v4 复核 v3 修复时发现的残留缺陷：
 *
 *  P0-4 DST 回拨日死循环：小时跳跃用 "UTC 瞬时 + 1h"，回拨日墙钟原地踏步
 *       （01:00 EDT → 01:00 EST），迭代器永不前进。
 *       实测 getNextCronRun 卡死 63.8 秒 → 整个 Node 事件循环冻结 1 分钟。
 *  P0-5 整点被跳过：getDelayMs 传 now+1000 作为搜索起点，
 *       距目标整点不足 1 秒时整点被整段跳过（v3 "整点晚一小时" 的残留变种）。
 *  P1-5 闰年不可达：搜索窗口只有 366 天，"0 0 29 2 *" 永远算不出下次运行。
 *  P1-6 不可达日期静默：getNextCronRun 返回 null 时静默不调度，无任何告警。
 *  P1-7 every 过期补跑：重启后落后多个周期的任务 1 秒就补跑一次。
 *  P1-8 DST 日墙钟漂移：日期跳跃用 UTC +24h，DST 日墙钟偏 1 小时。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CronScheduler, getNextCronRun, type CronJob } from '../core/cron-scheduler.js';
import { getZonedParts } from '../core/timezone.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cron-v4-test-'));
});
afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function wallClock(date: Date, tz: string): string {
  const z = getZonedParts(date, tz);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')} ` +
    `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}

// ════════════════════════════════════════════
// P0-4: DST 回拨日死循环
// ════════════════════════════════════════════
describe('P0-4 DST 回拨日不得死循环', () => {
  it('回拨日搜索必须快速返回（曾卡死 63.8 秒）', () => {
    const after = new Date('2026-11-01T05:00:30Z'); // 01:00:30 EDT
    const t0 = Date.now();
    const next = getNextCronRun('0 2 * * *', after, 'America/New_York');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1000); // 绝不能卡死
    expect(next).not.toBeNull();
    expect(wallClock(next!, 'America/New_York')).toBe('2026-11-01 02:00');
  });

  it('回拨日 01:00 重复不导致原地踏步', () => {
    // 05:00Z 是 01:00 EDT，06:00Z 也是 01:00 EST —— 墙钟相同
    const after = new Date('2026-11-01T04:00:00Z');
    const next = getNextCronRun('0 2 * * *', after, 'America/New_York');
    expect(next!.getTime()).toBeGreaterThan(after.getTime());
    expect(wallClock(next!, 'America/New_York')).toBe('2026-11-01 02:00');
  });

  it('春季跳变日不存在的小时被跳过而非死循环', () => {
    // 2026-03-08 纽约 02:00 不存在
    const after = new Date('2026-03-08T00:00:00Z');
    const t0 = Date.now();
    const next = getNextCronRun('0 2 * * *', after, 'America/New_York');
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(1000);
    expect(next).not.toBeNull();
    // Vixie 语义：跳过不存在的时刻 → 顺延到次日 02:00
    expect(wallClock(next!, 'America/New_York')).toBe('2026-03-09 02:00');
  });

  it('搜索期间事件循环保持响应（不被冻结）', () => {
    const after = new Date('2026-11-01T05:00:30Z');
    let ticks = 0;
    const iv = setInterval(() => ticks++, 5);
    const t0 = Date.now();
    getNextCronRun('0 2 * * *', after, 'America/New_York');
    const elapsed = Date.now() - t0;
    clearInterval(iv);
    expect(elapsed).toBeLessThan(500);
  });
});

// ════════════════════════════════════════════
// P0-5: 整点被跳过
// ════════════════════════════════════════════
describe('P0-5 整点不得被跳过', () => {
  it('距整点不足 1 秒时仍命中该整点', () => {
    // 08:59:59.5 → 09:00（只差 500ms）
    const after = new Date('2026-10-21T00:59:59.500Z');
    const next = getNextCronRun('0 9 * * *', after, 'Asia/Shanghai');
    expect(next).not.toBeNull();
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-10-21 09:00');
  });

  it('真实调度路径的 nextRunAt 指向正确整点', () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    sched.addJob({
      id: 'j', name: '整点任务', enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      payload: { kind: 'systemEvent' }, runCount: 0, createdAt: Date.now(),
    });
    const job = sched.getJob('j')!;
    expect(job.nextRunAt).toBeDefined();
    expect(wallClock(new Date(job.nextRunAt!), 'Asia/Shanghai')).toMatch(/ 09:00$/);
    expect(job.nextRunAt!).toBeGreaterThan(Date.now());
    sched.stop();
  });
});

// ════════════════════════════════════════════
// P1-5: 闰年可达
// ════════════════════════════════════════════
describe('P1-5 闰年任务必须可达', () => {
  it('2/29 表达式能算出下一个闰日', () => {
    const after = new Date('2026-10-21T00:00:00Z');
    const next = getNextCronRun('0 0 29 2 *', after, 'Asia/Shanghai');
    expect(next).not.toBeNull();
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2028-02-29 00:00');
  });

  it('闰日任务的 nextRunAt 指向 2028-02-29', () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    sched.addJob({
      id: 'leap', name: '闰日', enabled: true,
      schedule: { kind: 'cron', expr: '0 0 29 2 *', tz: 'Asia/Shanghai' },
      payload: { kind: 'systemEvent' }, runCount: 0, createdAt: Date.now(),
    });
    const job = sched.getJob('leap')!;
    expect(wallClock(new Date(job.nextRunAt!), 'Asia/Shanghai')).toBe('2028-02-29 00:00');
    sched.stop();
  });
});

// ════════════════════════════════════════════
// P1-6: 不可达日期必须可见
// ════════════════════════════════════════════
describe('P1-6 不可达日期必须可见', () => {
  it('2/30 这类不存在的日期 nextRunAt 为 undefined', () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    sched.addJob({
      id: 'bad', name: '不存在的日期', enabled: true,
      schedule: { kind: 'cron', expr: '0 0 30 2 *', tz: 'Asia/Shanghai' },
      payload: { kind: 'systemEvent' }, runCount: 0, createdAt: Date.now(),
    });
    const job = sched.getJob('bad')!;
    expect(job.nextRunAt).toBeUndefined();
    sched.stop();
  });

  it('不可达日期的搜索不会长时间卡顿', () => {
    const after = new Date('2026-10-21T00:00:00Z');
    const t0 = Date.now();
    getNextCronRun('0 0 30 2 *', after, 'Asia/Shanghai');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

// ════════════════════════════════════════════
// P1-7: every 过期任务不补跑
// ════════════════════════════════════════════
describe('P1-7 every 过期任务不补跑', () => {
  it('落后 30 分钟的 every 任务重启后不立即触发', async () => {
    const now = Date.now();
    writeFileSync(join(tmpDir, 'cron-jobs.json'), JSON.stringify([{
      id: 'stale', name: '过期 every', enabled: true,
      schedule: { kind: 'every', everyMs: 60000 },
      payload: { kind: 'systemEvent' },
      lastRunAt: now - 30 * 60 * 1000,
      runCount: 5, createdAt: now - 60 * 60 * 1000,
    }]), 'utf8');

    let fired = 0;
    const sched = new CronScheduler(async () => { fired++; }, tmpDir);
    sched.start();
    await new Promise(r => setTimeout(r, 2500));
    sched.stop();

    // 旧实现：Math.max(next - now, 1000) → 1 秒后就触发
    expect(fired).toBe(0);
  });

  it('落后很多周期时只按固定周期继续，不追赶历史', async () => {
    const now = Date.now();
    writeFileSync(join(tmpDir, 'cron-jobs.json'), JSON.stringify([{
      id: 'stale2', name: '严重过期', enabled: true,
      schedule: { kind: 'every', everyMs: 1000 },
      payload: { kind: 'systemEvent' },
      lastRunAt: now - 100 * 60 * 1000,
      runCount: 1, createdAt: now - 200 * 60 * 1000,
    }]), 'utf8');

    let fired = 0;
    const sched = new CronScheduler(async () => { fired++; }, tmpDir);
    sched.start();
    await new Promise(r => setTimeout(r, 3000));
    sched.stop();

    // 不应追赶 6000 个周期
    expect(fired).toBeLessThanOrEqual(4);
  });
});

// ════════════════════════════════════════════
// P1-8: DST 日墙钟漂移
// ════════════════════════════════════════════
describe('P1-8 DST 日墙钟不得漂移', () => {
  it('跳变日触发时刻正确', () => {
    const after = new Date('2026-03-08T00:00:00Z');
    const next = getNextCronRun('30 1 * * *', after, 'America/New_York');
    expect(wallClock(next!, 'America/New_York')).toBe('2026-03-08 01:30');
  });

  it('跳变次日不漂移到 02:30', () => {
    const after = new Date('2026-03-09T00:00:00Z');
    const next = getNextCronRun('30 1 * * *', after, 'America/New_York');
    expect(wallClock(next!, 'America/New_York')).toBe('2026-03-09 01:30');
  });

  it('回拨日触发时刻正确', () => {
    const after = new Date('2026-10-31T12:00:00Z');
    const next = getNextCronRun('30 1 * * *', after, 'America/New_York');
    expect(wallClock(next!, 'America/New_York')).toBe('2026-11-01 01:30');
  });

  it('连续多日推进时墙钟始终正确（不累积漂移）', () => {
    // 从跳变日前一天开始，跨过跳变日，检查每天 01:30 都精确命中
    const after = new Date('2026-03-07T00:00:00Z');
    const next = getNextCronRun('30 1 * * *', after, 'America/New_York');
    expect(wallClock(next!, 'America/New_York')).toBe('2026-03-07 01:30');

    const after2 = new Date('2026-03-07T12:00:00Z');
    const next2 = getNextCronRun('30 1 * * *', after2, 'America/New_York');
    expect(wallClock(next2!, 'America/New_York')).toBe('2026-03-08 01:30');
  });
});

// ════════════════════════════════════════════
// P1-9: nextRunAt 落盘一致性
// ════════════════════════════════════════════
describe('P1-9 nextRunAt 落盘必须与内存一致', () => {
  it('首次落盘时 nextRunAt 已是有效值（不是 null）', () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    sched.addJob({
      id: 'j', name: '整点任务', enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
      payload: { kind: 'systemEvent' }, runCount: 0, createdAt: Date.now(),
    });

    const file = join(tmpDir, 'cron-jobs.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    // 旧顺序（先落盘后调度）会写出 null
    expect(typeof data[0].nextRunAt).toBe('number');
    expect(data[0].nextRunAt).toBe(sched.getJob('j')!.nextRunAt);
    sched.stop();
  });

  it('磁盘上的 nextRunAt 与内存一致', () => {
    const sched = new CronScheduler(async () => {}, tmpDir);
    sched.start();
    sched.addJob({
      id: 'j2', name: '每日任务', enabled: true,
      schedule: { kind: 'cron', expr: '30 8 * * *', tz: 'Asia/Shanghai' },
      payload: { kind: 'systemEvent' }, runCount: 0, createdAt: Date.now(),
    });
    const file = join(tmpDir, 'cron-jobs.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    expect(data[0].nextRunAt).toBe(sched.getJob('j2')!.nextRunAt);
    sched.stop();
  });
});

// ════════════════════════════════════════════
// 回归：v3 修复不能被破坏
// ════════════════════════════════════════════
describe('v3 修复回归', () => {
  it('整点仍然精确命中 09:00', () => {
    const after = new Date('2026-07-15T00:00:00Z');
    const next = getNextCronRun('0 9 * * *', after, 'Asia/Shanghai');
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-07-15 09:00');
  });

  it('年度任务仍指向 2027-01-01', () => {
    const after = new Date('2026-10-21T00:00:00Z');
    const next = getNextCronRun('0 0 1 1 *', after, 'Asia/Shanghai');
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2027-01-01 00:00');
  });

  it('日/星期 OR 语义仍然正确', () => {
    const after = new Date('2026-10-01T00:00:00Z');
    const next = getNextCronRun('0 9 15 * 1', after, 'Asia/Shanghai');
    expect(wallClock(next!, 'Asia/Shanghai')).toBe('2026-10-05 09:00');
  });
});
