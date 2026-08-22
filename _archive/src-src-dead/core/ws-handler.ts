import type { MessageRouter } from "./router.js";
import type { WebSocket } from "ws";
import { dispatchDebateSummary, dispatchRoundtableNext, dispatchVoteSummary, dispatchBrainstormNext } from "./chat-modes.js";
import { Orchestrator, type TaskNode } from "./orchestrator.js";

// === 长任务状态追踪（支持断点续做）===
interface TaskPlan {
  taskId: string;
  chatId: string;
  agentId: string;
  goal: string;
  steps: TaskStep[];
  currentStep: number;
  status: 'planning' | 'executing' | 'completed' | 'failed';
  createdAt: number;
  result?: string;
}
interface TaskStep {
  id: string;
  name: string;
  prompt: string;
  dependsOn: string[];
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  output?: string;
}
// 活跃任务计划（内存中，进程重启丢失但不会半途中断当前执行）
const activeTaskPlans = new Map<string, TaskPlan>();

export interface WSResponse {
  type: string;
  [key: string]: any;
}

// V10: subscription tracking per WebSocket connection
export const wsSubscriptions = new WeakMap<WebSocket, Set<string>>();

// ── 停止生成：追踪每个聊天正在进行中的回复（可并发多个 Agent）──
const activeGenerations = new Map<string, Set<AbortController>>();
function registerGeneration(chatId: string, ctrl: AbortController): void {
  if (!activeGenerations.has(chatId)) activeGenerations.set(chatId, new Set());
  activeGenerations.get(chatId)!.add(ctrl);
}
function unregisterGeneration(chatId: string, ctrl: AbortController): void {
  const set = activeGenerations.get(chatId);
  if (!set) return;
  set.delete(ctrl);
  if (set.size === 0) activeGenerations.delete(chatId);
}
export function stopGeneration(chatId: string): boolean {
  const set = activeGenerations.get(chatId);
  if (!set || set.size === 0) return false;
  for (const ctrl of set) { try { ctrl.abort(); } catch { /* ignore */ } }
  return true;
}

// ── AbortSignal 合并：把「超时信号」和「用户停止信号」合成一个传给 AI 调用 ──
function mergeAbort(...signals: (AbortSignal | undefined)[]): AbortController {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl;
}

