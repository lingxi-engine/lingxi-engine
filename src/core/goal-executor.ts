/**
 * GoalExecutor — 目标任务闭环自治执行引擎 v2.0（架构升级版）
 *
 * 架构：Supervisor(监督循环) + Executor(执行器) + Verifier(验收裁判)
 *   - Executor：每轮通过 router.generateReply（taskGoal 模式，带工具循环）实际干活
 *   - Verifier：独立裁判调用（generateOneShot, temperature=0），逐条对照验收标准
 *   - Supervisor：未完成 → 把剩余验收项 + 裁判建议拼进下一轮指令继续跑
 *
 * v2.0 架构升级（让几十小时长任务可强制完成）：
 *  ═══ 1. 放开硬上限 ═══
 *   - MAX_ROUNDS 默认 50 → 500（可 GOAL_MAX_ROUNDS 覆盖），支持几十小时任务
 *   - TOTAL_TIMEOUT 默认 180 分钟 → 默认不设上限（GOAL_TOTAL_TIMEOUT_MINUTES=0 表示不限）
 *   ═══ 2. 文件级 checkpoint（TaskStore）═══
 *   - 每轮结束把执行状态写入 checkpoint 文件，进程崩溃后精确恢复
 *   - 与 SQLite(project_goals) 互补，SQLite 存目标定义，checkpoint 存执行状态
 *   ═══ 3. 三层看门狗（Watchdog）═══
 *   - 每轮上报心跳，卡死/崩溃自动触发恢复（断点续传）
 *   ═══ 4. 上下文滚动压缩（ContextRoller）═══
 *   - 每阶段压缩历史摘要落盘，后续阶段只读摘要，防上下文爆掉
 *   ═══ 5. 强制完成模式（force_complete）═══
 *   - 用户声明后自动关闭提前收敛，跑满直到产出落盘
 *   - 失败降级而非放弃，绝不阻塞整体交付
 *
 * 护栏（v2.0 可配置）：
 *   - 最大轮数 GOAL_MAX_ROUNDS（默认 500）
 *   - 单轮超时由 router 的 TASK_TIMEOUT_SECONDS 控制
 *   - 总时限 GOAL_TOTAL_TIMEOUT_MINUTES（默认 0 = 不限）
 *   - 轮间异常指数退避，连续失败 MAX_CONSECUTIVE_FAILURES 判 failed
 *   - 连续零进度 ZERO_PROGRESS_LIMIT 判 stuck（防烧 token，force_complete 时跳过）
 *   - 用户随时 stop（AbortController 全链路中断）
 *   - 状态持久化到 checkpoint 文件，重启后 resumeAll 断点续跑
 *
 * 核心理念：持续性由引擎层强制保证，不靠提示词。
 */

import { getDB, listChats, addMessage, getChatParticipants } from '../storage/db.js';
import { GoalTracker } from './goal-tracker.js';
import type { ProjectGoal } from './goal-tracker.js';
import type { MessageRouter } from './router.js';
import { TaskStore } from './task-store.js';
import { Watchdog } from './watchdog.js';
import { ContextRoller } from './context-roller.js';

// ── 可配置护栏（环境变量覆盖）──
// v2.0: 默认 500 轮，支持几十小时长任务；GOAL_MAX_ROUNDS 可覆盖
const MAX_ROUNDS = Math.max(1, parseInt(process.env.GOAL_MAX_ROUNDS || '500', 10));
// v2.0: 默认不设总时限（0 = 不限）；GOAL_TOTAL_TIMEOUT_MINUTES 设置后生效
const TOTAL_TIMEOUT_MS = Math.max(0, parseInt(process.env.GOAL_TOTAL_TIMEOUT_MINUTES || '0', 10)) * 60_000;
const MAX_CONSECUTIVE_FAILURES = Math.max(3, parseInt(process.env.GOAL_MAX_FAILURES || '8', 10));
const ZERO_PROGRESS_LIMIT = Math.max(3, parseInt(process.env.GOAL_ZERO_PROGRESS_LIMIT || '5', 10));
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 5 * 60_000;

