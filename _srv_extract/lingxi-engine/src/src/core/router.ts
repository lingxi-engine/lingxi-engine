import { runToolsLoop } from "../tools/executor.js";
import type { ChatMessage } from "../tools/executor.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolRegistryInterface, Agent, Database, AgentManager, AIClientResult } from "../types/index.js";
import { MemoryReflector, type MemoryFact, type ReflectionResult } from "./memory-reflector.js";
import { MemorySearch, type SearchableDocument } from "./memory-search.js";
import { compactMessages } from "./compaction.js";
import { shouldCreateSkill, createSkillFromSession } from "../tools/auto-skill.js";
import { UsageTracker } from "./usage-tracker.js";
import { RAGEngine, type RAGDocument, type RAGSearchResult } from "./rag-engine.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir, platform, arch, tmpdir } from "os";
import { execSync } from "child_process";
import { getChatMemory, upsertChatMemory, getDB, getChatMode } from "../storage/db.js";
import { GoalTracker } from "./goal-tracker.js";
import { dispatchByMode, type ModeDispatchResult } from "./chat-modes.js";

/**
 * 检测当前系统可访问的磁盘盘符（Windows）或挂载点（Linux/Mac）
 * 返回逗号分隔的盘符列表，如 "C:, D:, E:"
 */
function getAvailableDrives(): string {
  const isWin = platform() === 'win32';
  if (isWin) {
    // Windows: 遍历 A-Z 检测盘符
    const drives: string[] = [];
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i); // A=65
      const drivePath = letter + ':\\';
      try {
        if (existsSync(drivePath)) {
          drives.push(letter + ':');
        }
      } catch {
        // 跳过不可访问的盘符
      }
    }
    return drives.length > 0 ? drives.join(', ') : 'C:';
  } else {
    // Linux/Mac: 检查 / 和 /home
    try {
      const mounts: string[] = [];
      if (existsSync('/')) mounts.push('/');
      if (existsSync('/home')) mounts.push('/home');
      return mounts.length > 0 ? mounts.join(', ') : '/';
    } catch {
      return '/';
    }
  }
}

/**
 * 检测 Python 是否可用，以及 python-docx 库是否已安装
 * 缓存结果避免每次构建 prompt 都执行命令
 */
let _pythonCheckCache: { available: boolean; docxAvailable: boolean } | null = null;
function isPythonAvailable(): boolean {
  if (_pythonCheckCache) return _pythonCheckCache.available;
  try {
    const pyCmd = process.platform === 'win32' ? 'python --version' : 'python3 --version';
    execSync(pyCmd, { timeout: 5000, stdio: 'pipe' });
    _pythonCheckCache = { available: true, docxAvailable: false };
    // 顺便检查 python-docx（非阻塞，失败不影响主流程）
    try {
      const checkCmd = process.platform === 'win32' ? 'python -c "import docx"' : 'python3 -c "import docx"';
      execSync(checkCmd, { timeout: 5000, stdio: 'pipe' });
      _pythonCheckCache.docxAvailable = true;
    } catch {
      // python-docx 未安装，但 Python 本身可用
    }
    return true;
  } catch {
    _pythonCheckCache = { available: false, docxAvailable: false };
    return false;
  }
}

/**
 * 发现项目上下文文件（AGENTS.md / CLAUDE.md / .cursorrules）
 * 扫描顺序: 项目根目录 → ~/.config/lingxi/ → 全局（跳过 Windows 上不存在的 /etc）
 */
function discoverProjectContext(workDir: string): string {
  const candidateNames = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'];
  const searchPaths = [workDir];

  // Linux/Mac 用户级配置
  try {
    const userConfig = join(homedir(), '.config', 'lingxi');
    searchPaths.push(userConfig);
  } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }

  // 全局配置（Linux）
  if (process.platform !== 'win32') {
    searchPaths.push('/etc/lingxi');
  }

  const found: string[] = [];
  for (const dir of searchPaths) {
    for (const name of candidateNames) {
      const fullPath = join(dir, name);
      try {
        if (existsSync(fullPath)) {
          const raw = readFileSync(fullPath, 'utf8');
          const content = raw.length > 3000 ? raw.slice(0, 3000) + '\n...[内容已截断]' : raw;
          found.push(`### ${name} (${fullPath})\n${content}`);
        }
      } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }
    }
  }

  if (found.length > 0) {
    return '\n## 项目上下文 (from AGENTS.md / CLAUDE.md / .cursorrules)\n\n' + found.join('\n\n---\n\n');
  }

  return '';
}

// 缓存上下文避免每次请求都读磁盘
let _cachedContext: { workDir: string; content: string; mtime: number } | null = null;
function getProjectContext(workDir?: string): string {
  const cwd = workDir || process.cwd();
  const now = Date.now();
  // 60 秒缓存
  if (_cachedContext && _cachedContext.workDir === cwd && (now - _cachedContext.mtime) < 60000) {
    return _cachedContext.content;
  }
  const content = discoverProjectContext(cwd);
  _cachedContext = { workDir: cwd, content, mtime: now };
  return content;
}



export class MessageRouter {
  private toolRegistry?: ToolRegistry;
  private reflector?: MemoryReflector;
  private memorySearch: MemorySearch = new MemorySearch();
  private ragEngine: RAGEngine = new RAGEngine();
  private reflectionCounts: Map<string, number> = new Map();
  private readonly REFLECT_EVERY_N_MESSAGES = 5;

