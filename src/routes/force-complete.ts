/**
 * force-complete.ts — 强制完成模式 API 路由
 *
 * 提供 HTTP 接口：
 *  - POST /api/force-complete/on        开启全局强制完成模式
 *  - POST /api/force-complete/off       关闭全局强制完成模式
 *  - GET  /api/force-complete/status    查询当前状态 + 看门狗心跳 + 未完成任务
 *  - POST /api/force-complete/resume    手动触发断点恢复（resumeAll）
 *  - POST /api/force-complete/goal/:id/force   对单个目标开启强制完成
 *  - POST /api/force-complete/goal/:id/stop    停止单个目标执行
 *  - GET  /api/force-complete/goal/:id/status  查询单个目标状态
 *
 * 依赖注入：需要 GoalExecutor + Watchdog + TaskStore
 * 由 index.ts 在启动时调用 createForceCompleteRoutes 注册。
 */

import { Router } from 'express';
import { GoalExecutor } from '../core/goal-executor.js';
import { Watchdog } from '../core/watchdog.js';
import { TaskStore } from '../core/task-store.js';
import { GoalTracker } from '../core/goal-tracker.js';

export function createForceCompleteRoutes(): Router {
  const r = Router();

  /** 解析布尔值 */
  function toBool(v: any): boolean {
    if (v === undefined) return false;
    const s = String(v).toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
  }

  // 开启全局强制完成模式
  r.post('/on', (req: any, res: any) => {
    process.env.FORCE_COMPLETE = '1';
    // 同步到 ApprovalManager（如果已注入）
    try {
      const approval = req.app?.locals?.approvalManager as any;
      approval?.setForceComplete?.(true);
    } catch { /* ignore */ }
    res.json({ ok: true, message: '强制完成模式已开启（FORCE_COMPLETE=1），目标任务将跑满直至产出落盘' });
  });

  // 关闭全局强制完成模式
  r.post('/off', (req: any, res: any) => {
    process.env.FORCE_COMPLETE = '0';
    try {
      const approval = req.app?.locals?.approvalManager as any;
      approval?.setForceComplete?.(false);
    } catch { /* ignore */ }
    res.json({ ok: true, message: '强制完成模式已关闭' });
  });

  // 查询状态
  r.get('/status', (_req: any, res: any) => {
    res.json({
      ok: true,
      forceComplete: toBool(process.env.FORCE_COMPLETE),
      watchdog: {
        enabled: Watchdog.watchedCount() > 0,
        watchedTasks: Watchdog.watchedCount(),
        snapshot: Watchdog.snapshot(),
      },
      incompleteCheckpoints: TaskStore.listIncomplete().map(cp => ({
        goalId: cp.goalId, title: cp.title, status: cp.status,
        round: cp.round, progress: cp.progress, stepProgress: `${cp.steps.filter(s => s.status === 'done').length}/${cp.steps.length}`,
      })),
    });
  });

  // 手动触发断点恢复
  r.post('/resume', (_req: any, res: any) => {
    GoalExecutor.resumeAll();
    res.json({ ok: true, message: '断点恢复已触发，未完成目标将自动续跑' });
  });

  // 对单个目标开启强制完成
  r.post('/goal/:id/force', (req: any, res: any) => {
    const id = req.params.id;
    const goal = GoalTracker.get(id);
    if (!goal) return res.status(404).json({ ok: false, error: '目标不存在' });
    TaskStore.setForceComplete(id, true);
    if (!GoalExecutor.isRunning(id)) {
      GoalExecutor.start(goal, 0);
    }
    res.json({ ok: true, message: `目标 "${goal.title}" 已开启强制完成并开始执行` });
  });

  // 停止单个目标
  r.post('/goal/:id/stop', (req: any, res: any) => {
    const id = req.params.id;
    const stopped = GoalExecutor.stop(id);
    res.json({ ok: stopped, message: stopped ? '目标已停止' : '目标未在运行' });
  });

  // 查询单个目标状态
  r.get('/goal/:id/status', (req: any, res: any) => {
    const id = req.params.id;
    const status = GoalExecutor.getStatus(id);
    res.json({ ok: true, goalId: id, ...status });
  });

  return r;
}