export type ExecStatus = 'executing' | 'verifying' | 'done' | 'stopped' | 'failed' | 'stuck';

interface ExecInfo {
  goalId: string;
  controller: AbortController;
  round: number;
  progress: number;
  status: ExecStatus;
  startedAt: number;
  lastError?: string;
  forceComplete: boolean;
}

interface Verdict {
  done: boolean;
  satisfied: string[];
  remaining: string[];
  progress: number;
  nextAction?: string;
}

export class GoalExecutor {
  private static router: MessageRouter | null = null;
  private static broadcast: ((e: any) => void) | null = null;
  private static running = new Map<string, ExecInfo>();

  /** 由 index.ts 启动时注入依赖 */
  static init(router: MessageRouter, broadcast: (e: any) => void): void {
    GoalExecutor.router = router;
    GoalExecutor.broadcast = broadcast;
  }

  /** 是否开启强制完成模式（全局开关，可被单任务覆盖） */
  static isForceCompleteMode(): boolean {
    return envBool(process.env.FORCE_COMPLETE);
  }

  // ─────────────────────────── 公开 API ───────────────────────────

  /**
   * 启动目标的闭环执行（异步，立即返回）
   * @param resumeRound 断点续跑时的起始轮次
   * @param forceComplete 强制完成模式（覆盖全局开关）
   */
  static start(goal: ProjectGoal, resumeRound = 0, forceComplete?: boolean): boolean {
    if (GoalExecutor.running.has(goal.id)) {
      console.log(`[GoalExecutor] 目标 "${goal.title}" 已在执行中，跳过重复启动`);
      return false;
    }
    if (!GoalExecutor.router) {
      console.error('[GoalExecutor] router 未初始化');
      return false;
    }
    const chatId = GoalExecutor.resolveChatId(goal);
    const agentId = chatId ? GoalExecutor.resolveAgentId(chatId) : null;
    if (!chatId || !agentId) {
      console.error(`[GoalExecutor] 目标 "${goal.title}" 无法执行：缺少会话或会话内无 Agent (chatId=${chatId}, agentId=${agentId})`);
      GoalExecutor.saveExec(goal.id, 'failed', resumeRound, 0, '缺少会话或会话内无 Agent');
      return false;
    }
    const fc = forceComplete ?? GoalExecutor.isForceCompleteMode();
    const exec: ExecInfo = {
      goalId: goal.id,
      controller: new AbortController(),
      round: resumeRound,
      progress: 0,
      status: 'executing',
      startedAt: Date.now(),
      forceComplete: fc,
    };
    GoalExecutor.running.set(goal.id, exec);
    // v2.0: 上报看门狗心跳
    Watchdog.beat(goal.id, 'executing', resumeRound, 0);
    GoalExecutor.loop(goal.id, chatId, agentId, exec).catch((e: any) => {
      console.error(`[GoalExecutor] 监督循环未捕获异常:`, e?.message || e);
    }).finally(() => {
      GoalExecutor.running.delete(goal.id);
      Watchdog.clear(goal.id);
    });
    return true;
  }

  /** 用户停止执行 */
  static stop(goalId: string): boolean {
    const exec = GoalExecutor.running.get(goalId);
    if (!exec) return false;
    exec.controller.abort();
    GoalExecutor.saveExec(goalId, 'stopped', exec.round, exec.progress, '用户手动停止');
    GoalExecutor.emit(goalId, 'stopped', exec.round, exec.progress, '已停止');
    TaskStore.setStatus(goalId, 'stopped', '用户手动停止');
    console.log(`[GoalExecutor] 目标 ${goalId} 已被用户停止（第 ${exec.round} 轮，进度 ${exec.progress}%）`);
    return true;
  }

