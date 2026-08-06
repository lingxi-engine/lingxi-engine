/**
 * 工具调用系统 - 核心类型定义
 */

/** 工具参数 schema（JSON Schema 子集） */
export interface ToolParamSchema {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  default?: any;
  items?: ToolParamSchema;
  properties?: Record<string, ToolParamSchema>;
  required?: string[];
}

/** 工具定义 */
export interface ToolDefinition {
  name: string;                    // 工具唯一名，如 "web_search"
  description: string;             // 给模型看的描述
  parameters: ToolParamSchema;     // 参数 schema
  skills?: string[];               // 属于哪些技能标签
}

/** 工具调用请求（模型输出） */
export interface ToolCallRequest {
  id: string;                      // 本次调用的唯一 ID
  name: string;                    // 工具名
  arguments: Record<string, any>;  // 参数
}

/** 工具执行结果 */
export interface ToolCallResult {
  callId: string;
  toolName: string;
  success: boolean;
  result: any;
  error?: string;
  durationMs: number;
}

/** 技能定义 */
export interface Skill {
  id: string;                      // 如 "search-expert"
  name: string;                    // 显示名
  description: string;             // 描述
  tools: string[];                 // 包含的工具名
  prompt: string;                  // 系统 prompt 增强片段
}

/** OpenAI 兼容的工具格式 */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

/** 将内部 ToolDefinition 转为 OpenAI tools 格式 */
export function toOpenAITool(tool: ToolDefinition): OpenAITool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties: tool.parameters.properties || {},
        required: tool.parameters.required || [],
      },
    },
  };
}

// ═══════════════════════════════════════════════
// 类型守卫 (Type Guards) — v1.3.0 P2-1 类型安全增强
// ═══════════════════════════════════════════════

/**
 * 检查值是否为非 null 的普通对象（排除数组、null、原始类型）
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 检查值是否为有效字符串
 */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * 类型守卫：验证对象是否符合 ToolCallRequest 接口
 * 检查必填字段 id(name/string), name(name/string), arguments(name/object)
 */
export function isToolCallRequest(obj: unknown): obj is ToolCallRequest {
  if (!isRecord(obj)) return false;
  if (!isString(obj.id) || obj.id.length === 0) return false;
  if (!isString(obj.name) || obj.name.length === 0) return false;
  if (!isRecord(obj.arguments)) return false;
  return true;
}

/**
 * 类型守卫：验证对象是否符合 ToolCallResult 接口
 */
export function isToolCallResult(obj: unknown): obj is ToolCallResult {
  if (!isRecord(obj)) return false;
  if (!isString(obj.callId)) return false;
  if (!isString(obj.toolName)) return false;
  if (typeof obj.success !== "boolean") return false;
  if (typeof obj.durationMs !== "number") return false;
  return true;
}

/**
 * 类型守卫：验证对象是否符合 OpenAI tool_calls 消息格式
 * { id: string, type: "function", function: { name: string, arguments: string } }
 */
export function isToolCallInMessage(obj: unknown): obj is { id: string; type: "function"; function: { name: string; arguments: string } } {
  if (!isRecord(obj)) return false;
  if (!isString(obj.id)) return false;
  if (obj.type !== "function") return false;
  if (!isRecord(obj.function)) return false;
  if (!isString(obj.function.name)) return false;
  if (!isString(obj.function.arguments)) return false;
  return true;
}

/**
 * 类型守卫：检查 ChatMessage 是否包含 tool_calls 数组
 */
export function hasToolCalls(msg: { tool_calls?: unknown }): msg is { tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> } {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

/**
 * 安全解析 JSON 字符串，失败返回 undefined
 */
export function safeJsonParse(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}
