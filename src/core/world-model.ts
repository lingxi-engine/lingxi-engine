/**
 * 世界模型 - World Model (常识推理层)
 *
 * AGI 与 Chatbot 的分水岭：
 *  Chatbot 只会"回应你的话"
 *  AGI 需要"理解世界如何运转"，能处理隐含假设和物理常识
 *
 * 实现思路：
 *  1. 对每条用户输入，先抽取"世界断言"（用户隐含假设了什么物理/社会规律）
 *  2. 在常识库中查找/验证这些规律
 *  3. 让 AI 基于常识 + 上下文一起推理
 */

import type OpenAI from 'openai';

/** 一条世界断言 */
export interface WorldAssertion {
  /** 用户的隐含假设，如"水烧开了会冒泡" */
  assumption: string;
  /** 常识判定：true=符合常识 false=违反常识 unknown=未知 */
  verdict: 'matches' | 'contradicts' | 'unknown';
  /** 推理过程 */
  reasoning: string;
  /** 相关常识条目 */
  relatedRules: string[];
}

/** 常识规则库 */
const COMMON_SENSE_RULES: { pattern: RegExp; rule: string; domain: string }[] = [
  // 物理世界
  { pattern: /烧开|沸腾|热水/, rule: '水加热到100°C会沸腾并产生气泡', domain: '物理' },
  { pattern: /下雨|淋湿/, rule: '下雨时未打伞会被淋湿', domain: '物理' },
  { pattern: /堵车|高峰期/, rule: '工作日早晚高峰道路容易拥堵', domain: '社会规律' },
  { pattern: /周一|周五|周末/, rule: '周一多数人要上班，周五大家期待周末', domain: '社会规律' },
  { pattern: /冰箱|冷藏/, rule: '食物放冰箱可以延缓变质', domain: '物理' },
  { pattern: /冬天|夏天|季节/, rule: '季节变化影响气温、日照和人的行为', domain: '物理' },
  { pattern: /熬夜|早睡/, rule: '长期熬夜对身体健康有害', domain: '生物' },
  { pattern: /运动|锻炼/, rule: '规律运动有助于提升体能和心情', domain: '生物' },

  // 经济与社会
  { pattern: /价格|涨价|贬值/, rule: '供需关系影响价格', domain: '经济' },
  { pattern: /工资|收入|月薪/, rule: '收入通常按月发放', domain: '经济' },
  { pattern: / deadline|DDL|截止/, rule: '截止日期前工作压力增大', domain: '社会规律' },
  { pattern: /周一|例会/, rule: '周一常安排周会和例会', domain: '工作' },
  { pattern: /周五|周报|总结/, rule: '周五常安排周报和总结', domain: '工作' },

  // 时间与因果
  { pattern: /明天|后天|昨天/, rule: '时间不可逆流，明天还没到', domain: '时间' },
  { pattern: /如果.*那么|假如|要是/, rule: '条件假设需要验证前提是否成立', domain: '逻辑' },
  { pattern: /因为.*所以|导致/, rule: '因果关系需要验证因果链是否成立', domain: '逻辑' },
];

export class WorldModel {
  private client: OpenAI | null;
  private model: string;

  constructor(client: OpenAI | null, model: string) {
    this.client = client;
    this.model = model;
  }

  /**
   * 从用户输入提取世界断言并验证
   */
  async assertWorld(userInput: string, context?: string): Promise<WorldAssertion[]> {
    // 步骤1: 从规则库匹配已知常识
    const matchedRules = COMMON_SENSE_RULES.filter(r => r.pattern.test(userInput));

    // 如果没有匹配到已知常识，且没有 AI 引擎，快速返回空
    if (!this.client || matchedRules.length === 0) {
      return matchedRules.length === 0
        ? []
        : matchedRules.map(r => ({
            assumption: `用户输入暗含【${r.domain}】常识`,
            verdict: 'matches' as const,
            reasoning: `匹配到已知规则：${r.rule}`,
            relatedRules: [r.rule],
          }));
    }

    // 步骤2: 让 AI 验证常识假设是否合理
    try {
      const rulesContext = matchedRules.map(r => `- ${r.rule} (${r.domain})`).join('\n');
      const prompt = `分析用户输入，提取其中隐含的物理/社会/逻辑常识假设，并判断是否成立。

用户输入: "${userInput}"
${context ? `上下文: ${context}` : ''}

已知相关常识规则:
${rulesContext}

请以 JSON 数组格式回复，每个元素：
{"assumption": "用户隐含的假设", "verdict": "matches|contradicts|unknown", "reasoning": "你的推理", "relatedRules": ["相关常识"]}
只返回 JSON 数组，不要加其他文字。`;

      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1000,
      });

      const content = (resp.choices[0]?.message as any)?.content || (resp.choices[0]?.message as any)?.reasoning_content || (resp.choices[0]?.message as any)?.reasoning || '[]';
      const parsed = JSON.parse(content);
      const aiResult = Array.isArray(parsed) ? parsed : [];
      // 如果 AI 返回空结果，回退到规则匹配（常识库是基础保障，AI 是增强）
      if (aiResult.length === 0 && matchedRules.length > 0) {
        return matchedRules.map(r => ({
          assumption: `用户输入暗含【${r.domain}】常识`,
          verdict: 'matches' as const,
          reasoning: `匹配到已知规则：${r.rule}`,
          relatedRules: [r.rule],
        }));
      }
      return aiResult;
    } catch (err: any) {
      console.warn('[WorldModel] assertWorld failed:', err.message);
      return matchedRules.map(r => ({
        assumption: `用户输入暗含【${r.domain}】常识`,
        verdict: 'matches' as const,
        reasoning: `匹配到已知规则：${r.rule}`,
        relatedRules: [r.rule],
      }));
    }
  }

  /**
   * 生成"世界模型"上下文片段，注入 system prompt
   */
  buildWorldContext(assertions: WorldAssertion[]): string {
    if (assertions.length === 0) return '';

    const lines: string[] = ['-- 世界模型（常识推理）--'];
    for (const a of assertions) {
      const icon = a.verdict === 'matches' ? '✓' : a.verdict === 'contradicts' ? '✗' : '?';
      lines.push(`${icon} ${a.assumption}`);
      if (a.verdict === 'contradicts') {
        lines.push(`  ⚠️ 注意：用户假设与现实不符——${a.reasoning}`);
      }
    }
    return lines.join('\n');
  }
}

/**
 * 辅助：从用户输入快速抽取可能的常识断言（不依赖 AI）
 */
export function quickExtractAssertions(userInput: string): WorldAssertion[] {
  const matchedRules = COMMON_SENSE_RULES.filter(r => r.pattern.test(userInput));
  return matchedRules.map(r => ({
    assumption: `用户输入暗含【${r.domain}】常识`,
    verdict: 'matches' as const,
    reasoning: `匹配到已知规则：${r.rule}`,
    relatedRules: [r.rule],
  }));
}
