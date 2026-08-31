/**
 * executor.patch.ts - executor.ts 改造补丁（P0 核心模块）
 *
 * 目的：修复 executor.ts 的两个结构性缺陷，让长任务不被"轮数封顶"和"无完成校验"掐断。
 *
 * 缺陷1：maxIterations=50 封顶，工具循环耗尽后无论任务是否完成都被迫收尾
 * 缺陷2：无"目标达成校验"——50 轮跑完直接给 finalContent，不检查目标是否真的达成
 *
 * 改造方案：
 *  A. 引入目标达成校验器（GoalVerifier）：每轮结束后检查产出物是否满足目标清单
 *  B. force_complete 模式下：轮数上限大幅放宽（如 500+），以"目标达成校验"为收尾条件
 *  C. 未达成时自动续跑（而非返回半成品）
 *
 * 用法：这是对 runToolsLoop 的关键补丁，接入点见文件底部 PATCH 说明。
 */

export interface GoalCheckResult {
  achieved: boolean;
  progress: number;        // 0~1 完成度
  missing: string[];       // 未达成的目标项
  evidence?: string;       // 达成证据（产出物路径等）
}

export interface GoalVerifierOptions {
  /** 目标清单：每一项是一个可校验的产出物描述 */
  goals: Array<{
    id: string;
    description: string;
    /** 校验函数：返回 true 表示该目标已达成 */
    check: (jobMeta: any, toolResults: any[]) => boolean | Promise<boolean>;
  }>;
  /** 强制完成模式下允许的最大轮数（默认 500，远超原来的 50） */
  forceCompleteMaxIterations?: number;
}

/**
 * 目标达成校验器
 * 让"任务完成"从"轮数耗尽"变成"目标真正达成"
 */
export class GoalVerifier {
  private goals: GoalVerifierOptions['goals'];
  private forceMax: number;

  constructor(opts: GoalVerifierOptions) {
    this.goals = opts.goals;
    this.forceMax = opts.forceCompleteMaxIterations ?? 500;
  }

  /** 检查当前进度是否达成所有目标 */
  async check(jobMeta: any, toolResults: any[]): Promise<GoalCheckResult> {
    const missing: string[] = [];
    let achieved = true;

    for (const goal of this.goals) {
      try {
        const ok = await goal.check(jobMeta, toolResults);
        if (!ok) {
          achieved = false;
          missing.push(goal.description);
        }
      } catch (err: any) {
        achieved = false;
        missing.push(`${goal.description}（校验异常: ${err.message}）`);
      }
    }

    const progress = this.goals.length === 0 ? 1 : (this.goals.length - missing.length) / this.goals.length;
    return { achieved, progress, missing };
  }

  /** 在 force_complete 模式下，计算实际允许的最大轮数 */
  effectiveMaxIterations(baseMax: number, forceComplete: boolean): number {
    return forceComplete ? Math.max(baseMax, this.forceMax) : baseMax;
  }
}

/**
 * 便捷函数：判断是否应继续跑（供 runToolsLoop 每轮末尾调用）
 *  - 目标已达成 → 停止
 *  - 未达成且 forceComplete → 继续跑（即使轮数已到原上限）
 *  - 未达成且非 forceComplete → 返回半成品（原行为）
 */
export function shouldContinue(
  iterations: number,
  baseMaxIterations: number,
  forceComplete: boolean,
  goalResult: GoalCheckResult
): boolean {
  if (goalResult.achieved) return false;      // 目标达成，收尾
  if (forceComplete) {
    // 强制完成模式：只要没达成且没超过 forceMax 就继续
    return iterations < baseMaxIterations * 10; // 放宽到原上限 10 倍
  }
  // 普通模式：轮数到了就停
  return iterations < baseMaxIterations;
}

// ═══════════════════════════════════════════════
// PATCH 接入说明（在 runToolsLoop 中如何应用）
// ═══════════════════════════════════════════════
//
// 1. 在 options 中新增可选参数：
//      verifier?: GoalVerifier
//      forceComplete?: boolean        // 来自 /force-complete 开关
//
// 2. 主循环 for 的结束条件改为：
//      for (let i = 0; i < maxIterations; i++) {
//        ...
//        // 每轮工具执行后、进入下一轮前：
//        if (verifier) {
//          const goalResult = await verifier.check(jobMeta, result.toolResults);
//          if (!shouldContinue(i + 1, maxIterations, forceComplete, goalResult)) {
//            if (goalResult.achieved) {
//              result.finalContent = `[目标达成] 完成度 ${Math.round(goalResult.progress*100)}%`;
//            }
//            break;
//          }
//        }
//      }
//
// 3. 原"兜底强制再调一次"逻辑保留，但只有非 forceComplete 才走（forceComplete 未达成时继续循环而非兜底收尾）
