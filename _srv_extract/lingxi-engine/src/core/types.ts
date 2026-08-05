/**
 * Project Hub - 核心数据类型定义
 * 所有模块共享这套类型
 */

// ==================== 身份 ====================

/** 真人用户 */
export interface User {
  id: string              // 全局唯一 ID，如 "user-shen"
  displayName: string     // 显示名，如 "申总"
  avatar?: string         // 头像 URL
  agentId: string         // 绑定的智能体 ID
  createdAt: number       // 注册时间戳
}

/** AI 智能体 */
export interface Agent {
  id: string              // 全局唯一 ID，如 "agent-songzi"
  userId: string          // 归属的用户 ID
  displayName: string     // 显示名，如 "松仔"
  avatar?: string
  model: string           // 使用的模型，如 "gpt-4o" / "llama3"
  modelSource: "cloud" | "local"  // 模型来源
  personality: string    // 性格/角色描述 prompt
  autonomy: AutonomyLevel // 自主度
  skills: string[]        // 技能标签
  memory: AgentMemory     // 记忆数据
  status: "online" | "busy" | "offline"
  createdAt: number
}

/** 智能体自主度 */
export type AutonomyLevel =
  | "passive"    // 纯被动：只有被 @ 或点名才说话
  | "semi"       // 半自主：检测到相关话题自动插话，但敏感话题先问
  | "full"       // 全自主：像真人一样自由发言

/** 智能体记忆 */
export interface AgentMemory {
  // 短期记忆：最近 N 条对话（存在内存/缓存）
  recentMessages: MessageRef[]
  // 长期记忆：精华摘要（存在磁盘）
  longTermSummary?: string
  // 用户偏好/重要事实
  facts: Record<string, string>
  // 上次更新时间
  lastUpdated: number
}

// ==================== 聊天 ====================

/** 会话（私聊 or 群聊） */
export interface Chat {
  id: string              // 如 "chat-001"
  type: "private" | "group"
  participants: Participant[]
  createdAt: number
  lastMessageAt?: number
}

/** 参与者（一个会话里的每个成员） */
export interface Participant {
  userId?: string          // 真人（可选，因为可能只有 agent）
  agentId?: string         // 智能体（可选）
  role: "owner" | "member" | "agent"  // 角色：群主/成员/智能体
  joinedAt: number
}

/** 单条消息 */
export interface Message {
  id: string
  chatId: string
  senderType: "user" | "agent"  // 谁发的
  senderId: string              // 对应 User.id 或 Agent.id
  content: string
  type: "text" | "image" | "file" | "system"  // 消息类型
  replyTo?: string              // 回复哪条消息的 ID
  metadata?: Record<string, any>
  timestamp: number
}

/** 消息引用（用于记忆） */
export interface MessageRef {
  messageId: string
  chatId: string
  summary: string      // 简述这条消息内容
  timestamp: number
}

// ==================== AI 接入 ====================

/** AI 提供商配置 */
export interface AIProvider {
  id: string
  type: "openai" | "ollama" | "anthropic" | "custom"
  apiKey?: string
  baseUrl?: string      // 自定义 API 地址
  models: string[]      // 该提供商支持的模型列表
  isLocal: boolean
  isActive: boolean
}

/** AI 生成请求 */
export interface AIRequest {
  agentId: string
  messages: ChatMessage[]   // 对话历史
  model?: string
  temperature?: number
  maxTokens?: number
  tools?: AITool[]          // 工具调用定义
  stream?: boolean          // 是否流式输出
}

/** AI 生成响应 */
export interface AIResponse {
  content: string
  model: string
  usage?: {
    promptTokens: number
    completionTokens: number
  }
  toolCalls?: AIToolCall[]  // AI 请求调用工具
}

/** 对话消息（AI 接口用） */
export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/** 工具调用 */
export interface AITool {
  name: string
  description: string
  parameters: Record<string, any>
}

export interface AIToolCall {
  name: string
  arguments: Record<string, any>
  result?: any
}

// ==================== 事件 ====================

/** 系统事件类型 */
export type EventType =
  | "message.new"         // 新消息
  | "agent.speak"         // 智能体准备发言
  | "agent.status"        // 智能体状态变化
  | "user.online"         // 用户上线
  | "chat.created"        // 新建会话
  | "typing"              // 正在输入
  | "error"               // 错误

/** 事件 */
export interface Event {
  type: EventType
  data: Record<string, any>
  timestamp: number
}