export function handleWSMessage(
  raw: any,
  clientId: string,
  router: MessageRouter,
  broadcast: (event: WSResponse) => void,
  ws?: WebSocket
) {
  let event: any;
  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  try {
    event = JSON.parse(raw.toString());
  } catch {
    broadcast({ type: "error", message: "Invalid JSON" });
    return;
  }

  const { type } = event;

  switch (type) {
    case "subscribe": {
      // V10: 记录此 WS 连接订阅的 chatId，用于过滤广播
      if (ws) {
        let subs = wsSubscriptions.get(ws);
        if (!subs) {
          subs = new Set();
          wsSubscriptions.set(ws, subs);
        }
        if (event.chatId) subs.add(event.chatId);
      }
      broadcast({ type: "subscribed", chatId: event.chatId, clientId });
      break;
    }

    case "register_user": {
      const raw = String(event.displayName || 'user');
      // 安全校验：只保留字母/数字/中文/下划线/连字符，去掉危险字符（路径穿越/空格/特殊符号）
      const safe = raw.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '').slice(0, 30);
      const displayName = safe || 'user';
      const userId = `user-${displayName}-${Date.now().toString(36)}`;
      broadcast({ type: "user.registered", userId, displayName, clientId });
      break;
    }

    case "create_chat": {
      const { chatId, participantIds } = event;
      for (const pid of participantIds) {
        broadcast({
          type: "chat.invited",
          chatId,
          from: clientId,
          recipient: pid,
        });
      }
      break;
    }

    case "message": {
      const { chatId, content, replyTo } = event;
      processUserMessage(chatId, clientId, content, replyTo, router, broadcast);
      break;
    }

    case "stop": {
      // 停止某聊天当前正在进行的所有 Agent 回复
      const { chatId } = event;
      if (!chatId) { broadcast({ type: "error", message: "stop 需要 chatId" }); break; }
      const stopped = stopGeneration(chatId);
      broadcast({ type: "stop.ack", chatId, stopped });
      break;
    }

    case "agent.message": {
      const { chatId, content } = event;
      const agentSenderId = `agent:${clientId}`;
      broadcast({
        type: "message.new",
        chatId,
        from: agentSenderId,
        senderId: agentSenderId,
        senderType: "agent",
        content,
        timestamp: Date.now(),
      });
      break;
    }

    case "typing": {
      const { chatId, isTyping } = event;
      broadcast({
        type: "typing",
        chatId,
        from: clientId,
        isTyping,
      });
      break;
    }

    case "agent.task": {
      // === 自主任务模式 v2 (Orchestrator + DAG + progress broadcast) ===
      const { chatId, agentId, goal } = event;
      if (!chatId || !agentId || !goal) {
        broadcast({ type: "error", message: "agent.task needs chatId/agentId/goal" });
        break;
      }

      const taskMsgId = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const agentSenderId = 'agent:' + agentId;

      // 1. broadcast task start
      broadcast({
        type: "agent.streaming.start",
        chatId,
        from: agentSenderId,
        senderType: "agent",
        msgId: taskMsgId,
        goal,
        timestamp: Date.now(),
      });

      // 2. async: plan -> orchestrate -> progress
      (async () => {
        // ⭐ 停止生成：注册后用户点"停止"可中断整个任务（否则任务无法被停止）
        const taskCtrl = new AbortController();
        registerGeneration(chatId, taskCtrl);
        let taskHeartbeatId: ReturnType<typeof setInterval> | undefined;
        try {
          // Phase 1: task decomposition
          broadcast({
            type: "task.progress",
            chatId, from: agentSenderId, msgId: taskMsgId,
            phase: "planning",
            message: "正在分析任务并制定执行计划...",
            step: 0, total: 0,
            timestamp: Date.now(),
          });

          // ⭐ 心跳保活：任务执行期间每 5 秒发一次心跳
          taskHeartbeatId = setInterval(() => {
            broadcast({
              type: "agent.streaming.heartbeat",
              chatId, from: agentSenderId, msgId: taskMsgId,
              timestamp: Date.now(),
            });
          }, 3000);
          if (taskHeartbeatId.unref) taskHeartbeatId.unref();

          const planPrompt = "你是灵犀引擎的任务规划器。请将以下任务拆分为 2-6 个可执行的子步骤。\n\n任务目标：" + goal + "\n\n要求：\n- 返回纯 JSON 数组，不要有其他文字\n- 每个步骤包含：id（step-1, step-2...）、name（简短名称）、prompt（具体执行指令）、dependsOn（依赖的前置步骤 id 数组，无依赖则为空数组）\n- 步骤之间可以有依赖关系（DAG），无依赖的步骤将并行执行\n- 第一步通常无依赖，最后一步通常是汇总\n\n示例格式：\n[{\"id\":\"step-1\",\"name\":\"搜索\",\"prompt\":\"搜索XX\",\"dependsOn\":[]},{\"id\":\"step-2\",\"name\":\"分析\",\"prompt\":\"分析结果\",\"dependsOn\":[\"step-1\"]}]\n\n请返回 JSON：";

          // 规划阶段：无工具一次性调用（修复：原先把 planPrompt 传到 generateReply 的 taskGoal 参数位，
          // 被包成“自主执行任务”模式与“只返回 JSON”指令冲突，且会误触发工具循环）
          const planResponse = await router.generateOneShot(agentId, planPrompt, { temperature: 0.2, timeoutMs: 90000 });

          // parse JSON plan (tolerant: extract first JSON array)
          let steps: any[] = [];
          try {
            const jsonMatch = planResponse.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              steps = JSON.parse(jsonMatch[0]);
            }
          } catch { /* parse error */ }

          // fallback: single step if parse failed
          if (!steps || !Array.isArray(steps) || steps.length === 0) {
            steps = [{ id: 'step-1', name: '执行任务', prompt: goal, dependsOn: [] }];
          }

          // ⭐ 计划清洗（修复拆分瑕疵）：
          // 1) 丢弃无 prompt 的无效步骤；2) 补齐/去重 id；3) 依赖引用去重
          steps = steps.filter((s: any) => s && typeof s.prompt === 'string' && s.prompt.trim());
          if (steps.length === 0) {
            steps = [{ id: 'step-1', name: '执行任务', prompt: goal, dependsOn: [] }];
          }
          const seenIds = new Set<string>();
          steps = steps.map((s: any, i: number) => {
            let id = (typeof s.id === 'string' && s.id.trim()) ? s.id.trim() : ('step-' + (i + 1));
            while (seenIds.has(id)) id = id + '-' + Math.random().toString(36).slice(2, 5);
            seenIds.add(id);
            return {
              ...s,
              id,
              name: (typeof s.name === 'string' && s.name.trim()) ? s.name.trim() : ('步骤 ' + (i + 1)),
              dependsOn: Array.isArray(s.dependsOn) ? [...new Set(s.dependsOn.filter((d: any) => typeof d === 'string'))] : [],
            };
          });

          // safety limit（截断后必须同步清理依赖引用，否则被引用步骤永远无法满足依赖 → 任务整体挂死）
          if (steps.length > 10) steps = steps.slice(0, 10);
          const validIds = new Set<string>(steps.map((s: any) => s.id));
          for (const s of steps as any[]) {
            s.dependsOn = s.dependsOn.filter((d: string) => validIds.has(d) && d !== s.id);
          }

          // save task plan (for resume support)
          const plan: TaskPlan = {
            taskId: taskMsgId,
            chatId, agentId, goal,
            steps: steps.map((s: any) => ({ ...s, status: 'pending' })),
            currentStep: 0,
            status: 'executing',
            createdAt: Date.now(),
          };
          activeTaskPlans.set(taskMsgId, plan);

          // Phase 2: broadcast plan
          broadcast({
            type: "task.progress",
            chatId, from: agentSenderId, msgId: taskMsgId,
            phase: "plan_ready",
            message: "任务已拆分为 " + steps.length + " 个步骤",
            step: 0, total: steps.length,
            steps: steps.map((s: any) => ({ id: s.id, name: s.name, dependsOn: s.dependsOn })),
            timestamp: Date.now(),
          });

          // Phase 3: execute DAG via Orchestrator
          const executor = async (task: TaskNode, context: Record<string, string>, signal?: AbortSignal) => {
            const stepIdx = steps.findIndex((s: any) => s.id === task.id);
            // 用户在步骤间隙点停止 → 直接失败，级联跳过后续依赖步骤
            if (taskCtrl.signal.aborted) {
              throw new Error('用户已停止任务');
            }
            let abortedByTimeout = false;
            const onAbort = () => { abortedByTimeout = true; };
            if (signal) signal.addEventListener('abort', onAbort, { once: true });

            broadcast({
              type: "task.progress",
              chatId, from: agentSenderId, msgId: taskMsgId,
              phase: "step_start",
              message: "执行步骤 " + (stepIdx + 1) + "/" + steps.length + "：" + task.name,
              step: stepIdx + 1, total: steps.length,
              stepId: task.id, stepName: task.name,
              timestamp: Date.now(),
            });

            // build prompt with dependency outputs
            let fullPrompt = task.prompt;
            const depOutputs = Object.entries(context);
            if (depOutputs.length > 0) {
              fullPrompt += "\n\n## 前置步骤结果\n";
              for (const [depId, depOutput] of depOutputs) {
                const depStep = steps.find((s: any) => s.id === depId);
                fullPrompt += "### " + (depStep?.name || depId) + "\n" + depOutput.slice(0, 3000) + "\n\n";
              }
            }

            let stepResult = '';
            let stepSuccess = true;
            // ⭐ 合并超时信号 + 用户停止信号，两者都能中断 AI 调用
            const merged = mergeAbort(signal, taskCtrl.signal);
            try {
              // 修复：fullPrompt 传到 customPrompt（第8参）而非 taskGoal（第6参）；
              // skipPersist 避免中间步骤污染聊天历史
              stepResult = await router.generateReply(
                chatId, agentId, taskMsgId,
                (chunk) => {
                  broadcast({ type: "agent.streaming.chunk", chatId, from: agentSenderId, msgId: taskMsgId, chunk });
                },
                undefined,
                undefined,
                undefined,
                fullPrompt,
                merged.signal,
                { skipPersist: true }
              );
            } catch (stepErr: any) {
              stepSuccess = false;
              if (taskCtrl.signal.aborted) {
                stepResult = "步骤被用户停止中断";
              } else if (abortedByTimeout || signal?.aborted) {
                stepResult = "步骤执行超时（" + (task.timeout || 120000) + "ms）被中断";
              } else {
                stepResult = "步骤执行失败：" + (stepErr.message || '未知错误');
              }
              console.error('[WS] step ' + task.id + ' failed:', stepErr);
            }

            if (signal) signal.removeEventListener('abort', onAbort);

            broadcast({
              type: "task.progress",
              chatId, from: agentSenderId, msgId: taskMsgId,
              phase: "step_done",
              message: (stepSuccess ? "步骤 " : "步骤失败 ") + (stepIdx + 1) + "：" + task.name,
              step: stepIdx + 1, total: steps.length,
              stepId: task.id, stepName: task.name,
              success: stepSuccess,
              output: (stepResult || "").slice(0, 500),
              timestamp: Date.now(),
            });

            // update plan state
            const p = activeTaskPlans.get(taskMsgId);
            if (p) {
              const st = p.steps.find(s => s.id === task.id);
              if (st) { st.status = stepSuccess ? 'done' : 'failed'; st.output = stepResult; }
              p.currentStep = stepIdx + 1;
              if (!stepSuccess) p.status = 'failed';
            }

            return stepResult || '';
          };

          const orchestrator = new Orchestrator(executor);
          for (const step of steps) {
            orchestrator.addTask({
              id: step.id,
              name: step.name,
              prompt: step.prompt,
              dependsOn: step.dependsOn || [],
              timeout: (parseInt(process.env.ORCHESTRATOR_TIMEOUT_SECONDS || '120', 10)) * 1000,
            });
          }

          const orchResult = await orchestrator.run();

          // Phase 4: summarize results
          let finalResult = '';
          const allResults = orchestrator.getResults();
          if (steps.length === 1) {
            finalResult = allResults[0]?.output || '任务已执行';
          } else {
            const completed = allResults.filter(r => r.status === 'done');
            if (completed.length === allResults.length) {
              const lastStep = steps[steps.length - 1];
              const lastResult = allResults.find(r => r.id === lastStep.id);
              finalResult = lastResult?.output || '所有步骤已完成';
            } else {
              const failed = allResults.filter(r => r.status === 'failed');
              const skipped = allResults.filter(r => r.status === 'skipped');
              finalResult = "任务部分完成。成功 " + completed.length + "/" + allResults.length + "，失败 " + failed.length + "，跳过 " + skipped.length + "。";
              if (failed.length > 0) {
                finalResult += "\n失败步骤：" + failed.map(f => f.id + "(" + (f.error || "") + ")").join(", ");
              }
            }
          }

          // update plan status
          const p = activeTaskPlans.get(taskMsgId);
          if (p) {
            p.status = orchResult.success ? 'completed' : 'failed';
            p.result = finalResult;
          }

          // broadcast completion with accurate step count
          // ⭐ 修复：原 findIndex 返回的是首个失败步骤的下标而非完成数，且忽略 skipped；改为真实统计
          const completedStepCount = allResults.filter(r => r.status === 'done').length;
          const userStopped = taskCtrl.signal.aborted;
          broadcast({
            type: "task.progress",
            chatId, from: agentSenderId, msgId: taskMsgId,
            phase: "completed",
            message: userStopped ? '任务已停止' : (orchResult.success ? '任务全部完成' : '任务部分失败'),
            step: completedStepCount, total: steps.length,
            success: orchResult.success,
            duration: orchResult.duration,
            timestamp: Date.now(),
          });

          // ⭐ Bug fix: 必须发送 streaming.end，否则前端 generatingChats 永不递减，聊天卡死
          broadcast({ type: "agent.streaming.end", chatId, from: agentSenderId, msgId: taskMsgId });

          broadcast({
            type: "message.new", chatId,
            from: agentSenderId, senderId: agentSenderId, senderType: "agent",
            content: finalResult,
            msgId: taskMsgId, timestamp: Date.now(),
          });

          // cleanup after 5 min
          setTimeout(() => activeTaskPlans.delete(taskMsgId), 5 * 60 * 1000);
        } catch (err: any) {
          console.error('[WS] agent.task error:', err);
          broadcast({
            type: "task.progress",
            chatId, from: agentSenderId, msgId: taskMsgId,
            phase: "failed",
            message: "任务执行失败：" + (err.message || '未知错误'),
            timestamp: Date.now(),
          });
          broadcast({ type: "agent.streaming.end", chatId, from: agentSenderId, msgId: taskMsgId, error: err.message });
          // ⭐ 修复：失败时也要发送 message.new，否则用户看不到错误信息
          broadcast({
            type: "message.new", chatId,
            from: agentSenderId, senderId: agentSenderId, senderType: "agent",
            content: "❌ 任务执行失败：" + (err.message || '未知错误'),
            msgId: taskMsgId, timestamp: Date.now(),
          });
        } finally {
          if (taskHeartbeatId) clearInterval(taskHeartbeatId);
          unregisterGeneration(chatId, taskCtrl);
        }
      })();
      break;
    }

    case "task.list": {
      const plans = Array.from(activeTaskPlans.values()).map(p => ({
        taskId: p.taskId, chatId: p.chatId, agentId: p.agentId,
        goal: p.goal, status: p.status,
        currentStep: p.currentStep, totalSteps: p.steps.length,
        steps: p.steps.map(s => ({ id: s.id, name: s.name, status: s.status })),
        createdAt: p.createdAt,
      }));
      broadcast({ type: "task.list.result", plans, clientId });
      break;
    }

    case "task.status": {
      const { taskId } = event;
      if (!taskId) { broadcast({ type: "error", message: "task.status needs taskId" }); break; }
      const p = activeTaskPlans.get(taskId);
      if (!p) {
        broadcast({ type: "task.status.result", taskId, found: false });
      } else {
        broadcast({
          type: "task.status.result", taskId, found: true,
          plan: {
            taskId: p.taskId, chatId: p.chatId, agentId: p.agentId,
            goal: p.goal, status: p.status,
            currentStep: p.currentStep, totalSteps: p.steps.length,
            steps: p.steps.map(s => ({ id: s.id, name: s.name, status: s.status, output: s.output?.slice(0, 500) })),
            result: p.result, createdAt: p.createdAt,
          },
        });
      }
      break;
    }

    case "sessions.list": {
      // 前端请求会话列表
      const { userId } = event;
      if (!userId) { broadcast({ type: "error", message: "sessions.list 需要 userId" }); break; }
      // 这个处理在 index.ts 的 WS 连接事件中已经自动发送了
      // 但某些前端需要在运行时手动刷新列表
      broadcast({ type: "sessions.list.ack", chatId: event.chatId, message: "会话恢复依赖于 index.ts 的 WS handler" });
      break;
    }

    default:
  }
}

