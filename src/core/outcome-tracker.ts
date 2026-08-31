/**
 * 评分卡 Outcome Tracker v1.7.0
 *
 * AI 任务完成度自评追踪。对标 Anthropic 的 rubric-driven "Outcomes"。
 */

import { logger } from './logger.js';

// ─── 类型 ───

export interface OutcomeItem {
  id: string;
  description: string;     // 子目标描述
  status: 'pending' | 'done' | 'partial';
  score: number;            // 0-100
  comment?: string;         // AI 自评备注
}

export interface OutcomeCard {
  id: string;
  chatId: string;
  agentId: string;
  goal: string;             // 用户原始目标
  items: OutcomeItem[];
  overallScore: number;     // 综合分 0-100
  createdAt: number;
  updatedAt: number;
}

// ─── 追踪器 ───

export class OutcomeTracker {
  private cards: Map<string, OutcomeCard> = new Map(); // cardId → card
  private aiClient: any;
  private aiModel: string;

  constructor(aiClient: any, aiModel: string) {
    this.aiClient = aiClient;
    this.aiModel = aiModel;
  }

  /**
   * 从用户目标生成评分卡
   */
  async createCard(goal: string, chatId: string, agentId: string): Promise<OutcomeCard> {
    logger.info('Outcome', `创建评分卡: ${goal.slice(0, 60)}`);

    const prompt = `将以下任务目标分解为 3-5 个可验证的子目标。每个子目标应具体、可检查。

目标: "${goal}"

请以 JSON 数组格式输出（不要有其他内容）：
[{"description":"子目标1","status":"pending"}, ...]`;

    try {
      const resp = await this.aiClient.chat.completions.create({
        model: this.aiModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1000,
      });

      const raw = resp.choices[0]?.message?.content || '';
      // 先尝试从 markdown 代码块提取
      let jsonStr = raw.match(/```(?:json)?\s*\[([\s\S]*?)\]```/);
      let jsonMatch = jsonStr ? ['[' + jsonStr[1] + ']'] : null;
      // 非贪婪匹配
      if (!jsonMatch) jsonMatch = raw.match(/\[([\s\S]*?)\]/);
      const items: OutcomeItem[] = jsonMatch
        ? JSON.parse(jsonMatch[0]).map((item: any, i: number) => ({
            id: `oc-${Date.now()}-${i}`,
            description: item.description || `子目标 ${i + 1}`,
            status: 'pending' as const,
            score: 0,
          }))
        : [{ id: `oc-${Date.now()}-0`, description: goal, status: 'pending' as const, score: 0 }];

      const card: OutcomeCard = {
        id: `card-${Date.now()}`,
        chatId, agentId, goal,
        items,
        overallScore: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.cards.set(card.id, card);
      return card;
    } catch {
      const card: OutcomeCard = {
        id: `card-${Date.now()}`,
        chatId, agentId, goal,
        items: [{ id: `oc-${Date.now()}`, description: goal, status: 'pending', score: 0 }],
        overallScore: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.cards.set(card.id, card);
      return card;
    }
  }

  /**
   * AI 自评完成度
   */
  async evaluate(cardId: string, conversationSummary: string): Promise<OutcomeCard | null> {
    const card = this.cards.get(cardId);
    if (!card) return null;

    logger.info('Outcome', `自评: ${cardId}`);

    const prompt = `根据以下对话结果，评估各子目标的完成度（0-100），并给简短评语。

原始目标: "${card.goal}"

子目标:
${card.items.map(i => `- ${i.description}`).join('\n')}

对话结果:
${conversationSummary.slice(0, 2000)}

请以 JSON 格式输出（不要有其他内容）：
{"items":[{"id":"子目标ID","score":80,"comment":"已完成但可优化"},...],"overallScore":75}`;

    try {
      const resp = await this.aiClient.chat.completions.create({
        model: this.aiModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 800,
      });

      const raw = resp.choices[0]?.message?.content || '';
      // 先尝试从 markdown 代码块提取
      let jsonStr = raw.match(/```(?:json)?\s*\{([\s\S]*?)\}```/);
      let jsonMatch = jsonStr ? ['{' + jsonStr[1] + '}'] : null;
      // 非贪婪匹配
      if (!jsonMatch) jsonMatch = raw.match(/\{([\s\S]*?)\}/);
      if (!jsonMatch) return card;

      const eval_ = JSON.parse(jsonMatch[0]);

      for (const item of eval_.items || []) {
        const target = card.items.find(i => i.id === item.id || i.description === item.description);
        if (target) {
          target.score = item.score || 50;
          target.status = target.score >= 80 ? 'done' : target.score >= 40 ? 'partial' : 'pending';
          target.comment = item.comment;
        }
      }

      card.overallScore = eval_.overallScore || Math.round(
        card.items.reduce((s, i) => s + i.score, 0) / Math.max(card.items.length, 1)
      );
      card.updatedAt = Date.now();

      logger.info('Outcome', `评分完成: ${card.overallScore}%`);
      return card;
    } catch {
      card.overallScore = Math.round(card.items.reduce((s, i) => s + i.score, 0) / Math.max(card.items.length, 1));
      return card;
    }
  }

  /** 获取评分卡 */
  getCard(cardId: string): OutcomeCard | undefined {
    return this.cards.get(cardId);
  }

  /** 列出所有评分卡 */
  list(chatId?: string): OutcomeCard[] {
    const all = Array.from(this.cards.values());
    return chatId ? all.filter(c => c.chatId === chatId) : all;
  }
}
