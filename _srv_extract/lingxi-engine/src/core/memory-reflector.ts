/**
 * 记忆反思系统 - Memory Reflection
 * 定期压缩 memory_summary → 结构化要点
 * 解决原系统"只追加不整理"的问题
 */

export interface MemoryFact {
  key: string;       // 要点键，如 "用户偏好/饮食习惯/工作习惯"
  value: string;     // 要点值
  updatedAt: number; // 最后更新时间
}

export interface ReflectionResult {
  summary: string;    // 压缩后的摘要
  facts: MemoryFact[];  // 提取的关键事实
  originalLength: number;
  compressedLength: number;
}

/**
 * 反思引擎
 * 接收一段原始 memory_summary，通过 AI 压缩为结构化要点
 */
export class MemoryReflector {
  private client: any;
  private model: string;

  constructor(client: any, model: string) {
    this.client = client;
    this.model = model;
  }

  /**
   * 对一段 memory_summary 执行反思压缩
   * @param rawSummary - 原始累积的 memory_summary
   * @param existingFacts - 已有的结构化事实
   * @returns 压缩后的结果
   */
  async reflect(rawSummary: string, existingFacts: MemoryFact[] = []): Promise<ReflectionResult> {
    if (!rawSummary || rawSummary.length < 50) {
      return {
        summary: rawSummary || '',
        facts: existingFacts,
        originalLength: rawSummary?.length || 0,
        compressedLength: rawSummary?.length || 0,
      };
    }

    const factsStr = existingFacts.length > 0
      ? '\n\n已有事实（请合并更新，不丢失重要信息）：\n' + existingFacts.map(f => `- ${f.key}: ${f.value}`).join('\n')
      : '';

    const prompt = `你是一个记忆整理助手。请把下面的聊天记忆整理为：

1. 精简摘要（保留核心信息，去掉重复和冗余，300字以内）
2. 关键事实列表（用 JSON 数组格式，每条 {key, value}）

原始记忆：
---
${rawSummary}
---${factsStr}

请严格按以下 JSON 格式回复（不要加其他文字）：
{"summary":"精简后的摘要","facts":[{"key":"分类/标签","value":"具体事实","updatedAt":0}]}`;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1500,
      });

      const content = response.choices[0].message.content || '';

      // 尝试解析 JSON
      const parsed = this.parseReflectionJSON(content);
      if (parsed) {
        // 合并事实：新事实覆盖旧事实（按 key 匹配）
        const mergedFacts = this.mergeFacts(existingFacts, parsed.facts);
        return {
          summary: parsed.summary,
          facts: mergedFacts,
          originalLength: rawSummary.length,
          compressedLength: parsed.summary.length,
        };
      }

      // JSON 解析失败，降级：直接截取前 500 字作为 summary
      const truncated = rawSummary.length > 500 ? rawSummary.slice(-500) : rawSummary;
      return {
        summary: truncated,
        facts: existingFacts,
        originalLength: rawSummary.length,
        compressedLength: truncated.length,
      };
    } catch (err: any) {
      console.error('[MemoryReflector] 反思失败:', err.message);
      // 降级：保留最近 500 字
      const truncated = rawSummary.length > 500 ? rawSummary.slice(-500) : rawSummary;
      return {
        summary: truncated,
        facts: existingFacts,
        originalLength: rawSummary.length,
        compressedLength: truncated.length,
      };
    }
  }

  /**
   * 从 AI 回复中解析 JSON（尝试多种提取策略）
   */
  private parseReflectionJSON(content: string): { summary: string; facts: { key: string; value: string; updatedAt: number }[] } | null {
    const now = Date.now();

    // 策略1：直接解析
    try {
      const obj = JSON.parse(content.trim());
      if (obj.summary) {
        obj.facts = (obj.facts || []).map((f: any) => ({ ...f, updatedAt: f.updatedAt || now }));
        return obj;
      }
    } catch { /* continue */ }

    // 策略2：提取 ```json ... ``` 块
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        const obj = JSON.parse(codeBlockMatch[1].trim());
        if (obj.summary) {
          obj.facts = (obj.facts || []).map((f: any) => ({ ...f, updatedAt: f.updatedAt || now }));
          return obj;
        }
      } catch { /* continue */ }
    }

    // 策略3：提取第一个 { ... } 对象
    const objMatch = content.match(/\{[\s\S]*"summary"[\s\S]*\}/);
    if (objMatch) {
      try {
        const obj = JSON.parse(objMatch[0]);
        if (obj.summary) {
          obj.facts = (obj.facts || []).map((f: any) => ({ ...f, updatedAt: f.updatedAt || now }));
          return obj;
        }
      } catch { /* continue */ }
    }

    return null;
  }

  /**
   * 合并新旧事实
   */
  private mergeFacts(oldFacts: MemoryFact[], newFacts: { key: string; value: string; updatedAt: number }[]): MemoryFact[] {
    const factMap = new Map<string, MemoryFact>();
    for (const f of oldFacts) {
      factMap.set(f.key, f);
    }
    for (const f of newFacts) {
      factMap.set(f.key, { key: f.key, value: f.value, updatedAt: f.updatedAt || Date.now() });
    }
    // 最多保留 30 条事实
    const all = Array.from(factMap.values());
    return all.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
  }
}
