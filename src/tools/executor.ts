/**
 * executor.ts - 工具调用执行器（类型安全增强版 v1.3.0 P2-1）
 * AI 生成 -> 检测 tool_calls -> 执行工具 -> 把结果喂回 AI -> 重复
 *
 * P2-1: 补充工具执行器的类型守卫
 *   - 全部 any 替换为具体类型或 unknown + 守卫
 *   - AI 响应结构通过类型守卫验证
 *   - 工具参数在传入 registry.execute 前校验
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
  /**
   * AGI 持续执行模式：true 时，AI 输出文字但没调工具时不会立即结束，
   * 而是强制追问"任务是否真的完成？"直到出现明确的完成信号或达到额外追问上限。
   * 解决"干一点就停"的根因——AI 做了一部分后主观判定完成导致回合提前结束。
   * 普通闲聊不开启（避免一问一答变啰嗦）。
   */
  requireCompletion?: boolean;
  onToolCall?: (e: ToolCallEvent) => void;
  onToolResult?: (e: ToolResultEvent) => void;
  onThink?: (thinkChunk: string) => void;
  /** 真流式：工具循环期间实时推送正文 delta（有工具时也能边生成边显示） */
  onChunk?: (chunk: string) => void;
  /**
   * 时序封块：本轮正文已流完、即将执行工具时触发。
   * 前端收到后把当前气泡「封块」（定稿 Markdown、摘光标），
   * 工具卡追加到封块之后；下一轮正文再新建气泡。
   * 这样时间线严格保持「文字 → 工具卡 → 文字 → 工具卡」，不再倒置。
   */
  onSegmentEnd?: () => void;
}

export interface RunToolsResult {
  finalContent: string;
  messages: ChatMessage[];
  toolResults: any[];
  iterations: number;
  aborted: boolean;
  consecutiveErrors?: number;
  /** v2.1: 循环终止原因，供上层（router 断点续跑）判断是否需要自动续跑 */
  stopReason?: 'completed' | 'idle_stop' | 'max_iterations' | 'aborted' | 'tool_failures' | 'ai_errors';
}

// ═══════════════════════════════════════════════
// 工具构建
// ═══════════════════════════════════════════════

export function buildToolsForAgent(registry: ToolRegistry, agentId: string): ToolDefinition[] {
  return registry.listToolsForAgent(agentId);
}

export function buildOpenAITools(tools: ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object",
        properties: t.parameters.properties || {},
        required: t.parameters.required || [],
      },
    },
  }));
}

// ═══════════════════════════════════════════════
// 文本中提取工具调用（容错解析）
// ═══════════════════════════════════════════════

/**
 * 解析后的工具调用（内部表示）
 */
interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * 剥离 DSML 工具调用标记块，保留正常文本
 * 兼容两种变体：单｜ <｜DSML｜｜...> 和 双｜ <｜｜DSML｜｜...>（DeepSeek 系模型偶发输出）
 */
export function stripDsmlMarkup(text: string): string {
  if (!text || !text.includes("DSML")) return text;
  return text
    .replace(/<｜{1,2}DSML｜{1,2}tool_calls>[\s\S]*?<\/｜{1,2}DSML｜{1,2}tool_calls>/g, "")
    .replace(/<｜{1,2}DSML｜{1,2}invoke[\s\S]*?<\/｜{1,2}DSML｜{1,2}invoke>/g, "")
    .replace(/<\/?｜{1,2}DSML｜{1,2}[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 流式增量 DSML 过滤器
 * ─────────────────────────────────────────────
 * 逐 delta 推送正文时，DeepSeek 系模型可能把工具调用标记（<｜DSML｜｜tool_calls>…）
 * 混在正文里流出来，用户会看到一堆裸标记，非常出戏。
 *
 * 难点：标记可能跨多个 chunk（这一帧只到 "<｜DS"，下一帧才补齐），
 * 不能简单地对单帧做 replace。
 *
 * 策略：维护一个未决缓冲区 buf——
 *   1) 先把 buf 里"已闭合"的完整 DSML 块整体删掉；
 *   2) 若 buf 里出现"未闭合"的 DSML 开标记，则只吐出开标记之前的安全前缀，
 *      其余留在 buf 里等后续 chunk 补齐闭合再删；
 *   3) 若 buf 尾部是一个"可能长成 DSML 标记"的半截前缀（如 "<"、"<｜D"），
 *      暂时扣住不吐，避免把标记的开头漏给用户；
 *   4) 流结束时调用 flush()，把残留 buf 用 stripDsmlMarkup 兜底清洗后吐出。
 *
 * 正常正文（不含 <｜ 全角竖线）几乎零延迟直通，只有遇到可能是标记的 "<" 才扣一帧。
 */
