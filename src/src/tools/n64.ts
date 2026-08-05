/**
 * types.ts - 工具调用系统的类型定义
 */

/** 对 OpenAI API 的 model/tools/tool_choice 的统一抽象 */
export interface OpenAIToolChoice {
  type: "function";
  name?: string;
}

export interface OpenAIToolFunction {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface OpenAIFunctionCall {
  id: string;
  name: string;
  arguments: string;  // JSON string
}

export interface OpenAIChatToolCall {
  id: string;
  type: "function";
  function: OpenAIFunctionCall;
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: OpenAIChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIResponse {
  id: string;
  choices: {
    index: number;
    message: OpenAIChatMessage;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