/**
 * 处理一条用户消息的完整编排（WS 层与实例网格共用）：
 *   1. router.handleIncoming 落库 + 按群聊协作模式调度
 *   2. 广播用户消息
 *   3. 触发各 AI 回复（链式串行 / 其他并行+delayMs 错开）
 *   4. 后续轮次：辩论汇总 / 圆桌多轮 / 投票开票
 */
// ── 复杂度判断：决定是否自动触发任务拆解 ──
const COMPLEX_KEYWORDS = [
  '全部修复', '批量', '所有', '全面', '整体', '系统性', '全量',
  '重构', '审计', '扫描全部', '逐个', '依次', '分步骤', '多步骤',
  '打包上传', '打包并', '上传服务器', '部署到', '发布到', '还要', '然后再',
  'all fix', 'batch', 'comprehensive', 'full scan', 'refactor all'
];
function shouldAutoDecompose(content: string): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  // ⭐ 排除纯提问/咨询，避免把问题误拆成多步骤任务
  if (/[?？]\s*$/.test(trimmed)) return false;
  if (/^(为什么|为啥|怎么|如何|是什么|什么是|是不是|能不能|可不可以|有没有|哪个|哪些|多少|who|what|why|how|when|where|is |are |can |do |does )/i.test(trimmed)) return false;
  // ⭐ 排除简短偏好/指令类消息（如"以后回答都要简洁"），没有可拆分的多步动作
  if (trimmed.length < 12 && !/(修复|修|部署|打包|上传|重构|审计)/.test(trimmed)) return false;
  const lower = content.toLowerCase();
  // 关键词匹配
  for (const kw of COMPLEX_KEYWORDS) {
    if (lower.includes(kw.toLowerCase())) return true;
  }
  // 较长消息（>80字）+ 包含多个操作动词 → 多步骤任务
  if (content.length > 80) {
    const actionCount = ['修复', '修改', '添加', '删除', '更新', '检查', '实现', '创建', '配置', '部署', '打包', '上传', '验证',
                         'fix', 'add', 'remove', 'update', 'check', 'implement', 'create', 'config', 'deploy', 'package', 'upload']
      .filter(v => lower.includes(v)).length;
    if (actionCount >= 2) return true;
  }
  return false;
}

