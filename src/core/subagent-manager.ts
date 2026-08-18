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

/**
 * 子代理管理器 v2.0
 */
export class SubAgentManager {
  private tasks = new Map<string, SubAgentTask>();
  private running = new Map<string, AbortController>();
  private aiClient: any;
  private aiModel: string;
  private onResult: ((task: SubAgentTask) => void) | null = null;

  // v2.0: Agent 间消息系统
  private agentMessages = new Map<string, AgentMessage[]>();  // agentId -> 消息队列
  private messageHandlers = new Map<string, AgentMessageHandler>();  // agentId -> 处理器
  private messageListeners = new Map<string, (msg: AgentMessage) => void>();

  constructor(aiClient: any, aiModel: string) {
    this.aiClient = aiClient;
    this.aiModel = aiModel;
    // 每小时清理一次超过24h的已完成任务记录，避免内存泄漏
    const cleaner = setInterval(() => { try { this.cleanup(24 * 60 * 60 * 1000); } catch { /* ignore */ } }, 60 * 60 * 1000);
    if (cleaner.unref) cleaner.unref();
  }

  /** 设置结果回调 */
  setResultHandler(handler: (task: SubAgentTask) => void): void {
    this.onResult = handler;
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
      timeoutSeconds: opts.timeoutSeconds || parseInt(process.env.SUBAGENT_TIMEOUT_SECONDS || '600', 10),
      toolRegistry: opts.toolRegistry,
      agentIdForTools: opts.agentIdForTools || opts.parentId,
      onProgress: opts.onProgress,
      messageHistory: [],
    };

    this.tasks.set(taskId, task);
    this.executeTask(task).catch(err => {
      console.error(`[SubAgent] ${taskId} 执行异常:`, err.message);
    });
    return taskId;
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
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if ((task.status === 'completed' || task.status === 'failed' || task.status === 'timeout') &&
          task.completedAt && task.completedAt < cutoff) {
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
      const timeoutMs = opts?.timeoutMs || 120000;
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

      if (task.toolRegistry && task.agentIdForTools) {
        const tools = task.toolRegistry.listToolsForAgent(task.agentIdForTools);
        if (tools && tools.length > 0) {
          if (task.onProgress) task.onProgress('execute', 'running', '使用 ' + tools.length + ' 个工具');

          const toolPrompt = '你是一个独立子任务执行器，拥有工具调用能力。请完成以下任务。\n\n任务目标：' + task.objective + '\n\n规则：\n- 主动调用工具完成任务（搜索、读写文件、执行代码等）\n- 如果需要其他 Agent 的协助，可以使用 request_agent_help 工具\n- 完成后给出简洁的结果总结\n- 不要有多余解释';

          const result = await runToolsLoop({
            client: this.aiClient,
            model: task.model || this.aiModel,
            messages: [
              { role: 'system', content: '你是灵犀引擎的子任务执行器，拥有工具调用能力。你可以通过 request_agent_help 工具请求其他 Agent 协助。' },
              { role: 'user', content: toolPrompt },
            ],
            registry: task.toolRegistry,
            agentId: task.agentIdForTools,
            chatId: task.parentChatId,
            maxIterations: 20,
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
      const prompt = `你是一个独立子任务执行器。请完成以下任务，直接给出结果，不要有多余解释。

任务目标：${task.objective}

完成结果：`;

      const response = await this.aiClient.chat.completions.create({
        model: task.model || this.aiModel,
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
      const t = setTimeout(() => { this.tasks.delete(tid); this.running.delete(tid); }, 24 * 60 * 60 * 1000);
      if (t.unref) t.unref();
    }
  }
}