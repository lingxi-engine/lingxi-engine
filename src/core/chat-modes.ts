/**
 * 群聊对话模式调度器
 * 
 * 六种模式：
 *   - free      自由模式（默认）：@触及 + autonomy 驱动
 *   - route     路由式：经理 AI 分析意图 → 自动 @ 专家 AI
 *   - debate    辩论式：N 个 AI 同时从不同立场论述 → 汇总
 *   - chain     链式：A → B → C 按序传递输出
 *   - roundtable 圆桌式：N 个 AI 轮流发言 N 轮
 *   - vote      投票式：N 个 AI 独立投票 → 统计结果
 */

import { getChatMode as dbGetChatMode, setChatMode as dbSetChatMode } from '../storage/db.js';

export type ChatMode = 'free' | 'route' | 'debate' | 'chain' | 'roundtable' | 'vote';

export interface ModeDispatchResult {
  /** 需要触发的回复列表 */
  responses: Array<{
    chatId: string;
    agentId: string;
    triggerMessage: { id: string; content: string; senderId: string };
    /** 自定义 prompt 注入（辩论/投票等场景） */
    customPrompt?: string;
    /** 延迟触发（ms），用于轮转/链式场景 */
    delayMs?: number;
    /** 链式阶段名 */
    stage?: string;
  }>;
  /** 是否需要后续轮次 */
  needsFollowUp?: boolean;
  /** 后续轮次要用到的上下文 */
  followUpContext?: any;
}

/**
 * 获取群聊当前的对话模式（持久化于 chats.chat_mode 列）
 */
export function getChatMode(chatId: string, _db?: any): ChatMode {
  return dbGetChatMode(chatId) as ChatMode;
}

/**
 * 设置群聊对话模式（持久化于 chats.chat_mode 列）
 */
export function setChatMode(chatId: string, mode: ChatMode, _db?: any): boolean {
  return dbSetChatMode(chatId, mode);
}

/**
 * 核心调度入口：根据聊天模式决定哪些 AI 应该回复，以及怎么回复
 */
export async function dispatchByMode(
  chatId: string,
  mode: ChatMode,
  senderId: string,
  senderType: 'user' | 'agent',
  content: string,
  agentsInChat: any[],
  agentManager: any,
  db: any,
  aiHub?: any
): Promise<ModeDispatchResult> {
  switch (mode) {
    case 'free':
      return dispatchFree(chatId, senderId, senderType, content, agentsInChat, agentManager);
    case 'route':
      return dispatchRoute(chatId, senderId, content, agentsInChat, agentManager, db, aiHub);
    case 'debate':
      return dispatchDebate(chatId, senderId, content, agentsInChat);
    case 'chain':
      return dispatchChain(chatId, senderId, content, agentsInChat, db);
    case 'roundtable':
      return dispatchRoundtable(chatId, senderId, content, agentsInChat, db);
    case 'vote':
      return dispatchVote(chatId, senderId, content, agentsInChat);
    default:
      return dispatchFree(chatId, senderId, senderType, content, agentsInChat, agentManager);
  }
}

// ─── 自由模式 ───────────────────────────────────────
function dispatchFree(
  _chatId: string, senderId: string, senderType: 'user' | 'agent',
  content: string, agents: any[], agentManager: any
): ModeDispatchResult {
  const responses: ModeDispatchResult['responses'] = [];
  for (const agent of agents) {
    if (senderType === 'agent' && senderId === agent.id) continue;
    if (shouldAgentRespond(agent, content, senderType)) {
      responses.push({
        chatId: _chatId,
        agentId: agent.id,
        triggerMessage: { id: 'msg-free', content, senderId },
      });
    }
  }
  // v1.9.5 兜底：用户消息没有任何 Agent 响应时，强制让第一个 Agent 回复（避免"发了消息没反应"）
  if (senderType === 'user' && responses.length === 0 && agents.length > 0) {
    const fallback = agents.find((a: any) => a.autonomy !== 'passive') || agents[0];
    responses.push({
      chatId: _chatId,
      agentId: fallback.id,
      triggerMessage: { id: 'msg-free-fallback', content, senderId },
    });
    console.log(`[ChatModes] free 模式兜底：强制分派给 ${fallback.displayName || fallback.id}`);
  }
  return { responses };
}

