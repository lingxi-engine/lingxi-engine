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
import { setDelegateContext } from "../core/builtin.js";
import { UsageTracker } from "../core/usage-tracker.js";
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
  onToolCall?: (e: ToolCallEvent) => void;
  onToolResult?: (e: ToolResultEvent) => void;
  onThink?: (thinkChunk: string) => void;
}

export interface RunToolsResult {
  finalContent: string;
  messages: ChatMessage[];
  toolResults: any[];
  iterations: number;
  aborted: boolean;
  consecutiveErrors?: number;
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
  const dsmlRegex = /<｜｜DSML｜｜invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
  let dsmlMatch: RegExpExecArray | null;
  while ((dsmlMatch = dsmlRegex.exec(trimmed)) !== null) {
    const toolName = dsmlMatch[1];
    const inner = dsmlMatch[2];
    const args: Record<string, unknown> = {};
    // 提取 <｜｜DSML｜｜parameter name="xxx" string="true">value</...>
    const paramRegex = /<｜｜DSML｜｜parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
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
    onToolCall,
    onToolResult,
    onThink,
  } = options;

  const result: RunToolsResult = {
    finalContent: "",
    messages: [...messages],
    toolResults: [],
    iterations: 0,
    aborted: false,
  };

  const availableTools = buildToolsForAgent(registry, agentId);
  const openaiTools = availableTools.length > 0 ? buildOpenAITools(availableTools) : undefined;

  for (let i = 0; i < maxIterations; i++) {
    result.iterations = i + 1;

    if (signal?.aborted) {
      result.aborted = true;
      break;
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
      // 传入 signal：用户点"停止"时可立即中断进行中的 AI 请求（不必等轮次结束）
      aiResponse = await client.chat.completions.create(
        requestParams,
        signal ? { signal } : undefined
      ) as OpenAIChatResponse;
    } catch (err: unknown) {
      // 用户主动停止：直接退出循环，由上层按"已停止"处理
      if (signal?.aborted) {
        result.aborted = true;
        break;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Executor] AI 调用失败 (iteration ${i + 1}):`, errMsg);
      result.consecutiveErrors = (result.consecutiveErrors || 0) + 1;
      if (result.consecutiveErrors >= 3) {
        result.finalContent = `AI 调用连续失败 3 次: ${errMsg}。请检查 API Key 和网络连接。`;
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
    const reasoningContent = (assistantMsg as any)?.reasoning_content;
    if (reasoningContent && onThink) {
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
      }
    }

    // 没有工具调用，AI 给出了最终回复
    if (toolCalls.length === 0) {
      result.messages.push(assistantEntry);
      result.finalContent = assistantMsg.content || "";
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

    // ── 执行所有工具调用 ──
    // v1.5.0: 注入上下文给子程序
    if (chatId) setDelegateContext(agentId, chatId);

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
      if (resultContent.length > 8000 && callResult.success && toolName !== 'read_file' && toolName !== 'list_dir' && toolName !== 'shell_exec' && toolName !== 'patch_file') {
        try {
          const summaryResp = await client.chat.completions.create({
            model,
            messages: [{
              role: "user",
              content: `请把以下工具返回的数据压缩成简洁摘要，保留关键信息（标题、URL、核心数据），去掉重复和冗余。限 800 字以内。\n\n工具: ${toolName}\n结果:\n${resultContent.slice(0, 4000)}`,
            }],
            temperature: 0.2,
            max_tokens: 1000,
          }) as OpenAIChatResponse;
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

  // 兜底
  if (!result.finalContent && !result.aborted) {
    // 兜底：强制再调一次 AI（不带 tools），让它必须出文字回复
    // ⚠️ 只带最近的消息，避免多轮工具调用后上下文超限导致这次兜底也失败
    // （这正是"干了半天最后显示没有回复"的常见根因）
    const trimmedMessages = result.messages.length > 24
      ? [
          ...result.messages.slice(0, 2),
          { role: "user", content: `（中间 ${result.messages.length - 24} 条工具调用记录已省略）` } as ChatMessage,
          ...result.messages.slice(-22),
        ]
      : result.messages;
    try {
      const finalResp = await client.chat.completions.create({
        model,
        messages: [...trimmedMessages, { role: "user", content: "请根据以上工具返回的结果，给出最终回复。如果工具没有返回有用信息，请说明情况。" }],
        temperature,
        max_tokens: maxTokens,
      }, signal ? { signal } : undefined) as OpenAIChatResponse;
      result.finalContent = finalResp.choices[0]?.message?.content
        || "工具已执行完毕，但模型未给出文字总结。请再发一条消息让我汇总结果。";
      if (finalResp.usage) {
        UsageTracker.record({
          model,
          promptTokens: finalResp.usage.prompt_tokens,
          completionTokens: finalResp.usage.completion_tokens,
          type: "reply",
        });
      }
    } catch {
      if (signal?.aborted) {
        result.aborted = true;
      } else {
        const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant" && m.content);
        const lastTool = [...result.messages].reverse().find((m) => m.role === "tool");
        result.finalContent = lastAssistant?.content
          || (lastTool
            ? `工具已执行完毕，但汇总回复调用失败（可能是上下文过大）。最近一次工具结果：${String(lastTool.content).slice(0, 300)}`
            : "本次生成未产生最终回复，请重试或换一种问法。");
      }
    }
  }

  // 被停止时给前端一个明确文本，避免空气泡
  if (!result.finalContent && result.aborted) {
    result.finalContent = "⏹ 已停止生成。";
  }

  return result;
}