export function createStreamDsmlFilter(): { push: (raw: string) => string; flush: () => string } {
  let buf = "";
  // 判断某段文本是否是"可能继续长成 DSML 标记"的半截前缀
  const PARTIAL = /^<｜{0,2}(?:D(?:S(?:M(?:L(?:｜{0,2})?)?)?)?)?$/;
  const stripComplete = (s: string) =>
    s
      .replace(/<｜{1,2}DSML｜{1,2}tool_calls>[\s\S]*?<\/｜{1,2}DSML｜{1,2}tool_calls>/g, "")
      .replace(/<｜{1,2}DSML｜{1,2}invoke[\s\S]*?<\/｜{1,2}DSML｜{1,2}invoke>/g, "");
  return {
    push(raw: string): string {
      if (!raw) return "";
      buf += raw;
      buf = stripComplete(buf);
      // 出现未闭合开标记 → 只吐标记之前的安全前缀
      const openMatch = /<｜{1,2}DSML｜{1,2}/.exec(buf);
      if (openMatch && typeof openMatch.index === "number") {
        const safe = buf.slice(0, openMatch.index);
        buf = buf.slice(openMatch.index);
        // 把残留里已完整的简单标签也清掉（例如已闭合的 invoke 尾标签）
        buf = buf.replace(/<\/?｜{1,2}DSML｜{1,2}[^>]*>/g, "");
        // 若清理后 buf 不再以开标记开头，说明是可释放的普通文本
        if (!/<｜{1,2}DSML｜{1,2}/.test(buf)) {
          const rest = buf;
          buf = "";
          return safe + rest;
        }
        return safe;
      }
      // 无开标记：扣住尾部"可能是标记半截前缀"的部分，其余全部吐出
      const lt = buf.lastIndexOf("<");
      if (lt !== -1 && PARTIAL.test(buf.slice(lt))) {
        const safe = buf.slice(0, lt);
        buf = buf.slice(lt);
        return safe;
      }
      const out = buf;
      buf = "";
      return out;
    },
    flush(): string {
      const rest = stripDsmlMarkup(buf);
      buf = "";
      return rest;
    },
  };
}

/**
 * 判断 AI 的输出是否带有明确的"完成任务"信号
 * 用于持续执行模式：只有当 AI 明确宣告完成时才允许结束回合。
 *
 * v2.1 收紧完成信号（防进度汇报误判）：
 *  1) 完成声明必须出现在文本结尾（最后 200 字符内或最后一段），
 *     避免文中出现"步骤1已完成"就误判整个任务完成；
 *  2) 声明之后不得再出现"接下来/下一步/现在开始"等继续意图，否则视为进度汇报；
 *  3) 反问/请示一律不算完成（原 askingPatterns 是死代码——done 命中直接 return true，
 *     永远走不到 asking 分支；现在 asking 真正生效）。
 */