  constructor(
    // db 和 agentManager 使用精确接口类型
    // aiHub 保留 any —— OpenAI SDK 返回类型无法在接口层静态表达
    private db: Database,
    private agentManager: AgentManager,
    private aiHub: any,
  ) {}

  /** 注入工具注册中心（在 index.ts 初始化后调用） */
  setToolRegistry(registry: ToolRegistry) {
    this.toolRegistry = registry;
  }

  /** 注入 AI 客户端（用于记忆反思） */
  setAIClient(client: unknown, model: string) {
    this.reflector = new MemoryReflector(client as any, model);
  }

  async handleIncoming(event: { chatId: string; senderType: 'user' | 'agent'; senderId: string; content: string; replyTo?: string }): Promise<ModeDispatchResult & { shouldRespond: boolean; agentsInChat: Agent[] }> {
    const { chatId, senderType, senderId, content } = event;
    const msgId = 'msg-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8);
    this.db.addMessage({ id: msgId, chatId, senderType, senderId, content, type: 'text', replyTo: event.replyTo, timestamp: Date.now() });
    const participants = this.db.getChatParticipants(chatId);
    const agentsInChat = participants.filter(p => p.agent_id).map(p => this.agentManager.get(p.agent_id!)).filter((a): a is Agent => a !== undefined);
    const mentionedAgents = agentsInChat.filter(a => content.includes('@' + a.displayName) || content.includes('@' + a.id));

    // 群聊协作模式（持久化于 chats.chat_mode，重启不丢）
    const chatMode = getChatMode(chatId);

    if (senderType === 'user') {
      // 统一交给 chat-modes 调度器（free/route/debate/chain/roundtable/vote 六模式）
      const dispatch = await dispatchByMode(chatId, chatMode, senderId, senderType, content, agentsInChat, this.agentManager, this.db, this.aiHub);
      // 把调度结果里的触发消息 id 回填为真实落库的 msgId（保证 RAG 检索与 replyTo 正确）
      let responses = dispatch.responses.map(r => ({ ...r, triggerMessage: { ...r.triggerMessage, id: msgId } }));
      // free 模式保留"@提及则仅被 @ 的 AI 回复"的既有行为
      if (chatMode === 'free' && mentionedAgents.length > 0) {
        responses = responses.filter(r => mentionedAgents.some(a => a.id === r.agentId));
      }
      return { shouldRespond: responses.length > 0, responses, needsFollowUp: dispatch.needsFollowUp, followUpContext: dispatch.followUpContext, agentsInChat };
    } else {
      // Agent 发的消息：其他 Agent 按 autonomy 决定是否回复
      const responses: ModeDispatchResult['responses'] = [];
      for (const agent of agentsInChat) {
        if (senderId === agent.id) continue;
        if (this.shouldAgentRespond(agent, content, senderType)) {
          if (mentionedAgents.length > 0 && !mentionedAgents.includes(agent)) continue;
          responses.push({ chatId, agentId: agent.id, triggerMessage: { id: msgId, content, senderId } });
        }
      }
      return { shouldRespond: responses.length > 0, responses, agentsInChat };
    }
  }

  private matchAgentScore(agent: Agent, content: string): number {
    // 简单关键词匹配：Agent 名字/描述里的词在消息中出现就加分
    const text = content.toLowerCase();
    let score = 0;
    const nameWords = (agent.displayName || '').toLowerCase().split(/[\s,，、]+/).filter((w: string) => w.length > 1);
    for (const w of nameWords) if (text.includes(w)) score += 10;
    const personalityWords = (agent.personality || '').toLowerCase().split(/[\s,，、]+/).filter((w: string) => w.length > 2);
    for (const w of personalityWords) if (text.includes(w)) score += 1;
    return score;
  }

  private shouldAgentRespond(agent: Agent, content: string, senderType: 'user' | 'agent'): boolean {
    const mentioned = content.includes('@' + agent.displayName) || content.includes('@' + agent.id);
    if (mentioned) return true;
    switch (agent.autonomy) {
      case 'passive':
        return false;
      case 'semi':
        return senderType === 'user';
      case 'full':
        return true;
      default:
        return false;
    }
  }

