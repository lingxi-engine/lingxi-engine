/**
 * 多智能体对弈 - Multi-Agent Debate
 *
 * 用多个灵犀实例互相批判、分工解难题
 * 角色：Proposer(提出方案) → Critic(挑漏洞) → Synthesizer(总结最优解)
 * 这是逼近涌现能力(Emergence)的低成本实验场
 */

import type OpenAI from 'openai';

export interface DebateRole {
  name: string;
  role: 'proposer' | 'critic' | 'synthesizer' | 'devil_advocate';
  systemPrompt: string;
}

export interface DebateRound {
  round: number;
  speaker: string;
  role: DebateRole['role'];
  content: string;
  critiqueTarget?: string; // Critic 轮 -> 被批评的是哪条
  confidence: number; // 0-100
}

export interface DebateResult {
  topic: string;
  rounds: DebateRound[];
  consensus: string;
  /** 各方案的最终得分 */
  scores: { proposal: string; score: number; reasons: string[] }[];
  /** 整个辩论用了多少轮 */
  totalRounds: number;
}

const ROLE_PROMPTS: Record<DebateRole['role'], string> = {
  proposer: `你是"提议者"。针对议题，给出一个具体、可执行的方案。方案要创新、务实、可落地。直接给出方案，不要解释。`,
  critic: `你是"批判者"。针对当前方案，找出至少3个具体漏洞。每个漏洞要指出：(1)是什么问题 (2)会导致什么后果 (3)如何改进。要尖锐但公平。`,
  synthesizer: `你是"综合者"。听完提议和批评后，综合各方观点，给出一个最优解。要平衡、务实、能落地。`,
  devil_advocate: `你是"魔鬼代言人"。为了检验方案的鲁棒性，故意从最极端的角度挑战方案。找出那个"如果失败了会怎样"的画面。`,
};

/**
 * 多智能体辩论引擎
 */
export class DebateEngine {
  private client: OpenAI | null;
  private model: string;

  constructor(client: OpenAI | null, model: string) {
    this.client = client;
    this.model = model;
  }

  /**
   * 运行一场完整的辩论
   */
  async debate(topic: string, maxRounds: number = 3): Promise<DebateResult> {
    if (!this.client) {
      return this._fallbackDebate(topic);
    }

    const rounds: DebateRound[] = [];
    let currentProposal = '';

    // Round 1: Proposer 提出方案
    const proposal = await this._runRole('proposer', topic, null);
    rounds.push({
      round: 1,
      speaker: 'Proposer',
      role: 'proposer',
      content: proposal,
      confidence: 80,
    });
    currentProposal = proposal;

    // Round 2: Critic 批判
    const critique1 = await this._runRole('critic', topic, currentProposal);
    rounds.push({
      round: 2,
      speaker: 'Critic',
      role: 'critic',
      content: critique1,
      critiqueTarget: proposal,
      confidence: 75,
    });

    // Round 3: Devil's Advocate 极端挑战
    if (maxRounds >= 3) {
      const devilsChallenge = await this._runRole('devil_advocate', topic, currentProposal);
      rounds.push({
        round: 3,
        speaker: 'Devil Advocate',
        role: 'devil_advocate',
        content: devilsChallenge,
        critiqueTarget: proposal,
        confidence: 70,
      });
    }

    // Round 4: Synthesizer 综合最优解
    const allArguments = rounds.map(r => `${r.speaker}: ${r.content}`).join('\n\n');
    const consensus = await this._runRole('synthesizer', topic, allArguments);
    rounds.push({
      round: rounds.length + 1,
      speaker: 'Synthesizer',
      role: 'synthesizer',
      content: consensus,
      confidence: 85,
    });

    // 评分
    const scores = await this._scoreProposals(topic, currentProposal, consensus);

    return {
      topic,
      rounds,
      consensus,
      scores,
      totalRounds: rounds.length,
    };
  }

  /**
   * 运行一个角色
   */
  private async _runRole(
    role: DebateRole['role'],
    topic: string,
    context: string | null
  ): Promise<string> {
    if (!this.client) return `[${role}] 离线模式`;

    const systemPrompt = ROLE_PROMPTS[role];
    const userMessage = context
      ? `议题：${topic}\n\n上下文：\n${context}\n\n请以"${role}"的身份回应。`
      : `议题：${topic}\n\n请以"${role}"的身份回应。`;

    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: role === 'critic' ? 0.7 : 0.5,
        max_tokens: 800,
      });
      const msg: any = resp.choices[0]?.message;
      return msg?.content || msg?.reasoning_content || msg?.reasoning || `[${role}] 无回复`;
    } catch (err: any) {
      console.error(`[Debate] ${role} failed:`, err.message);
      return `[${role}] 回应失败：${err.message}`;
    }
  }

  /**
   * 给两个方案评分
   */
  private async _scoreProposals(
    topic: string,
    proposal: string,
    consensus: string
  ): Promise<DebateResult['scores']> {
    if (!this.client) {
      return [{ proposal: '原始方案', score: 75, reasons: ['离线评分'] }];
    }

    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: `对以下两个方案评分(0-100)，给出理由。

议题：${topic}

方案A(原始方案)：${proposal}

方案B(综合最优)：${consensus}

以 JSON 数组返回：[{"proposal":"A或B","score":数字,"reasons":["理由1","理由2"]},...]`,
          },
        ],
        temperature: 0.2,
        max_tokens: 600,
      });
      const content = resp.choices[0]?.message?.content || '[]';
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * 离线模式的兜底
   */
  private _fallbackDebate(topic: string): DebateResult {
    return {
      topic,
      rounds: [{
        round: 1,
        speaker: 'System',
        role: 'proposer',
        content: `请配置 AI Provider 以启用辩论模式。当前议题："${topic}"`,
        confidence: 0,
      }],
      consensus: '（离线模式，无法生成辩论）',
      scores: [],
      totalRounds: 0,
    };
  }

  /**
   * 把辩论结果格式化为文本
   */
  formatDebate(result: DebateResult): string {
    const lines: string[] = [`📋 议题：${result.topic}`, ''];
    for (const r of result.rounds) {
      const icon = {
        proposer: '💡',
        critic: '🔍',
        devil_advocate: '😈',
        synthesizer: '⚖️',
      }[r.role];
      lines.push(`${icon} [${r.speaker}] ${r.content}`);
      lines.push('');
    }
    lines.push(`✅ 最终共识：${result.consensus}`);
    if (result.scores.length > 0) {
      lines.push(`\n📊 方案评分：`);
      for (const s of result.scores) {
        lines.push(`  - ${s.proposal}: ${s.score}分 (${s.reasons.join('；')})`);
      }
    }
    return lines.join('\n');
  }
}
