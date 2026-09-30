/**
 * executor.ts - 工具调用执行器（类型安全增强版 v1.3.0 P2-1）
 *
 * P2-1: 补充工具执行器的类型守卫
 *   - 全部 any 替换为具体类型或 unknown + 守卫
 *   - AI 响应结构通过类型守卫验证
 *   - 工具参数在传入 registry.execute 前校验
 *
 * v2.7.0 韧性增强（长任务自愈，治"限流后要用户点继续"）：
 *   - AI 调用失败区分「可重试」与「致命」两类
 *   - 可重试（429/5xx/网络抖动）走指数退避 + Retry-After，原地重试，不消耗外层迭代
 *   - 连续可重试失败超过上限才置 ai_errors，且不立即放弃（由 autonomy 续跑兜底）
 *   - 致命错误（400/401/403/404/410/422）立刻停，避免无意义空转
 */
import type { ToolDefinition, ToolCallRequest, ToolCallResult } from "./types.js";
import {
  isRecord,
  isToolCallInMessage,
  hasToolCalls,
  safeJsonParse,
} from "./types.js";
import { setDelegateContext } from "./builtin.js";
import { UsageTracker } from "../core/usage-tracker.js";
import { estimateMessagesTokens } from "../core/compaction.js";
import type { ToolRegistry } from "./registry.js";
import {
  isRetryableError,
  extractRetryAfterMs,
  backoffDelayMs,
} from "../core/autonomy.js";

// ═══════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: ToolCallInMessage[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCallInMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** OpenAI 聊天补全 API 响应（工具调用的子集） */
interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
      function_call?: {
        name?: string;
        tool_name?: string;
        arguments?: string;
        parameters?: Record<string, unknown>;
      };
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export interface RunToolsResult {
  finalContent: string;
  messages: ChatMessage[];
  toolResults: ToolCallResult[];
  iterations: number;
  aborted: boolean;
  consecutiveErrors?: number;
  /** 中断原因，供 router 决定是否自动续跑（v2.3.0 新增 ai_errors） */
  stopReason?:
    | 'completed'
    | 'idle_stop'
    | 'max_iterations'
    | 'aborted'
    | 'tool_failures'
    | 'ai_errors'
    | 'repeat_tool';
}

export interface ToolCallEvent {
  chatId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, any>;
  description?: string;
  timestamp: number;
}

export interface ToolResultEvent {
  chatId: string;
  agentId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, any>;
  success: boolean;
  result: any;
  error?: string;
  timestamp: number;
}

export interface RunToolsOptions {
  client: any;
  model: string;
  messages: ChatMessage[];
  registry: ToolRegistry;
  agentId: string;
  chatId?: string;
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** P1-6: 摘要专用模型（轻量），未设置时用主 model */
  summaryModel?: string;
  /**
   * force_complete 强制完成模式：true 时，工具连续失败不轻易放弃，迭代上限更高。
   * 由 FORCE_COMPLETE 环境变量或 GoalExecutor 传入。
   */
  forceComplete?: boolean;
  requireCompletion?: boolean;
  onChunk?: (chunk: string) => void;
  onThink?: (thinkChunk: string) => void;
  onSegmentEnd?: () => void;
  onToolCall?: (e: ToolCallEvent) => void;
  onToolResult?: (e: ToolResultEvent) => void;
  /** 是否高亮压缩工具结果 */
  highlightCompacted?: boolean;
  availableTools?: ToolDefinition[];
}

/** ─────────────────────────────────────────────
 * v2.7.0 韧性参数（全部可配，默认值面向长任务自愈）
 * ───────────────────────────────────────────── */