  static isRunning(goalId: string): boolean {
    return GoalExecutor.running.has(goalId);
  }

  /** 查询执行状态（运行中取内存，否则取持久化） */
  static getStatus(goalId: string) {
    const exec = GoalExecutor.running.get(goalId);
    if (exec) {
      return {
        running: true, status: exec.status, round: exec.round, progress: exec.progress,
        maxRounds: MAX_ROUNDS, elapsedMs: Date.now() - exec.startedAt, lastError: exec.lastError,
        forceComplete: exec.forceComplete,
      };
    }
    // v2.0: 优先读 checkpoint 文件（更精确）
    const cp = TaskStore.load(goalId);
    if (cp) {
      return {
        running: false, status: cp.status, round: cp.round, progress: cp.progress,
        maxRounds: MAX_ROUNDS, forceComplete: cp.forceComplete, lastError: cp.lastError,
        stepProgress: `${cp.steps.filter(s => s.status === 'done').length}/${cp.steps.length}`,
      };
    }
    try {
      const db = getDB();
      const stmt = db.prepare('SELECT exec_status, exec_round, exec_progress, exec_log FROM project_goals WHERE id = ?');
      stmt.bind([goalId]);
      if (stmt.step()) {
        const row = stmt.getAsObject() as any;
        stmt.free();
        let lastEntry = '';
        try {
          const log = JSON.parse(row.exec_log || '[]');
          lastEntry = log.length > 0 ? log[log.length - 1] : '';
        } catch { /* ignore */ }
        return { running: false, status: row.exec_status || 'idle', round: row.exec_round || 0, progress: row.exec_progress || 0, maxRounds: MAX_ROUNDS, lastEntry };
      }
      stmt.free();
    } catch { /* ignore */ }
    return { running: false, status: 'idle', round: 0, progress: 0, maxRounds: MAX_ROUNDS };
  }

  /** 重启后断点续跑：恢复 checkpoint 文件 + SQLite 中未完成的目标 */
  static resumeAll(): void {
    let resumed = 0;
    // v2.0: 优先从 checkpoint 文件恢复
    const cps = TaskStore.listIncomplete();
    for (const cp of cps) {
      const goal = GoalTracker.get(cp.goalId);
      if (!goal) continue;
      const resumeRound = Math.max(0, cp.round - 1);
      console.log(`[GoalExecutor] 续跑目标 "${goal.title}"（从 checkpoint 第 ${resumeRound + 1} 轮开始）`);
      GoalExecutor.start(goal, resumeRound, cp.forceComplete);
      resumed++;
    }
    // 再从 SQLite 恢复（无 checkpoint 文件的历史目标）
    try {
      const db = getDB();
      const stmt = db.prepare(`SELECT id FROM project_goals WHERE status = 'in_progress' AND (exec_status IS NULL OR exec_status IN ('executing', 'verifying'))`);
      const ids: string[] = [];
      while (stmt.step()) {
        const id = (stmt.getAsObject() as any).id;
        if (!TaskStore.has(id)) ids.push(id); // 跳过已有 checkpoint 的（避免重复）
      }
      stmt.free();
      for (const id of ids) {
        const goal = GoalTracker.get(id);
        if (!goal) continue;
        const status = GoalExecutor.getStatus(id);
        const resumeRound = Math.max(0, (status.round || 0) - 1);
        console.log(`[GoalExecutor] 续跑目标 "${goal.title}"（从 SQLite 第 ${resumeRound + 1} 轮开始）`);
        GoalExecutor.start(goal, resumeRound);
        resumed++;
      }
    } catch (e: any) {
      console.error('[GoalExecutor] SQLite resumeAll 失败:', e?.message || e);
    }
    console.log(`[GoalExecutor] 断点恢复完成，共续跑 ${resumed} 个目标`);
  }

  // ─────────────────────────── Supervisor 监督循环 ───────────────────────────