export function isCompletionSignal(content: string): boolean {
  if (!content) return false;
  const t = content.trim();
  if (!t) return false;

  // 明确完成信号
  const donePatterns = [
    /(任务|工作|全部|所有|目标)(已经|已|均已|都)(完成|做完|搞定|结束|处理完|执行完)/,
    /任务完成/,
    /全部完成/,
    /已全部完成/,
    /均已完成/,
    /(?:所有|全部)验收(?:标准|条件)(?:已|均已)?(?:满足|达到|完成)/,
    /(?:done|completed|finished|all done)\.?\s*$/i,
  ];

  // 找到完成声明"最后一次"出现的结束位置（文中可能多次提及，以结尾处为准）
  let lastMatchEnd = -1;
  for (const p of donePatterns) {
    const flags = p.flags.includes('g') ? p.flags : p.flags + 'g';
    const gp = new RegExp(p.source, flags);
    let m: RegExpExecArray | null;
    while ((m = gp.exec(t)) !== null) {
      const end = m.index + m[0].length;
      if (end > lastMatchEnd) lastMatchEnd = end;
      if (m.index === gp.lastIndex) gp.lastIndex++;
    }
  }
  if (lastMatchEnd < 0) return false;

  // ── 要求 1：声明必须出现在文本结尾（最后 200 字符内，或落在最后一段里）──
  const paras = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const lastPara = paras.length > 0 ? paras[paras.length - 1] : '';
  const lastParaStart = lastPara ? t.lastIndexOf(lastPara) : -1;
  const inLast200 = t.length - lastMatchEnd <= 200;
  const inLastPara = lastParaStart >= 0 && lastMatchEnd >= lastParaStart && lastMatchEnd <= lastParaStart + lastPara.length;
  if (!inLast200 && !inLastPara) return false;

  // ── 要求 2：声明之后不得有继续意图（否则是进度汇报，不是完成声明）──
  const after = t.slice(lastMatchEnd);
  const continueIntent = /(接下来|下一步|现在(?:开始|去|执行|做|进行|继续|处理)|然后(?:继续|再|开始)|稍后|待会|回头|后续(?:还|我|会)|我将|我会|我准备|我打算|还需要|还需|继续(?:做|执行|推进|完成|处理)|还要(?:做|继续)|开始(?:执行|做|处理)|马上(?:开始|执行)|立刻(?:开始|执行))/;
  if (continueIntent.test(after)) return false;

  // ── 要求 3：反问/请示（这些不是完成，是停下来等用户）──
  const askingPatterns = [
    /(需要我|要我|是否需要|要不要)(继续|接着|下一步)/,
    /(还需要|还需要做什么|还有什么需要)/,
    /是否(需要|要我)/,
    /\?\s*$/,
  ];
  for (const p of askingPatterns) {
    if (p.test(t)) return false;
  }
  return true;
}

/**
 * v2.1: 检测 AI 是否在"问用户要不要继续"而非干活
 * 这类输出是"停下来等用户回复"的典型模式，需要强力推送工具指令
 */
function isAskingUserToContinue(content: string): boolean {
  if (!content) return false;
  const t = content.trim();
  const askPatterns = [
    /(需要我|要我|是否需要|要不要)(继续|接着|下一步|做)/,
    /(还需要|还需要做什么|还有什么需要)/,
    /是否(需要|要我|可以)/,
    /(请告诉我|请确认|请选择|请回复)/,
    /(等你|等待你的|等你的)(回复|指示|确认)/,
    /(接下来|下一步)(做什么|怎么办|怎么处理)/,
  ];
  return askPatterns.some(p => p.test(t));
}

/**
 * 从 AI 的 content 文本里提取工具调用
 * 支持格式：[{"name":"x","arguments":{...}}]
 */