export function processUserMessage(
  chatId: string,
  senderId: string,
  content: string,
  replyTo: string | undefined,
  router: MessageRouter,
  broadcast: (event: any) => void
): void {
  // ── 复杂度判断：如果消息看起来需要多步骤，自动触发任务拆解 ──
  if (shouldAutoDecompose(content)) {
    router.handleIncoming({
      chatId,
      senderType: "user",
      senderId,
      content,
      replyTo,
    }).then(async (result) => {
      // 广播用户消息
      broadcast({
        type: "message.new",
        chatId,
        from: senderId,
        senderId,
        senderType: "user",
        content,
        replyTo,
        timestamp: Date.now(),
      });

      const agents = result.agentsInChat || [];
      if (agents.length > 0) {
        const agent = agents[0];
        const agentId = agent.id || (agent as any).agent_id || (agent as any).agentId;
        if (agentId) {
          // 自动触发任务拆解（复用 agent.task 逻辑）
          const taskEvent = JSON.stringify({ type: "agent.task", chatId, agentId, goal: content });
          handleWSMessage(taskEvent, senderId, router, broadcast);
          return;
        }
      }
      // 没有 Agent，回退到普通回复
      const nameOf = (agentId: string) =>
        agents.find((a: any) => a.id === agentId)?.displayName || agentId;
      const collected = await runResponses(
        chatId, result.responses, broadcast, router, nameOf, false
      );
    }).catch((err: any) => {
      console.error('[WS] auto-decompose error:', err);
      try { broadcast({ type: 'error', message: err?.message || '处理失败' }); } catch (_) {}
    });
    return;
  }

  router.handleIncoming({
    chatId,
    senderType: "user",
    senderId,
    content,
    replyTo,
  }).then(async (result) => {
    // 广播用户消息
    broadcast({
      type: "message.new",
      chatId,
      from: senderId,
      senderId,
      senderType: "user",
      content,
      replyTo,
      timestamp: Date.now(),
    });

    const agents = result.agentsInChat || [];
    const nameOf = (agentId: string) =>
      agents.find((a: any) => a.id === agentId)?.displayName || agentId;
    // 链式模式：严格串行（上一步输出落库后下一步才开始读得到）
    const isChain = result.followUpContext?.type === 'chain';

    // 首轮回复：收集每个 AI 的输出，供后续汇总/开票使用
    const collected = await runResponses(
      chatId, result.responses, broadcast, router, nameOf, isChain
    );

    // ── 后续轮次编排（辩论汇总 / 圆桌多轮 / 投票开票）──
    let followUp = result.needsFollowUp ? result.followUpContext : undefined;
    let guard = 0;
    while (followUp && guard++ < 6) {
      let next: any = null;
      if (followUp.type === 'debate') {
        next = dispatchDebateSummary(chatId, collected, agents);
        followUp = undefined; // 一次性汇总
      } else if (followUp.type === 'roundtable') {
        next = dispatchRoundtableNext(chatId, agents, followUp.round, followUp.maxRounds);
        followUp = next?.needsFollowUp ? next.followUpContext : undefined;
      } else if (followUp.type === 'brainstorm') {
        next = dispatchBrainstormNext(chatId, agents, collected, followUp.phase || 'converge', followUp.topic || '');
        followUp = next?.needsFollowUp ? next.followUpContext : undefined;
      } else if (followUp.type === 'vote') {
        next = dispatchVoteSummary(chatId, collected, agents, followUp.options || []);
        followUp = undefined; // 一次性开票
      } else {
        followUp = undefined;
      }
      if (!next || !next.responses?.length) break;
      await runResponses(chatId, next.responses, broadcast, router, nameOf, false);
    }
  }).catch((err: any) => {
    console.error('[WS] handleIncoming error:', err);
    try { broadcast({ type: 'error', message: err?.message || '处理失败' }); } catch (_) {}
  });
}

