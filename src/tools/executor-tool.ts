/**
 * executor-tool.ts - executor 的 ITool 封装（受控工具调用路径）
 *
 * 把 runToolsLoop 的能力收敛成标准工具实例，走 ToolBase/ITool 流程：
 *   validate → dryRun → execute
 *
 * 能力：
 *   - validate: 参数校验（task 必填、数值范围检查）
 *   - dryRun:   无副作用预演，返回将执行的迭代预算与工具集
 *   - execute:  尊重 input.signal（AbortSignal），abort 时抛出明确错误
 *               try/catch 错误分类（abort/timeout/cancel/unknown）+ 日志
 *
 * 注册方式（启动入口 index.ts）：
 *   registry.registerToolInstance({ name: 'executor', parameters: {...} }, new ExecutorTool());
 */

import type { ToolDefinition, ToolCallRequest, ToolCallResult } from "./types.js";
import { runToolsLoop, type RunToolsOptions, type RunToolsResult } from "./executor.js";
import type { ToolRegistry } from "./registry.js";

// ═══════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════

/** 暴露给 Agent 的参数面（AI 可控部分） */
export interface ExecutorToolInput {
  /** 目标描述（喂给 AI 的任务指令） */
  task: string;
  /** 指定 agent 身份（技能绑定决定可用工具集） */
  agentId?: string;
  /** 最大迭代轮数，默认 50 */
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /** force_complete 模式：工具连续失败上限放宽到 20 */
  forceComplete?: boolean;
  /** AGI 持续执行模式：AI 只出文字不调工具时强制追问完成 */
  requireCompletion?: boolean;
}

/** execute 的完整上下文（由调用方注入，AI 不可控） */
export interface ExecutorToolContext {
  /** AI 客户端（OpenAI 兼容） */
  client: any;
  /** 模型名 */
  model: string;
  /** 工具注册中心（用于推导可用工具） */
  registry: ToolRegistry;
  /** agentId 兜底（input 未指定时使用） */
  agentId?: string;
  /** 会话 ID（子代理委派上下文注入用） */
  chatId?: string;
  /** 摘要专用轻量模型 */
  summaryModel?: string;
  /** AbortSignal，abort 时 execute 抛出明确错误 */
  signal?: AbortSignal;
  /** 事件回调透传 */
  onToolCall?: RunToolsOptions["onToolCall"];
  onToolResult?: RunToolsOptions["onToolResult"];
  onThink?: RunToolsOptions["onThink"];
}

/** 错误分类 */
export type ExecutorErrorKind = "abort" | "timeout" | "cancel" | "unknown";

/** 带分类的执行错误 */
export class ExecutorToolError extends Error {
  readonly kind: ExecutorErrorKind;
  constructor(kind: ExecutorErrorKind, message: string) {
    super(message);
    this.name = "ExecutorToolError";
    this.kind = kind;
  }
}

/** dryRun 预演结果 */
export interface ExecutorDryRunResult {
  aborted: boolean;
  plannedIterations: number;
  toolsAvailable: number;
  toolNames: string[];
  notes: string[];
}

/** execute 的返回（在 RunToolsResult 基础上补充错误分类信息） */
export interface ExecutorExecuteResult extends RunToolsResult {
  errorKind?: ExecutorErrorKind;
}

// ═══════════════════════════════════════════════
// 工具定义（OpenAI function 格式的参数面）
// ═══════════════════════════════════════════════

export const EXECUTOR_TOOL_DEFINITION: ToolDefinition = {
  name: "executor",
  description:
    "Run an autonomous multi-step task loop: the AI plans, calls tools, feeds results back and iterates until the task is done. Use for complex goals that need multiple tool calls.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Task goal description (fed to the AI as instruction)" },
      agentId: { type: "string", description: "Agent identity whose skills determine available tools" },
      maxIterations: { type: "number", description: "Max loop iterations (default 50)" },
      temperature: { type: "number", description: "Sampling temperature (default 0.7)" },
      maxTokens: { type: "number", description: "Max tokens per AI call (default 16384)" },
      forceComplete: { type: "boolean", description: "Relax failure limit to 20 consecutive tool errors (default false)" },
      requireCompletion: { type: "boolean", description: "Keep nudging AI until explicit completion signal (default false)" },
    },
    required: ["task"],
  },
};

// ═══════════════════════════════════════════════
// 校验
// ═══════════════════════════════════════════════