  private static async loop(goalId: string, chatId: string, agentId: string, exec: ExecInfo): Promise<void> {
    const router = GoalExecutor.router!;
    let consecutiveFailures = 0;
    let zeroProgressRounds = 0;
    let lastRemaining: string[] = [];
    let lastNextAction = '';
    let terminated = false;

    while (exec.round < MAX_ROUNDS) {
      const goal = GoalTracker.get(goalId);
      if (!goal) { GoalExecutor.finish(exec, 'failed', '目标已被删除'); return; }
      if (goal.status === 'cancelled') { GoalExecutor.finish(exec, 'stopped', '目标已被取消'); return; }
      if (goal.status === 'done') { GoalExecutor.finish(exec, 'done', '目标已标记完成'); return; }
      if (TOTAL_TIMEOUT_MS > 0 && Date.now() - exec.startedAt > TOTAL_TIMEOUT_MS) {
        GoalExecutor.finish(exec, 'stuck', `总时限 ${Math.round(TOTAL_TIMEOUT_MS / 60000)} 分钟已到`);
        return;
      }

      exec.round += 1;
      exec.status = 'executing';
      GoalExecutor.saveExec(goalId, 'executing', exec.round, exec.progress);
      // v2.0: 文件级 checkpoint + 看门狗心跳
      TaskStore.setRound(goalId, exec.round);
      Watchdog.beat(goalId, 'executing', exec.round, exec.progress);
      GoalExecutor.emit(goalId, 'executing', exec.round, exec.progress, `第 ${exec.round}/${MAX_ROUNDS} 轮执行中`);
      console.log(`[GoalExecutor] ▶ 目标 "${goal.title}" 第 ${exec.round}/${MAX_ROUNDS} 轮开始`);

      let roundOutput = '';
      try {
        roundOutput = await GoalExecutor.executeRound(goal, chatId, agentId, exec.round, lastRemaining, lastNextAction, exec.controller.signal, router);
        if (exec.controller.signal.aborted) return; // stop() 已处理状态
        if (!roundOutput || roundOutput.trim().length < 2) {
          throw new Error('本轮 AI 未产生有效输出');
        }
        consecutiveFailures = 0;
      } catch (e: any) {
        if (exec.controller.signal.aborted) return;
        consecutiveFailures += 1;
        exec.lastError = e?.message || String(e);
        console.error(`[GoalExecutor] 第 ${exec.round} 轮执行失败 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, exec.lastError);
        GoalExecutor.emit(goalId, 'executing', exec.round, exec.progress, `第 ${exec.round} 轮失败: ${exec.lastError}`);
        Watchdog.beat(goalId, 'executing', exec.round, exec.progress);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          // v2.0: force_complete 模式下不因连续失败放弃，降级继续
          if (exec.forceComplete) {
            console.warn(`[GoalExecutor] force_complete 模式：连续 ${consecutiveFailures} 轮失败，降级继续而非放弃`);
            consecutiveFailures = 0;
          } else {
            GoalExecutor.finish(exec, 'failed', `连续 ${MAX_CONSECUTIVE_FAILURES} 轮执行失败: ${exec.lastError}`);
            return;
          }
        }
        await GoalExecutor.backoff(consecutiveFailures, exec.controller.signal);
        continue;
      }

      // ── Verifier 独立验收 ──
      exec.status = 'verifying';
      GoalExecutor.saveExec(goalId, 'verifying', exec.round, exec.progress);
      GoalExecutor.emit(goalId, 'verifying', exec.round, exec.progress, '验收裁判评估中');
      Watchdog.beat(goalId, 'verifying', exec.round, exec.progress);

      let verdict: Verdict | null = null;
      try {
        verdict = await GoalExecutor.verify(goal, roundOutput, agentId, router);
      } catch (e: any) {
        console.warn(`[GoalExecutor] 验收调用失败，视为未完成继续下一轮:`, e?.message || e);
      }

      if (verdict?.done) {
        exec.progress = 100;
        GoalExecutor.finish(exec, 'done', '验收裁判确认全部验收标准已满足');
        terminated = true;
        return;
      }

      // 未完成：记录进度，准备下一轮
      const newProgress = verdict ? Math.max(0, Math.min(100, Math.round(verdict.progress))) : exec.progress;
      if (newProgress <= exec.progress) zeroProgressRounds += 1;
      else zeroProgressRounds = 0;
      exec.progress = Math.max(exec.progress, newProgress);
      lastRemaining = verdict?.remaining || [];
      lastNextAction = verdict?.nextAction || '';
      GoalExecutor.saveExec(goalId, 'executing', exec.round, exec.progress,
        `第${exec.round}轮: 进度${exec.progress}%${lastRemaining.length ? `, 剩余${lastRemaining.length}项` : ''}`);
      GoalExecutor.emit(goalId, 'executing', exec.round, exec.progress,
        verdict ? `验收未通过，剩余 ${lastRemaining.length} 项，继续第 ${exec.round + 1} 轮` : '验收结果解析失败，继续下一轮');
      console.log(`[GoalExecutor] 第 ${exec.round} 轮验收: 进度 ${exec.progress}%，剩余 ${lastRemaining.length} 项`);

      // v2.0: 零进度保护——force_complete 模式下跳过零进度终止（强制跑满）
      if (zeroProgressRounds >= ZERO_PROGRESS_LIMIT && !exec.forceComplete) {
        GoalExecutor.finish(exec, 'stuck', `连续 ${ZERO_PROGRESS_LIMIT} 轮零进度，已暂停以防烧 token（可调整目标后重新启动）`);
        return;
      }
      if (zeroProgressRounds >= ZERO_PROGRESS_LIMIT && exec.forceComplete) {
        console.warn(`[GoalExecutor] force_complete 模式：连续 ${zeroProgressRounds} 轮零进度，仍强制继续`);
        zeroProgressRounds = 0; // 重置，继续跑
      }
      // 轮间短停顿，避免打满 API 限流
      await GoalExecutor.sleep(3000, exec.controller.signal);
    }

    if (!terminated && exec.round >= MAX_ROUNDS) {
      // v2.0: force_complete 模式达到轮数上限时，不判失败，而是标记"达到轮数上限需人工确认"
      if (exec.forceComplete) {
        GoalExecutor.finish(exec, 'stuck', `达到最大轮数 ${MAX_ROUNDS}（强制完成模式），产出已落盘，请检查结果`);
      } else {
        GoalExecutor.finish(exec, 'stuck', `达到最大轮数 ${MAX_ROUNDS}，仍未通过验收`);
      }
    }
  }

  // ─────────────────────────── Executor 执行器 ───────────────────────────

  private static async executeRound(
    goal: ProjectGoal, chatId: string, agentId: string, round: number,
    remaining: string[], nextAction: string, signal: AbortSignal, router: MessageRouter,
  ): Promise<string> {
    const db = getDB();
    const msgId = 'goal-exec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

    // v2.0: 注入历史阶段摘要（上下文滚动压缩）
    const historyContext = ContextRoller.buildHistoryContext(goal.id);

    let content: string;
    if (round === 1) {
      content = goal.acceptanceCriteria
        ? `请开始执行目标任务：「${goal.title}」\n\n验收标准：${goal.acceptanceCriteria}\n\n要求：\n1. 将目标拆解为子步骤，逐步执行\n2. 每个子步骤都需要实际完成（调用工具、生成结果），不只是写计划\n3. 不要停下来问用户问题，自主判断并执行\n4. 遇到困难换一种方式继续，不要放弃\n5. 尽可能在本轮内完成全部验收标准`
        : `请开始执行目标任务：「${goal.title}」\n\n要求：\n1. 拆解为子步骤并实际执行（调用工具、生成结果）\n2. 不要停下来问用户问题，自主判断并执行\n3. 遇到困难换一种方式继续\n4. 尽可能在本轮内彻底完成`;
    } else {
      const remainText = remaining.length > 0
        ? `\n\n上一轮验收后仍未满足的项目（本轮必须优先完成这些）：\n${remaining.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
        : '';
      const adviceText = nextAction ? `\n\n验收裁判建议：${nextAction}` : '';
      content = `继续执行目标任务：「${goal.title}」（第 ${round} 轮）\n\n上一轮工作已完成部分进展，但验收未全部通过。${remainText}${adviceText}${historyContext}\n\n要求：\n1. 针对未满足的项目实际执行（调用工具、生成结果），不要只写计划或重复已做过的事\n2. 不要停下来问用户问题，自主判断并执行\n3. 遇到困难换一种方式继续，不要放弃不要停\n4. 完成后简要说明本轮做了什么、结果如何`;
    }

    // 注入指令消息（聊天可见）
    addMessage({ id: msgId, chatId, senderType: 'user', senderId: 'goal-executor', content, type: 'text', timestamp: Date.now() });
    GoalExecutor.broadcast?.({ type: 'message.new', chatId, from: 'goal-executor', senderId: 'goal-executor', senderType: 'user', content, timestamp: Date.now() });

    // 执行：taskGoal 模式（工具循环，v2.0 支持更长迭代）
    const output = await router.generateReply(
      chatId, agentId, msgId,
      undefined,                          // onChunk（非流式）
      undefined,                          // onThink
      goal.title,                         // taskGoal：任务模式
      (e: any) => GoalExecutor.broadcast?.({ ...e, chatId }),
    );

    // v2.0: 本轮产出落盘到 context-roller（供后续阶段引用，防上下文爆）
    if (output && output.trim().length > 50) {
      ContextRoller.roll(goal.id, round, `第${round}轮执行产出摘要：${output.slice(0, 800)}`, output.length);
    }

    // AI 回复广播（generateReply 内部已落库）
    if (output) {
      GoalExecutor.broadcast?.({
        type: 'message.new', chatId, from: agentId, senderId: agentId,
        senderType: 'agent', content: output, timestamp: Date.now(),
      });
    }
    return output || '';
  }

  // ─────────────────────────── Verifier 验收裁判 ───────────────────────────

  private static async verify(goal: ProjectGoal, roundOutput: string, agentId: string, router: MessageRouter): Promise<Verdict | null> {
    if (!goal.acceptanceCriteria) {
      // 无验收标准：有实质输出即视为完成
      return roundOutput.trim().length > 50 ? { done: true, satisfied: [goal.title], remaining: [], progress: 100 } : null;
    }
    const prompt = `你是严格的验收裁判。请逐条核对验收标准是否已被实际满足（只看事实证据，不看承诺和计划）。

【目标任务】${goal.title}
【验收标准】
${goal.acceptanceCriteria}

【本轮执行报告】
${roundOutput.slice(0, 6000)}

请只输出一个 JSON（不要输出其他任何内容），格式：
{"done":true或false,"satisfied":["已满足的标准"],"remaining":["未满足的标准及缺什么"],"progress":0到100的整数,"nextAction":"未完成时下一轮应该具体做什么"}`;

    const raw = await router.generateOneShot(agentId, prompt, {
      temperature: 0,
      maxTokens: 2048,
      timeoutMs: 120_000,
      systemPrompt: '你是客观严格的验收裁判。只依据给定证据判断，未明确完成的一律视为未完成。只输出合法 JSON，不要输出任何其他文字。',
    });

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn('[GoalExecutor] 验收输出无 JSON:', raw.slice(0, 200));
      return null;
    }
    try {
      const v = JSON.parse(match[0]);
      return {
        done: v.done === true,
        satisfied: Array.isArray(v.satisfied) ? v.satisfied.map(String) : [],
        remaining: Array.isArray(v.remaining) ? v.remaining.map(String) : [],
        progress: typeof v.progress === 'number' ? v.progress : (v.done === true ? 100 : 0),
        nextAction: typeof v.nextAction === 'string' ? v.nextAction : '',
      };
    } catch (e: any) {
      console.warn('[GoalExecutor] 验收 JSON 解析失败:', e?.message || e);
      return null;
    }
  }

  // ─────────────────────────── 辅助 ───────────────────────────

  /** 解析目标绑定的会话 */
  private static resolveChatId(goal: ProjectGoal): string | null {
    if (goal.projectId.startsWith('project-')) return goal.projectId.slice(8);
    try {
      const chats = listChats();
      if (chats && chats.length > 0) return (chats[0] as any).id;
    } catch { /* ignore */ }
    return null;
  }

  /** 解析会话内第一个可用 Agent */
  private static resolveAgentId(chatId: string): string | null {
    try {
      const db = getDB();
      const participants = getChatParticipants(chatId) as any[];
      for (const p of participants) {
        if (p.agent_id) return p.agent_id;
      }
    } catch { /* ignore */ }
    return null;
  }

  private static finish(exec: ExecInfo, status: ExecStatus, message: string): void {
    exec.status = status;
    GoalExecutor.saveExec(exec.goalId, status, exec.round, exec.progress, message);
    GoalExecutor.emit(exec.goalId, status, exec.round, exec.progress, message);
    // v2.0: 同步 checkpoint 状态
    TaskStore.setStatus(exec.goalId, status as any, message);
    Watchdog.complete(exec.goalId);
    const icon = status === 'done' ? '🎉' : status === 'failed' ? '❌' : '⚠️';
    console.log(`[GoalExecutor] ${icon} 目标 ${exec.goalId} 结束: ${status}（第 ${exec.round} 轮，进度 ${exec.progress}%）${message}`);
    if (status === 'done') {
      try { GoalTracker.markDone(exec.goalId); } catch { /* ignore */ }
    }
  }

  /** 持久化执行状态（追加 exec_log，最多保留 50 条） */
  private static saveExec(goalId: string, status: ExecStatus, round: number, progress: number, logEntry?: string): void {
    try {
      const db = getDB();
      if (logEntry) {
        const stmt = db.prepare('SELECT exec_log FROM project_goals WHERE id = ?');
        stmt.bind([goalId]);
        let log: string[] = [];
        if (stmt.step()) {
          try { log = JSON.parse((stmt.getAsObject() as any).exec_log || '[]'); } catch { log = []; }
        }
        stmt.free();
        log.push(`[${new Date().toLocaleString('zh-CN')}] ${logEntry}`);
        if (log.length > 50) log = log.slice(-50);
        db.run('UPDATE project_goals SET exec_status = ?, exec_round = ?, exec_progress = ?, exec_log = ? WHERE id = ?',
          [status, round, progress, JSON.stringify(log), goalId]);
      } else {
        db.run('UPDATE project_goals SET exec_status = ?, exec_round = ?, exec_progress = ? WHERE id = ?',
          [status, round, progress, goalId]);
      }
    } catch (e: any) {
      console.warn('[GoalExecutor] saveExec 失败:', e?.message || e);
    }
  }

  private static emit(goalId: string, status: string, round: number, progress: number, message: string): void {
    GoalExecutor.broadcast?.({ type: 'goal.progress', goalId, status, round, maxRounds: MAX_ROUNDS, progress, message });
  }

  private static async backoff(failCount: number, signal: AbortSignal): Promise<void> {
    const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, failCount - 1), BACKOFF_CAP_MS);
    console.log(`[GoalExecutor] 失败退避 ${Math.round(delay / 1000)}s 后继续`);
    await GoalExecutor.sleep(delay, signal);
  }

  private static sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { cleanup(); resolve(); };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      signal?.addEventListener('abort', onAbort);
    });
  }
}

/** 解析环境变量布尔值 */
function envBool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
