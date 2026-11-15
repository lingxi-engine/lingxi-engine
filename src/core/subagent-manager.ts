/**
 * 子代理系统 - SubAgent Spawn + Inter-Agent Communication
 * 
 * v2.0 新增：
 *   - Agent 间消息传递（requestHelp / sendMessage）
 *   - 子代理可以主动请求其他 Agent 协助
 *   - 消息队列 + 事件通知
 * 
 * 对标 CrewAI delegation + AutoGen GroupChat
 */

import { runToolsLoop } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface SubAgentTask {
  id: string;
  parentAgentId: string;
  parentChatId: string;
  objective: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout';
  model?: string;
  result?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  timeoutSeconds: number;
  toolRegistry?: any;
  agentIdForTools?: string;
  skills?: string[];        // v2.0.24: 子代理独立技能集（优先于父 Agent 技能）
  role?: string;            // v2.0.24: 子代理角色/persona 描述
  onProgress?: (step: string, status: string, output?: string) => void;
  // v2.0: 子代理间消息历史
  messageHistory?: AgentMessage[];
}

export interface SpawnOptions {
  objective: string;
  parentId: string;
  chatId: string;
  model?: string;
  timeoutSeconds?: number;
  taskName?: string;
  toolRegistry?: any;
  agentIdForTools?: string;
  skills?: string[];        // v2.0.24: 子代理独立技能集
  role?: string;            // v2.0.24: 子代理角色描述
  onProgress?: (step: string, status: string, output?: string) => void;
}

// v2.0: Agent 间消息
export interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  type: 'request' | 'response' | 'broadcast' | 'steer';
  taskId?: string;        // 关联的子任务 ID
  replyTo?: string;       // 回复哪条消息
  timestamp: number;
  status: 'pending' | 'delivered' | 'read';
}

// v2.0: Agent 间消息处理器（由外部注入，用于触发目标 Agent 回复）
type AgentMessageHandler = (msg: AgentMessage) => Promise<string>;

// v2.1: 多智能体协作编排
export type CollabMode = 'voting' | 'debate' | 'roundtable' | 'pipeline' | 'review' | 'orchestrator';

export interface CollabTurn {
  round: number;
  model: string;
  role: 'speak' | 'judge' | 'summary';
  content: string;
  failed?: boolean;
  ts: number;
}

export interface CollabSession {
  id: string;
  mode: CollabMode;
  question: string;
  models: string[];
  rounds: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  transcript: CollabTurn[];
  conclusion?: string;
  error?: string;
  chatId?: string;
}

export interface CollabOptions {
  mode: CollabMode;
  question: string;
  models?: string[];
  rounds?: number;
  parentId?: string;
  chatId?: string;
  maxSpeakSeconds?: number;
  onEvent?: (evt: any) => void;
}


/**
 * 子代理管理器 v2.0
 */
export class SubAgentManager {
  private tasks = new Map<string, SubAgentTask>();
  private running = new Map<string, AbortController>();
  private aiClient: any;
  private aiModel: string;
  // FIX-SUBAGENT-MODEL(2026-11-14): 按任务模型动态解析客户端（与主回复路径同走 AIHub），
  // 避免钉死启动时 DEFAULT_MODEL 客户端——该通道欠费/故障时子代理必挂。
  private clientResolver: ((model?: string) => { client: any; resolvedModel: string } | null) | null = null;
  private onResult: ((task: SubAgentTask) => void) | null = null;
  // v2.0.22: 全局进度回调（用于把子代理内部工具调用回传父级，修 G6 steps=0）
  private onGlobalProgress: ((task: SubAgentTask, step: string, status: string, output?: string) => void) | null = null;

  // v2.0: Agent 间消息系统
  private agentMessages = new Map<string, AgentMessage[]>();  // agentId -> 消息队列
  private messageHandlers = new Map<string, AgentMessageHandler>();  // agentId -> 处理器
  private messageListeners = new Map<string, (msg: AgentMessage) => void>();

  // v2.1: 协作会话存储 + 事件回调
  private collabSessions = new Map<string, CollabSession>();
  private collabCounter = 0;
  private collabOnEvent: ((evt: any) => void) | null = null;