function shouldAgentRespond(agent: any, content: string, senderType: 'user' | 'agent'): boolean {
  const mentioned = content.includes('@' + agent.displayName) || content.includes('@' + agent.id);
  if (mentioned) return true;
  switch (agent.autonomy) {
    case 'passive': return false;
    case 'semi': return senderType === 'user';
    case 'full': return true;
    default: return false;
  }
}

// ─── 路由式 ─────────────────────────────────────────
// 找一个"经理"AI 分析意图，由其决定该 @ 谁
async function dispatchRoute(
  chatId: string, senderId: string, content: string,
  agents: any[], _agentManager: any, db: any, aiHub?: any
): Promise<ModeDispatchResult> {
  const routerAgent = agents.find((a: any) => 
    a.displayName?.toLowerCase().includes('路由') || 
    a.displayName?.toLowerCase().includes('router') ||
    a.personality?.toLowerCase().includes('router')
  ) || agents.find((a: any) => a.autonomy === 'full') || agents[0];

  if (!routerAgent) return { responses: [] };

  const otherAgents = agents.filter((a: any) => a.id !== routerAgent.id);
  
  // P0-2 修复：真正调用 AI 做路由分析，而非假装路由
  if (aiHub && otherAgents.length > 0) {
    try {
      const agentList = otherAgents.map((a: any) => 
        `- @${a.displayName}: ${a.personality ? a.personality.slice(0,80) : '通用助手'}`
      ).join('\n');
      
      const routePrompt = `你是一个路由助手。用户发的消息需要被分派给最合适的 AI 处理。

【用户消息】${content}

【可用的 AI】
${agentList}

请直接回复你要 @ 的 AI 名字（可以多个，用逗号分隔），不要任何解释。如果都不合适，回复"none"。`;

      const clientResult = aiHub.getClient(aiHub.getDefaultModel?.() || '');
      if (clientResult) {
        const resp = await clientResult.client.chat.completions.create({
          model: clientResult.resolvedModel,
          messages: [{ role: 'user', content: routePrompt }],
          temperature: 0.1,
          max_tokens: 200,
        });
        const routeResult = (resp.choices[0]?.message?.content || '').trim();
        console.log(`[ChatModes] 路由分析结果: ${routeResult}`);
        
        // 解析 AI 回复，提取被 @ 的 Agent 名字
        const selectedNames = routeResult
          .split(/[,，、\s]+/)
          .map((s: any) => s.replace(/^@/, '').trim())
          .filter(Boolean);
        
        // 匹配被选中的 Agent
        const selectedAgents = otherAgents.filter(a => 
          selectedNames.some((name: string) => 
            a.displayName === name || a.id === name || 
            a.displayName?.includes(name) || name.includes(a.displayName)
          )
        );
        
        if (selectedAgents.length > 0) {
          // 只触发被选中的 Agent
          const responses: ModeDispatchResult['responses'] = selectedAgents.map((agent, i) => ({
            chatId,
            agentId: agent.id,
            triggerMessage: { id: 'route-' + Date.now(), content, senderId },
            delayMs: i * 1500,
          }));
          return { responses };
        }
        // AI 回复 none 或无法匹配 → fallback 到 routerAgent + all full
      }
    } catch (err: any) {
      console.warn('[ChatModes] 路由 AI 分析失败，fallback:', err.message);
    }
  }

  // Fallback：路由 Agent 先回复 + 所有 full 模式 Agent 延迟触发
  const responses: ModeDispatchResult['responses'] = [];
  responses.push({
    chatId,
    agentId: routerAgent.id,
    triggerMessage: { id: 'route-' + Date.now(), content, senderId },
    customPrompt: `你是路由助手。分析用户消息：'${content}'，决定应该通知哪个 AI 处理。
可选的 AI：${otherAgents.map(a => a.displayName).join('、')}
请用 '@AI名字' 的格式告知需要呼叫的 AI，并简要说明原因。`,
  });

  for (const agent of otherAgents) {
    if (agent.autonomy === 'full') {
      responses.push({
        chatId,
        agentId: agent.id,
        triggerMessage: { id: 'route-' + Date.now(), content, senderId },
        delayMs: 2000,
      });
    }
  }

  return { responses };
}

