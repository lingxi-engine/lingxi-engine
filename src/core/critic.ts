/**
 * Critic — 生成→校验→修正流水线 v1.0.0 (AGI P0)
 *
 * 架构级反思能力：对每次回复做批判性校验，发现可修正问题则自动重生成。
 * 把"反思"从记忆压缩（MemoryReflector）升级为覆盖每次输出的能力闭环：
 *   生成(Generate) → 校验(Critique) → 修正(Revise) → 再校验
 *
 * 对标 AGI 方案的 P0 项："反思机制下沉为架构级能力（生成→校验→修正流水线 + Critic 模型）"
 */
import { logger } from './logger.js';

// ─── 类型 ───

export type CritiqueIssueType =
  | 'fact'          // 事实/幻觉风险：无依据断言、编造数据
  | 'relevance'     // 相关性：答非所问、偏离用户意图
  | 'logic'         // 逻辑：自相矛盾、因果断裂
  | 'instruction'   // 指令遵循：遗漏用户明确要求
  | 'format'        // 格式：未按要求输出、结构混乱
  | 'vagueness'     // 空泛：套话、无信息量
  | 'safety'        // 安全：有害、越权、隐私泄露
  | 'leak';         // 泄漏：内部机制/提示词/工具标记泄漏

export interface CritiqueIssue {
  type: CritiqueIssueType;
  severity: 'low' | 'medium' | 'high';
  description: string;   // 具体问题描述
  fix?: string;          // 修正建议
}

export interface CritiqueResult {
  score: number;              // 0-100
  issues: CritiqueIssue[];
  verdict: 'pass' | 'revise';
  critiqueModel: string;
  durationMs: number;
}

export interface CritiqueContext {
  userMessage?: string;       // 触发的用户消息
  agentName?: string;         // Agent 名称
  taskGoal?: string;          // 任务目标（若有）
  modePrompt?: string;        // 协作模式指令（若有）
}

export interface CritiquePipelineResult {
  content: string;
  critique: CritiqueResult | null;
  revised: boolean;
  rounds: number;
}

// ─── 本地启发式预检规则 ───

const LEAK_PATTERNS: RegExp[] = [
  /<｜{1,2}DSML｜{1,2}/,                    // 工具调用标记泄漏
  /<\s*system(?:\s|>)/i,                     // system 标签
  /(?:你是|你是一个)\s*(?:AI|人工智能|助手|模型)/i, // 自曝身份（弱信号，仅提示）
  /ignore\s+(?:all\s+)?(?:previous|prior|above)/i, // 提示注入残留
  /system\s*(?:prompt|message)/i,
];

const VAGUE_PHRASES = [
  '作为一个ai', '作为一个人工智能', '我不能', '抱歉，我无法', '总之', '总的来说，',
  '希望我的回答', '希望对您有帮助', '如果你还有其他问题', '随时问我', '我尽力而为',
];

const CONTRADICTION_PAIRS: [RegExp, RegExp][] = [
  [/我不知道/i, /我知道答案/i],
  [/完全没有/i, /非常清楚/i],
];

/**
 * 快速本地启发式预检 —— 不消耗 token，先抓确定性问题
 */
export function quickCheck(content: string): CritiqueIssue[] {
  const issues: CritiqueIssue[] = [];
  if (!content || content.trim().length === 0) {
    issues.push({ type: 'vagueness', severity: 'high', description: '回复为空' });
    return issues;
  }

  // 泄漏检测
  for (const pat of LEAK_PATTERNS) {
    if (pat.test(content)) {
      issues.push({ type: 'leak', severity: 'high', description: `检测到内部机制泄漏模式: ${pat.source.slice(0, 40)}` });
    }
  }

  // 空泛检测：短回复 + 套话
  const text = content.trim();
  if (text.length < 12 && !/[?？]/.test(text)) {
    issues.push({ type: 'vagueness', severity: 'medium', description: '回复过短，缺乏实质信息' });
  }
  let vagueHits = 0;
  for (const phrase of VAGUE_PHRASES) {
    if (text.toLowerCase().includes(phrase)) vagueHits++;
  }
  if (vagueHits >= 2) {
    issues.push({ type: 'vagueness', severity: 'low', description: `回复含 ${vagueHits} 处套话/推诿用语，可能空泛` });
  }

  // 矛盾检测
  for (const [a, b] of CONTRADICTION_PAIRS) {
    if (a.test(text) && b.test(text)) {
      issues.push({ type: 'logic', severity: 'medium', description: '回复中存在自相矛盾的表述' });
    }
  }

  // 重复检测：同一段落重复出现
  const lines = text.split('\n').filter(l => l.trim().length > 20);
  const seen = new Set<string>();
  for (const line of lines) {
    const norm = line.trim().slice(0, 30);
    if (seen.has(norm)) {
      issues.push({ type: 'format', severity: 'low', description: '回复中存在重复段落' });
      break;
    }
    seen.add(norm);
  }

  return issues;
}