/** 校验输入，返回错误消息列表（空数组 = 通过） */
export function validateExecutorInput(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return ["input 必须是对象"];
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.task !== "string" || obj.task.trim().length === 0) {
    errors.push("task 必须是非空字符串");
  }
  if (obj.agentId !== undefined && (typeof obj.agentId !== "string" || obj.agentId.length === 0)) {
    errors.push("agentId 必须是非空字符串");
  }
  if (obj.maxIterations !== undefined) {
    if (typeof obj.maxIterations !== "number" || !Number.isFinite(obj.maxIterations) || obj.maxIterations < 1 || obj.maxIterations > 500) {
      errors.push("maxIterations 必须是 1~500 的数字");
    }
  }
  if (obj.temperature !== undefined) {
    if (typeof obj.temperature !== "number" || obj.temperature < 0 || obj.temperature > 2) {
      errors.push("temperature 必须在 0~2 之间");
    }
  }
  if (obj.maxTokens !== undefined) {
    if (typeof obj.maxTokens !== "number" || obj.maxTokens < 1 || obj.maxTokens > 200000) {
      errors.push("maxTokens 必须是 1~200000 的数字");
    }
  }
  if (obj.forceComplete !== undefined && typeof obj.forceComplete !== "boolean") {
    errors.push("forceComplete 必须是布尔值");
  }
  if (obj.requireCompletion !== undefined && typeof obj.requireCompletion !== "boolean") {
    errors.push("requireCompletion 必须是布尔值");
  }
  return errors;
}

// ═══════════════════════════════════════════════
// ITool / ToolBase 实现
// ═══════════════════════════════════════════════

/**
 * ExecutorTool - runToolsLoop 的受控封装
 *
 * 设计约定（与仓库现有 registry.execute(handler) 模式兼容）：
 *   - execute(input, ctx?) 中 ctx 由绑定闭包注入
 *   - signal 在循环级和单次工具执行级双重检查
 *   - abort/timeout/cancel 错误分类明确，日志完整
 */
export class ExecutorTool {
  readonly definition: ToolDefinition = EXECUTOR_TOOL_DEFINITION;

  /** 校验入参 */
  validate(input: unknown): string[] {
    return validateExecutorInput(input);
  }

  /** 无副作用预演 */
  dryRun(input: ExecutorToolInput, ctx?: Partial<ExecutorToolContext>): ExecutorDryRunResult {
    const errors = this.validate(input);
    if (errors.length > 0) {
      return {
        aborted: false,
        plannedIterations: 0,
        toolsAvailable: 0,
        toolNames: [],
        notes: errors.map(e => `校验失败: ${e}`),
      };
    }
    const agentId = input.agentId || ctx?.agentId || "";
    const registry = ctx?.registry;
    let toolNames: string[] = [];
    if (registry && agentId) {
      toolNames = registry.listToolsForAgent(agentId).map(t => t.name);
    }
    return {
      aborted: ctx?.signal?.aborted ?? false,
      plannedIterations: Math.min(input.maxIterations ?? 50, 500),
      toolsAvailable: toolNames.length,
      toolNames,
      notes: [
        `将执行任务: ${input.task.slice(0, 80)}${input.task.length > 80 ? "…" : ""}`,
        agentId ? `agentId=${agentId}` : "agentId 未指定（execute 时必填）",
        input.forceComplete ? "force_complete 模式：失败上限放宽" : "普通模式",
      ],
    };
  }