// ─── 辩论式 ─────────────────────────────────────────
function dispatchDebate(
  chatId: string, senderId: string, content: string,
  agents: any[]
): ModeDispatchResult {
  // 所有 AI 从不同立场回答
  const participants = agents.filter((a: any) => a.autonomy !== 'passive');
  if (participants.length < 2) {
    // 不够人辩论，fallback 到 free
    return dispatchFree(chatId, senderId, 'user', content, agents, null as any);
  }

  const debateTopics = ['支持方', '反对方', '中立分析方', '批判性思维方'];
  const responses: ModeDispatchResult['responses'] = [];

  for (let i = 0; i < Math.min(participants.length, debateTopics.length); i++) {
    const agent = participants[i];
    const stance = debateTopics[i];
    responses.push({
      chatId,
      agentId: agent.id,
      triggerMessage: { id: 'debate-' + Date.now(), content, senderId },
      customPrompt: `【辩论模式 - 你是${stance}】

议题：${content}

请从「${stance}」的立场出发，进行论述。要求：
1. 清晰表明立场
2. 给出 2-3 个论据
3. 引用事实或逻辑支撑
4. 避免人身攻击，针对议题不针对人

请直接开始你的发言。`,
      stage: stance,
    });
  }

  return { responses, needsFollowUp: true, followUpContext: { type: 'debate', topic: content } };
}

// ─── 链式 ───────────────────────────────────────────
function dispatchChain(
  chatId: string, senderId: string, content: string,
  agents: any[], db: any
): ModeDispatchResult {
  // 按加入顺序串行：上一个输出是下一个输入
  const activeAgents = agents.filter((a: any) => a.autonomy !== 'passive');
  if (activeAgents.length < 2) {
    return dispatchFree(chatId, senderId, 'user', content, agents, null as any);
  }

  const responses: ModeDispatchResult['responses'] = [];
  const chainStages = ['分析', '执行', '审查', '优化'];

  for (let i = 0; i < Math.min(activeAgents.length, chainStages.length); i++) {
    const agent = activeAgents[i];
    const stage = chainStages[i];
    const isFirst = i === 0;
    const prevName = i > 0 ? activeAgents[i - 1].displayName : '用户';

    responses.push({
      chatId,
      agentId: agent.id,
      triggerMessage: { id: 'chain-' + Date.now(), content, senderId },
      customPrompt: isFirst
        ? `【链式协作 - 第 ${i + 1} 步：${stage}】

任务：${content}

你是链式协作的第一步（${stage}）。请完成你的任务并输出结果，你的输出将交给下一步的 AI 继续处理。`
        : `【链式协作 - 第 ${i + 1} 步：${stage}】

原始任务：${content}
上一环节（${prevName}）的产出请见上方消息。

你是${stage}环节，请基于上一步的结果继续推进任务。如有不满意的部分请标注出来。`,
      delayMs: isFirst ? 0 : 3000 + i * 2000,
      stage,
    });
  }

  // P1-3: 链式串行由 ws-handler.ts 的 runResponses(sequential=true) 保证
  // 上一步落库后下一步才开始读，不再依赖固定延迟
  return { responses, followUpContext: { type: 'chain', step: 0 } };
}

// ─── 圆桌式 ─────────────────────────────────────────
function dispatchRoundtable(
  chatId: string, senderId: string, content: string,
  agents: any[], db: any
): ModeDispatchResult {
  const activeAgents = agents.filter((a: any) => a.autonomy !== 'passive');
  if (activeAgents.length < 2) {
    return dispatchFree(chatId, senderId, 'user', content, agents, null as any);
  }

  const maxRounds = 3;
  const responses: ModeDispatchResult['responses'] = [];

  // 第一轮：大家依次发言
  for (let i = 0; i < activeAgents.length; i++) {
    const agent = activeAgents[i];
    responses.push({
      chatId,
      agentId: agent.id,
      triggerMessage: { id: 'round-' + Date.now(), content, senderId },
      customPrompt: `【圆桌讨论 - 第 1 轮 / 共 ${maxRounds} 轮】

议题：${content}

你是参与者之一。请发表你的看法：
1. 对这个问题的理解
2. 你的建议或方案
3. 对其他成员可能的质疑点

稍后其他成员会回复你。保持开放态度。`,
      delayMs: i * 3000,
      stage: `第1轮`,
    });
  }

  return { responses, needsFollowUp: true, followUpContext: { type: 'roundtable', round: 1, maxRounds } };
}