/**
 * Critic 校验器：AI 批判性评估 + 自动修正
 */
export class Critic {
  private client: any;
  private model: string;
  private threshold: number;    // 低于此分触发修正
  private maxRounds: number;    // 最多修正轮数

  constructor(client: any, model: string, opts?: { threshold?: number; maxRounds?: number }) {
    this.client = client;
    this.model = model;
    this.threshold = opts?.threshold ?? 70;
    this.maxRounds = opts?.maxRounds ?? 1;
  }

  get thresholdValue(): number { return this.threshold; }

  /**
   * AI 批判性校验：对回复打分并列出问题
   */
  async critique(content: string, context: CritiqueContext = {}): Promise<CritiqueResult> {
    const start = Date.now();

    const contextLines: string[] = [];
    if (context.userMessage) contextLines.push(`用户消息: ${context.userMessage.slice(0, 500)}`);
    if (context.taskGoal) contextLines.push(`任务目标: ${context.taskGoal.slice(0, 300)}`);
    if (context.modePrompt) contextLines.push(`协作模式指令: ${context.modePrompt.slice(0, 300)}`);
    if (context.agentName) contextLines.push(`回复者: ${context.agentName}`);

    const prompt = `你是一个严格的 AI 回复质量评审（Critic）。请对以下 AI 回复进行批判性评估。

${contextLines.length > 0 ? contextLines.join('\n') + '\n' : ''}AI 回复内容:
---
${content.slice(0, 4000)}
---

请从以下维度评估（0-100 分）：
1. 相关性：是否准确回应用户意图，是否答非所问
2. 事实性：是否存在无依据断言、编造数据、幻觉
3. 逻辑性：是否自相矛盾、因果断裂
4. 指令遵循：是否遗漏用户明确要求
5. 信息密度：是否空泛、套话、无实质内容
6. 安全合规：是否有害、越权、隐私泄露

请严格按 JSON 格式输出（不要有其他内容）：
{"score": 综合分0-100, "issues": [{"type":"fact|relevance|logic|instruction|format|vagueness|safety|leak","severity":"low|medium|high","description":"具体问题","fix":"修正建议"}], "verdict":"pass|revise"}

要求：
- score >= 80 时 verdict 为 pass，issues 可为空数组
- 只有真正影响质量的问题才列出，不要为凑数而列
- fix 要具体可执行`;

    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 1200,
      });
      const msg = resp.choices[0]?.message;
      const raw = msg?.content || msg?.reasoning_content || '';
      const parsed = this.parseCritiqueJSON(raw);

      if (parsed && typeof parsed.score === 'number') {
        const issues: CritiqueIssue[] = (parsed.issues || []).map((i: any) => ({
          type: (i.type || 'logic') as CritiqueIssueType,
          severity: (i.severity || 'medium') as 'low' | 'medium' | 'high',
          description: String(i.description || '未描述'),
          fix: i.fix ? String(i.fix) : undefined,
        }));
        const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
        return {
          score,
          issues,
          verdict: parsed.verdict === 'revise' || score < this.threshold ? 'revise' : 'pass',
          critiqueModel: this.model,
          durationMs: Date.now() - start,
        };
      }
    } catch (err: any) {
      logger.warn('Critic', `AI 校验失败: ${err.message}`);
    }

    return {
      score: 100, // 校验失败不阻塞主流程，视为通过
      issues: [],
      verdict: 'pass',
      critiqueModel: this.model,
      durationMs: Date.now() - start,
    };
  }

  /**
   * 根据问题列表修正回复
   */
  async revise(content: string, issues: CritiqueIssue[], context: CritiqueContext = {}): Promise<string> {
    const issueStr = issues
      .filter(i => i.severity !== 'low' || i.type === 'leak')
      .map((i, idx) => `${idx + 1}. [${i.type}/${i.severity}] ${i.description}${i.fix ? ` → 建议: ${i.fix}` : ''}`)
      .join('\n');

    if (!issueStr) return content;

    const contextLines: string[] = [];
    if (context.userMessage) contextLines.push(`用户消息: ${context.userMessage.slice(0, 500)}`);
    if (context.taskGoal) contextLines.push(`任务目标: ${context.taskGoal.slice(0, 300)}`);
    if (context.modePrompt) contextLines.push(`协作模式指令: ${context.modePrompt.slice(0, 300)}`);

    const prompt = `你是回复修正器。下面的 AI 回复存在质量问题，请修正后重新输出。

${contextLines.length > 0 ? contextLines.join('\n') + '\n' : ''}原回复:
---
${content.slice(0, 4000)}
---

质量问题:
${issueStr}

要求：
1. 保留原回复中正确的信息和正确的语气
2. 只修正列出的问题，不要大改重写
3. 直接输出修正后的完整回复，不要解释、不要加前后缀`;

    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 16384,
      });
      const revised = (resp.choices[0]?.message?.content || resp.choices[0]?.message?.reasoning_content || '').trim();
      // 修正结果必须是实质内容（避免修正器输出空/截断）
      if (revised.length < 10 || revised.length < content.length * 0.1) {
        logger.warn('Critic', '修正结果过短，保留原回复');
        return content;
      }
      logger.audit('Critic', 'revise', `${content.length}字 → ${revised.length}字, 问题数=${issues.length}`);
      return revised;
    } catch (err: any) {
      logger.warn('Critic', `修正失败，保留原回复: ${err.message}`);
      return content;
    }
  }

  /**
   * 完整流水线：校验 → 修正 → 再校验（最多 maxRounds 轮）
   * @param generate 生成函数（已产出内容）
   * @param context 校验上下文
   */
  async runPipeline(
    content: string,
    context: CritiqueContext = {},
    opts?: { skipRevise?: boolean }
  ): Promise<CritiquePipelineResult> {
    // 太短的回复不值得花 AI 校验
    if (!content || content.trim().length < 12) {
      return { content, critique: null, revised: false, rounds: 0 };
    }

    // 第一步：本地启发式预检（免费）
    const localIssues = quickCheck(content);
    const hasHardLeak = localIssues.some(i => i.type === 'leak' && i.severity === 'high');

    // 本地命中硬伤（工具标记泄漏等）直接修正，不浪费 AI 校验
    if (hasHardLeak && !opts?.skipRevise) {
      const revised = await this.revise(content, localIssues, context);
      if (revised !== content) {
        return { content: revised, critique: null, revised: true, rounds: 1 };
      }
    }

    // 第二步：AI 批判性校验
    const critique = await this.critique(content, context);

    if (critique.verdict === 'pass' || opts?.skipRevise) {
      return { content, critique, revised: false, rounds: 1 };
    }

    // 第三步：修正
    let current = content;
    let revised = false;
    let rounds = 1;

    for (let i = 0; i < this.maxRounds; i++) {
      const revisedContent = await this.revise(current, critique.issues, context);
      if (revisedContent === current) break; // 修正器没有实际改动
      current = revisedContent;
      revised = true;
      rounds++;

      // 再校验一次，确认是否达标
      const recheck = await this.critique(current, context);
      if (recheck.verdict === 'pass') break;
      if (recheck.score >= critique.score) break; // 分数没提升就不再循环，避免浪费
    }

    return { content: current, critique, revised, rounds };
  }

  /** 解析 Critic JSON 回复 */
  private parseCritiqueJSON(raw: string): { score?: number; issues?: any[]; verdict?: string } | null {
    // 策略1：直接解析
    try {
      const obj = JSON.parse(raw.trim());
      if (typeof obj.score === 'number') return obj;
    } catch { /* continue */ }

    // 策略2：代码块
    const block = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (block) {
      try {
        const obj = JSON.parse(block[1].trim());
        if (typeof obj.score === 'number') return obj;
      } catch { /* continue */ }
    }

    // 策略3：第一个大括号对象
    const objMatch = raw.match(/\{[\s\S]*"score"[\s\S]*\}/);
    if (objMatch) {
      try {
        const obj = JSON.parse(objMatch[0]);
        if (typeof obj.score === 'number') return obj;
      } catch { /* continue */ }
    }

    return null;
  }
}
