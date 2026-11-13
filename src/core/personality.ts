/**
 * 人格演化系统 - Personality Evolution
 *
 * 4 个核心维度，每次反思时 AI 建议微调目标值，实际缓慢移动（限制步长防跳变）
 *  维度都是 0-1：
 *   - formalness:   正式度  0=非常随意  1=非常正式
 *   - proactiveness: 主动度 0=完全被动  1=主动出击
 *   - humor:        幽默感  0=严肃     1=爱开玩笑
 *   - warmth:       温暖度  0=高冷     1=热情洋溢
 */

export interface PersonalityDims {
  formalness: number;
  proactiveness: number;
  humor: number;
  warmth: number;
}

export const DEFAULT_DIMS: PersonalityDims = {
  formalness: 0.5,
  proactiveness: 0.5,
  humor: 0.5,
  warmth: 0.7, // 默认偏温暖
};

/** 每次反思时最多移动 0.05（缓慢演化防跳变） */
const MAX_STEP = 0.05;

/**
 * 把维度文本化成 system prompt 片段
 */
export function formatPersonalityForPrompt(dims: PersonalityDims): string {
  const traits: string[] = [];
  // ★ FIX(2026-11-09): personality_dims 从 DB 读回来可能是字符串（JSON 里存成 "0.5"），
  //   直接调 .toFixed() 会抛 "dims.formalness.toFixed is not a function"，
  //   导致整个 system prompt 的性格注入被跳过。这里统一数字化为兜底。
  const num = (v: any, d: number) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : d;
  };
  dims = {
    ...dims,
    formalness: num(dims?.formalness, 0.5),
    proactiveness: num(dims?.proactiveness, 0.5),
    humor: num(dims?.humor, 0.5),
    warmth: num(dims?.warmth, 0.7),
  } as PersonalityDims;

  if (dims.formalness < 0.3) traits.push('非常随和，多用口语和网络梗');
  else if (dims.formalness < 0.5) traits.push('语气随和，接地气');
  else if (dims.formalness < 0.7) traits.push('语气自然，不正式也不随意');
  else if (dims.formalness < 0.9) traits.push('偏正式，用词谨慎');
  else traits.push('非常正式，公文风格');

  if (dims.proactiveness < 0.3) traits.push('沉默寡言，问一句答一句');
  else if (dims.proactiveness < 0.5) traits.push('不主动打断，被叫到才回应');
  else if (dims.proactiveness < 0.7) traits.push('会主动补充和提醒');
  else traits.push('非常主动，积极给建议、安排任务');

  if (dims.humor < 0.3) traits.push('严肃认真，不开玩笑');
  else if (dims.humor < 0.5) traits.push('偶尔幽默，适可而止');
  else if (dims.humor < 0.8) traits.push('爱讲冷笑话，喜欢文字游戏');
  else traits.push('段子手附身，每句话都可以带梗');

  if (dims.warmth < 0.3) traits.push('高冷简洁，少废话');
  else if (dims.warmth < 0.5) traits.push('礼貌克制，点到为止');
  else if (dims.warmth < 0.8) traits.push('温暖有耐心，乐于倾听');
  else traits.push('热情洋溢，多用语气词和 emoji');

  return `-- 你的性格风格 --\n${traits.join('、')}\n（formalness=${dims.formalness.toFixed(2)} proactiveness=${dims.proactiveness.toFixed(2)} humor=${dims.humor.toFixed(2)} warmth=${dims.warmth.toFixed(2)}）`;
}

/**
 * 解析 AI 建议的人格微调方向，返回新的 dims
 * 输入是 AI 输出的 JSON: {formalness: 0.6, humor: 0.4, ...}
 */
export function evolvePersonality(
  current: Partial<PersonalityDims>,
  suggestion: Partial<PersonalityDims>
): PersonalityDims {
  const merged: PersonalityDims = {
    formalness: current.formalness ?? DEFAULT_DIMS.formalness,
    proactiveness: current.proactiveness ?? DEFAULT_DIMS.proactiveness,
    humor: current.humor ?? DEFAULT_DIMS.humor,
    warmth: current.warmth ?? DEFAULT_DIMS.warmth,
  };

  for (const key of ['formalness', 'proactiveness', 'humor', 'warmth'] as const) {
    const target = suggestion[key];
    if (typeof target !== 'number') continue;
    const targetClamped = Math.max(0, Math.min(1, target));
    const currentVal = merged[key];
    const diff = targetClamped - currentVal;
    // 限制步长，缓慢演化
    const step = Math.sign(diff) * Math.min(Math.abs(diff), MAX_STEP);
    merged[key] = Math.round((currentVal + step) * 1000) / 1000;
  }

  return merged;
}

/**
 * 从用户交互信号推断人格调整建议
 * 信号来源：用户回应长度、语气、互动模式
 * 这里只是启发式基线，真正的建议由 AI 在反思时给出
 */
export function inferPersonalityHint(userMessages: string[]): Partial<PersonalityDims> {
  if (userMessages.length === 0) return {};

  const hint: Partial<PersonalityDims> = {};
  const avgLen = userMessages.reduce((s, m) => s + m.length, 0) / userMessages.length;

  // 短消息居多 → 用户偏好简洁 → 稍微正式+高冷一点
  if (avgLen < 20) {
    hint.formalness = 0.6;
    hint.warmth = 0.4;
  }
  // 长消息/带表情 → 用户可以承受更丰富的语气
  else if (avgLen > 60 || userMessages.some(m => /😀|😂|🤣|哈哈|666|nice|卧槽/.test(m))) {
    hint.formalness = 0.4;
    hint.warmth = 0.8;
    hint.humor = 0.7;
  }

  // 用户经常使用"帮我/请/麻烦" → 偏主动一点的助手受欢迎
  if (userMessages.some(m => /帮我|麻烦|请你|能不能/.test(m))) {
    hint.proactiveness = 0.7;
  }

  return hint;
}