  /**
   * 执行任务循环
   *
   * @param input AI 可控参数
   * @param ctx   调用方注入的上下文（client/model/registry/signal 等）
   */
  async execute(input: ExecutorToolInput, ctx: ExecutorToolContext): Promise<ExecutorExecuteResult> {
    const startTs = Date.now();
    const errors = this.validate(input);
    if (errors.length > 0) {
      throw new ExecutorToolError("unknown", `参数校验失败: ${errors.join("; ")}`);
    }

    const agentId = input.agentId || ctx.agentId || "";
    if (!agentId) {
      throw new ExecutorToolError("unknown", "agentId 未指定：input.agentId 或 ctx.agentId 至少提供一个");
    }
    if (!ctx.client || !ctx.model || !ctx.registry) {
      throw new ExecutorToolError("unknown", "ExecutorTool 缺少必要上下文: client/model/registry 均必填");
    }

    // signal 已 abort：快速失败
    if (ctx.signal?.aborted) {
      console.warn("[ExecutorTool] signal 已 abort，拒绝启动任务循环");
      throw new ExecutorToolError("abort", "任务在启动前已被中止 (aborted before start)");
    }

    const loopOptions: RunToolsOptions = {
      client: ctx.client,
      model: ctx.model,
      messages: [{ role: "user", content: input.task }],
      registry: ctx.registry,
      agentId,
      chatId: ctx.chatId,
      maxIterations: input.maxIterations ?? 50,
      temperature: input.temperature ?? 0.7,
      maxTokens: input.maxTokens ?? 16384,
      signal: ctx.signal,
      forceComplete: input.forceComplete ?? false,
      requireCompletion: input.requireCompletion ?? false,
      summaryModel: ctx.summaryModel,
      onToolCall: ctx.onToolCall,
      onToolResult: ctx.onToolResult,
      onThink: ctx.onThink,
    };

    try {
      const result = await runToolsLoop(loopOptions);

      // 循环结束后 signal 检查：runToolsLoop 的 aborted 标志 → 抛出明确错误
      if (ctx.signal?.aborted || result.aborted) {
        console.warn(`[ExecutorTool] 任务被中止 (iterations=${result.iterations}, toolResults=${result.toolResults.length})`);
        const err = new ExecutorToolError(
          "abort",
          `任务在迭代 ${result.iterations} 后被中止，已完成的 ${result.toolResults.length} 个工具结果保留在 result 中`
        );
        (err as any).partialResult = result;
        throw err;
      }

      console.log(`[ExecutorTool] 完成 (iterations=${result.iterations}, toolResults=${result.toolResults.length}, ${Date.now() - startTs}ms)`);
      return result;
    } catch (err: unknown) {
      if (err instanceof ExecutorToolError) throw err;

      const errMsg = err instanceof Error ? err.message : String(err);
      const kind = classifyExecutorError(errMsg, ctx.signal);
      console.error(`[ExecutorTool] 执行失败 (kind=${kind}):`, errMsg);

      if (kind === "abort") {
        throw new ExecutorToolError("abort", `任务被中止: ${errMsg}`);
      }
      if (kind === "timeout") {
        throw new ExecutorToolError("timeout", `任务超时: ${errMsg}`);
      }
      if (kind === "cancel") {
        throw new ExecutorToolError("cancel", `任务被取消: ${errMsg}`);
      }
      throw new ExecutorToolError("unknown", `任务执行失败: ${errMsg}`);
    }
  }
}

/**
 * 错误分类：根据错误消息与 signal 状态判断类别
 */
export function classifyExecutorError(message: string, signal?: AbortSignal): ExecutorErrorKind {
  const m = (message || "").toLowerCase();
  if (signal?.aborted) return "abort";
  if (m.includes("abort") || m.includes("aborted") || m.includes("aborterror")) return "abort";
  if (m.includes("timeout") || m.includes("timed out") || m.includes("超时") || m.includes("etimedout")) return "timeout";
  if (m.includes("cancel") || m.includes("cancelled") || m.includes("canceled") || m.includes("已取消")) return "cancel";
  return "unknown";
}

// ═══════════════════════════════════════════════
// registry 适配：包装成 ToolCallRequest handler
// ═══════════════════════════════════════════════

/**
 * 构建一个可直接交给 registry.registerToolInstance 的执行闭包
 *
 * 用法：
 *   const executorTool = new ExecutorTool();
 *   registry.registerToolInstance(EXECUTOR_TOOL_DEFINITION, executorTool, {
 *     client, model, registry, agentId: 'default',
 *   });
 */
export function bindExecutorTool(
  tool: ExecutorTool,
  ctx: ExecutorToolContext
): (args: Record<string, any>) => Promise<any> {
  return async (args: Record<string, any>) => {
    const input: ExecutorToolInput = {
      task: String(args.task || ""),
      agentId: typeof args.agentId === "string" ? args.agentId : undefined,
      maxIterations: typeof args.maxIterations === "number" ? args.maxIterations : undefined,
      temperature: typeof args.temperature === "number" ? args.temperature : undefined,
      maxTokens: typeof args.maxTokens === "number" ? args.maxTokens : undefined,
      forceComplete: args.forceComplete === true,
      requireCompletion: args.requireCompletion === true,
    };
    const result = await tool.execute(input, ctx);
    return {
      finalContent: result.finalContent,
      iterations: result.iterations,
      toolResultsCount: result.toolResults.length,
      toolResults: result.toolResults,
    };
  };
}

/**
 * 类型守卫：验证 ToolCallRequest
 */
export function isExecutorRequest(req: ToolCallRequest): boolean {
  return req.name === "executor" && validateExecutorInput(req.arguments).length === 0;
}

/** 便捷：把 ToolCallResult 转成摘要（日志用） */
export function summarizeCallResult(r: ToolCallResult): string {
  return `[${r.toolName}] ${r.success ? "ok" : "FAIL"} ${r.durationMs}ms ${r.error || ""}`.trim();
}