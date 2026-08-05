import { v4 as uuid } from 'uuid';

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
  status: string;
  created_at: number;
}

function rowToDTO(row: any): AgentDTO {
  if (!row) return row;
  // sql.js exec 返回的是 values 数组，prepare 的是 object
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
      status: row[10],
      createdAt: row[11],
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
    status: row.status,
    createdAt: row.created_at,
  };
}

function safeArr(v: any): string[] {
  if (!v) return [];
  try { const r = JSON.parse(v); return Array.isArray(r) ? r : []; } catch { return []; }
}
function safeObj(v: any): Record<string, string> {
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

  update(id: string, updates: Partial<AgentDTO>): AgentDTO {
    const agent: AgentRow | undefined = this.db.getAgent(id);
    if (!agent) throw new Error('Agent not found: ' + id);
    if (updates.displayName) agent.display_name = updates.displayName;
    if (updates.model) agent.model = updates.model;
    if (updates.modelSource) agent.model_source = updates.modelSource;
    if (updates.personality) agent.personality = updates.personality as string;
    if (updates.autonomy) agent.autonomy = updates.autonomy as string;
    if (updates.skills) agent.skills = JSON.stringify(updates.skills);
    if (updates.memorySummary !== undefined) agent.memory_summary = updates.memorySummary;
    if (updates.memoryFacts) agent.memory_facts = JSON.stringify(updates.memoryFacts);
    if (updates.status) agent.status = updates.status;
    const dbRef: any = this.db;
    dbRef.raw.run('UPDATE agents SET display_name=?,model=?,model_source=?,personality=?,autonomy=?,skills=?,memory_summary=?,memory_facts=?,status=? WHERE id=?',
      [agent.display_name, agent.model, agent.model_source, agent.personality, agent.autonomy, agent.skills, agent.memory_summary, agent.memory_facts, agent.status, id]);
    return rowToDTO(agent);
  }

  setStatus(agentId: string, status: string) {
    const agent = this.db.getAgent(agentId);
    if (!agent) return;
    (this.db as any).db.prepare('UPDATE agents SET status=? WHERE id=?').run(status, agentId);
  }
}
