/**
 * AGI P0: 意图澄清机制
 * 在 generateReply 入口前评估用户意图清晰度，对模糊/歧义查询自动追问
 */

/** 澄清评估结果 */
export interface ClarifyResult {
  /** 综合清晰度分数 0-100，越高越清晰 */
  score: number;
  /** 是否需要追问 */
  needsClarify: boolean;
  /** 追问问题列表 */
  questions: string[];
  /** 触发的维度及理由 */
  reasons: ClarifyReason[];
}

interface ClarifyReason {
  dimension: string;
  description: string;
  penalty: number;
}

/** 可配置阈值 */
export interface ClarifyOptions {
  /** 低于此分数强制追问（默认 60） */
  hardThreshold?: number;
  /** 低于此分数温和建议（默认 75） */
  softThreshold?: number;
  /** 最大追问问题数（默认 3） */
  maxQuestions?: number;
}

const DEFAULT_OPTS: Required<ClarifyOptions> = {
  hardThreshold: 60,
  softThreshold: 75,
  maxQuestions: 3,
};

/** 模糊指代词 */
const VAGUE_PRONOUNS = ['它', '这个', '那个', '这些', '那些', '其', '此', '该', '上面', '下面', '前面的', '刚才的'];
/** 多意图连接词 */
const MULTI_INTENT_MARKERS = ['还有', '顺便', '另外', '同时', '以及', '然后还要', '再加上'];
/** 模糊量词/不确定词 */
const FUZZY_WORDS = ['随便', '大概', '差不多', '可能', '好像', '似乎', '应该', '之类的', '什么的', '左右'];

export class Clarifier {
  private opts: Required<ClarifyOptions>;

  constructor(opts?: ClarifyOptions) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
  }

  /**
   * 评估用户输入的意图清晰度
   * @param input 用户原始输入
   * @param isFollowUp 是否是追问轮（首轮更严格）
   * @param history 近期对话历史（用于判断上下文依赖）
   */
  evaluate(input: string, isFollowUp: boolean = false, history: string[] = []): ClarifyResult {
    const text = input.trim();
    const reasons: ClarifyReason[] = [];
    let score = 100;
    const questions: string[] = [];

    // 1. 关键词缺失检测：极短输入且没有上下文
    if (text.length < 5 && !isFollowUp) {
      reasons.push({
        dimension: '关键词缺失',
        description: '输入过短且无上下文，无法判断意图',
        penalty: 30,
      });
      questions.push('你能具体说说想了解什么吗？');
      score -= 30;
    }

    // 2. 指代模糊检测
    let vagueCount = 0;
    for (const pron of VAGUE_PRONOUNS) {
      if (text.includes(pron)) vagueCount++;
    }
    if (vagueCount >= 2) {
      reasons.push({
        dimension: '指代模糊',
        description: `检测到 ${vagueCount} 个模糊指代词（它/这个/那个等），无法确定指向对象`,
        penalty: 20,
      });
      questions.push('你提到的"它/这个"具体指什么？');
      score -= 20;
    } else if (vagueCount === 1 && !isFollowUp) {
      // 首轮单个指代词也扣分
      reasons.push({
        dimension: '指代模糊',
        description: '首轮对话中出现指代词，但缺少前文指向',
        penalty: 10,
      });
      score -= 10;
    }

    // 3. 多意图并存检测
    let multiCount = 0;
    for (const marker of MULTI_INTENT_MARKERS) {
      if (text.includes(marker)) multiCount++;
    }
    if (multiCount >= 2) {
      reasons.push({
        dimension: '多意图并存',
        description: `检测到 ${multiCount} 个多意图连接词，可能包含多个不相关任务`,
        penalty: 15,
      });
      questions.push('你提到了多个需求，能先说最优先要处理哪个吗？');
      score -= 15;
    }

    // 4. 上下文依赖检测（首轮用"上面""之前"等）
    if (!isFollowUp || history.length === 0) {
      const contextDeps = ['上面', '之前', '刚才', '前面的', '上次说的', '你之前提到的'];
      for (const dep of contextDeps) {
        if (text.includes(dep)) {
          reasons.push({
            dimension: '上下文依赖',
            description: `引用了"${dep}"但当前没有可用的上下文`,
            penalty: 15,
          });
          questions.push('我没有找到你说的相关上下文，能重新描述一下吗？');
          score -= 15;
          break;
        }
      }
    }

    // 5. 任务复杂度检测
    if (text.length > 500) {
      reasons.push({
        dimension: '任务复杂度',
        description: '输入超过 500 字，可能包含复杂多约束任务',
        penalty: 10,
      });
      score -= 10;
    }

    // 6. 模糊/不确定用语检测
    let fuzzyCount = 0;
    for (const word of FUZZY_WORDS) {
      if (text.includes(word)) fuzzyCount++;
    }
    if (fuzzyCount >= 2) {
      reasons.push({
        dimension: '模糊用语',
        description: `检测到 ${fuzzyCount} 个模糊/不确定用语，目标不明确`,
        penalty: 10,
      });
      questions.push('你希望的结果具体是什么样的？');
      score -= 10;
    }

    score = Math.max(0, Math.min(100, score));

    const needsClarify = score < this.opts.hardThreshold;
    const limitedQuestions = questions.slice(0, this.opts.maxQuestions);

    return {
      score,
      needsClarify,
      questions: needsClarify ? limitedQuestions : [],
      reasons,
    };
  }

  /** 温和建议（中等歧义时追加到回复末尾） */
  buildSoftSuggestion(result: ClarifyResult, interpretedIntent: string): string {
    if (result.score >= this.opts.softThreshold) return '';
    if (result.score >= this.opts.hardThreshold) {
      return `\n\n---\n*我理解你想要的是：${interpretedIntent}。如果不是，请告诉我具体需求。*`;
    }
    return '';
  }
}