const AI_RETRY_BASE_MS = parseInt(process.env.AI_RETRY_BASE_MS || '1000', 10);
const AI_RETRY_MAX_MS = parseInt(process.env.AI_RETRY_MAX_MS || '32000', 10);
/** 同一轮里对"可重试错误"最多原地重试几次（不消耗外层迭代预算） */
const AI_RETRY_PER_ITER = parseInt(process.env.AI_RETRY_PER_ITER || '4', 10);
/** 连续多少轮都遇到可重试错误才判定 ai_errors（比旧版的 5 更宽松） */
const AI_ERROR_ROUNDS_LIMIT = parseInt(process.env.AI_ERROR_ROUNDS_LIMIT || '8', 10);

/** 可中断的 sleep：abort 立刻醒，不浪费剩余退避时间 */
function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 判断是否为"压缩类"工具结果需要高亮 */
function isCompactionTool(name: string): boolean {
  return /compact|summar/i.test(name);
}

export function isSearchTool(name: string): boolean {
  return /search|scrape|fetch|browse|web/i.test(name);
}

/**
 * 提取"明确完成"信号。
 * 任务模式（requireCompletion）下模型必须显式声明完成，否则视为未完成。
 */
export function isCompletionSignal(text: string): boolean {
  if (!text) return false;
  const t = text.trim();
  return /任务完成|全部完成|已完成|完成了|搞定|done\b|completed/i.test(t)
    // 反向信号优先：「未完成/还差/待办」出现时不认完成
    && !/(尚未完成|未完成|还没做完|还差|待办|下一步|继续做)/.test(t);
}

/** 检测模型是否在问用户"要不要继续" */
export function isAskingUserToContinue(text: string): boolean {
  if (!text) return false;
  return /(需要我(继续|接着)|是否(需要|要)(继续|接着)|要我继续|要不要继续|请确认是否继续|需要确认)/.test(text);
}

// ═══════════════════════════════════════════════
// DSML 文本内工具调用解析
// ═══════════════════════════════════════════════

interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 从纯文本里抠出 DSML 工具调用块 */
export function extractToolCallsFromText(text: string): ParsedToolCall[] {
  const out: ParsedToolCall[] = [];
  if (!text) return out;
  const blockRe = /<｜{1,2}DSML｜{1,2}tool_calls>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}tool_calls>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const inner = m[1];
    const invokeRe = /<｜{1,2}DSML｜{1,2}invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}invoke>/g;
    let im: RegExpExecArray | null;
    while ((im = invokeRe.exec(inner)) !== null) {
      const name = im[1];
      const body = im[2];
      const pm = body.match(/<｜{1,2}DSML｜{1,2}parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}parameter>/g);
      const args: Record<string, unknown> = {};
      if (pm) {
        for (const p of pm) {
          const pn = p.match(/name="([^"]+)"/)?.[1];
          const pv = p.replace(/^[\s\S]*?>/, '').replace(/<\/｜{1,2}DSML｜{1,2}parameter>$/, '').trim();
          if (pn) args[pn] = pv;
        }
      }
      out.push({ id: 'call-' + Math.random().toString(36).slice(2), name, arguments: args });
    }
  }
  return out;
}

/** 校验从文本解析出的工具调用的名字是否合法 */
export function isValidParsedToolCall(tc: ParsedToolCall): boolean {
  if (!tc || typeof tc.name !== 'string' || tc.name.length === 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tc.name);
}

/** 剥离 DSML 标记（保留正常文本），避免模型看到自己的标记持续模仿 */
export function stripDsmlMarkup(text: string): string {
  if (!text) return '';
  return text
    .replace(/<｜{1,2}DSML｜{1,2}tool_calls>[\s\S]*?<\/｜{1,2}DSML｜{1,2}tool_calls>/g, '')
    .replace(/<｜{1,2}DSML｜{1,2}invoke[\s\S]*?<\/｜{1,2}DSML｜{1,2}invoke>/g, '')
    .replace(/<\/??｜{1,2}DSML｜{1,2}[^>]*>/g, '')
    .trim();
}

/**
 * 发起一次聊天补全请求（流式 / 非流式统一入口）。
 */
