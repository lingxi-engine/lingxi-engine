/**
 * 子代理系统 - SubAgent Spawn
 * 
 * 支持从主 Agent 派生独立子任务：
 *   - 子代理拥有独立上下文（不污染主对话）
 *   - 执行完成后结果回传给父 Agent
 *   - 超时自动终止
 * 
 * 对标 OpenClaw 的 sessions_spawn + sessions_yield
 */

import { runToolsLoop } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface SubAgentTask {
  id: string;
  parentAgentId: string;
  parentChatId: string;
  objective: string;          // 任务目标
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout';
  model?: string;             // 使用的模型（默认和父 Agent 一样）
  result?: string;           // 执行结果
  error?: string;             // 错误信息
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  timeoutSeconds: number;     // 超时时间
  toolRegistry?: any;         // 工具注册中心（可选，有则子代理可调用工具）
  agentIdForTools?: string;  // 用于工具权限查询的 Agent ID
  onProgress?: (step: string, status: string, output?: string) => void;
}

export interface SpawnOptions {
  objective: string;
  parentId: string;           // 父 Agent ID
  chatId: string;              // 父聊天 ID
  model?: string;             // 模型覆盖
  timeoutSeconds?: number;    // 超时（默认 120 秒）
  taskName?: string;          // 稳定标识（可选）
  toolRegistry?: any;         // 工具注册中心（传入则子代理可调用工具）
  agentIdForTools?: string;  // 用于工具权限查询的 Agent ID
  onProgress?: (step: string, status: string, output?: string) => void;
}

/**
 * 子代理管理器
 */
export class SubAgentManager {
  private tasks = new Map<string, SubAgentTask>();
  private running = new Map<string, AbortController>();
  private aiClient: any;
  private aiModel: string;
  private onResult: ((task: SubAgentTask) => void) | null = null;

  constructor(aiClient: any, aiModel: string) {
    this.aiClient = aiClient;
    this.aiModel = aiModel;
  }

  /** 设置结果回调（任务完成后通知父 Agent） */
  setResultHandler(handler: (task: SubAgentTask) => void): void {
    this.onResult = handler;
  }

  /**
   * 派生一个子代理任务
   * @returns 任务 ID
   */
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
      timeoutSeconds: opts.timeoutSeconds || parseInt(process.env.SUBAGENT_TIMEOUT_SECONDS || '120', 10),
      toolRegistry: opts.toolRegistry,
      agentIdForTools: opts.agentIdForTools || opts.parentId,
      onProgress: opts.onProgress,
    };

    this.tasks.set(taskId, task);

    // 异步执行
    this.executeTask(task).catch(err => {
      console.error(`[SubAgent] ${taskId} 执行异常:`, err.message);
    });

    return taskId;
  }

  /**
   * 等待子代理完成（带超时）
   */
  async awaitResult(taskId: string, timeoutMs?: number): Promise<SubAgentTask | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const deadline = Date.now() + (timeoutMs || task.timeoutSeconds * 1000);

    return new Promise((resolve) => {
      const check = () => {
        const t = this.tasks.get(taskId);
        if (!t) { resolve(null); return; }
        if (t.status === 'completed' || t.status === 'failed' || t.status === 'timeout') {
          resolve(t);
          return;
        }
        if (Date.now() > deadline) {
          t.status = 'timeout';
          t.error = '等待超时';
          t.completedAt = Date.now();
          const ctrl = this.running.get(taskId);
          if (ctrl) ctrl.abort();
          resolve(t);
          return;
        }
        setTimeout(check, 500);
      };
      check();
    });
  }

  /**
   * 向子代理发送补充指令
   */
  steer(taskId: string, message: string): boolean {
    // 当前的简单实现：记录补充指令到任务描述
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;
    task.objective += '\n\n补充指令: ' + message;
    return true;
  }

  /**
   * 取消子代理
   */
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

  /**
   * 列出所有子代理任务
   */
  list(parentAgentId?: string): SubAgentTask[] {
    const tasks = Array.from(this.tasks.values());
    if (parentAgentId) return tasks.filter(t => t.parentAgentId === parentAgentId);
    return tasks.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 清理已完成的任务
   */
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

  // ── 内部执行 ──

  private async executeTask(task: SubAgentTask): Promise<void> {
    const controller = new AbortController();
    this.running.set(task.id, controller);

    task.status = 'running';
    task.startedAt = Date.now();

    // 超时控制
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

      // ── 有工具注册中心时走 runToolsLoop（子代理可以搜索/读写文件/执行代码）──
      if (task.toolRegistry && task.agentIdForTools) {
        const tools = task.toolRegistry.listToolsForAgent(task.agentIdForTools);
        if (tools && tools.length > 0) {
          if (task.onProgress) task.onProgress('execute', 'running', '使用 ' + tools.length + ' 个工具');

          const toolPrompt = '你是一个独立子任务执行器，拥有工具调用能力。请完成以下任务。\n\n任务目标：' + task.objective + '\n\n规则：\n- 主动调用工具完成任务（搜索、读写文件、执行代码等）\n- 完成后给出简洁的结果总结\n- 不要有多余解释';

          const result = await runToolsLoop({
            client: this.aiClient,
            model: task.model || this.aiModel,
            messages: [
              { role: 'system', content: '你是灵犀引擎的子任务执行器，拥有工具调用能力。' },
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

      // ── 无工具时走原始纯文本模式 ──
      const prompt = `你是一个独立子任务执行器。请完成以下任务，直接给出结果，不要有多余解释。

任务目标：${task.objective}

完成结果：`;

      const response = await this.aiClient.chat.completions.create({
        model: task.model || this.aiModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: 8192,  // P1-5: 从 2048 提升到 8192
        signal: controller.signal,
      });

      task.result = response.choices[0]?.message?.content || '(无结果)';
      task.status = 'completed';
      task.completedAt = Date.now();
      if (task.onProgress) task.onProgress('execute', 'done', (task.result || '').slice(0, 200));
    } catch (err: any) {
      if (err.name === 'AbortError') return; // 已处理
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
    // 安全修复 P1#15：完成后 5 分钟自动清理，防止 tasks Map 无限增长内存泄漏
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'timeout') {
      const tid = task.id;
      const t = setTimeout(() => { this.tasks.delete(tid); this.running.delete(tid); }, 5 * 60 * 1000);
      if (t.unref) t.unref();
    }
  }
}