function extractToolCallsFromText(content: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  const trimmed = content.trim();

  // 直接是 JSON 数组
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0) {
      for (const item of parsed) {
        if (!isRecord(item)) continue;
        if (!item.name || typeof item.name !== "string") continue;
        // arguments 可能是字符串或对象
        let args: Record<string, unknown>;
        if (typeof item.arguments === "string") {
          const parsed2 = safeJsonParse(item.arguments);
          if (!parsed2) continue;
          args = parsed2;
        } else if (isRecord(item.arguments)) {
          args = item.arguments;
        } else {
          continue;
        }
        results.push({
          id: typeof item.id === "string" ? item.id : "call-" + Math.random().toString(36).slice(2),
          name: item.name,
          arguments: args,
        });
      }
      if (results.length > 0) return results;
    }
  } catch { /* not bare JSON array */ }

  // <|tool_call|> 标记后的 JSON
  const markerMatch = trimmed.match(/<\|tool_call\|>([\s\S]*)/);
  if (markerMatch) {
    try {
      const parsed = JSON.parse(markerMatch[1].trim());
      if (isRecord(parsed) && isRecord(parsed.arguments) && typeof parsed.name === "string") {
        results.push({
          id: "call-" + Math.random().toString(36).slice(2),
          name: parsed.name,
          arguments: parsed.arguments,
        });
        return results;
      }
    } catch { /* ignore */ }
  }

    // DSML 标记格式（DeepSeek V4 偶尔输出）：<｜｜DSML｜｜tool_calls> <｜｜DSML｜｜invoke name="xxx"> ...
  // 兼容单｜/双｜两种变体
  const dsmlRegex = /<｜{1,2}DSML｜{1,2}invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}invoke>/g;
  let dsmlMatch: RegExpExecArray | null;
  while ((dsmlMatch = dsmlRegex.exec(trimmed)) !== null) {
    const toolName = dsmlMatch[1];
    const inner = dsmlMatch[2];
    const args: Record<string, unknown> = {};
        // 提取 <｜｜DSML｜｜parameter name="xxx" string="true">value</...>（兼容单｜/双｜变体）
    const paramRegex = /<｜{1,2}DSML｜{1,2}parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜{1,2}DSML｜{1,2}parameter>/g;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramRegex.exec(inner)) !== null) {
      args[pMatch[1]] = pMatch[2].trim();
    }
    results.push({
      id: "call-" + Math.random().toString(36).slice(2),
      name: toolName,
      arguments: args,
    });
  }
  if (results.length > 0) return results;

  // 全局搜索所有 {name, arguments} 对象
  const objRegex = /\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:(\{[\s\S]*?\}|\[[\s\S]*?\]|"[^"]*")[\s\S]*?\}/g;
  let match: RegExpExecArray | null;
  while ((match = objRegex.exec(trimmed)) !== null) {
    try {
      const name = match[1];
      const argsRaw = match[2];
      const args = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
      if (!isRecord(args)) continue;
      results.push({
        id: "call-" + Math.random().toString(36).slice(2),
        name,
        arguments: args,
      });
    } catch { /* ignore bad match */ }
    if (results.length >= 5) break;
  }

  return results;
}

/**
 * 类型守卫：验证对象是合法的 ParsedToolCall
 */
function isValidParsedToolCall(obj: unknown): obj is ParsedToolCall {
  if (!isRecord(obj)) return false;
  if (typeof obj.id !== "string" || obj.id.length === 0) return false;
  if (typeof obj.name !== "string" || obj.name.length === 0) return false;
  if (!isRecord(obj.arguments)) return false;
  return true;
}

// ═══════════════════════════════════════════════
// 主循环
// ═══════════════════════════════════════════════

/**
 * 工具调用主循环（类型安全增强版）
 *
 * P2-1 改进：
 *  - aiResponse 不再用 any，使用 OpenAIChatResponse 类型
 *  - tool_calls 通过 isToolCallInMessage 逐个验证
 *  - 工具参数解析通过 safeJsonParse + isRecord 校验
 *  - 不再使用 as any 强制类型转换
 */
/**
 * 发起一次补全请求：有 onChunk 时优先真流式（stream:true），
 * 实时回调正文/推理 delta，结束后把 delta 重组成与非流式一致的
 * OpenAIChatResponse 结构，保证下游 tool_calls 解析逻辑完全不变。
 * 无 onChunk 或流式不可用时，自动回退到非流式一次性请求。
 */