async function requestCompletion(
  client: any,
  params: Record<string, any>,
  signal?: AbortSignal,
  onChunk?: (c: string) => void,
  onThink?: (t: string) => void,
): Promise<any> {
  const useStream = !!onChunk;
  const finalParams = { ...params };
  if (useStream) finalParams.stream = true;
  const resp = await client.chat.completions.create(
    finalParams,
    signal ? { signal } : undefined,
  );
  if (!useStream) return resp;

  // 流式：拼装成非流式结构返回给上层统一处理
  let content = '';
  let reasoning = '';
  const toolAcc: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  const callIdx = new Map<number, number>();
  for await (const chunk of resp) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    const r = (delta as any)?.reasoning_content ?? (delta as any)?.reasoning;
    if (r) { reasoning += r; if (onThink) onThink(r); }
    if (delta.content) { content += delta.content; if (onChunk) onChunk(delta.content); }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        if (!callIdx.has(idx)) {
          callIdx.set(idx, toolAcc.length);
          toolAcc.push({ id: tc.id || 'call-' + idx + '-' + Math.random().toString(36).slice(2), type: 'function', function: { name: '', arguments: '' } });
        }
        const slot = toolAcc[callIdx.get(idx)!];
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
      }
    }
  }
  return {
    choices: [{ message: { role: 'assistant', content, tool_calls: toolAcc.length ? toolAcc : undefined } }],
    usage: (resp as any).usage,
  };
}

// ═══════════════════════════════════════════════
// 主循环
// ═══════════════════════════════════════════════

const MAX_IDLE_ROUNDS = 4;
const REPEAT_TOOL_LIMIT = 2;
const SEARCH_CALL_LIMIT = 4;

