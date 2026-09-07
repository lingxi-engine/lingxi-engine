/**
 * 工具调用系统 - 工具注册中心
 * 负责注册、查找、执行工具
 */
import type { ToolDefinition, ToolCallRequest, ToolCallResult, Skill } from "./types.js";
import type { ITool } from "./tool-base.js";
// 架构建议 #3: 接线 ApprovalManager
import type { ApprovalManager } from "../core/approval.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private handlers = new Map<string, (args: Record<string, any>) => Promise<any>>();
  private skills = new Map<string, Skill>();
  private agentSkills = new Map<string, string[]>(); // agentId -> skillIds[];
  private instances = new Map<string, ITool>();
  private approvalManager: ApprovalManager | null = null;

  // ── 工具注册 ──

  /** 注册一个工具 */
  registerTool(tool: ToolDefinition, handler: (args: Record<string, any>) => Promise<any>) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    this.handlers.set(tool.name, handler);
  }

  /** 批量注册工具 */
  registerTools(entries: { tool: ToolDefinition; handler: (args: Record<string, any>) => Promise<any> }[]) {
    for (const { tool, handler } of entries) {
      this.registerTool(tool, handler);
    }
  }

  /** 注册一个工具实例（ITool 实现，优先于 handler 执行） */
  registerToolInstance(tool: ToolDefinition, instance: ITool) {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    this.instances.set(tool.name, instance);
  }

  // ── 技能管理 ──

  /** 注册一个技能 */
  registerSkill(skill: Skill) {
    if (this.skills.has(skill.id)) {
      throw new Error(`Skill already registered: ${skill.id}`);
    }
    // 验证技能引用的工具都存在
    for (const toolName of skill.tools) {
      if (!this.tools.has(toolName)) {
        console.warn(`[ToolRegistry] Skill "${skill.id}" references unknown tool: "${toolName}"`);
      }
    }
    this.skills.set(skill.id, skill);
  }

  /** 给某个 Agent 绑定技能 */
  bindSkills(agentId: string, skillIds: string[]) {
    this.agentSkills.set(agentId, skillIds);
  }

  /** 获取 Agent 绑定的技能 */
  getAgentSkills(agentId: string): Skill[] {
    const ids = this.agentSkills.get(agentId) || [];
    return ids.map(id => this.skills.get(id)).filter(Boolean) as Skill[];
  }

  // ── 查询 ──

  /** 获取单个工具 */
  getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** 列出所有工具 */
  listTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** 列出某个 Agent 可用的工具（从技能推导） */
  listToolsForAgent(agentId: string): ToolDefinition[] {
    const skills = this.getAgentSkills(agentId);
    const toolSet = new Set<string>();
    for (const skill of skills) {
      for (const name of skill.tools) {
        toolSet.add(name);
      }
    }
    return Array.from(toolSet).map(name => this.tools.get(name)!).filter(Boolean);
  }

  /** 列出指定技能集的工具 */
  listToolsForSkills(skillIds: string[]): ToolDefinition[] {
    const toolSet = new Set<string>();
    for (const sid of skillIds) {
      const skill = this.skills.get(sid);
      if (skill) {
        for (const name of skill.tools) {
          toolSet.add(name);
        }
      }
    }
    return Array.from(toolSet).map(name => this.tools.get(name)!).filter(Boolean);
  }

  /** 列出所有技能 */
  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  // ── 审批管理器 ──

  /** 注入审批管理器 */
  setApprovalManager(mgr: ApprovalManager): void {
    this.approvalManager = mgr;
    console.log("[ToolRegistry] ApprovalManager 已注入，危险工具调用将走审批流");
  }

  // ── 执行 ──

  /** 执行单个工具调用 */
  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const instance = this.instances.get(request.name);
    const handler = this.handlers.get(request.name);
    if (!instance && !handler) {
      return {
        callId: request.id,
        toolName: request.name,
        success: false,
        result: null,
        error: `Unknown tool: ${request.name}`,
        durationMs: 0,
      };
    }
    // 架构建议 #3: 危险操作需审批
    if (this.approvalManager && this.approvalManager.needsApproval(request.name, request.arguments)) {
      try {
        const req = this.approvalManager.request('system', request.name, request.arguments, undefined, 'medium');
        console.log(`[ToolRegistry] 工具 ${request.name} 需要审批，等待批准 (reqId=${req.id})`);
        const decision = await this.approvalManager.waitForApproval(req.id);
        if (decision.status !== 'approved') {
          return { callId: request.id, toolName: request.name, success: false, result: null, error: `操作未获审批 (${decision.status})`, durationMs: 0 };
        }
      } catch (err: any) {
        return { callId: request.id, toolName: request.name, success: false, result: null, error: `审批流程异常: ${err.message}`, durationMs: 0 };
      }
    }

    const start = Date.now();
    try {
      const result = instance ? await instance.execute(request.arguments) : await handler!(request.arguments);
      return {
        callId: request.id,
        toolName: request.name,
        success: true,
        result,
        durationMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        callId: request.id,
        toolName: request.name,
        success: false,
        result: null,
        error: err.message || String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  /** 批量执行 */
  async executeAll(requests: ToolCallRequest[]): Promise<ToolCallResult[]> {
    return Promise.all(requests.map(r => this.execute(r)));
  }

  /** 生成 Agent 可用的 OpenAI tool 定义（从技能推导） */
  toOpenAIToolsForAgent(agentId: string) {
    return this.listToolsForAgent(agentId).map(toOpenAIFormat);
  }

  /** 生成所有工具的 OpenAI tool 定义 */
  toOpenAIToolsAll() {
    return this.listTools().map(toOpenAIFormat);
  }
}

/** 转为 OpenAI 格式 */
function toOpenAIFormat(tool: ToolDefinition) {
  // 将我们的 ToolParamSchema 转为 JSON Schema
  const properties: Record<string, any> = {};
  for (const [key, param] of Object.entries(tool.parameters.properties || {})) {
    properties[key] = {
      type: param.type,
      description: param.description || "",
      ...(param.enum ? { enum: param.enum } : {}),
    };
  }
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: "object",
        properties,
        required: tool.parameters.required || [],
      },
    },
  };
}
