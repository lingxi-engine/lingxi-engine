/**
 * 工具调用系统 - 工具注册中心
 * 负责注册、查找、执行工具
 */
import type { ToolDefinition, ToolCallRequest, ToolCallResult, Skill } from "./types.js";
// 架构建议 #3: 接线 ApprovalManager
import type { ApprovalManager } from "../core/approval.js";

/** 工具实例接口（ITool 风格）：validate/dryRun/execute 三段式 */
export interface ITool {
  /** 校验入参，返回错误列表（空 = 通过），可选 */
  validate?(input: unknown): string[];
  /** 无副作用预演，可选 */
  dryRun?(input: unknown, ctx?: unknown): unknown;
  /** 执行（args 为 AI 传入参数，ctx 为注册时绑定的上下文） */
  execute(args: Record<string, any>, ctx?: unknown): Promise<any>;
}

/** registerToolInstance 的绑定配置 */
export interface ToolInstanceBinding {
  /** 注入给实例的上下文（透传给 execute 第二参数） */
  context?: unknown;
  /** 描述（审计日志用） */
  description?: string;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private handlers = new Map<string, (args: Record<string, any>) => Promise<any>>();
  /** 工具实例注册表：name → ITool 实例 */
  private instances = new Map<string, ITool>();
  /** 实例绑定的上下文：name → context */
  private instanceContexts = new Map<string, unknown>();
  private skills = new Map<string, Skill>();
  private agentSkills = new Map<string, string[]>(); // agentId -> skillIds[];
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

  /**
   * 注册一个工具实例（ITool 风格）
   *
   * 与 registerTool 的区别：
   *   - 实例可带 validate/dryRun 钩子（可选实现）
   *   - context 在注册时绑定，execute 时作为第二参数透传
   *   - 执行时自动走 validate（失败抛错）→ execute
   *
   * @param def       工具定义（name/parameters 等）
   * @param instance  ITool 实例
   * @param binding   绑定配置（context/description）
   */
  registerToolInstance(
    def: ToolDefinition,
    instance: ITool,
    binding?: ToolInstanceBinding
  ): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
    }
    this.tools.set(def.name, def);
    this.instances.set(def.name, instance);
    this.instanceContexts.set(def.name, binding?.context ?? null);
    // 统一 handler：validate → execute
    this.handlers.set(def.name, async (args: Record<string, any>) => {
      const inst = this.instances.get(def.name)!;
      const ctx = this.instanceContexts.get(def.name);
      if (typeof inst.validate === "function") {
        const errs = inst.validate(args);
        if (errs && errs.length > 0) {
          throw new Error(`[${def.name}] 参数校验失败: ${errs.join("; ")}`);
        }
      }
      return inst.execute(args, ctx);
    });
    if (binding?.description) {
      console.log(`[ToolRegistry] 实例注册: ${def.name} — ${binding.description}`);
    }
  }

  /** 获取工具实例（未以实例方式注册则返回 undefined） */
  getToolInstance(name: string): ITool | undefined {
    return this.instances.get(name);
  }

  /** 批量注册工具 */
  registerTools(entries: { tool: ToolDefinition; handler: (args: Record<string, any>) => Promise<any> }[]) {
    for (const { tool, handler } of entries) {
      this.registerTool(tool, handler);
    }
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
    const handler = this.handlers.get(request.name);
    if (!handler) {
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
      const result = await handler(request.arguments);
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