export async function runToolsLoop(options: RunToolsOptions): Promise<any> {
  const {
    client, model, registry, agentId, chatId,
    temperature = 0.7, maxTokens = 4096, signal,
    forceComplete = false, requireCompletion = false,
    onChunk, onThink, onSegmentEnd, onToolCall, onToolResult,
    highlightCompacted = false,
  } = options;

  const messages = (options.messages || []).slice();
  const maxIterations = options.maxIterations ?? 50;
  const availableTools = options.availableTools || registry.listToolsForAgent?.(agentId) || [];

  const result: any = {
    finalContent: '',
    messages,
    toolResults: [] as ToolCallResult[],
    iterations: 0,
    aborted: false,
    consecutiveErrors: 0,
    stopReason: undefined as
      | 'completed' | 'idle_stop' | 'max_iterations' | 'aborted'
      | 'tool_failures' | 'ai_errors' | 'repeat_tool'
      | undefined,
  };

  let idleRounds = 0;
  let consecutiveToolFailures = 0;
  let lastToolSignature = '';
  let sameSignatureCount = 0;
  let searchCallCount = 0;

  // 工具 schema（供 tool_choice / 请求体）
  const openaiTools = availableTools.length
    ? availableTools.map((t: ToolDefinition) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: (t.description || '').slice(0, 1024),
          parameters: t.parameters as any,
        },
      }))
    : undefined;

  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) {
      result.aborted = true;
      break;
    }

    // ── 构造请求 ──
    const requestParams: Record<string, any> = {
      model,
      messages: messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (openaiTools) {
      requestParams.tools = openaiTools;
      requestParams.tool_choice = 'auto';
    }

    // ── v2.7.0：带韧性重试的 AI 调用 ──
    //   关键：可重试错误（429/5xx/网络）不再立刻消耗一次外层迭代，
    //   而是原地退避重试；只有真正失败才推进迭代。
    let aiResponse!: OpenAIChatResponse;   // 由下面的 aiCallOk 守卫保证已赋值
    let aiCallOk = false;
    let lastErr: unknown = undefined;
    for (let a = 0; a <= AI_RETRY_PER_ITER; a++) {
      try {
        aiResponse = await requestCompletion(client, requestParams, signal, onChunk, onThink) as OpenAIChatResponse;
        aiCallOk = true;
        break;
      } catch (err: unknown) {
        lastErr = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        const status = typeof (err as any)?.status === 'number' ? (err as any).status : undefined;

        // 用户主动停止 / 超时：不当作 AI 错误，原样退出
        if (signal?.aborted) {
          result.aborted = true;
          break;
        }

        // 致命错误（配置/权限/模型不存在）：重试无意义，立刻停
        if (!isRetryableError(err)) {
          console.error(`[Executor] AI 调用致命失败 (${status ?? 'no-status'}):`, errMsg);
          result.consecutiveErrors = (result.consecutiveErrors || 0) + 1;
          result.finalContent = `AI 调用失败：${errMsg}。这通常是配置问题（API Key / 模型名 / 权限），重试无用，请检查引擎配置。`;
          result.stopReason = 'ai_errors';
          aiCallOk = false;
          break;
        }

        // 可重试错误：退避后原地重试（不推进外层迭代）
        const delay = extractRetryAfterMs(err, backoffDelayMs(a + 1, AI_RETRY_BASE_MS, AI_RETRY_MAX_MS));
        console.warn(
          `[Executor] AI 调用可重试失败 (status=${status ?? 'net'})，第 ${a + 1}/${AI_RETRY_PER_ITER} 次退避 ${delay}ms 后重试: ${errMsg}`
        );
        await sleepWithSignal(delay, signal);
        if (signal?.aborted) { result.aborted = true; break; }
      }
    }

    if (result.aborted) break;
    if (!aiCallOk) {
      // 致命错误已置 stopReason；退避耗尽则记一轮连续错误
      if (!result.stopReason) {
        const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
        result.consecutiveErrors = (result.consecutiveErrors || 0) + 1;
        if (result.consecutiveErrors >= AI_ERROR_ROUNDS_LIMIT) {
          result.finalContent =
            `AI 服务连续 ${result.consecutiveErrors} 轮不可用（限流或网络）。` +
            `已完成的进度全部保留，稍后重试即可从断点继续。`;
          result.stopReason = 'ai_errors';
          break;
        }
        result.messages.push({
          role: 'user',
          content:
            `系统提示：AI 接口暂时不可用（限流/网络），刚才的调用没有成功。` +
            `这不是任务失败。请保持当前进度，等会儿继续。`,
        });
        continue; // 不推进 i
      }
      break;
    }

    // 调用成功：重置连续错误计数
    result.consecutiveErrors = 0;
    result.iterations = i + 1;

    // 统计 token
    if (aiResponse.usage) {
      UsageTracker.record({
        model,
        promptTokens: aiResponse.usage.prompt_tokens,
        completionTokens: aiResponse.usage.completion_tokens,
        type: 'tool',
      });
    }

    const choice = aiResponse.choices[0];
    const assistantMsg = choice.message;

    // 提取推理/思考过程（DeepSeek-R1/o1/GPT-5 等推理模型会返回）
    const reasoningContent = (assistantMsg as any)?.reasoning_content ?? (assistantMsg as any)?.reasoning;
    if (reasoningContent && onThink && !(assistantMsg as any).__streamed) {
      onThink(reasoningContent);
    }

    // AI 回复加入历史
    const assistantEntry: ChatMessage = {
      role: 'assistant',
      content: assistantMsg.content ?? '',
    };

    // ── 提取工具调用 (3 层 fallback) ──
    let toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

    // 优先：标准 tool_calls
    if (Array.isArray(assistantMsg.tool_calls)) {
      const validCalls = assistantMsg.tool_calls.filter(isToolCallInMessage);
      if (validCalls.length > 0) {
        toolCalls = validCalls;
      }
    }

    // Fallback A: 旧格式 function_call
    if (toolCalls.length === 0 && assistantMsg.function_call) {
      const fc = assistantMsg.function_call;
      const name = fc.name || fc.tool_name || '';
      if (name.length > 0) {
        toolCalls = [{
          id: 'call-' + Math.random().toString(36).slice(2),
          type: 'function',
          function: {
            name,
            arguments: fc.arguments || JSON.stringify(fc.parameters || {}),
          },
        }];
      }
    }

    // Fallback B: 从 content 文本里提取
    if (toolCalls.length === 0 && assistantMsg.content) {
      const parsed = extractToolCallsFromText(assistantMsg.content);
      if (parsed.length > 0) {
        toolCalls = parsed
          .filter(isValidParsedToolCall)
          .map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        // 剥离 DSML 标记后再写入历史，避免模型下一轮看到自己的标记持续模仿
        if (assistantMsg.content.includes('DSML')) {
          assistantEntry.content = stripDsmlMarkup(assistantMsg.content);
        }
      }
    }

    // 没有工具调用，AI 给出了最终回答
    if (toolCalls.length === 0) {
      const textContent = stripDsmlMarkup(assistantMsg.content || '');
      result.messages.push(assistantEntry);

      // AGI 持续执行：任务模式（requireCompletion=true）下，AI 只出文字不调工具时，
      // 先判断是否真的"完成"——含明确完成信号才停；否则注入追问强制继续。
      // 这是解决"干一点就停"的核心：不能把"AI 这轮没调工具"当成"任务完成"。
      if (requireCompletion && !isCompletionSignal(textContent) && idleRounds < MAX_IDLE_ROUNDS) {
        idleRounds += 1;
        const isAsking = isAskingUserToContinue(textContent);
        let nudge: string;
        if (isAsking) {
          nudge = `系统提示：你刚才在问用户"要不要继续"——这是禁止的。不要问，直接调用工具继续干活。任务还没完成，立即执行下一步，不许停。`;
        } else if (idleRounds === 1) {
          nudge = "系统提示：任务还没完成，不要回复文字就停。请直接调用工具继续执行剩余步骤。不要问我要不要继续，直接做。";
        } else if (idleRounds === 2 || idleRounds % 2 === 0) {
          nudge = `系统提示：任务仍未完成（已提醒 ${idleRounds} 次）。请不要解释、不要汇报、不要问问题，直接调用工具执行下一步。如果你认为确实做完了，请明确输出"任务完成"并说明已满足的条件（声明之后不要再写"接下来/下一步"等后续计划）；否则立即调用工具。`;
        } else {
          nudge = "系统提示：继续执行任务剩余步骤，直接调用工具，不要停下。";
        }
        result.messages.push({ role: 'user', content: nudge } as ChatMessage);
        console.log(`[Executor] 持续执行：AI 未调工具且未声明完成（idleRounds=${idleRounds}/${MAX_IDLE_ROUNDS}${isAsking ? ', 检测到问用户' : ''}），注入追问继续`);
        continue;
      }
      result.finalContent = textContent;
      // 区分"确认完成"vs"提醒达上限后强停"（后者上层可触发断点续跑）
      result.stopReason = (requireCompletion && !isCompletionSignal(textContent)) ? 'idle_stop' : 'completed';
      break;
    }

    // 记录 tool_calls（已验证过的条目）
    assistantEntry.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
    result.messages.push(assistantEntry);

    // 时序封块：本轮正文已流完且要开始调工具了，通知前端把当前气泡定稿
    if (onChunk && onSegmentEnd) onSegmentEnd();

    // ── 执行所有工具调用 ──
    if (chatId) setDelegateContext(agentId, chatId, registry);
    for (const tc of toolCalls) {
      const toolName = tc.function.name;
      // 类型守卫：安全解包 tool arguments
      let toolArgs: Record<string, unknown> = {};
      const parsed = safeJsonParse(tc.function.arguments);
      if (parsed) {
        toolArgs = parsed;
      }
      console.log(`[Executor] 调用工具: ${toolName}`, JSON.stringify(toolArgs).slice(0, 200));
      if (onToolCall) onToolCall({
        chatId: chatId || '',
        agentId,
        toolCallId: tc.id,
        toolName,
        args: toolArgs,
        description: (availableTools.find((t) => t.name === toolName)?.description || registry.getTool(toolName)?.description || ''),
        timestamp: Date.now(),
      });
      // 构建合法的 ToolCallRequest
      const toolSignature = toolName + '::' + JSON.stringify(toolArgs);
      if (toolSignature === lastToolSignature) {
        sameSignatureCount += 1;
      } else {
        lastToolSignature = toolSignature;
        sameSignatureCount = 1;
      }
      if (isSearchTool(toolName)) searchCallCount += 1;

      const toolRequest: ToolCallRequest = {
        id: tc.id,
        name: toolName,
        arguments: toolArgs,
      };
      const callResult: ToolCallResult = await registry.execute(toolRequest);
      result.toolResults.push(callResult);

      // 连续工具失败检测：工具连续失败达上限则停止循环，避免死循环卡住
      if (!callResult.success) {
        consecutiveToolFailures++;
        const FAIL_LIMIT = forceComplete ? 20 : 6;
        if (consecutiveToolFailures >= FAIL_LIMIT) {
          console.warn(`[Executor] 工具连续失败 ${consecutiveToolFailures} 次，停止循环`);
          result.finalContent = `工具连续失败 ${consecutiveToolFailures} 次，已停止执行。最后错误：${callResult.error || '未知'}。建议换一种方式或拆小任务重试。`;
          result.stopReason = 'tool_failures';
          i = maxIterations;
          break;
        }
        // 连续失败 3 次后注入纠正提示，给 AI 自我修复机会而非直接终止
        if (consecutiveToolFailures === 3 || (forceComplete && consecutiveToolFailures % 3 === 0)) {
          console.warn(`[Executor] 工具已连续失败 ${consecutiveToolFailures} 次，注入纠正提示`);
          result.messages.push({
            role: 'user',
            content: `系统提示：最近连续 3 次工具调用失败。请分析失败原因（参数格式？路径不存在？权限不足？），换一种方式或换一个工具继续完成任务，不要放弃。`,
          });
        }
      } else {
        consecutiveToolFailures = 0;
      }

      if (onToolResult) onToolResult({
        chatId: chatId || '',
        agentId,
        toolCallId: tc.id,
        toolName,
        args: toolArgs,
        success: callResult.success,
        result: callResult.result,
        error: callResult.error,
        timestamp: Date.now(),
      });

      // 把工具结果喂回对话（超长结果自动摘要）
      const resultPayload = callResult.success ? callResult.result : { error: callResult.error };
      let resultContent = JSON.stringify(resultPayload);
      // 如果结果 > 6000 字符，用 AI 摘要（但 read_file 等原样返回）
      if (
        resultContent.length > 6000 &&
        callResult.success &&
        toolName !== 'read_file' &&
        toolName !== 'list_dir' &&
        toolName !== 'shell_exec' &&
        toolName !== 'patch_file'
      ) {
        try {
          const summaryModelName = options.summaryModel || model;
          const summaryResp = await client.chat.completions.create({
            model: summaryModelName,
            messages: [{
              role: 'user',
              content: `请把以下工具返回的数据压缩成简洁摘要，保留关键信息（标题、URL、核心数据），去掉重复和冗余。限 800 字以内。\n\n工具: ${toolName}\n结果:\n${resultContent.slice(0, 4000)}`,
            }],
            temperature: 0.2,
            max_tokens: 1000,
          }, signal ? { signal } : undefined) as OpenAIChatResponse;
          const summarized = summaryResp.choices[0]?.message?.content || resultContent;
          resultContent = `[摘要] ${summarized}`;
          if (summaryResp.usage) {
            UsageTracker.record({
              model,
              promptTokens: summaryResp.usage.prompt_tokens,
              completionTokens: summaryResp.usage.completion_tokens,
              type: 'summary',
            });
          }
          console.log(`[Executor] 工具结果已摘要: ${resultContent.length} ← ${JSON.stringify(resultPayload).length} 字符`);
        } catch {
          resultContent = resultContent.slice(0, 4000) + '\n...[结果已截断]';
        }
      }

      const toolMessage: ChatMessage = {
        role: 'tool',
        tool_call_id: tc.id,
        name: toolName,
        content: resultContent,
      };
      result.messages.push(toolMessage);

      // 重复调用收敛：达到阈值先注入"降级作答"提示，再 +2 次则硬停止
      const degradeReason = sameSignatureCount === REPEAT_TOOL_LIMIT
        ? `已连续 ${sameSignatureCount} 次用相同参数调用「${toolName}」`
        : (isSearchTool(toolName) && searchCallCount === SEARCH_CALL_LIMIT)
          ? `已累计调用 ${searchCallCount} 次搜索工具`
          : '';
      if (degradeReason) {
        console.warn(`[Executor] 重复调用收敛：${degradeReason}，注入降级提示`);
        result.messages.push({
          role: 'user',
          content: `系统提示：${degradeReason}，继续调用不会得到新信息（很可能是命中了搜索缓存或结果无更新）。请立即停止调用该工具，基于已有信息和你的知识直接给出最终答案；如信息不足，请明确说明不确定性并给出最佳估计，不要再搜索、不要再重复调用。`,
        });
      }
      if (sameSignatureCount >= REPEAT_TOOL_LIMIT + 2 || (isSearchTool(toolName) && searchCallCount >= SEARCH_CALL_LIMIT + 2)) {
        console.warn(`[Executor] 重复调用收敛：硬停止（sameSignature=${sameSignatureCount}, searchCalls=${searchCallCount}）`);
        result.stopReason = 'repeat_tool';
        i = maxIterations;
        break;
      }
      console.log(
        `[Executor] 工具结果: ${toolName}`,
        callResult.success ? 'ok' : 'FAIL',
        callResult.error || ''
      );
    }
  }

  // 未显式标记终止原因时补齐（超时 / abort / 迭代上限耗尽）
  if (!result.stopReason) {
    result.stopReason = result.aborted ? 'aborted' : 'max_iterations';
  }

  // 兜底：若 finalContent 为空，强制再调一次 AI 让它给出文字回复
  if (!result.finalContent) {
    try {
      const finalResp = await client.chat.completions.create({
        model,
        messages: [...result.messages, { role: 'user', content: '请根据以上工具返回的结果，给出最终回复。如果工具没有返回有用信息，请说明情况。' }],
        temperature,
        max_tokens: maxTokens,
      }) as OpenAIChatResponse;
      result.finalContent = stripDsmlMarkup(finalResp.choices[0]?.message?.content || '');
      if (finalResp.usage) {
        UsageTracker.record({
          model,
          promptTokens: finalResp.usage.prompt_tokens,
          completionTokens: finalResp.usage.completion_tokens,
          type: 'reply',
        });
      }
    } catch {
      const lastAssistant = [...result.messages].reverse().find((m) => m.role === 'assistant');
      result.finalContent = stripDsmlMarkup(lastAssistant?.content || '');
    }
    // 最终兜底：仍为空时给有意义的文案（而非占位符）
    if (!result.finalContent) {
      result.finalContent = result.aborted
        ? '任务执行超出时限被中断，已完成的进度保留在上下文中。可输入「继续」从断点恢复执行，或把任务拆小一点再试。'
        : 'AI 本次未返回有效内容（可能是上下文过长或模型异常），请稍后重试或简化任务后再试。';
    }
  }

  return result;
}