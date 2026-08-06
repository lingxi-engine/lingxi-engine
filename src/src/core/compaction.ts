/**
 * 上下文压缩（Compaction）
 * 
 * 当对话历史超过 token 阈值时，用 AI 把旧消息压缩成摘要，
 * 保留最近 N 条完整 + 之前的摘要，释放 token 空间。
 * 
 * 参考：OpenClaw/OpenCode 的 compaction 机制
 */

// 粗略估算 token 数：中文 1 字 ≈ 1.5 token，英文 1 词 ≈ 1.3 token
export function estimateTokens(text: string): number {
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
  // V10 修复：用英文总字符数（而非单词匹配数）计算 otherChars
  const englishLetterCount = (text.match(/[a-zA-Z]/g) || []).length;
  const otherChars = text.length - chineseChars - englishLetterCount;
  return Math.ceil(chineseChars * 1.5 + englishWords * 1.3 + otherChars * 0.5);
}

// V10: 支持 tool_calls 字段的消息类型，兼容 executor.ts 的 ChatMessage
export interface ChatMessage {
  role: string;
  content?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + (m.content ? estimateTokens(m.content) : 0) + 4, 0);
}

/**
 * 压缩对话历史
 * 策略：保留最近 keepRecent 条完整 + 之前的用 AI 摘要
 */
export async function compactMessages(
  messages: ChatMessage[],
  options: {
    client: any;
    model: string;
    maxTokens?: number;
    keepRecent?: number;
    keepSystem?: boolean;
  }
): Promise<{ messages: ChatMessage[]; compacted: boolean; savedTokens: number }> {
  const {
    client,
    model,
    maxTokens = 30000,
    keepRecent = 10,
    keepSystem = true,
  } = options;

  const totalTokens = estimateMessagesTokens(messages);

  // 没超限，不需要压缩
  if (totalTokens <= maxTokens) {
    return { messages, compacted: false, savedTokens: 0 };
  }

  // 分离 system 消息和对话消息
  let systemMsgs: ChatMessage[] = [];
  let dialogMsgs: ChatMessage[] = [];

  if (keepSystem) {
    systemMsgs = messages.filter(m => m.role === 'system');
    dialogMsgs = messages.filter(m => m.role !== 'system');
  } else {
    dialogMsgs = [...messages];
  }

  // 保留最近 keepRecent 条
  const recentMsgs = dialogMsgs.slice(-keepRecent);
  const oldMsgs = dialogMsgs.slice(0, -keepRecent);

  if (oldMsgs.length === 0) {
    return { messages, compacted: false, savedTokens: 0 };
  }

  // 把旧消息压缩成摘要（v2.0.6 修复：处理 content=undefined 和 tool_calls 信息）
  const oldText = oldMsgs.map(m => {
    const parts = [`${m.role}: ${m.content || ''}`];
    if (m.tool_calls && m.tool_calls.length > 0) {
      parts.push(`[tool_calls: ${m.tool_calls.map((tc: any) => tc.function?.name || tc.name).join(', ')}]`);
    }
    if (m.tool_call_id) {
      parts.push(`[tool_call_id: ${m.tool_call_id}]`);
    }
    if (m.name) {
      parts.push(`[name: ${m.name}]`);
    }
    return parts.join(' ');
  }).join('\n\n');

  const summaryPrompt = `请把以下对话历史压缩成一段简洁的摘要，保留：
1. 用户的核心需求和意图
2. 已经讨论的关键结论和决定
3. 重要的上下文信息（人名、项目名、技术细节）
4. 未解决的问题

丢弃：寒暄、重复内容、无关细节。

对话历史：
---
${oldText.slice(0, 8000)}
---

请直接输出摘要，不要加"摘要："之类的标题。限 500 字以内。`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: summaryPrompt }],
      temperature: 0.3,
      max_tokens: 800,
    });

    const summary = response.choices[0].message.content || '';

    // 构建压缩后的消息列表
    const compactedMessages = [
      ...systemMsgs,
      { role: 'system', content: `[对话摘要] ${summary}` },
      ...recentMsgs,
    ];

    const newTokens = estimateMessagesTokens(compactedMessages);
    const savedTokens = totalTokens - newTokens;

    console.log(`[Compaction] 压缩完成: ${oldMsgs.length} 条旧消息 → 摘要 ${estimateTokens(summary)} tokens, 节省 ${savedTokens} tokens`);

    return { messages: compactedMessages, compacted: true, savedTokens };
  } catch (err: any) {
    console.error('[Compaction] 压缩失败:', err.message);
    // 压缩失败：提取旧消息的关键句作为摘要，避免完全丢失上下文
    const oldSummaryLines = oldMsgs
      .filter((m: ChatMessage) => m.role === 'user' || (m.role === 'assistant' && (m.content || '').length > 20))
      .map((m: ChatMessage) => (m.content || '').split(/[\n。！？]/)[0].slice(0, 80))
      .filter((s: string) => s.length > 5)
      .slice(0, 15);
    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `[历史对话摘要（压缩失败，保留关键句）]\n${oldSummaryLines.join('\n')}`,
    };
    const truncated = [...systemMsgs, summaryMsg, ...recentMsgs];
    return { messages: truncated, compacted: true, savedTokens: totalTokens - estimateMessagesTokens(truncated) };
  }
}