async function requestCompletion(
  client: any,
  requestParams: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onChunk: ((chunk: string) => void) | undefined,
  onThink: ((t: string) => void) | undefined,
): Promise<OpenAIChatResponse> {
  if (!onChunk) {
    return await client.chat.completions.create(requestParams, signal ? { signal } : undefined) as OpenAIChatResponse;
  }
  let emitted = false;
  try {
    const stream = await client.chat.completions.create(
      { ...requestParams, stream: true },
      signal ? { signal } : undefined,
    ) as any;

    let content = '';
    let reasoning = '';
    let usage: any = undefined;
    const acc: Record<number, { id: string; name: string; args: string }> = {};
    // ⭐ 流式增量剥 DSML：正文 delta 先过过滤器再推给前端，避免裸标记闪现
    const dsmlFilter = createStreamDsmlFilter();

    for await (const chunk of stream) {
      const ch = chunk?.choices?.[0];
      const delta: any = ch?.delta || {};
      const r = delta.reasoning_content ?? delta.reasoning;
      if (r) { reasoning += r; emitted = true; if (onThink) onThink(r); }
      if (delta.content) {
        content += delta.content; // 原始累积（供后续 tool_calls 文本解析，不能剥）
        emitted = true;
        if (onChunk) {
          const safe = dsmlFilter.push(delta.content);
          if (safe) onChunk(safe);
        }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (!acc[idx]) acc[idx] = { id: '', name: '', args: '' };
          if (tc.id) acc[idx].id = tc.id;
          if (tc.function?.name) acc[idx].name += tc.function.name;
          if (tc.function?.arguments) acc[idx].args += tc.function.arguments;
        }
      }
      if ((delta as any).function_call) {
        if (!acc[0]) acc[0] = { id: '', name: '', args: '' };
        if ((delta as any).function_call.name) acc[0].name += (delta as any).function_call.name;
        if ((delta as any).function_call.arguments) acc[0].args += (delta as any).function_call.arguments;
      }
      if (chunk?.usage) usage = chunk.usage;
    }
    // ⭐ 流结束：把过滤器里扣住的尾巴（非标记的普通残留）补吐给前端
    if (onChunk) {
      const tail = dsmlFilter.flush();
      if (tail) onChunk(tail);
    }

    const idxs = Object.keys(acc).map(Number).sort((a, b) => a - b);
    const tool_calls = idxs.length > 0
      ? idxs.map((k) => ({
          id: acc[k].id || ('call-' + Math.random().toString(36).slice(2)),
          type: 'function' as const,
          function: { name: acc[k].name, arguments: acc[k].args },
        }))
      : undefined;
    const message: any = { role: 'assistant', content: content || null, __streamed: true };
    if (reasoning) message.reasoning_content = reasoning;
    if (tool_calls) message.tool_calls = tool_calls;
    return { choices: [{ message }], usage } as unknown as OpenAIChatResponse;
  } catch (streamErr: unknown) {
    // 已吐出部分 delta 再失败，不能回退（会重复），直接抛给外层
    if (emitted) throw streamErr;
    // 流式不支持（部分 provider / 模型）→ 回退非流式
    console.warn('[Executor] 流式请求失败，回退非流式:', (streamErr as Error)?.message || streamErr);
    return await client.chat.completions.create(requestParams, signal ? { signal } : undefined) as OpenAIChatResponse;
  }
}

