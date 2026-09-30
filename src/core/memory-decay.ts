/**
 * 记忆衰减系统 - Memory Decay (LETHE 简化版)
 *
 * 类比人类记忆：时间越久，记忆越模糊，但核心事实依然保留。
 * 不删除原始数据，只在"调取"时按时间衰减压扁内容长度。
 */

export interface DecayedMemory {
  key: string;
  value: string;
  /** 0-1 之间,越小越模糊 */
  importance: number;
  /** 距今天数 */
  ageDays: number;
  /** 衰减后的内容 */
  decayedValue: string;
  /** 是否被遗忘(低于重要性阈值) */
  forgotten: boolean;
  /** 是否是"否定/作废"类记忆(纠错指令)，此类永不因低分被遗忘 */
  isRevocation?: boolean;
}

/** 衰减配置 */
export interface DecayConfig {
  /** 各时间档位允许的最大长度 */
  tiers: { maxAgeDays: number; maxLength: number }[];
  /** 重要性下限,低于此值的记忆直接遗忘 */
  forgetThreshold: number;
}

const DEFAULT_CONFIG: DecayConfig = {
  tiers: [
    { maxAgeDays: 1, maxLength: Infinity },   // 1天内 完整保留
    { maxAgeDays: 7, maxLength: 150 },        // 1周内 150字
    { maxAgeDays: 30, maxLength: 80 },        // 1月内 80字
    { maxAgeDays: 90, maxLength: 40 },        // 3月内 40字
    { maxAgeDays: Infinity, maxLength: 20 },  // 3月以上 20字
  ],
  forgetThreshold: 0.15,
};

/**
 * 否定/作废类关键词 —— 用户纠正指令。
 *
 * 为什么单独拎出来：原实现只有"喜欢/讨厌/偏好"这类肯定词表，
 * 导致「市场不用了」和「我喜欢聊天」得分完全一样(0.5)，
 * 否定式纠错因此被优先衰减掉 —— 这就是"为什么每次都要重说一遍"。
 *
 * 命中此类词的记忆是"对系统的纠正"，必须比普通偏好更稳定地保留。
 */
export const REVOCATION_KEYWORDS = [
  '作废', '不用了', '不需要', '不要', '别', '禁止', '下线', '取消', '关闭',
  '移除', '删除', '去掉', '停用', '废弃', '不再', '别再', '撤销', '失效',
  '不用', '没有这回事', '搞错了', '说错了', '更正', '纠正',
];

/**
 * 判断一段文本是否是"否定/作废"类记忆
 */
export function isRevocationText(value: string): boolean {
  if (!value) return false;
  return REVOCATION_KEYWORDS.some(k => value.includes(k));
}

/**
 * 估算记忆重要性 (0-1)
 * 规则：
 *  - 基础 0.5
 *  - 包含"喜欢/讨厌/偏好/习惯/决定/目标"等关键词 +0.2
 *  - 包含"作废/不用了/禁止/下线"等否定纠正词 +0.3（更高：对系统的纠正）
 *  - 长度 >100 字 +0.1 (长回复往往信息量大)
 *  - 多次出现 (+0.2, 由 updateCount 提供)
 */
export function estimateImportance(value: string, updateCount: number = 1): number {
  let score = 0.5;
  const keywords = ['喜欢', '讨厌', '偏好', '习惯', '决定', '目标', '计划', '生日', '名字', '电话', '地址', '邮箱', '职业', '公司', '家人', '朋友'];
  for (const k of keywords) {
    if (value.includes(k)) { score += 0.2; break; }
  }
  // 否定/作废类纠错指令 —— 权重高于普通偏好
  if (isRevocationText(value)) { score += 0.3; }
  if (value.length > 100) score += 0.1;
  if (updateCount > 1) score += Math.min(0.2, updateCount * 0.05);
  return Math.min(1, score);
}

/**
 * 对单条记忆应用衰减
 */
export function applyDecay(
  key: string,
  value: string,
  updatedAt: number,
  updateCount: number = 1,
  config: DecayConfig = DEFAULT_CONFIG
): DecayedMemory {
  const ageMs = Date.now() - updatedAt;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const importance = estimateImportance(value, updateCount);
  const isRevocation = isRevocationText(value);

  // 找到适用的时间档位
  const tier = config.tiers.find(t => ageDays <= t.maxAgeDays)!;

  let decayedValue = value;
  if (value.length > tier.maxLength) {
    // 首尾兼顾截断
    if (tier.maxLength < 40) {
      decayedValue = value.slice(0, tier.maxLength) + '…';
    } else {
      const head = Math.floor(tier.maxLength * 0.6);
      const tail = tier.maxLength - head - 1;
      decayedValue = value.slice(0, head) + '…' + value.slice(-tail);
    }
  }

  // 作废/否定类记忆永不因低分被遗忘（它是对系统的纠正，不是普通偏好）
  const forgotten = !isRevocation && importance < config.forgetThreshold;

  return {
    key,
    value,
    importance,
    ageDays: Math.round(ageDays * 10) / 10,
    decayedValue: forgotten ? '' : decayedValue,
    forgotten,
    isRevocation,
  };
}

/**
 * 对事实列表批量衰减,并按重要性+新鲜度排序
 */
export function decayFacts(
  facts: { key: string; value: string; updatedAt?: number; updateCount?: number }[],
  config: DecayConfig = DEFAULT_CONFIG
): DecayedMemory[] {
  const now = Date.now();
  return facts
    .map(f => applyDecay(
      f.key,
      f.value,
      f.updatedAt || now,
      f.updateCount || 1,
      config
    ))
    .filter(m => !m.forgotten)
    .sort((a, b) => {
      // 作废/否定类记忆永远排最前 —— 保证纠错永远压过旧事实
      if (a.isRevocation !== b.isRevocation) {
        return a.isRevocation ? -1 : 1;
      }
      // 重要性优先,其次新鲜度
      if (Math.abs(a.importance - b.importance) > 0.1) {
        return b.importance - a.importance;
      }
      return a.ageDays - b.ageDays;
    });
}

/**
 * 把衰减后的事实列表编织进 system prompt
 */
export function formatDecayedFactsForPrompt(memories: DecayedMemory[]): string {
  if (memories.length === 0) return '';
  const items = memories.map(m => {
    const freshness = m.ageDays < 1 ? '今天' : m.ageDays < 7 ? `${Math.floor(m.ageDays)}天前` : m.ageDays < 30 ? `${Math.floor(m.ageDays / 7)}周前` : `${Math.floor(m.ageDays / 30)}月前`;
    return `- [${freshness}] ${m.key}: ${m.decayedValue}`;
  });
  const revocations = memories.filter(m => m.isRevocation);
  let out = `-- 关于用户的记忆(按重要性排序) --\n${items.join('\n')}`;
  if (revocations.length > 0) {
    // 单独重申作废项 —— 防止旧事实把纠错指令"挤掉"
    const revLines = revocations.map(m => `- ${m.key}: ${m.value}`);
    out += `\n\n-- 以下为用户明确的否定/作废指令，必须严格遵守，不得再用已作废的旧设定 --\n${revLines.join('\n')}`;
  }
  return out;
}