/**
 * 触发 Agent 回复 —— 支持流式输出
 * 流程：
 *   1. 广播 agent.streaming.start（前端创建打字气泡）
 *   2. 逐 chunk 广播 agent.streaming.chunk（前端追加文字）
 *   3. 广播 message.new（最终完整消息，前端替换打字气泡为正式消息）
 */
async function triggerAgentReply(
  chatId: string,
  agentId: string,
  triggerMsgId: string,
  broadcast: (event: any) => void,
  router: MessageRouter,
  customPrompt?: string
): Promise<string> {
  const msgId = 'msg-agent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  let fullContent = '';
  const agentSenderId = `agent:${agentId}`;
  // ⭐ 停止生成：为本次回复注册 AbortController，stop 指令可中断它
  const ctrl = new AbortController();
  registerGeneration(chatId, ctrl);

  let heartbeatId: ReturnType<typeof setInterval> | undefined;
  try {
    // 先通知前端：Agent 开始回复（打字机效果）
    broadcast({
      type: "agent.streaming.start",
      chatId,
      from: agentSenderId,
      senderId: agentSenderId,
      senderType: "agent",
      msgId,
      replyTo: triggerMsgId,
      timestamp: Date.now(),
    });

    // ⭐ 心跳保活：AI 处理期间每 5 秒发一次心跳，防止 WS 连接超时断开
    heartbeatId = setInterval(() => {
      broadcast({
        type: "agent.streaming.heartbeat",
        chatId,
        from: agentSenderId,
        msgId,
        timestamp: Date.now(),
      });
    }, 3000);
    if (heartbeatId.unref) heartbeatId.unref();

    const reply = await router.generateReply(
      chatId,
      agentId,
      triggerMsgId,
      // 流式 chunk 回调
      (chunk: string) => {
        fullContent += chunk;
        broadcast({
          type: "agent.streaming.chunk",
          chatId,
          from: agentSenderId,
          senderId: agentSenderId,
          msgId,
          chunk,
        });
      },
      // onThink - 推理/思考过程回调
      (thinkChunk: string) => {
        broadcast({
          type: "agent.streaming.think",
          chatId,
          from: agentSenderId,
          senderId: agentSenderId,
          msgId,
          think: thinkChunk,
        });
      },
      // taskGoal 可选
      undefined,
      // ⭐ 工具调用进度广播：把工具 call/result 转给前端
      (event: any) => {
        broadcast({
          ...event,
          chatId,
          from: agentSenderId,
          senderId: agentSenderId,
          senderType: 'agent',
        });
      },
      // ⭐ 协作模式指令注入（辩论立场/链式步骤/圆桌轮次/投票选项等）
      customPrompt,
      // ⭐ 停止信号：用户点"停止"时中断本次生成
      ctrl.signal
    );

    // 如果 generateReply 内部已经拼接了 fullContent（工具调用场景），用返回值
    if (reply && !fullContent) fullContent = reply;
    if (reply && fullContent !== reply) fullContent = reply;

    // V10: 先发送 streaming.end 关闭打字气泡
    broadcast({
      type: "agent.streaming.end",
      chatId,
      from: agentSenderId,
      msgId,
    });
    // 再广播最终完整消息（前端替换打字气泡为正式消息）
    broadcast({
      type: "message.new",
      chatId,
      from: agentSenderId,
      senderId: agentSenderId,
      senderType: "agent",
      content: fullContent || reply,
      replyTo: triggerMsgId,
      timestamp: Date.now(),
    });
    return fullContent || reply || '';
  } catch (err: any) {
    // ⭐ 用户主动停止：不当作错误，关闭打字气泡并标记 stopped（前端显示"已停止"）
    if (ctrl.signal.aborted) {
      broadcast({
        type: "agent.streaming.end",
        chatId,
        from: agentSenderId,
        msgId,
        stopped: true,
      });
      return '';
    }
    console.error(`[WS] Agent ${agentId} reply failed:`, err);
    // 构建用户可读的错误信息
    let errorMsg = err.message || '未知错误';
    let errorDetail = '';
    if (err.status) {
      errorDetail += `HTTP ${err.status}`;
      if (err.status === 401) errorDetail += ' 认证失败（API Key 无效或过期）';
      else if (err.status === 400) errorDetail += ' 请求格式错误';
      else if (err.status === 404) errorDetail += ' 模型不存在或路径错误';
      else if (err.status === 429) errorDetail += ' 请求频率超限（Rate Limit）';
      else if (err.status === 500) errorDetail += ' 服务端错误';
    }
    if (err.error?.message) errorDetail += ' | ' + err.error.message;
    if (err.code) errorDetail += ' | code: ' + err.code;
    const fullError = errorDetail ? `${errorMsg} (${errorDetail})` : errorMsg;
    // 流式失败也要关闭打字气泡
    broadcast({
      type: "agent.streaming.end",
      chatId,
      from: `agent:${agentId}`,
      msgId,
      error: fullError,
    });
    broadcast({
      type: "error",
      message: fullError,
      detail: {
        status: err.status,
        code: err.code,
        type: err.type,
        model: err.model,
        rawMessage: err.message,
      },
    });
    return '';
  } finally {
    if (heartbeatId) clearInterval(heartbeatId);
    unregisterGeneration(chatId, ctrl);
  }
}