  /**
   * 生成 AI 回复 —— 支持流式 + 工具调用循环
   * 如果 Agent 绑定了技能（有工具），走 runToolsLoop
   * 否则走普通 chat.completions.create
   * @param onChunk - 可选流式回调，每收到一个 chunk 就回调
   */
  async generateReply(
    chatId: string,
    agentId: string,
    triggerMsgId: string,
    onChunk?: (chunk: string) => void,
    onThink?: (thinkChunk: string) => void,
    taskGoal?: string,
    onBroadcast?: (event: any) => void,
    customPrompt?: string,
    signal?: AbortSignal
  ): Promise<string> {
    const agent = this.agentManager.get(agentId);
    if (!agent) throw new Error('Agent not found: ' + agentId);

    const recentMessages = this.db.listMessages(chatId, 100);
    // 检索知识库上下文（如果有）
    let ragContext = '';
    let memoryContext = '';
    try {
      const triggerMsg = recentMessages.find(m => m.id === triggerMsgId);
      const triggerContent = triggerMsg?.content || recentMessages[recentMessages.length - 1]?.content || '';
      ragContext = await this.getRagContextForReply(triggerContent);
      // v2.0.7: 语义记忆召回 — 搜索用户消息相关的历史记忆（按 agentId 过滤，防止串记忆）
      const allHits = this.memorySearch.search(triggerContent, 10, 0.15);
      const memoryHits = allHits.filter(h => {
        const meta = h.metadata as any;
        if (!meta) return true;
        // 按 agentId + chatId 双重过滤：防止跨 agent 和跨聊天串记忆
        const sameAgent = meta.agentId === agentId || !meta.agentId;
        const sameChat = !meta.chatId || meta.chatId === chatId;
        return sameAgent && sameChat;
      }).slice(0, 3);
      if (memoryHits.length > 0) {
        memoryContext = '\n\n## 相关历史记忆\n' + memoryHits.map(h => `- ${h.text}`).join('\n');
      }
    } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }
    // 协作模式指令（辩论立场/链式步骤/圆桌轮次/投票选项/路由裁决等）注入 system prompt
    const modePrompt = customPrompt ? '\n\n## 当前协作模式指令（必须遵守）\n' + customPrompt : '';
    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystemPrompt(agent, taskGoal, chatId) + ragContext + memoryContext + modePrompt },
      ...recentMessages.map(m => ({
        role: (m.sender_type === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      })),
    ];

    // 获取 AI 客户端（model 为空时用默认模型）
    const requestedModel = agent.model || this.aiHub.getDefaultModel?.() || '';
    const clientResult = this.aiHub.getClient(requestedModel);
    if (!clientResult) {
      throw new Error('找不到模型 ' + agent.model + '，且无可用 fallback');
    }
    const { client, resolvedModel } = clientResult;

    // ── 多模型协作：工具用轻量模型，回复用强模型 ──
    const toolClient = this.aiHub.getRoleClient('tool') || clientResult;
    const replyClient = this.aiHub.getRoleClient('reply') || clientResult;

    // ── 上下文压缩：超限时用工具模型摘要旧消息 ──
    const compactResult = await compactMessages(messages, {
      client: toolClient.client,
      model: toolClient.resolvedModel,
      maxTokens: 30000,
      keepRecent: 10,
      keepSystem: true,
    });
    const messagesFinal = compactResult.messages as ChatMessage[];

    let finalContent = '';

    // ── 判断是否有工具可用 ──
    const agentTools = this.toolRegistry ? this.toolRegistry.listToolsForAgent(agentId) : [];
    console.log(`[Router] generateReply: agentId=${agentId}, agentModel=${agent.model}, tools=${agentTools.length}`);

    // ── 尝试流式 ──
    const useStream = !!onChunk;

    if (agentTools.length > 0) {
      // 有工具：走工具调用循环，最终回复支持流式
      console.log(`[Router] Agent ${agent.displayName} 有 ${agentTools.length} 个可用工具，启动工具调用循环`);
      try {
      // 总超时控制：2 分钟兜底，防止 AI 响应慢或工具卡住导致前端无响应
      const TOTAL_TIMEOUT = 600000;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TOTAL_TIMEOUT);
      // ⭐ 停止生成：外部信号 abort 时同步中断内部 controller
      const onExternalAbort = () => controller.abort();
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener('abort', onExternalAbort);
      }

      const result = await runToolsLoop({
        client: toolClient.client,
        model: toolClient.resolvedModel,
        messages: messagesFinal as any,
        registry: this.toolRegistry!,
        agentId,
        chatId,
        maxIterations: 50,
        temperature: 0.7,
        maxTokens: 16384,
        signal: controller.signal,
        onToolCall: onBroadcast ? (e) => onBroadcast({ type: 'tool.call', ...e }) : undefined,
        onToolResult: onBroadcast ? (e) => onBroadcast({ type: 'tool.result', ...e }) : undefined,
        onThink: onThink,
      }).finally(() => {
        clearTimeout(timeoutId);
        if (signal) signal.removeEventListener('abort', onExternalAbort);
      });
      // ⭐ 用户停止：runToolsLoop 仅在轮次间检查 abort，这里统一转成 throw 让上层按"已停止"处理
      if (signal?.aborted) {
        const abortErr: any = new Error('生成已停止');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
        finalContent = result.finalContent;
        if (result.toolResults.length > 0) {
          const toolNames = result.toolResults.map(r => r.toolName).join(', ');
          console.log(`[Router] 工具调用完成: ${toolNames}, ${result.iterations} 轮`);
          // ── 自动技能创建：复杂任务完成后自动总结经验 ──
          if (shouldCreateSkill(result.toolResults, messagesFinal as any)) {
            createSkillFromSession(toolClient.client, toolClient.resolvedModel, messagesFinal as any, result.toolResults).catch(err => {
              console.error('[Router] 自动技能创建失败:', err.message);
            });
          }
        }
        // 工具调用后有最终回复时，按词块流式输出（比逐字快3倍，体验更自然）
        if (finalContent && onChunk) {
          const chunks = finalContent.match(/[^\s，。！？、；：]+[\s，。！？、；：]?/g) || [finalContent];
          for (const chunk of chunks) {
            onChunk(chunk);
            await new Promise(r => setTimeout(r, 15));
          }
        }
      } catch (err: any) {
        // ⭐ 用户停止：不回退重新生成，直接抛给上层按"已停止"处理
        if (signal?.aborted) throw err;
        console.error(`[Router] 工具调用循环失败，回退普通回复:`, err.message);
        const response = await replyClient.client.chat.completions.create({
          model: replyClient.resolvedModel,
          messages: messagesFinal as any,
          temperature: 0.7,
          max_tokens: 16384,
        });
        if (response.usage) UsageTracker.record({ model: replyClient.resolvedModel, promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens, type: 'reply' });
        // 提取推理内容
        if (onThink) {
          const r = (response.choices[0].message as any)?.reasoning_content;
          if (r) onThink(r);
        }
        finalContent = response.choices[0].message.content || '';
        // 回退也走词块流式
        if (finalContent && onChunk) {
          const chunks = finalContent.match(/[^\s，。！？、；：]+[\s，。！？、；：]?/g) || [finalContent];
          for (const chunk of chunks) {
            onChunk(chunk);
            await new Promise(r => setTimeout(r, 15));
          }
        }
      }
    } else if (useStream) {
      // 没有工具 + 流式：逐 chunk 回调
      console.log(`[Router] Agent ${agent.displayName} 流式生成`);
      try {
        const stream = await replyClient.client.chat.completions.create({
          model: replyClient.resolvedModel,
          messages: messagesFinal as any,
          temperature: 0.7,
          max_tokens: 16384,
          stream: true,
        }, signal ? { signal } : undefined);
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.reasoning_content && onThink) onThink(delta.reasoning_content);
          const content = delta?.content || '';
          if (content) {
            finalContent += content;
            onChunk(content);
          }
          if ((chunk as any).usage) {
            UsageTracker.record({
              model: replyClient.resolvedModel,
              promptTokens: (chunk as any).usage.prompt_tokens,
              completionTokens: (chunk as any).usage.completion_tokens,
              type: 'reply',
            });
          }
        }
      } catch (err: any) {
        // ⭐ 用户停止：不回退重新生成，直接抛给上层按"已停止"处理
        if (signal?.aborted) throw err;
        console.error(`[Router] 流式生成失败，回退普通:`, err.message);
        const response = await replyClient.client.chat.completions.create({
          model: replyClient.resolvedModel,
          messages: messagesFinal as any,
          temperature: 0.7,
          max_tokens: 16384,
        });
        if (response.usage) UsageTracker.record({ model: replyClient.resolvedModel, promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens, type: 'reply' });
        if (onThink) {
          const r = (response.choices[0].message as any)?.reasoning_content;
          if (r) onThink(r);
        }
        finalContent = response.choices[0].message.content || '';
      }
    } else {
      // 没有工具 + 非流式：普通聊天
      const response = await replyClient.client.chat.completions.create({
        model: replyClient.resolvedModel,
        messages: messagesFinal as any,
        temperature: 0.7,
        max_tokens: 16384,
      }, signal ? { signal } : undefined);
      if (response.usage) UsageTracker.record({ model: replyClient.resolvedModel, promptTokens: response.usage.prompt_tokens, completionTokens: response.usage.completion_tokens, type: 'reply' });
      finalContent = response.choices[0].message.content || '';
    }

    // 保存回复消息
    const replyId = 'msg-' + Date.now() + '-' + crypto.randomUUID().slice(0, 8);
    this.db.addMessage({ id: replyId, chatId, senderType: 'agent', senderId: agent.id, content: finalContent, type: 'text', replyTo: triggerMsgId, timestamp: Date.now() });

    // 更新记忆
    const exchangeSummary = `[${new Date().toLocaleString('zh-CN')}] ${agent.displayName} 在 ${chatId} 回复说: ${finalContent.slice(0, 200)}`;
    // v1.4.0: 群聊独立记忆 — 群聊写入 chat_memories
    if (chatId) {
      const existing = getChatMemory(chatId, agent.id);
      const prevSummary = existing?.memory_summary || '';
      const updated = prevSummary ? prevSummary + '\n' + exchangeSummary : exchangeSummary;
      const trimmed = updated.length > 2000 ? updated.slice(-2000) : updated;
      const prevFacts = (() => {
        try { return JSON.parse(existing?.memory_facts || '{}'); } catch { return {}; }
      })();
      // v2.0.7: 删除正则事实提取（从 AI 回复提取用户事实是 bug，交给 MemoryReflector/Dreamer 统一处理）
      upsertChatMemory(chatId, agent.id, trimmed, prevFacts);
    }
    this.db.appendMemorySummary(agent.id, exchangeSummary);

    // ── 触发记忆反思（每 N 条消息压缩一次，按 agentId 独立计数） ──
    // v1.4.0: 群聊独立计数
    const reflectKey = chatId ? `${chatId}:${agent.id}` : agent.id;
    const agentCount = (this.reflectionCounts.get(reflectKey) || 0) + 1;
    this.reflectionCounts.set(reflectKey, agentCount);
    if (agentCount >= this.REFLECT_EVERY_N_MESSAGES) {
      this.reflectionCounts.set(reflectKey, 0);
      this.triggerReflection(agent.id, chatId).catch(err => {
        console.error(`[Router] 记忆反思失败:`, err.message);
      });
    }

    // v2.0.7: 语义索引存用户消息（之前存 AI 回复，搜出来全是 AI 说的话）
    const triggerMsg = recentMessages.find(m => m.id === triggerMsgId);
    // fallback: 找最后一条用户消息（避免 cron 定时任务把 AI 回复当用户消息存）
    const lastUserMsg = [...recentMessages].reverse().find(m => m.sender_type === 'user');
    const userContent = triggerMsg?.sender_type === 'user' ? triggerMsg.content : (lastUserMsg?.content || '');
    if (userContent) {
      this.memorySearch.addDocument({
        id: triggerMsgId ? `${triggerMsgId}:${agent.id}` : ('user-' + Date.now()),
        text: userContent,
        source: 'messages',
        metadata: { agentId: agent.id, chatId, timestamp: Date.now() },
      });
    }

    return finalContent;
  }

  private buildSystemPrompt(agent: Agent, taskGoal?: string, chatId?: string): string {
    // 获取当前模型信息
    const toolModel = process.env.TOOL_MODEL || process.env.DEFAULT_MODEL || '默认';
    const replyModel = process.env.REPLY_MODEL || process.env.DEFAULT_MODEL || '默认';
    const allModels = this.aiHub.listModels().map((m: any) => m.id).join(', ');
    
    const lines: string[] = [
      '你是「灵犀引擎」上的 AI 助手，名叫 ' + agent.displayName + '。',
      agent.personality || '你是一个智能、务实、有主见的 AI 助手。',
      '',
      '## 你的运行环境（事实，不要质疑）',
      '- 操作系统: ' + process.platform + ' ' + process.arch,
      '- 可访问磁盘: ' + getAvailableDrives(),
      '- 工作目录: ' + process.cwd(),
      '- Python 可用: ' + (isPythonAvailable() ? '是' : '否'),
      '- 工具调用模型: ' + toolModel,
      '- 回复模型: ' + replyModel,
      '- 可用模型列表: ' + allModels,
      '- 当用户问你用什么模型时，直接告诉对方：工具调用用 ' + toolModel + '，最终回复用 ' + replyModel + '。',
      '- 以上环境信息是引擎自动注入的事实。你确实可以访问这些磁盘和路径，不要怀疑自己的文件访问能力。',
      '',
      '## 核心原则',
      '- 先思考再回答。复杂问题分步推理，不要急着给结论。',
      '- 有工具就主动用。需要查信息就搜索，需要算就算，需要读文件就读。不要自己瞎猜。',
      '- 回答要有信息密度。不要说废话、不要重复用户的问题、不要"好的我来帮你"这种废话。直接给答案。',
      '- 诚实。不确定就说不确定，做不了就说做不了。不要编造。',
      '- 用中文回答，除非用户用其他语言提问。',
      '',
      '## 工具使用规则',
      '- 当用户要求查询时间、计算、搜索网络、读写文件、列目录、执行命令时，必须调用对应工具，不要自己写代码模拟。',
      '- 文件操作可以访问任意路径（C盘、D盘、E盘等），这是事实，不是虚拟路径。',
      '- shell_exec 可执行任意命令，包括 Python 脚本。当 write_file 无法处理二进制文件格式（如 docx/xlsx/pptx）时，使用 shell_exec 调用 python-docx 等 Python 库操作。',
      '- write_file 仅支持纯文本写入，不支持 docx/xlsx/pptx 等二进制格式。需要操作这些格式时直接用 shell_exec + Python 脚本。',
      '- read_file 支持 docx/xlsx/pptx/pdf 等 Office 格式的读取（引擎内置解析）。',
      '',
      '## 错误处理铁律',
      '- 任何工具失败后，先用最小代价验证前提假设（一行 Python 命令、一个 list_dir 调用），再决定下一步。',
      '- 禁止在未验证的情况下向用户宣布"我做不到"或"我无法访问"。先验证，再下结论。',
      '- 同一方法失败 2 次必须切换工具链，不得原样重试。例如 write_file 失败 → 切换 shell_exec + Python 脚本。',
      '- 遇到不确定的能力边界时，先跑一个轻量级自检（如 shell_exec 执行 python -c "import docx; print(\'ok\')"），不要靠推理猜测。',
      '- 工具失败后如实告诉用户失败原因，并立刻给出备选方案，不要只报错不解决。',
      '',
    ];

    if (taskGoal) {
      lines.push(
        '## 当前任务',
        '你正在执行一个自主任务：「' + taskGoal + '」',
        '',
        '- 把目标拆成小步骤，一步一步做',
        '- 主动调用工具：web_search 搜索、scrape_url 抓网页、code_execute 写代码、write_file 存结果、read_file 读文件',
        '- 每完成一步，简短汇报进展',
        '- 遇到困难换种方式再试，不要停',
        '- 全部完成后说「任务完成」',
        '- 确实做不了就诚实说明原因',
        '',
      );
    } else {
      lines.push(
        '## 对话风格',
        '- 简洁有力，像一个很聪明的真人在聊天。',
        '- 有观点、有判断，不要什么都"你说得对"。',
        '- 可以主动开启话题或提出建议。',
        '- 需要工具时直接调用，不用问用户"要不要我帮你查"。',
        '',
      );
    }

    // 工具列表
    if (this.toolRegistry) {
      const tools = this.toolRegistry.listToolsForAgent(agent.id);
      if (tools.length > 0) {
        lines.push('## 可用工具');
        for (const t of tools) {
          const params = Object.entries(t.parameters.properties || {})
            .map(([k, v]: any) => `${k}(${v.type})`)
            .join(', ');
          lines.push(`- **${t.name}**: ${t.description.slice(0, 80)} [${params}]`);
        }
        lines.push('');
      }
    }

    // 记忆注入
    if (agent.memory_summary) {
      lines.push('## 你的记忆', agent.memory_summary, '');
    }

    // 记忆事实注入
    if (agent.memory_facts) {
      try {
        const facts = typeof agent.memory_facts === 'string' ? JSON.parse(agent.memory_facts) : agent.memory_facts;
        if (facts && typeof facts === 'object' && Object.keys(facts).length > 0) {
          lines.push('## 关于用户的关键事实');
          for (const [key, value] of Object.entries(facts)) {
            lines.push(`- ${key}: ${value}`);
          }
          lines.push('');
        }
      } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }
    }

    // v1.7.0: 实体注入（从数据库读取已知实体）
    if (chatId) {
      try {
        const db = getDB();
        const stmt = db.prepare('SELECT type, value, count FROM entities WHERE chat_id = ? AND agent_id = ? ORDER BY count DESC LIMIT 10');
        stmt.bind([chatId, agent.id]);
        const entities: { type: string; value: string; count: number }[] = [];
        while (stmt.step()) entities.push(stmt.getAsObject() as { type: string; value: string; count: number });
        stmt.free();
        if (entities.length > 0) {
          lines.push('已知实体');
          for (const e of entities) {
            lines.push(`- ${e.type}: ${e.value} (出现${e.count}次)`);
          }
          lines.push('');
        }
      } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }
    }

    // v1.4.0: 群聊独立记忆注入
    if (chatId) {
      const chatMem = getChatMemory(chatId, agent.id);
      if (chatMem?.memory_summary) {
        lines.push('## 当前群聊记忆', chatMem.memory_summary, '');
      }
      if (chatMem?.memory_facts) {
        try {
          const facts = typeof chatMem.memory_facts === 'string' ? JSON.parse(chatMem.memory_facts) : chatMem.memory_facts;
          if (facts && typeof facts === 'object' && Object.keys(facts).length > 0) {
            lines.push('## 当前群聊用户偏好');
            for (const [key, value] of Object.entries(facts)) {
              lines.push(`- ${key}: ${value}`);
            }
            lines.push('');
          }
        } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }
      }
    }

    // v1.7.1: 项目目标追踪 — 注入到 system prompt
    if (taskGoal) {
      try {
        const projectId = `project-${chatId || agent.id}`;
        const summary = GoalTracker.getProgressSummary(projectId);
        if (summary) {
          lines.push(summary);
        }
      } catch { /* goal tracker 未初始化时跳过 */ }
    }

    // AGENTS.md 项目上下文自动注入
    try {
      const projectContext = getProjectContext();
      if (projectContext) {
        lines.push(projectContext);
      }
    } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }

    return lines.join('\n');
  }

  // ────── 记忆反思 ──────

  /**
   * 触发记忆反思：压缩 memory_summary → 结构化要点
   * 异步执行，不阻塞回复
   */
  private async triggerReflection(agentId: string, chatId?: string): Promise<void> {
    if (!this.reflector) return;
    const agent = this.agentManager.get(agentId);
    if (!agent) return;

    // v1.4.0: 群聊独立记忆 — 从 chat_memories 读取
    let rawSummary = '';
    let existingFacts: MemoryFact[] = [];
    if (chatId) {
      const chatMem = getChatMemory(chatId, agentId);
      rawSummary = chatMem?.memory_summary || '';
      try {
        const parsed = typeof chatMem?.memory_facts === 'string' ? JSON.parse(chatMem.memory_facts) : (chatMem?.memory_facts || '{}');
        if (Array.isArray(parsed)) {
          existingFacts = parsed;
        } else if (typeof parsed === 'object') {
          existingFacts = Object.entries(parsed).map(([key, value]) => ({ key, value: String(value), updatedAt: Date.now() }));
        }
      } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }
    }
    // fallback: 全局记忆
    if (!rawSummary.length) {
      rawSummary = agent.memorySummary || agent.memory_summary || '';
      try {
        const rawFacts = agent.memoryFacts || agent.memory_facts || '{}';
        const parsed = typeof rawFacts === 'string' ? JSON.parse(rawFacts) : rawFacts;
        if (Array.isArray(parsed)) {
          existingFacts = parsed;
        } else if (typeof parsed === 'object') {
          existingFacts = Object.entries(parsed).map(([key, value]) => ({ key, value: String(value), updatedAt: Date.now() }));
        }
      } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }
    }

    if (rawSummary.length < 20) return;

    console.log(`[Router] 触发记忆反思: agentId=${agentId}, chatId=${chatId||'全局'}, summary=${rawSummary.length}字, facts=${existingFacts.length}条`);

    const result: ReflectionResult = await this.reflector.reflect(rawSummary, existingFacts);

    const factsObj = result.facts.reduce((acc, f) => {
      (acc as Record<string, string>)[f.key] = String(f.value);
      return acc;
    }, {} as Record<string, string>);

    // v1.4.0: 群聊独立记忆 — 写入 chat_memories
    if (chatId) {
      upsertChatMemory(chatId, agentId, result.summary, factsObj);
    } else {
      this.db.updateAgentMemory(agentId, result.summary, factsObj);
    }

    console.log(`[Router] 记忆反思完成: ${result.originalLength}字 → ${result.compressedLength}字, ${result.facts.length}条事实`);

    // 同步更新搜索索引
    const idxKey = chatId ? `${chatId}:${agentId}` : agentId;
    this.memorySearch.addDocument({
      id: 'summary-' + idxKey,
      text: result.summary,
      source: 'summary',
      metadata: { agentId, chatId: chatId || '' },
    });
    for (const fact of result.facts) {
      this.memorySearch.addDocument({
        id: 'fact-' + idxKey + '-' + fact.key,
        text: fact.key + ': ' + fact.value,
        source: 'facts',
        metadata: { agentId, chatId: chatId || '' },
      });
    }
  }

  // ────── 记忆搜索 ──────

  /**
   * 搜索 Agent 的记忆
   * @param query - 搜索关键词
   * @param topK - 返回前 K 个结果
   */
  searchMemory(query: string, topK: number = 5) {
    return this.memorySearch.search(query, topK);
  }

  /**
   * 重建搜索索引（从数据库加载所有消息和记忆）
   */
  rebuildSearchIndex() {
    this.memorySearch.clear();
    const agents = this.db.listAgents();
    for (const agent of agents) {
      // 加入 memory_summary
      if (agent.memory_summary) {
        this.memorySearch.addDocument({
          id: 'summary-' + agent.id,
          text: agent.memory_summary,
          source: 'summary',
          metadata: { agentId: agent.id },
        });
      }
      // 加入 memory_facts
      try {
        const rawFacts = typeof agent.memory_facts === 'string' ? agent.memory_facts : JSON.stringify(agent.memory_facts || {});
        const facts = JSON.parse(rawFacts);
        for (const [key, value] of Object.entries(facts)) {
          this.memorySearch.addDocument({
            id: 'fact-' + agent.id + '-' + key,
            text: key + ': ' + String(value),
            source: 'facts',
            metadata: { agentId: agent.id },
          });
        }
      } catch (e: unknown) { console.warn('[Router] Non-critical error:', (e as Error)?.message || e); }
    }
    // v2.0.7: 补充 chat_memories 到索引
    try {
      const db = getDB();
      const stmt = db.prepare('SELECT chat_id, agent_id, memory_summary, memory_facts FROM chat_memories');
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        if (row.memory_summary) {
          this.memorySearch.addDocument({
            id: 'chat-summary-' + row.chat_id + '-' + row.agent_id,
            text: row.memory_summary,
            source: 'summary',
            metadata: { agentId: row.agent_id, chatId: row.chat_id },
          });
        }
        if (row.memory_facts) {
          try {
            const facts = JSON.parse(row.memory_facts);
            for (const [key, value] of Object.entries(facts)) {
              this.memorySearch.addDocument({
                id: 'chat-fact-' + row.chat_id + '-' + row.agent_id + '-' + key,
                text: key + ': ' + String(value),
                source: 'facts',
                metadata: { agentId: row.agent_id, chatId: row.chat_id },
              });
            }
          } catch {}
        }
      }
      stmt.free();
    } catch (e: unknown) { console.warn('[Router] chat_memories 索引重建失败:', (e as Error)?.message || e); }
    // v2.0.7: 补充最近用户消息到索引（重启后不丢原始对话记忆）
    try {
      const db = getDB();
      const stmt = db.prepare(`SELECT id, chat_id, sender_id, content FROM messages WHERE sender_type = 'user' ORDER BY timestamp DESC LIMIT 500`);
      while (stmt.step()) {
        const row = stmt.getAsObject() as any;
        if (row.content && row.content.length > 5) {
          this.memorySearch.addDocument({
            id: 'msg-' + row.id,
            text: row.content,
            source: 'messages',
            // 用户消息不带 agentId，只带 chatId — 同 chat 所有 agent 共享，靠 chatId 隔离
            metadata: { chatId: row.chat_id },
          });
        }
      }
      stmt.free();
    } catch (e: unknown) { console.warn('[Router] messages 索引重建失败:', (e as Error)?.message || e); }
    this.memorySearch.buildIndex();
    console.log(`[Router] 搜索索引已重建: ${this.memorySearch.size} 条文档`);
  }

  // ────── RAG 知识库 ──────

  /**
   * 获取 RAG 引擎实例
   */
  getRAG(): RAGEngine {
    return this.ragEngine;
  }

  /**
   * 初始化 RAG 引擎（从数据库加载已存在的文档）
   */
  initRAG(): void {
    // 从数据库加载文档和块
    const docs = (this.db as Database).listRagDocuments?.() || [];
    if (docs.length > 0) {
      const allDocs: RAGDocument[] = docs.map((d: any) => ({
        id: d.id,
        title: d.title,
        source: d.source,
        mimeType: d.mime_type || 'text/plain',
        content: d.content,
        createdAt: d.created_at,
        metadata: JSON.parse(d.metadata || '{}'),
      }));
      const allChunks = (this.db as any).listRagChunks?.() || [];
      this.ragEngine.importData({
        documents: allDocs,
        chunks: allChunks,
      });
      console.log(`[Router] RAG 知识库已加载: ${allDocs.length} 文档, ${allChunks.length} 块`);
    } else {
      this.ragEngine.buildIndex();
      console.log(`[Router] RAG 知识库为空，已初始化`);
    }
  }

  /**
   * 添加文档到知识库
   */
  async addRagDocument(doc: RAGDocument): Promise<number> {
    // 容错：确保 content 是字符串
    const contentStr = typeof doc.content === 'string' ? doc.content : String(doc.content || '');
    const safeDoc: RAGDocument = { ...doc, content: contentStr };
    const chunkCount = await this.ragEngine.addDocument(safeDoc);
    // 持久化到数据库
    try {
      (this.db as any).insertRagDocument?.({
        id: safeDoc.id,
        title: safeDoc.title,
        source: safeDoc.source,
        mimeType: safeDoc.mimeType,
        content: contentStr,
        metadata: safeDoc.metadata || {},
        createdAt: safeDoc.createdAt,
      });
      // 插入所有块
      const chunks = this.ragEngine.exportData().chunks.filter(c => c.docId === safeDoc.id);
      for (const chunk of chunks) {
        (this.db as any).insertRagChunk?.(chunk);
      }
    } catch (err: any) {
      console.error('[Router] RAG 文档持久化失败:', err.message);
    }
    return chunkCount;
  }

  /**
   * 删除知识库文档
   */
  removeRagDocument(docId: string): boolean {
    const removed = this.ragEngine.removeDocument(docId);
    if (removed) {
      try { (this.db as Database).deleteRagDocument?.(docId); } catch (e: unknown) { console.warn('[Router] deleteRagDocument failed:', (e as Error)?.message || e); }
    }
    return removed;
  }

  /**
   * 列出知识库文档
   */
  listRagDocuments() {
    return this.ragEngine.listDocuments();
  }

  /**
   * v1.4.0: 扫描 workspace 目录，自动导入文档到知识库
   */
  async scanWorkspaceForDocs(workspacePath: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
    const { readdirSync, statSync, readFileSync } = await import('fs');
    const { join, extname, basename } = await import('path');
    const result = { imported: 0, skipped: 0, errors: [] as string[] };
    const allowedExts = ['.md', '.txt', '.json', '.csv', '.html', '.py', '.ts', '.js', '.yaml', '.yml', '.toml', '.xml'];
    const maxSize = 1024 * 1024; // 1MB
    const existingDocs = this.ragEngine.listDocuments();

    const promises: Promise<void>[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return; // 最多3层
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const full = join(dir, entry);
          try {
            const st = statSync(full);
            if (st.isDirectory()) { walk(full, depth + 1); continue; }
            const ext = extname(entry).toLowerCase();
            if (!allowedExts.includes(ext)) continue;
            if (st.size > maxSize) continue;
            if (existingDocs.some((d: any) => d.source === full)) { result.skipped++; continue; }
            const content = readFileSync(full, 'utf8');
            if (content.trim().length < 10) { result.skipped++; continue; }
            const id = 'rag-auto-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
            promises.push(
              this.addRagDocument({
                id,
                title: basename(entry),
                source: full,
                mimeType: ext === '.md' ? 'text/markdown' : 'text/plain',
                content: content.slice(0, 50000),
                createdAt: Date.now(),
                metadata: { imported: 'auto', workspace: workspacePath }
              }).then(() => { result.imported++; }).catch((e: any) => {
                result.errors.push(`${entry}: ${e.message}`);
              })
            );
          } catch (e: any) { /* skip single file */ }
        }
      } catch (e: any) { /* skip dir */ }
    };

    walk(workspacePath, 0);
    await Promise.all(promises); // 等待所有导入完成
    console.log(`[RAG] 扫描完成: ${result.imported} 新文档, ${result.skipped} 跳过, ${result.errors.length} 错误`);
    return result;
  }

  /**
   * 知识库检索
   */
  searchRag(query: string, topK?: number): Promise<RAGSearchResult[]> {
    return this.ragEngine.search(query, topK);
  }

  /**
   * RAG 生成问答
   */
  async ragGenerate(query: string, options?: {
    topK?: number;
    systemPrompt?: string;
  }): Promise<{ answer: string; sources: any[]; contextUsed: number }> {
    const defaultModel = this.aiHub.getDefaultModel?.() || '';
    const result = this.aiHub.getClient(defaultModel);
    if (!result) {
      return { answer: 'AI 不可用', sources: [], contextUsed: 0 };
    }
    return this.ragEngine.generate(query, result.client, result.resolvedModel, options);
  }

  /**
   * 根据上下文检索，为 AI 回复补充知识
   * 在 generateReply 的 system prompt 里调用
   */
  async getRagContextForReply(content: string): Promise<string> {
    try {
      const hits = await this.ragEngine.search(content, 3);
      if (hits.length === 0) return '';
      return '\n\n-- 知识库参考 --\n' + hits.map((h, i) =>
        `[${i + 1}] (${h.docTitle}, 相关度${h.score})\n${h.content.slice(0, 250)}`
      ).join('\n');
    } catch {
      return '';
    }
  }
}
