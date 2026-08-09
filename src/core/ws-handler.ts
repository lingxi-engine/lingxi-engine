import type { MessageRouter } from "./router.js";
import type { WebSocket } from "ws";
import { dispatchDebateSummary, dispatchRoundtableNext, dispatchVoteSummary } from "./chat-modes.js";

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

export function handleWSMessage(
  raw: any,
  clientId: string,
  router: MessageRouter,
  broadcast: (event: WSResponse) => void,
  ws?: WebSocket
) {
  let event: any;
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
      // ═══ 自主任务模式 ═══
      // 给 Agent 一个目标，Agent 循环执行工具直到完成
      const { chatId, agentId, goal } = event;
      if (!chatId || !agentId || !goal) {
        broadcast({ type: "error", message: "agent.task 需要 chatId/agentId/goal" });
        break;
      }

      const taskMsgId = 'task-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      
      // 1. 广播任务开始
      broadcast({
        type: "agent.streaming.start",
        chatId,
        from: `agent:${agentId}`,
        senderType: "agent",
        msgId: taskMsgId,
        goal,
        timestamp: Date.now(),
      });

      // 2. 进入自主循环（最多 10 轮）
      (async () => {
        let result = '';
        let round = 0;
        const maxRounds = 10;
        
        while (round < maxRounds) {
          round++;
          
          broadcast({
            type: "agent.streaming.chunk",
            chatId, from: `agent:${agentId}`,
            msgId: taskMsgId,
            chunk: `\n🔧 第${round}轮思考... `,
          });

          const reply = await router.generateReply(
            chatId, agentId, taskMsgId,
            (chunk: string) => {
              broadcast({
                type: "agent.streaming.chunk",
                chatId, from: `agent:${agentId}`,
                msgId: taskMsgId, chunk,
              });
            },
            undefined, // onThink (optional)
            goal
          );

          result += reply;
          
          if (reply.includes('任务完成') || reply.includes('DONE') || round >= maxRounds) {
            break;
          }
        }

        broadcast({
          type: "message.new", chatId,
          from: `agent:${agentId}`, senderType: "agent",
          content: result || '任务已处理',
          msgId: taskMsgId, timestamp: Date.now(),
        });
        })().catch((err: any) => {
          broadcast({ type: "agent.streaming.end", chatId, from: `agent:${agentId}`, msgId: taskMsgId, error: err.message });
        });
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
export function processUserMessage(
  chatId: string,
  senderId: string,
  content: string,
  replyTo: string | undefined,
  router: MessageRouter,
  broadcast: (event: any) => void
): void {
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