export async function runToolsLoop(options: RunToolsOptions): Promise<RunToolsResult> {
  const {
    client,
    model,
    messages,
    registry,
    agentId,
    chatId,
    maxIterations = 50,
    temperature = 0.7,
    maxTokens = 16384,
    signal,
    requireCompletion = false,
    forceComplete = false,
    onToolCall,
    onToolResult,
    onThink,
    onChunk,
    onSegmentEnd,
  } = options;

  const result: RunToolsResult = {
    finalContent: "",
    messages: [...messages],
    toolResults: [],
    iterations: 0,
    aborted: false,
  };

  // ⭐ 连续工具失败计数器：防止 AI 反复尝试失败的工具导致死循环
  let consecutiveToolFailures = 0;
  // AGI 持续执行：AI 连续 N 轮只出文字不调工具时，判定为"确实完成"才停（防止无限追问）
  // v2.1 放宽空闲容忍：任务模式下默认 3 → 8（env MAX_IDLE_ROUNDS 可覆盖）。
  // 用户反馈"干活老是停下来问要不要继续"，3 轮太少——AI 写两轮汇报文字就被判完成退出；
  // 8 轮给足空间让 AI 自主完成多步骤任务。
  const MAX_IDLE_ROUNDS = requireCompletion
    ? Math.max(3, parseInt(process.env.MAX_IDLE_ROUNDS || '8', 10))
    : 3;
  let idleRounds = 0;

  const availableTools = buildToolsForAgent(registry, agentId);
  const openaiTools = availableTools.length > 0 ? buildOpenAITools(availableTools) : undefined;

  for (let i = 0; i < maxIterations; i++) {
    result.iterations = i + 1;

    if (signal?.aborted) {
      result.aborted = true;
      result.stopReason = 'aborted';
      break;
    }

    // ⭐ v2.1 上下文滑窗：循环内上下文逼近上限时，用摘要模型压缩早期工具结果，
    // 防长任务爆上下文（每 3 轮检查一次，减少开销；失败不阻塞主流程）
    if (i > 0 && i % 3 === 0) {
      try {
        const estTokens = estimateMessagesTokens(result.messages);
        const CONTEXT_TOKEN_LIMIT = parseInt(process.env.EXECUTOR_CONTEXT_MAX_TOKENS || '40000', 10);
        if (estTokens > CONTEXT_TOKEN_LIMIT) {
          const KEEP_RECENT_TOOLS = 6; // 最近 6 条工具结果保持原样
          const toolIdxs: number[] = [];
          result.messages.forEach((m, idx) => { if (m.role === 'tool') toolIdxs.push(idx); });
          const compressible = toolIdxs
            .slice(0, Math.max(0, toolIdxs.length - KEEP_RECENT_TOOLS))
            .filter(idx => {
              const c = result.messages[idx].content || '';
              return c.length > 800 && !c.startsWith('[已压缩]');
            })
            .slice(0, 6); // 单次最多压 6 条，摊薄延迟
          for (const idx of compressible) {
            const m = result.messages[idx];
            const rawContent = m.content || '';
            try {
              const resp = await client.chat.completions.create({
                model: options.summaryModel || model,
                messages: [{
                  role: 'user',
                  content: `请把以下工具执行结果压缩成简洁摘要，保留关键数据、路径、结论与错误信息。限 300 字以内。\n\n工具: ${m.name || ''}\n结果:\n${rawContent.slice(0, 6000)}`,
                }],
                temperature: 0.2,
                max_tokens: 500,
              }, signal ? { signal } : undefined) as OpenAIChatResponse;
              const summarized = resp.choices[0]?.message?.content || rawContent.slice(0, 400);
              if (resp.usage) {
                UsageTracker.record({ model, promptTokens: resp.usage.prompt_tokens, completionTokens: resp.usage.completion_tokens, type: 'summary' });
              }
              m.content = `[已压缩] ${summarized}`;
            } catch {
              m.content = `[已压缩] ${rawContent.slice(0, 400)}...[截断]`;
            }
          }
          if (compressible.length > 0) {
            console.log(`[Executor] 上下文滑窗: 估算 ${estTokens} tokens > ${CONTEXT_TOKEN_LIMIT}，已压缩 ${compressible.length} 条早期工具结果`);
          }
        }
      } catch (e: unknown) {
        console.warn('[Executor] 上下文滑窗压缩失败(非致命):', (e as Error)?.message || e);
      }
    }

    // 调用 AI
    const requestParams: Record<string, unknown> = {
      model,
      messages: result.messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (openaiTools) {
      requestParams.tools = openaiTools;
      requestParams.tool_choice = "auto";
    }

    let aiResponse: OpenAIChatResponse;
    try {
      aiResponse = await requestCompletion(client, requestParams, signal, onChunk, onThink) as OpenAIChatResponse;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Executor] AI 调用失败 (iteration ${i + 1}):`, errMsg);
      result.consecutiveErrors = (result.consecutiveErrors || 0) + 1;
      if (result.consecutiveErrors >= 5) {
        result.finalContent = `AI 调用连续失败 5 次: ${errMsg}。请检查 API Key 和网络连接。`;
        result.stopReason = 'ai_errors';
        break;
      }
      const errMsg2: ChatMessage = {
        role: "user",
        content: `系统提示：AI 调用失败 (${errMsg.substring(0, 200)})。请换一种方式回答，或告诉用户遇到了什么问题。`,
      };
      result.messages.push(errMsg2);
      continue;
    }
    result.consecutiveErrors = 0;

    // 统计 token
    if (aiResponse.usage) {
      UsageTracker.record({
        model,
        promptTokens: aiResponse.usage.prompt_tokens,
        completionTokens: aiResponse.usage.completion_tokens,
        type: "tool",
      });
    }

    const choice = aiResponse.choices[0];
    const assistantMsg = choice.message;

    // 提取推理/思考过程（DeepSeek-R1/o1/GPT-5 等推理模型会返回）
    const reasoningContent = (assistantMsg as any)?.reasoning_content ?? (assistantMsg as any)?.reasoning;
    if (reasoningContent && onThink && !(assistantMsg as any).__streamed) {
      onThink(reasoningContent);
    }

    // 把 AI 回复加入历史
    const assistantEntry: ChatMessage = {
      role: "assistant",
      content: assistantMsg.content ?? "",
    };

    // ── 提取工具调用 (3 层 fallback) ──

    let toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

    // 优先：标准 tool_calls
    if (Array.isArray(assistantMsg.tool_calls)) {
      const validCalls = assistantMsg.tool_calls.filter(isToolCallInMessage);
      if (validCalls.length > 0) {
        toolCalls = validCalls;
      }
    }

    // Fallback A: 旧格式 function_call（通过类型守卫验证）
    if (toolCalls.length === 0 && assistantMsg.function_call) {
      const fc = assistantMsg.function_call;
      const name = fc.name || fc.tool_name || "";
      if (name.length > 0) {
        toolCalls = [{
          id: "call-" + Math.random().toString(36).slice(2),
          type: "function",
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
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        // ⭐ 剥离 DSML 标记后再写入历史，避免模型下一轮看到自己的标记持续模仿
        if (assistantMsg.content.includes("DSML")) {
          assistantEntry.content = stripDsmlMarkup(assistantMsg.content);
        }
      }
    }

    // 没有工具调用，AI 给出了最终回复
    if (toolCalls.length === 0) {
      const textContent = stripDsmlMarkup(assistantMsg.content || "");
      result.messages.push(assistantEntry);

      // ⭐ AGI 持续执行：任务模式（requireCompletion=true）下，AI 只出文字不调工具时，
      // 先判断是否真的"完成"了——含明确完成信号才停；否则注入追问强制继续。
      // 这是解决"干一点就停"的核心：不能把"AI 这轮没调工具"当成"任务完成"。
      if (requireCompletion && !isCompletionSignal(textContent) && idleRounds < MAX_IDLE_ROUNDS) {
        idleRounds += 1;
        // v2.1 强化 nudge：(a) 检测到 AI 在问用户"要不要继续"时用最强力措辞；
        // (b) 其余轮次降低提醒频率——第 1/2 轮及偶数轮给完整提醒，奇数轮只给短促提示，
        //     避免 token 浪费在重复长提示上
        const isAsking = isAskingUserToContinue(textContent);
        let nudge: string;
        if (isAsking) {
          nudge = `系统提示：你刚才在问用户"要不要继续"——这是禁止的。不要问，直接调用工具继续干活。任务还没完成，立即执行下一步，不许停。`;
        } else if (idleRounds === 1) {
          nudge = "系统提示：任务还没完成，不要回复文字就停。请直接调用工具继续执行剩余步骤。不要问我要不要继续，直接做。";
        } else if (idleRounds === 2 || idleRounds % 2 === 0) {
          nudge = `系统提示：任务仍未完成（已提醒 ${idleRounds} 次）。请不要解释、不要汇报、不要问问题，直接调用工具执行下一步。如果你认为确实做完了，请明确输出"任务完成"并说明已满足的条件（声明之后不要再写"接下来/下一步"等后续计划）；否则立即调用工具。`;
        } else {
          nudge = "系统提示：继续执行任务剩余步骤，直接调用工具，不要停。";
        }
        result.messages.push({ role: "user", content: nudge } as ChatMessage);
        console.log(`[Executor] 持续执行：AI 未调工具且未声明完成（idleRounds=${idleRounds}/${MAX_IDLE_ROUNDS}${isAsking ? ', 检测到问用户' : ''}），注入追问继续`);
        continue;
      }

      result.finalContent = textContent;
      // v2.1: 区分"确认完成"与"提醒达上限后强停"（后者上层可触发断点续跑提示）
      result.stopReason = (requireCompletion && !isCompletionSignal(textContent)) ? 'idle_stop' : 'completed';
      break;
    }

    // 记录 tool_calls（已验证过的条目）
    assistantEntry.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));
    result.messages.push(assistantEntry);

    // ⭐ 时序封块：本轮正文已流完且要开始调工具了，通知前端把当前气泡定稿，
    //    随后的 tool.call 卡片会追加到封块之后，保证时间线正确。
    if (onChunk && onSegmentEnd) onSegmentEnd();

    // ── 执行所有工具调用 ──
    // v1.5.0: 注入上下文给子程序
    if (chatId) setDelegateContext(agentId, chatId, registry);

    for (const tc of toolCalls) {
      const toolName = tc.function.name;

      // 类型守卫：安全解析 tool arguments
      let toolArgs: Record<string, unknown> = {};
      const parsed = safeJsonParse(tc.function.arguments);
      if (parsed) {
        toolArgs = parsed;
      }

      console.log(`[Executor] 调用工具: ${toolName}`, JSON.stringify(toolArgs).slice(0, 200));
      if (onToolCall) onToolCall({
        chatId: chatId || "",
        agentId,
        toolCallId: tc.id,
        toolName,
        args: toolArgs,
        description: (availableTools.find((t) => t.name === toolName)?.description || registry.getTool(toolName)?.description || ""),
        timestamp: Date.now(),
      });

      // 构建合法的 ToolCallRequest
      const toolRequest: ToolCallRequest = {
        id: tc.id,
        name: toolName,
        arguments: toolArgs,
      };

      const callResult: ToolCallResult = await registry.execute(toolRequest);
      result.toolResults.push(callResult);

      // ⭐ 连续工具失败检测：工具连续失败 3 次则停止循环，避免死循环卡住
      if (!callResult.success) {
        consecutiveToolFailures++;
        const FAIL_LIMIT = forceComplete ? 20 : 6;
      if (consecutiveToolFailures >= FAIL_LIMIT) {
          console.warn(`[Executor] 工具连续失败 ${consecutiveToolFailures} 次，停止循环`);
          result.finalContent = `工具连续失败 ${consecutiveToolFailures} 次，已停止执行。最后错误: ${callResult.error || '未知'}。建议换一种方式或拆小任务重试。`;
          result.stopReason = 'tool_failures';
          i = maxIterations; // 强制退出外层循环
          break; // 退出内层循环
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
        chatId: chatId || "",
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
      const resultPayload = callResult.success
        ? callResult.result
        : { error: callResult.error };
      let resultContent = JSON.stringify(resultPayload);

      // 如果结果超 2000 字符，用 AI 摘要（但 read_file 除外——文件内容必须原样返回）
      // P2-5: 统一截断阈值 6000，更早介入摘要避免大结果占满上下文
    if (resultContent.length > 6000 && callResult.success && toolName !== 'read_file' && toolName !== 'list_dir' && toolName !== 'shell_exec' && toolName !== 'patch_file') {
        try {
          // P1-6: 摘要优先用轻量 summaryModel
          const summaryModelName = options.summaryModel || model;
          const summaryResp = await client.chat.completions.create({
            model: summaryModelName,
            messages: [{
              role: "user",
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
              type: "summary",
            });
          }
          console.log(`[Executor] 工具结果已摘要: ${resultContent.length} ← ${JSON.stringify(resultPayload).length} 字符`);
        } catch {
          resultContent = resultContent.slice(0, 4000) + "\n...[结果已截断]";
        }
      }

      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: tc.id,
        name: toolName,
        content: resultContent,
      };
      result.messages.push(toolMessage);

      console.log(
        `[Executor] 工具结果: ${toolName}`,
        callResult.success ? "ok" : "FAIL",
        callResult.error || ""
      );
    }
  }

  // v2.1: 未显式标记终止原因时补齐（超时 abort / 迭代上限耗尽）
  if (!result.stopReason) {
    result.stopReason = result.aborted ? 'aborted' : 'max_iterations';
  }

  // 兜底
  if (!result.finalContent) {
    // 兜底：强制再调一次 AI（不带 tools），让它必须出文字回复
    try {
      const finalResp = await client.chat.completions.create({
        model,
        messages: [...result.messages, { role: "user", content: "请根据以上工具返回的结果，给出最终回复。如果工具没有返回有用信息，请说明情况。" }],
        temperature,
        max_tokens: maxTokens,
      }) as OpenAIChatResponse;
      result.finalContent = stripDsmlMarkup(finalResp.choices[0]?.message?.content || "");
      if (finalResp.usage) {
        UsageTracker.record({
          model,
          promptTokens: finalResp.usage.prompt_tokens,
          completionTokens: finalResp.usage.completion_tokens,
          type: "reply",
        });
      }
    } catch {
      const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant");
      result.finalContent = stripDsmlMarkup(lastAssistant?.content || "");
    }
    // 最终兜底：仍为空时给有意义的文案（而非占位符），区分超时中断与空回复
    if (!result.finalContent) {
      result.finalContent = result.aborted
        ? "任务执行超出时限被中断，已完成的进度保留在上下文中。可输入「继续」从断点恢复执行，或把任务拆小一点再试。"
        : "AI 本次未返回有效内容（可能是上下文过长或模型异常），请稍后重试或简化任务后再试。";
    }
  }

  return result;
}