// ─── 投票式 ─────────────────────────────────────────
function dispatchVote(
  chatId: string, senderId: string, content: string,
  agents: any[]
): ModeDispatchResult {
  const activeAgents = agents.filter((a: any) => a.autonomy !== 'passive');
  if (activeAgents.length < 2) {
    return dispatchFree(chatId, senderId, 'user', content, agents, null as any);
  }

  // 尝试从消息中提取选项（逗号分隔或数字编号）
  const optionMatch = content.match(/[选项方案][：:]\s*(.+)/);
  const options = optionMatch
    ? optionMatch[1].split(/[,，、\n]/).filter(Boolean).map((s: any) => s.trim())
    : ['方案A', '方案B'];

  const responses: ModeDispatchResult['responses'] = [];
  for (const agent of activeAgents) {
    responses.push({
      chatId,
      agentId: agent.id,
      triggerMessage: { id: 'vote-' + Date.now(), content, senderId },
      customPrompt: `【投票模式】

议题：${content}
选项：${options.map((o, i) => `${i + 1}. ${o}`).join(' | ')}

请投出你的一票。回复格式：
✅ 我选择：选项X（X是数字）
理由：（一句话说明为什么）`,
    });
  }

  return { responses, needsFollowUp: true, followUpContext: { type: 'vote', options } };
}

/**
 * 处理辩论的后续轮次（收集各方观点后汇总）
 */
export function dispatchDebateSummary(
  chatId: string, responses: any[], agents: any[]
): ModeDispatchResult | null {
  if (responses.length === 0) return null;
  
  const allReplies = responses.map((r: any) => `${r.agentName || '某AI'} 的观点：${r.content}`).join('\n\n');
  const firstAgent = agents[0];
  if (!firstAgent) return null;

  return {
    responses: [{
      chatId,
      agentId: firstAgent.id,
      triggerMessage: { id: 'debate-summary', content: allReplies, senderId: 'system' },
      customPrompt: `【辩论总结】

以下是各方观点：
${allReplies}

请作为中立的总结者，归纳各方主要观点，指出共识和分歧，给出综合评价。`,
      stage: '总结',
    }],
  };
}

/**
 * 处理圆桌的后续轮次
 */
export function dispatchRoundtableNext(
  chatId: string, agents: any[], round: number, maxRounds: number
): ModeDispatchResult | null {
  if (round >= maxRounds) {
    // 最后一轮结束 → 总结
    const firstAgent = agents[0];
    if (!firstAgent) return null;
    return {
      responses: [{
        chatId,
        agentId: firstAgent.id,
        triggerMessage: { id: 'round-summary', content: `圆桌讨论第 ${round} 轮结束`, senderId: 'system' },
        customPrompt: '圆桌讨论已结束。请作为主持人对本次讨论做一个简洁的总结，归纳各方达成的共识和主要分歧。',
        stage: '总结发言',
      }],
    };
  }

  const responses: ModeDispatchResult['responses'] = [];
  for (let i = 0; i < agents.length; i++) {
    responses.push({
      chatId,
      agentId: agents[i].id,
      triggerMessage: { id: 'round-next-' + round, content: '', senderId: 'system' },
      customPrompt: `【圆桌讨论 - 第 ${round + 1} 轮 / 共 ${maxRounds} 轮】

请基于之前的讨论内容（上方消息），回应其他成员的观点，补充或修正你的看法。`,
      delayMs: i * 3000,
      stage: `第${round + 1}轮`,
    });
  }

  return { responses, needsFollowUp: true, followUpContext: { type: 'roundtable', round: round + 1, maxRounds } };
}

/**
 * 处理投票的后续轮次（收集各 AI 投票后开票统计）
 */
export function dispatchVoteSummary(
  chatId: string,
  responses: any[],
  agents: any[],
  options: string[]
): ModeDispatchResult | null {
  if (responses.length === 0) return null;

  const allVotes = responses.map((r: any) => `${r.agentName || '某AI'}：${r.content}`).join('\n\n');
  const firstAgent = agents[0];
  if (!firstAgent) return null;

  return {
    responses: [{
      chatId,
      agentId: firstAgent.id,
      triggerMessage: { id: 'vote-summary', content: allVotes, senderId: 'system' },
      customPrompt: `【投票开票】

以下是各位 AI 的投票结果：
${allVotes}

可选选项：${options.map((o, i) => `${i + 1}. ${o}`).join(' | ')}

请作为计票员：
1. 统计每个选项的得票数
2. 用表格或清单列出开票结果
3. 宣布得票最高的方案，并简述各方理由`,
      stage: '开票',
    }],
  };
}
