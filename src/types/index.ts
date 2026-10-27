/**
 * 灵犀引擎 — 核心类型定义 (v1.7.0 类型安全增强)
 * 所有核心接口集中定义，消除 any 滥用
 */

// ── Agent ──
export interface Agent {
  id: string;
  userId: string;
  displayName: string;
  personality: string;
  autonomy: 'passive' | 'semi' | 'full';
  model?: string;
  modelSource?: string;
  memorySummary?: string;
  memory_summary?: string;
  memoryFacts?: Record<string, string>;
  memory_facts?: string | Record<string, string>;
  personalityDims?: Record<string, number>;
}

// ── Chat Participant ──
export interface ChatParticipant {
  userId?: string;
  agentId?: string;
  agent_id?: string;
  role: 'owner' | 'admin' | 'member' | 'viewer' | 'agent';
}

// ── Message ──
export interface StoredMessage {
  id: string;
  chatId: string;
  senderType: 'user' | 'agent' | 'system';
  senderId: string;
  content: string;
  type: string;
  replyTo?: string;
  timestamp: number;
}

// ── Chat ──
export interface Chat {
  id: string;
  type: 'private' | 'group';
  title?: string;
  shared_workspace?: string;
  createdAt: number;
}

// ── Chat Memory ──
export interface ChatMemory {
  memory_summary?: string;
  memory_facts?: string | Record<string, string>;
}

// ── AI Hub ──
export interface AIModel {
  id: string;
  name?: string;
  provider: string;
}

export interface AIClientResult {
  client: any;  // OpenAI client — no typed SDK available
  resolvedModel: string;
}

// ── Database ──
export interface Database {
  addMessage(msg: { id: string; chatId: string; senderType: string; senderId: string; content: string; type: string; replyTo?: string; timestamp: number; metadata?: Record<string, any> }): void;
  listMessages(chatId: string, limit: number): Array<{ id: string; chatId: string; sender_type: string; senderId: string; content: string; type: string; replyTo?: string; timestamp: number; metadata?: string }>;
  getChatParticipants(chatId: string): ChatParticipant[];
  createChat(id: string, type?: 'private' | 'group', sharedWorkspace?: string, name?: string): { id: string; type: string; sharedWorkspace?: string; name?: string; createdAt: number };
  addParticipant(id: string, chatId: string, userId?: string, agentId?: string, role?: string): void;
  listAgents(): Agent[];
  createUser(id: string, displayName: string): unknown;
  appendMemorySummary(agentId: string, summary: string): void;
  updateAgentMemory(agentId: string, summary: string, facts: Record<string, string>): void;
  updateAgent(agentId: string, updates: Record<string, any>): void;
  getRecentMessages(agentId: string, limit: number): Array<{ content: string; timestamp: number }>;
  listRagDocuments?(): unknown[];
  listRagChunks?(): unknown[];
  insertRagDocument?(doc: unknown): void;
  insertRagChunk?(chunk: unknown): void;
  deleteRagDocument?(docId: string): void;
}

// ── Agent Manager ──
// Compatible with src/agents/manager.ts (optional params with defaults)
export interface AgentManager {
  get(agentId: string): Agent | undefined;
  register(userId: string, displayName: string, personality?: string, autonomy?: string): Agent;
  update(agentId: string, updates: { model?: string; modelSource?: string; [key: string]: unknown }): void;
  /**
   * 追加记忆摘要（供反思/总结调用）。
   * 实现见 src/agents/manager.ts —— 内部走去重 + 冲突检测。
   * [TS FIX] 之前接口没声明这个方法，router.ts 调用时报 TS2339。
   */
  appendMemorySummary(agentId: string, newContent: string): Promise<void>;
}

// ── AI Hub ──
export interface AIHub {
  getClient(model: string): AIClientResult | undefined;
  getDefaultModel?(): string;
  getRoleClient(role: string): AIClientResult | null;
  listModels(): Array<{ id: string; name?: string; provider?: string }>;
  syncNvidiaModels?(): Promise<void>;
  syncOllamaModels?(): Promise<void>;
}

// ── Tool Registry ──
export interface ToolRegistryInterface {
  listToolsForAgent(agentId: string): ToolDef[];
  listTools(): ToolDef[];
  listSkills(): string[];
  execute(request: ToolCallRequest): Promise<ToolCallResult>;
  registerTool(tool: ToolDef, handler: unknown): void;
  registerSkill(skill: unknown): void;
  bindSkills(agentId: string, skills: string[]): void;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  success: boolean;
  result?: unknown;
  error?: string;
}
