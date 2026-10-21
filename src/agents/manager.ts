import { v4 as uuid } from 'uuid';
import { updateAgentMemoryWithChecks, upsertChatMemoryWithChecks } from '../memory/memory-write-integration.js';

export type AutonomyLevel = 'passive' | 'semi' | 'full';

export interface AgentDTO {
  id: string;
  userId: string;
  displayName: string;
  model: string;
  modelSource: string;
  personality: string;
  autonomy: AutonomyLevel;
  skills: string[];
  memorySummary: string;
  memoryFacts: Record<string, string>;
  personalityDims: Record<string, number>;
  status: string;
  createdAt: number;
}

interface AgentRow {
  id: string;
  user_id: string;
  display_name: string;
  model: string;
  model_source: string;
  personality: string;
  autonomy: string;
  skills: string;
  memory_summary: string;
  memory_facts: string;
  personality_dims: string;
  status: string;
  created_at: number;
}

function rowToDTO(row: any): AgentDTO {
  if (!row) return row;
  if (Array.isArray(row)) {
    return {
      id: row[0],
      userId: row[1],
      displayName: row[2],
      model: row[3],
      modelSource: row[4],
      personality: row[5],
      autonomy: row[6],
      skills: safeArr(row[7]),
      memorySummary: row[8] || '',
      memoryFacts: safeObj(row[9]),
      personalityDims: safeObj(row[10]),
      status: row[11],
      createdAt: row[12],
    };
  }
  return {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    model: row.model,
    modelSource: row.model_source,
    personality: row.personality,
    autonomy: row.autonomy,
    skills: safeArr(row.skills),
    memorySummary: row.memory_summary || '',
    memoryFacts: safeObj(row.memory_facts),
    personalityDims: safeObj(row.personality_dims),
    status: row.status,
    createdAt: row.created_at,
  };
}

function safeArr(v: any): string[] {
  if (!v) return [];
  try { const r = JSON.parse(v); return Array.isArray(r) ? r : []; } catch { return []; }
}
function safeObj(v: any): Record<string, any> {
  if (!v) return {};
  try { const r = JSON.parse(v); return r && typeof r === 'object' ? r : {}; } catch { return {}; }
}

export class AgentManager {
  constructor(private db: any, private aiHub: any) {}

  register(userId: string, displayName: string, personality = '', autonomy: AutonomyLevel = 'semi'): AgentDTO {
    const agentId = 'agent-' + userId + '-' + uuid().slice(0, 6);
    const defaultModel = this.aiHub?.getDefaultModel?.() || '';
    const agent = this.db.createAgent(agentId, userId, displayName, personality, autonomy, defaultModel);
    console.log('[AgentManager] register:', agentId, 'model=' + defaultModel);
    return rowToDTO(agent);
  }

  get(id: string): AgentDTO | undefined {
    const row = this.db.getAgent(id);
    return row ? rowToDTO(row) : undefined;
  }

  list(): AgentDTO[] {
    const rows = this.db.listAgents();
    return rows.map((r: any) => rowToDTO(r));
  }

  async update(id: string, updates: Partial<AgentDTO>): Promise<AgentDTO> {
    const agent: AgentRow | undefined = this.db.getAgent(id);
    if (!agent) throw new Error('Agent not found: ' + id);
    if (updates.displayName) agent.display_name = updates.displayName;
    if (updates.model) agent.model = updates.model;
    if (updates.modelSource) agent.model_source = updates.modelSource;
    if (updates.personality) agent.personality = updates.personality as string;
    if (updates.autonomy) agent.autonomy = updates.autonomy as string;
    if (updates.skills) agent.skills = JSON.stringify(updates.skills);
    if (updates.status) agent.status = updates.status;

    const dbRef: any = this.db;

    // 处理记忆更新：如果有 memorySummary 或 memoryFacts 变更，走新的去重+冲突检测流程
    if (updates.memorySummary !== undefined || updates.memoryFacts) {
      const newSummary = updates.memorySummary !== undefined ? updates.memorySummary : agent.memory_summary;
      const newFacts = updates.memoryFacts || safeObj(agent.memory_facts);

      // 使用新的集成接口：语义去重 + 冲突检测 + 写入
      const result = await updateAgentMemoryWithChecks(id, newSummary, newFacts, {
        source: 'assistant',
        confidence: 0.8,
        skipConflictCheck: false,
        skipDedup: false,
      });

      if (!result.success) {
        // 冲突阻止写入，返回冲突信息供上层决策
        throw new Error(`记忆冲突: ${JSON.stringify(result.conflicts)}`);
      }
      // 更新 agent 对象以便后续统一 UPDATE
      agent.memory_summary = newSummary;
      agent.memory_facts = JSON.stringify({ ...safeObj(agent.memory_facts), ...newFacts });
    }

    // 其它字段常规更新
    dbRef.raw.run(
      'UPDATE agents SET display_name=?,model=?,model_source=?,personality=?,autonomy=?,skills=?,memory_summary=?,memory_facts=?,status=? WHERE id=?',
      [agent.display_name, agent.model, agent.model_source, agent.personality, agent.autonomy, agent.skills, agent.memory_summary, agent.memory_facts, agent.status, id]
    );
    dbRef.markDirty?.();
    return rowToDTO(agent);
  }

  setStatus(agentId: string, status: string) {
    const agent = this.db.getAgent(agentId);
    if (!agent) return;
    (this.db as any).db.prepare('UPDATE agents SET status=? WHERE id=?').run(status, agentId);
    this.db.markDirty?.();
  }

  /** 追加记忆摘要（供反思/总结调用）——接入去重+冲突检测 */
  async appendMemorySummary(agentId: string, newContent: string): Promise<void> {
    const agent = this.db.getAgent(agentId);
    if (!agent) return;
    const safeContent = this.db.sanitizeMemoryInput?.(newContent) || newContent;
    if (!safeContent) return;

    // 提取新 facts（简单启发式：按行分割 key: value）
    const newFacts: Record<string, string> = {};
    for (const line of safeContent.split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0 && idx < 50) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key && value) newFacts[key] = value;
      }
    }

    if (Object.keys(newFacts).length > 0) {
      // 走新接口：去重 + 冲突检测
      await updateAgentMemoryWithChecks(agentId, agent.memory_summary || '', newFacts, {
        source: 'assistant',
        confidence: 0.7,
        skipConflictCheck: false,
        skipDedup: false,
      });
    } else {
      // 纯文本摘要，走旧逻辑但标记脏位
      this.db.appendMemorySummary?.(agentId, safeContent);
    }
    this.db.markDirty?.();
  }
}