/**
 * 批量触发调度结果里的 AI 回复，并收集各自输出。
 * sequential=true（链式模式）：严格串行，忽略 delayMs —— 上一步落库后下一步才开始。
 * sequential=false：并行触发，按 delayMs 错开（辩论同时开火、圆桌轮流发言）。
 */
async function runResponses(
  chatId: string,
  responses: any[],
  broadcast: (event: any) => void,
  router: MessageRouter,
  nameOf: (agentId: string) => string,
  sequential: boolean
): Promise<Array<{ agentId: string; agentName: string; content: string }>> {
  const collected: Array<{ agentId: string; agentName: string; content: string }> = [];
  if (!responses || responses.length === 0) return collected;

  if (sequential) {
    for (const resp of responses) {
      const content = await triggerAgentReply(
        chatId, resp.agentId, resp.triggerMessage.id, broadcast, router, resp.customPrompt
      );
      collected.push({ agentId: resp.agentId, agentName: nameOf(resp.agentId), content });
    }
  } else {
    await Promise.all(responses.map(async (resp: any) => {
      if (resp.delayMs && resp.delayMs > 0) {
        await new Promise(r => setTimeout(r, resp.delayMs));
      }
      const content = await triggerAgentReply(
        chatId, resp.agentId, resp.triggerMessage.id, broadcast, router, resp.customPrompt
      );
      collected.push({ agentId: resp.agentId, agentName: nameOf(resp.agentId), content });
    }));
  }
  return collected;
}
