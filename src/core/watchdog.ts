/**
 * watchdog.ts — 三层自愈看门狗（守护的守护）
 *
 * 架构升级核心组件之一：
 *  - 监控目标任务执行心跳，检测到卡死/崩溃自动拉起续跑
 *  - 三层守护：任务级 → 进程级 → 系统级
 *  - 心跳机制：任务定期上报心跳，看门狗超时未收到即判定卡死
 *  - 自动拉起：卡死/崩溃后调用恢复回调（断点续传）
 *
 * 设计：
 *  - 任务级：GoalExecutor 每轮上报心跳，Watchdog 监控
 *  - 进程级：本进程内 Watchdog 常驻，进程活着就监控
 *  - 系统级：配合外部计划任务（cron/系统任务计划），进程死了由外部拉起
 */

import * as fs from 'fs';
import * as path from 'path';

// ── 心跳状态 ──────────────────────────────────────────────

interface HeartbeatEntry {
  goalId: string;
  lastBeat: number;
  status: string;
  round: number;
  progress: number;
}

export class Watchdog {
  private static hearts = new Map<string, HeartbeatEntry>();
  private static timer: NodeJS.Timeout | null = null;
  private static intervalMs = 15_000;          // 心跳检测周期
  private static timeoutMs = 5 * 60_000;       // 心跳超时阈值（默认5分钟无心跳判定卡死）
  private static onStall: ((goalId: string) => void) | null = null;
  private static enabled = false;

  /** 初始化：注册卡死回调 + 启动监控循环 */
  static init(onStall: (goalId: string) => void, opts?: { intervalMs?: number; timeoutMs?: number }): void {
    Watchdog.onStall = onStall;
    if (opts?.intervalMs) Watchdog.intervalMs = opts.intervalMs;
    if (opts?.timeoutMs) Watchdog.timeoutMs = opts.timeoutMs;
    Watchdog.enabled = true;
    Watchdog.start();
    console.log(`[Watchdog] 三层看门狗已启动 (interval=${Watchdog.intervalMs}ms, timeout=${Watchdog.timeoutMs}ms)`);
  }

  /** 启动监控循环（幂等） */
  static start(): void {
    if (Watchdog.timer) return;
    Watchdog.timer = setInterval(() => Watchdog.check(), Watchdog.intervalMs);
    Watchdog.timer.unref?.();
  }

  /** 停止监控 */
  static stop(): void {
    if (Watchdog.timer) { clearInterval(Watchdog.timer); Watchdog.timer = null; }
    Watchdog.enabled = false;
  }

  /** 任务上报心跳（每轮执行/验收时调用） */
  static beat(goalId: string, status: string, round: number, progress: number): void {
    Watchdog.hearts.set(goalId, { goalId, lastBeat: Date.now(), status, round, progress });
  }

  /** 任务正常结束时清除心跳 */
  static clear(goalId: string): void {
    Watchdog.hearts.delete(goalId);
  }

  /** 任务完成时主动上报 done，避免误判卡死 */
  static complete(goalId: string): void {
    const h = Watchdog.hearts.get(goalId);
    if (h) { h.lastBeat = Date.now(); h.status = 'done'; }
  }

  /** 检测卡死：超时未上报心跳的任务触发恢复 */
  private static check(): void {
    if (!Watchdog.enabled) return;
    const now = Date.now();
    for (const [goalId, h] of Watchdog.hearts) {
      if (h.status === 'done' || h.status === 'failed' || h.status === 'stopped') {
        // 已结束，清除
        Watchdog.hearts.delete(goalId);
        continue;
      }
      const idle = now - h.lastBeat;
      if (idle > Watchdog.timeoutMs) {
        console.warn(`[Watchdog] ⚠️ 目标 ${goalId} 心跳超时 ${Math.round(idle / 1000)}s（第${h.round}轮，进度${h.progress}%），判定卡死，触发自动恢复`);
        Watchdog.hearts.delete(goalId);
        Watchdog.onStall?.(goalId);
      }
    }
  }

  /** 获取当前被监控的任务数 */
  static watchedCount(): number {
    return Watchdog.hearts.size;
  }

  /** 获取心跳状态快照 */
  static snapshot(): HeartbeatEntry[] {
    return Array.from(Watchdog.hearts.values());
  }
}

// ── 系统级守护：写 PID + 心跳文件（供外部计划任务监控） ──

/** 写入看门狗 PID 文件（供外部脚本检测进程是否存活） */
export function writeWatchdogPidFile(): string {
  try {
    const dir = path.join(process.cwd(), 'storage');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'watchdog.pid');
    fs.writeFileSync(p, String(process.pid), 'utf8');
    return p;
  } catch (e: any) {
    console.error('[Watchdog] PID 文件写入失败:', e?.message || e);
    return '';
  }
}

/** 更新看门狗存活时间戳（供外部计划任务检测"看门狗是否还活着"） */
export function touchWatchdogAlive(): void {
  try {
    const dir = path.join(process.cwd(), 'storage');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'watchdog.alive'), String(Date.now()), 'utf8');
  } catch { /* ignore */ }
}