  constructor(aiClient: any, aiModel: string) {
    this.aiClient = aiClient;
    this.aiModel = aiModel;
    // 每小时清理一次超过24h的已完成任务记录，避免内存泄漏
    // v2.0.14: 间隔缩短为 5 分钟，失败任务按 SUBAGENT_FAIL_RETAIN_MS（默认10分钟）分级清理
    const cleaner = setInterval(() => { try { this.cleanup(24 * 60 * 60 * 1000); } catch { /* ignore */ } }, 5 * 60 * 1000);
    if (cleaner.unref) cleaner.unref();
  }

  /** 设置结果回调 */
  setResultHandler(handler: (task: SubAgentTask) => void): void {
    this.onResult = handler;
  }

  /** FIX-SUBAGENT-MODEL: 注入按模型解析客户端的回调（index.ts 用 AIHub.getClient 实现，与主回复路径一致）。 */
  setClientResolver(fn: (model?: string) => { client: any; resolvedModel: string } | null): void {
    this.clientResolver = fn;
  }

  /** 解析本次执行用的客户端+模型：优先 resolver（AIHub 路由），异常/空结果回退构造时默认客户端。 */
  private resolveExecutionClient(task: SubAgentTask): { client: any; model: string } {
    if (this.clientResolver) {
      try {
        const r = this.clientResolver(task.model);
        if (r && r.client) return { client: r.client, model: r.resolvedModel || task.model || this.aiModel };
      } catch (e: any) {
        console.warn('[SubAgent] clientResolver 异常，回退默认客户端:', e?.message || e);
      }
    }
    return { client: this.aiClient, model: task.model || this.aiModel };
  }

  /** v2.0.22: 全局进度回调 —— 子代理每次工具调用/结果都会触发，供上层（WebSocket）广播。 */
  setProgressHandler(handler: (task: SubAgentTask, step: string, status: string, output?: string) => void): void {
    this.onGlobalProgress = handler;
  }

  // ═══════════════════════════════════════════════
  // 子代理任务管理（原有功能）
  // ═══════════════════════════════════════════════

  async spawn(opts: SpawnOptions): Promise<string> {
    const taskId = 'subagent-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

    const task: SubAgentTask = {
      id: taskId,
      parentAgentId: opts.parentId,
      parentChatId: opts.chatId,
      objective: opts.objective,
      status: 'pending',
      model: opts.model || this.aiModel,
      createdAt: Date.now(),
      timeoutSeconds: opts.timeoutSeconds || parseInt(process.env.SUBAGENT_TIMEOUT_SECONDS || '1800', 10),
      toolRegistry: opts.toolRegistry,
      agentIdForTools: opts.agentIdForTools || opts.parentId,
      skills: opts.skills,
      role: opts.role,
      onProgress: undefined,
      messageHistory: [],
    };

    const _userProgress = opts.onProgress;
    task.onProgress = (step: string, status: string, output?: string) => {
      try { if (_userProgress) _userProgress(step, status, output); } catch { /* ignore */ }
      try { if (this.onGlobalProgress) this.onGlobalProgress(task, step, status, output); } catch { /* ignore */ }
    };
    this.tasks.set(taskId, task);
    this.executeTask(task).catch(err => {
      console.error(`[SubAgent] ${taskId} 执行异常:`, err.message);
    });
    return taskId;
  }

  // v2.0.24: 供 get_subagent_result 工具查询异步子代理状态
  getTask(taskId: string): SubAgentTask | null {
    return this.tasks.get(taskId) || null;
  }

  async awaitResult(taskId: string, timeoutMs?: number): Promise<SubAgentTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const deadline = Date.now() + (timeoutMs || task.timeoutSeconds * 1000);
    return new Promise((resolve) => {
      const check = () => {
        const t = this.tasks.get(taskId);
        if (!t) { resolve(null); return; }
        if (t.status === 'completed' || t.status === 'failed' || t.status === 'timeout') {
          resolve(t); return;
        }
        if (Date.now() > deadline) {
          t.status = 'timeout';
          t.error = '等待超时';
          t.completedAt = Date.now();
          const ctrl = this.running.get(taskId);
          if (ctrl) ctrl.abort();
          resolve(t); return;
        }
        setTimeout(check, 500);
      };
      check();
    });
  }

  steer(taskId: string, message: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.objective += '\n\n补充指令: ' + message;
    return true;
  }

  kill(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const ctrl = this.running.get(taskId);
    if (ctrl) ctrl.abort();
    task.status = 'failed';
    task.error = '被手动取消';
    task.completedAt = Date.now();
    return true;
  }

  list(parentAgentId?: string): SubAgentTask[] {
    const tasks = Array.from(this.tasks.values());
    if (parentAgentId) return tasks.filter(t => t.parentAgentId === parentAgentId);
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  cleanup(maxAgeMs: number = 3600000): number {
    // v2.0.14: 默认保留期与 notifyResult 对齐（失败任务短保留）；调用方可传 24h 清理已完成任务
    const FAIL_RETAIN_MS = parseInt(process.env.SUBAGENT_FAIL_RETAIN_MS || '600000', 10);
    const cutoff = Date.now() - maxAgeMs;
    const failCutoff = Date.now() - FAIL_RETAIN_MS;
    let removed = 0;
    for (const [id, task] of this.tasks) {
      const isFail = task.status === 'failed' || task.status === 'timeout';
      if ((task.status === 'completed' || isFail) &&
          task.completedAt && task.completedAt < (isFail ? failCutoff : cutoff)) {
        this.tasks.delete(id);
        removed++;
      }
    }
    return removed;
  }

  // ═══════════════════════════════════════════════
  // v2.0: Agent 间消息传递系统
  // ═══════════════════════════════════════════════

  /**
   * 注册 Agent 消息处理器（当该 Agent 收到消息时调用）
   * 处理器应返回 Agent 的回复内容
   */
  registerAgentMessageHandler(agentId: string, handler: AgentMessageHandler): void {
    if (this.messageHandlers.has(agentId)) {
      console.log(`[SubAgent] Agent ${agentId} 消息处理器已存在，跳过重复注册`);
      return;
    }
    this.messageHandlers.set(agentId, handler);
    console.log(`[SubAgent] Agent ${agentId} 消息处理器已注册`);
  }

  /** 注销 Agent 消息处理器 */
  unregisterAgentMessageHandler(agentId: string): void {
    this.messageHandlers.delete(agentId);
  }

  /**
   * Agent A 向 Agent B 发送消息（请求协助/对话）
   * @returns Agent B 的回复内容
   */
  async sendAgentMessage(
    fromAgentId: string,
    toAgentId: string,
    content: string,
    opts?: { type?: 'request' | 'response' | 'broadcast'; taskId?: string; replyTo?: string; timeoutMs?: number }
  ): Promise<{ ok: boolean; reply?: string; error?: string; messageId: string }> {
    const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const msg: AgentMessage = {
      id: msgId,
      fromAgentId,
      toAgentId,
      content,
      type: opts?.type || 'request',
      taskId: opts?.taskId,
      replyTo: opts?.replyTo,
      timestamp: Date.now(),
      status: 'pending',
    };

    // 存入目标 Agent 的消息队列
    if (!this.agentMessages.has(toAgentId)) {
      this.agentMessages.set(toAgentId, []);
    }
    this.agentMessages.get(toAgentId)!.push(msg);
    msg.status = 'delivered';

    // 通知监听器
    const listener = this.messageListeners.get(toAgentId);
    if (listener) {
      try { listener(msg); } catch { /* ignore */ }
    }

    // 调用目标 Agent 的消息处理器
    const handler = this.messageHandlers.get(toAgentId);
    if (!handler) {
      return { ok: false, error: `Agent ${toAgentId} 未注册消息处理器`, messageId: msgId };
    }

    try {
      const timeoutMs = opts?.timeoutMs || parseInt(process.env.SUBAGENT_MSG_TIMEOUT_MS || '300000', 10);
      const reply = await Promise.race([
        handler(msg),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Agent 消息回复超时')), timeoutMs)
        ),
      ]);

      // 存入回复消息
      const replyMsg: AgentMessage = {
        id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        fromAgentId: toAgentId,
        toAgentId: fromAgentId,
        content: reply,
        type: 'response',
        replyTo: msgId,
        taskId: opts?.taskId,
        timestamp: Date.now(),
        status: 'delivered',
      };
      if (!this.agentMessages.has(fromAgentId)) {
        this.agentMessages.set(fromAgentId, []);
      }
      this.agentMessages.get(fromAgentId)!.push(replyMsg);

      return { ok: true, reply, messageId: msgId };
    } catch (err: any) {
      return { ok: false, error: err.message, messageId: msgId };
    }
  }

  /**
   * 获取 Agent 的消息队列
   */
  getAgentMessages(agentId: string, limit?: number): AgentMessage[] {
    const msgs = this.agentMessages.get(agentId) || [];
    return limit ? msgs.slice(-limit) : msgs;
  }

  /**
   * 注册消息监听器（实时通知）
   */
  onAgentMessage(agentId: string, listener: (msg: AgentMessage) => void): void {
    this.messageListeners.set(agentId, listener);
  }

  /**
   * 清理 Agent 消息队列
   */
  clearAgentMessages(agentId: string, maxAgeMs: number = 3600000): number {
    const msgs = this.agentMessages.get(agentId);
    if (!msgs) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const before = msgs.length;
    const filtered = msgs.filter(m => m.timestamp > cutoff);
    this.agentMessages.set(agentId, filtered);
    return before - filtered.length;
  }

  // ═══════════════════════════════════════════════
  // 内部执行
  // ═══════════════════════════════════════════════

  private async executeTask(task: SubAgentTask): Promise<void> {
    const controller = new AbortController();
    this.running.set(task.id, controller);
    task.status = 'running';
    task.startedAt = Date.now();

    const timeoutTimer = setTimeout(() => {
      if (task.status === 'running') {
        task.status = 'timeout';
        task.error = `执行超时 (${task.timeoutSeconds}s)`;
        task.completedAt = Date.now();
        controller.abort();
        this.notifyResult(task);
      }
    }, task.timeoutSeconds * 1000);

    try {
      if (task.onProgress) task.onProgress('execute', 'running');
      const exec = this.resolveExecutionClient(task);
      console.log('[SubAgent] ' + task.id + ' 执行模型: ' + exec.model);

      if (task.toolRegistry && task.agentIdForTools) {
        // v2.0.24: 子代理有独立技能集时优先使用，否则回落到父 Agent 技能
        const tools = (task.skills && task.skills.length > 0 && task.toolRegistry.listToolsForSkills)
          ? task.toolRegistry.listToolsForSkills(task.skills)
          : task.toolRegistry.listToolsForAgent(task.agentIdForTools);
        if (tools && tools.length > 0) {
          if (task.onProgress) task.onProgress('execute', 'running', '使用 ' + tools.length + ' 个工具');

          const rolePrefix = task.role ? ('【角色】' + task.role + '\n') : '';
          const toolPrompt = rolePrefix + '你是一个独立子任务执行器，拥有工具调用能力。请完成以下任务。\n\n任务目标：' + task.objective + '\n\n规则：\n- 主动调用工具完成任务（搜索、读写文件、执行代码等）\n- 如果需要其他 Agent 的协助，可以使用 request_agent_help 工具\n- 完成后给出简洁的结果总结\n- 不要有多余解释';

          const systemPrompt = task.role
            ? ('你是灵犀引擎的子任务执行器，当前角色：' + task.role + '。拥有工具调用能力，可以通过 request_agent_help 工具请求其他 Agent 协助。')
            : '你是灵犀引擎的子任务执行器，拥有工具调用能力。你可以通过 request_agent_help 工具请求其他 Agent 协助。';

          const result = await runToolsLoop({
            client: exec.client,
            model: exec.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: toolPrompt },
            ],
            registry: task.toolRegistry,
            agentId: task.agentIdForTools,
            chatId: task.parentChatId,
            maxIterations: parseInt(process.env.SUBAGENT_MAX_ITERATIONS || '50', 10),
            temperature: 0.5,
            maxTokens: 8192,
            signal: controller.signal,
            onToolCall: task.onProgress ? (e: any) => task.onProgress!('tool_call', 'running', e.toolName) : undefined,
            onToolResult: task.onProgress ? (e: any) => task.onProgress!('tool_result', e.success ? 'done' : 'failed', e.toolName) : undefined,
          });

          task.result = result.finalContent || '(无结果)';
          task.status = 'completed';
          task.completedAt = Date.now();
          if (task.onProgress) task.onProgress('execute', 'done', (task.result || '').slice(0, 200));
          return;
        }
      }

      // 无工具时走纯文本模式
      const roleLine = task.role ? ('当前角色：' + task.role + '\n\n') : '';
      const prompt = `你是一个独立子任务执行器。${roleLine}请完成以下任务，直接给出结果，不要有多余解释。

任务目标：${task.objective}

完成结果：`;

      const response = await exec.client.chat.completions.create({
        model: exec.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: 8192,
        signal: controller.signal,
      });

      task.result = response.choices[0]?.message?.content || '(无结果)';
      task.status = 'completed';
      task.completedAt = Date.now();
      if (task.onProgress) task.onProgress('execute', 'done', (task.result || '').slice(0, 200));
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      task.status = 'failed';
      task.error = err.message;
      task.completedAt = Date.now();
    } finally {
      clearTimeout(timeoutTimer);
      this.running.delete(task.id);
      this.notifyResult(task);
    }
  }

  private notifyResult(task: SubAgentTask): void {
    if (this.onResult) {
      try { this.onResult(task); } catch { /* ignore */ }
    }
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'timeout') {
      const tid = task.id;
      // v2.0.14: 失败/超时任务保留期 24h → 10 分钟（env SUBAGENT_FAIL_RETAIN_MS 可调），避免面板长期残留失败任务
      const FAIL_RETAIN_MS = parseInt(process.env.SUBAGENT_FAIL_RETAIN_MS || '600000', 10);
      const retainMs = task.status === 'completed' ? (24 * 60 * 60 * 1000) : FAIL_RETAIN_MS;
      const t = setTimeout(() => { this.tasks.delete(tid); this.running.delete(tid); }, retainMs);
      if (t.unref) t.unref();
    }
  }


  // ═══════════════════════════════════════════════
  // v2.1: 多智能体协作编排（表决/辩论/圆桌/流水线/评审/总裁）
  // 防卡死设计：单次发言超时 + 整体超时 + 失败跳过 + 可取消 + TTL 清理
  // ═══════════════════════════════════════════════

  /** 创建协作会话（异步执行，立即返回 sessionId） */
  async collab(opts: CollabOptions): Promise<string> {
    const id = 'collab-' + Date.now() + '-' + (++this.collabCounter);
    const models = (opts.models || []).filter((m: string) => typeof m === 'string' && m.trim());
    const finalModels = models.length > 0 ? models : [this.aiModel];
    const session: CollabSession = {
      id, mode: opts.mode, question: opts.question,
      models: finalModels, rounds: Math.max(1, opts.rounds || 1),
      status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
      transcript: [], chatId: opts.chatId,
    };
    this.collabOnEvent = opts.onEvent || this.collabOnEvent;
    this.collabSessions.set(id, session);
    this.runCollab(session, opts, finalModels).catch((err: any) => {
      if (session.status === 'running') {
        session.status = 'failed';
        session.error = err.message || '协作失败';
        session.updatedAt = Date.now();
        this.emitCollabEvent(session, 'done');
      }
    });
    return id;
  }

  getCollab(id: string): CollabSession | undefined { return this.collabSessions.get(id); }

  listCollabs(limit = 20): CollabSession[] {
    return Array.from(this.collabSessions.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  killCollab(id: string): boolean {
    const s = this.collabSessions.get(id);
    if (!s || s.status !== 'running') return false;
    s.status = 'cancelled'; s.updatedAt = Date.now();
    this.emitCollabEvent(s, 'done');
    return true;
  }

  private emitCollabEvent(session: CollabSession, type: string, extra?: any): void {
    try {
      this.collabOnEvent?.(Object.assign({
        type, sessionId: session.id, chatId: session.chatId,
        mode: session.mode, question: session.question,
        status: session.status, transcript: session.transcript,
        conclusion: session.conclusion, error: session.error,
      }, extra || {}));
    } catch { /* ignore */ }
  }

  private collabSystem(model: string): string {
    return `你是「${model}」模型驱动的专家智能体，正在参加多智能体协作讨论。请专业、简洁、有观点地回应，中文作答，不要重复提问。`;
  }

  private collabTranscriptText(session: CollabSession): string {
    return session.transcript.map(t => `[${t.round}轮/${t.model}] ${t.content}`).join('\n\n');
  }

  private collabLastOfModel(session: CollabSession, model: string): string {
    for (let i = session.transcript.length - 1; i >= 0; i--) {
      if (session.transcript[i].model === model) return session.transcript[i].content;
    }
    return '';
  }

  private buildJudgePrompt(q: string, items: { model: string; content: string }[] | CollabTurn[], kind: 'vote' | 'conclude'): string {
    const text = items.map(t => t.model + ': ' + t.content).join('\n\n');
    return kind === 'vote'
      ? `问题：${q}\n\n以下为各模型的观点：\n${text}\n\n请作为裁判：投票选出最优观点，说明理由，并给出最终结论。`
      : `问题：${q}\n\n辩论记录：\n${text}\n\n请作为裁判：梳理各方立场、指出最有说服力的论点，给出最终结论。`;
  }

  /** 并行独立发言（任一失败不影响整体） */
  private async collabSpeakAll(models: string[], question: string, round: number, maxSpeakMs: number, signal: AbortSignal, session: CollabSession): Promise<{ model: string; content: string }[]> {
    const settled = await Promise.allSettled(models.map(async (m) => {
      const c = await this.collabSpeak(m, this.collabSystem(m), `问题：${question}\n\n请直接给出你的观点和理由。`, maxSpeakMs, signal);
      return { model: m, content: c };
    }));
    const out: { model: string; content: string }[] = [];
    settled.forEach((r, i) => {
      const m = models[i];
      if (r.status === 'fulfilled') {
        const v: any = r.value;
        out.push({ model: m, content: v.content });
        session.transcript.push({ round, model: m, role: 'speak', content: v.content, ts: Date.now() });
      } else {
        out.push({ model: m, content: '(该模型发言失败/超时，已跳过)' });
        session.transcript.push({ round, model: m, role: 'speak', content: '(该模型发言失败/超时，已跳过)', failed: true, ts: Date.now() });
      }
    });
    this.emitCollabEvent(session, 'round', { round });
    return out;
  }

  /** 单次发言：独立 AbortController + 超时 abort，绝不卡死 */
  private async collabSpeak(model: string, system: string, user: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs);
    if (timer.unref) timer.unref();
    const onOuterAbort = () => { try { ctrl.abort(); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', onOuterAbort);
    }
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 硬超时兜底：即使底层 client 不遵守 signal / 请求挂死，也保证 promise 一定 settle，
      // 避免 Promise.allSettled 永不 resolve 导致整个 collab 会话永久停留在 running。
      const hardTimeout = new Promise<never>((_, reject) => {
        hardTimer = setTimeout(
          () => reject(new Error(`collabSpeak hard-timeout after ${timeoutMs}ms (model=${model})`)),
          timeoutMs + 3000
        );
        if (hardTimer && (hardTimer as any).unref) (hardTimer as any).unref();
      });
      const resp: any = await Promise.race([
        this.aiClient.chat.completions.create({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0.6,
          max_tokens: 2000,
          signal: ctrl.signal,
        }),
        hardTimeout,
      ]);
      const content = resp?.choices?.[0]?.message?.content;
      if (!content || !content.trim()) return '(无内容)';
      return content.trim();
    } finally {
      clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  /** 协作主流程 */
  private async runCollab(session: CollabSession, opts: CollabOptions, models: string[]): Promise<void> {
    const maxSpeakMs = Math.max(15, Math.min(opts.maxSpeakSeconds || 60, 300)) * 1000;
    const overallMs = Math.min(
      30 * 1000 + (opts.rounds || 1) * (models.length + 2) * maxSpeakMs,
      10 * 60 * 1000
    );
    const overall = new AbortController();
    const overallTimer = setTimeout(() => { try { overall.abort(); } catch { /* ignore */ } }, overallMs);
    if (overallTimer.unref) overallTimer.unref();

    try {
      const q = session.question;
      // ── 阶段1：独立发言 ──
      const first = await this.collabSpeakAll(models, q, 1, maxSpeakMs, overall.signal, session);

      // ── 阶段2：按模式交互 ──
      const mode = session.mode;
      if (mode === 'voting') {
        // 表决：独立作答 + 裁判投票
        const judgeModel = models[0];
        const verdict = await this.collabSpeak(judgeModel, this.collabSystem(judgeModel), this.buildJudgePrompt(q, first, 'vote'), maxSpeakMs, overall.signal);
        session.transcript.push({ round: 2, model: judgeModel, role: 'judge', content: verdict, ts: Date.now() });
        session.conclusion = verdict;
        this.emitCollabEvent(session, 'round', { round: 2 });
      } else if (mode === 'debate') {
        // 辩论：多轮互驳 + 裁判裁决
        let round = 2;
        for (let r = 1; r <= session.rounds && !overall.signal.aborted; r++) {
          const speeches = await Promise.all(models.map(async (m) => {
            const mine = this.collabLastOfModel(session, m);
            const others = session.transcript.filter(t => t.model !== m).map(t => t.model + ': ' + t.content).join('\n\n');
            const p = `问题：${q}\n\n你的上一轮观点：\n${mine || '(无)'}\n\n其他模型的发言：\n${others || '(无)'}\n\n请反驳或修订你的观点，给出更严谨的结论。`;
            const c = await this.collabSpeak(m, this.collabSystem(m), p, maxSpeakMs, overall.signal);
            return { model: m, content: c };
          }));
          for (const s of speeches) session.transcript.push({ round, model: s.model, role: 'speak', content: s.content, ts: Date.now() });
          this.emitCollabEvent(session, 'round', { round });
          round++;
        }
        const verdict = await this.collabSpeak(models[0], this.collabSystem(models[0]), this.buildJudgePrompt(q, session.transcript, 'conclude'), maxSpeakMs, overall.signal);
        session.transcript.push({ round: round, model: models[0], role: 'judge', content: verdict, ts: Date.now() });
        session.conclusion = verdict;
      } else if (mode === 'roundtable') {
        // 圆桌：全员可见轮流发言 + 主持人总结
        let round = 2;
        for (let r = 1; r <= session.rounds && !overall.signal.aborted; r++) {
          for (const m of models) {
            if (overall.signal.aborted) break;
            const p = `问题：${q}\n\n目前讨论记录：\n${this.collabTranscriptText(session)}\n\n作为圆桌成员，请补充新观点或回应他人，不要重复已有内容。`;
            const c = await this.collabSpeak(m, this.collabSystem(m), p, maxSpeakMs, overall.signal);
            session.transcript.push({ round, model: m, role: 'speak', content: c, ts: Date.now() });
            this.emitCollabEvent(session, 'round', { round, model: m });
          }
          round++;
        }
        const host = models[0];
        const c = await this.collabSpeak(host, this.collabSystem(host), `问题：${q}\n\n圆桌讨论记录：\n${this.collabTranscriptText(session)}\n\n作为主持人，请总结讨论共识、分歧和最终建议。`, maxSpeakMs, overall.signal);
        session.transcript.push({ round, model: host, role: 'summary', content: c, ts: Date.now() });
        session.conclusion = c;
      } else if (mode === 'pipeline') {
        // 流水线：串行接力，每步一个专家
        let prev = '';
        for (let i = 0; i < models.length && !overall.signal.aborted; i++) {
          const m = models[i];
          const stageRole = i === 0 ? '负责初始产出' : (i === models.length - 1 ? '负责最终润色定稿' : '负责审改上一步产出');
          const p = prev ? `问题：${q}\n\n上一步产出：\n${prev}\n\n你${stageRole}，请输出加工后的完整结果。` : `问题：${q}\n\n你${stageRole}，请直接输出结果。`;
          const c = await this.collabSpeak(m, this.collabSystem(m), p, maxSpeakMs, overall.signal);
          session.transcript.push({ round: i + 1, model: m, role: 'speak', content: c, ts: Date.now() });
          this.emitCollabEvent(session, 'round', { round: i + 1, model: m });
          prev = c;
        }
        session.conclusion = prev;
      } else if (mode === 'review') {
        // 评审：方案 → 评审意见 → 修订（迭代）
        const author = models[0];
        const reviewers = models.slice(1);
        const draft = await this.collabSpeak(author, this.collabSystem(author), `问题：${q}\n\n请先给出你的方案初稿。`, maxSpeakMs, overall.signal);
        session.transcript.push({ round: 1, model: author, role: 'speak', content: draft, ts: Date.now() });
        let current = draft;
        for (let r = 1; r <= session.rounds && !overall.signal.aborted; r++) {
          const roundNo = r + 1;
          if (reviewers.length === 0) break;
          const reviews = await Promise.all(reviewers.map(async (m) => {
            const p = `方案：\n${current}\n\n请从专业角度评审：指出 1-3 个问题并给出改进建议。`;
            const c = await this.collabSpeak(m, this.collabSystem(m), p, maxSpeakMs, overall.signal);
            return { model: m, content: c };
          }));
          for (const rv of reviews) session.transcript.push({ round: roundNo, model: rv.model, role: 'speak', content: rv.content, ts: Date.now() });
          const reviewText = reviews.map(rv => rv.model + ': ' + rv.content).join('\n\n');
          const revised = await this.collabSpeak(author, this.collabSystem(author),
            `方案：\n${current}\n\n评审意见：\n${reviewText}\n\n请根据评审意见修订方案，输出最终版。`, maxSpeakMs, overall.signal);
          session.transcript.push({ round: roundNo, model: author, role: 'speak', content: revised, ts: Date.now() });
          current = revised;
          this.emitCollabEvent(session, 'round', { round: roundNo });
        }
        session.conclusion = current;
      } else {
        // orchestrator 总裁：拆解 → 并行执行 → 汇总
        const boss = models[0];
        const workers = models.slice(1);
        const plan = await this.collabSpeak(boss, this.collabSystem(boss), `问题：${q}\n\n你是负责人。请把任务拆解为 ${workers.length} 个子任务，每行一个，格式：1. 子任务描述。不要多余解释。`, maxSpeakMs, overall.signal);
        session.transcript.push({ round: 1, model: boss, role: 'speak', content: plan, ts: Date.now() });
        const tasks = plan.split(/\r?\n/).map((l: string) => l.replace(/^\s*\d+[.)、]\s*/, '').trim()).filter((l: string) => l.length > 0).slice(0, workers.length);
        const results = await Promise.all(workers.map(async (m, i) => {
          const t = tasks[i] || q;
          const c = await this.collabSpeak(m, this.collabSystem(m), `子任务：${t}\n\n请完成并输出结果。`, maxSpeakMs, overall.signal);
          return { model: m, task: t, content: c };
        }));
        for (const r of results) session.transcript.push({ round: 2, model: r.model, role: 'speak', content: r.content, ts: Date.now() });
        const summaryPrompt = `问题：${q}\n\n拆解计划：\n${plan}\n\n各子任务结果：\n${results.map(r => r.model + '(' + r.task + '): ' + r.content).join('\n\n')}\n\n请整合为最终完整结论。`;
        const final = await this.collabSpeak(boss, this.collabSystem(boss), summaryPrompt, maxSpeakMs, overall.signal);
        session.transcript.push({ round: 3, model: boss, role: 'summary', content: final, ts: Date.now() });
        session.conclusion = final;
        this.emitCollabEvent(session, 'round', { round: 3 });
      }

      if (!session.conclusion) session.conclusion = this.collabTranscriptText(session);
      session.status = 'completed';
      session.updatedAt = Date.now();
      this.emitCollabEvent(session, 'done');
    } catch (err: any) {
      session.status = 'failed';
      session.error = overall.signal.aborted ? '协作整体超时' : (err.message || '协作失败');
      session.updatedAt = Date.now();
      this.emitCollabEvent(session, 'done');
    } finally {
      clearTimeout(overallTimer);
      // 30 分钟后清理会话，防止内存泄漏
      const tid = session.id;
      const t = setTimeout(() => { this.collabSessions.delete(tid); }, 30 * 60 * 1000);
      if (t.unref) t.unref();
    }
  }
}