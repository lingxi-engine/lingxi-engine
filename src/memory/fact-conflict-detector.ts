/**
 * 事实冲突检测模块
 * 在写入 memory_facts 前调用，返回冲突信息供上层决策
 * 依赖：轻量规则 + 可选 LLM 判断
 */

import { globalDedup } from './semantic-dedup.js';
import { extractJsonObject } from './json-extract.js';

export interface FactEntry {
  key: string;
  value: string;
  source: 'user' | 'assistant' | 'system' | 'inferred';
  confidence: number; // 0-1
  createdAt: number;
  updatedAt: number;
  conflictWith?: string[]; // 冲突的旧 key 列表
  conflictReason?: string;
  superseded?: boolean; // 是否被新版本取代
}

export interface ConflictResult {
  hasConflict: boolean;
  conflicts: Array<{
    existingKey: string;
    existingValue: string;
    newKey: string;
    newValue: string;
    reason: 'direct_contradiction' | 'semantic_override' | 'temporal_supersede' | 'preference_change';
    severity: 'low' | 'medium' | 'high';
    suggestion: 'keep_both' | 'replace_old' | 'replace_new' | 'ask_user';
  }>;
  action: 'allow' | 'allow_with_warning' | 'block' | 'ask_user';
}

/**
 * 规则基冲突检测（同步、快速、无外部依赖）
 */
export class RuleBasedConflictDetector {
  // 直接矛盾模式：key 相同但 value 互斥
  private contradictionPatterns = [
    // 偏好类
    { keys: ['喜欢', '偏好', '爱吃', '讨厌', '不吃', '过敏'], pattern: /^(喜欢|偏好|爱吃|讨厌|不吃|过敏)[：:]\s*(.+)$/ },
    // 身份类
    { keys: ['姓名', '名字', '叫', '身份', '职业', '工作'], pattern: /^(姓名|名字|叫|身份|职业|工作)[：:]\s*(.+)$/ },
    // 状态类
    { keys: ['状态', '情况', '条件'], pattern: /^(状态|情况|条件)[：:]\s*(.+)$/ },
  ];

  // 互斥值对（可扩展为配置文件）
  private mutuallyExclusive: Record<string, string[]> = {
    '饮食': ['素食', '荤食', '清真', '犹太洁食', '生酮', '低碳水'],
    '过敏': ['花生', '海鲜', '乳制品', '麸质', '大豆', '鸡蛋'],
    '作息': ['早起', '夜猫子', '倒时差'],
  };

  detect(newFact: FactEntry, existingFacts: Map<string, FactEntry>): ConflictResult {
    const conflicts: ConflictResult['conflicts'] = [];

    for (const [existKey, existFact] of existingFacts) {
      // 1. 同 key 直接覆盖检查（最高优先级）
      if (existKey === newFact.key) {
        if (existFact.value !== newFact.value) {
          conflicts.push({
            existingKey: existKey,
            existingValue: existFact.value,
            newKey: newFact.key,
            newValue: newFact.value,
            reason: 'direct_contradiction',
            severity: this.assessSeverity(existKey, existFact.value, newFact.value),
            suggestion: this.suggestResolution(existFact, newFact, true), // 标记为同key冲突
          });
        }
        continue;
      }

      // 2. 语义覆盖检查（如「姓名：张三」vs「叫：张三」）
      const semanticConflict = this.checkSemanticOverride(existKey, existFact.value, newFact.key, newFact.value);
      if (semanticConflict) {
        conflicts.push(semanticConflict);
        continue;
      }

      // 3. 时序取代检查（新事实显式表示「现在/目前」覆盖旧状态）
      const temporalConflict = this.checkTemporalSupersede(existFact, newFact);
      if (temporalConflict) {
        conflicts.push(temporalConflict);
        continue;
      }

      // 4. 偏好变更检测
      const prefConflict = this.checkPreferenceChange(existFact, newFact);
      if (prefConflict) {
        conflicts.push(prefConflict);
      }
    }

    return this.aggregateResult(conflicts);
  }

  private checkSemanticOverride(
    eKey: string, eVal: string, nKey: string, nVal: string
  ): ConflictResult['conflicts'][0] | null {
    // 同一实体不同键名
    const entityPatterns = [
      { keys: ['姓名', '名字', '叫'], type: 'identity' },
      { keys: ['年龄', '岁数'], type: 'age' },
      { keys: ['城市', '居住地', '家乡', '所在地'], type: 'location' },
      { keys: ['职业', '工作', '职位'], type: 'job' },
      // [P1-1 FIX] 偏好类从语义覆盖移除，改由 preference_change 处理
    ];

    for (const { keys, type } of entityPatterns) {
      const eMatch = keys.find(k => eKey.includes(k));
      const nMatch = keys.find(k => nKey.includes(k));
      if (eMatch && nMatch && eVal !== nVal) {
        return {
          existingKey: eKey,
          existingValue: eVal,
          newKey: nKey,
          newValue: nVal,
          reason: 'semantic_override',
          severity: type === 'identity' ? 'high' : 'medium',
          suggestion: 'replace_old',
        };
      }
    }
    return null;
  }

  private checkTemporalSupersede(exist: FactEntry, newer: FactEntry): ConflictResult['conflicts'][0] | null {
    // 新事实包含时间标记且更新时间更晚
    const temporalMarkers = ['现在', '目前', '当前', '最新', '更新为', '改为', '变更为'];
    const hasTemporalMarker = temporalMarkers.some(m => newer.value.includes(m) || newer.key.includes(m));
    
    if (hasTemporalMarker && newer.updatedAt > exist.updatedAt) {
      // 检查是否同类实体
      if (this.sameEntityCategory(exist.key, newer.key)) {
        return {
          existingKey: exist.key,
          existingValue: exist.value,
          newKey: newer.key,
          newValue: newer.value,
          reason: 'temporal_supersede',
          severity: 'medium',
          suggestion: 'replace_old',
        };
      }
    }
    return null;
  }

  private checkPreferenceChange(exist: FactEntry, newer: FactEntry): ConflictResult['conflicts'][0] | null {
    const prefKeys = ['喜欢', '偏好', '爱吃', '讨厌', '不吃', '偏爱', '过敏'];
    const isPref = prefKeys.some(k => exist.key.includes(k) || newer.key.includes(k));
    if (!isPref) return null;

    // 同类别偏好反转
    for (const [category, values] of Object.entries(this.mutuallyExclusive)) {
      const eVal = exist.value;
      const nVal = newer.value;
      const eHas = values.some(v => eVal.includes(v));
      const nHas = values.some(v => nVal.includes(v));
      if (eHas && nHas) {
        // 找到具体互斥值
        const eSpecific = values.find(v => eVal.includes(v));
        const nSpecific = values.find(v => nVal.includes(v));
        if (eSpecific !== nSpecific) {
          return {
            existingKey: exist.key,
            existingValue: exist.value,
            newKey: newer.key,
            newValue: newer.value,
            reason: 'preference_change',
            severity: 'low',
            // [P1-1 FIX] 偏好变更改为 replace_old，避免同类偏好共存污染画像
            suggestion: 'replace_old',
          };
        }
      }
    }
    return null;
  }

  private sameEntityCategory(keyA: string, keyB: string): boolean {
    const categories = [
      ['姓名', '名字', '叫'],
      ['年龄', '岁数'],
      ['城市', '居住地', '家乡', '所在地'],
      ['职业', '工作', '职位'],
      ['喜欢', '偏好', '爱吃', '讨厌', '不吃', '过敏'],
    ];
    return categories.some(cat => 
      cat.some(k => keyA.includes(k)) && cat.some(k => keyB.includes(k))
    );
  }

  private assessSeverity(key: string, oldVal: string, newVal: string): 'low' | 'medium' | 'high' {
    const highSeverityKeys = ['姓名', '名字', '身份证', '手机', '邮箱', '地址', '过敏'];
    if (highSeverityKeys.some(k => key.includes(k))) return 'high';
    if (key.includes('偏好') || key.includes('喜欢') || key.includes('讨厌') || key.includes('爱吃') || key.includes('不吃')) return 'low';
    return 'medium';
  }

  private suggestResolution(exist: FactEntry, newer: FactEntry, isSameKey: boolean = false): ConflictResult['conflicts'][0]['suggestion'] {
    // 同 key 直接矛盾：按置信度、来源、更新时间决策
    if (isSameKey) {
      // [P1-2 FIX] 同 key 冲突时比较 updatedAt：更新时间新的才覆盖
      if (newer.updatedAt > exist.updatedAt) {
        // 高置信度新事实覆盖低置信度旧事实
        if (newer.confidence > exist.confidence + 0.2) return 'replace_old';
        if (exist.confidence > newer.confidence + 0.2) return 'replace_new';
        // 用户明确陈述 > 推断
        if (newer.source === 'user' && exist.source !== 'user') return 'replace_old';
        if (exist.source === 'user' && newer.source !== 'user') return 'replace_new';
        // 默认：新值替换旧值（更新时间更新）
        return 'replace_old';
      } else {
        // 新事实更旧，保留旧值
        return 'replace_new';
      }
    }
    
    // 不同 key 的语义冲突
    // 高置信度新事实覆盖低置信度旧事实
    if (newer.confidence > exist.confidence + 0.2) return 'replace_old';
    if (exist.confidence > newer.confidence + 0.2) return 'replace_new';
    // 用户明确陈述 > 推断
    if (newer.source === 'user' && exist.source !== 'user') return 'replace_old';
    if (exist.source === 'user' && newer.source !== 'user') return 'replace_new';
    return 'keep_both';
  }

  private aggregateResult(conflicts: ConflictResult['conflicts']): ConflictResult {
    if (conflicts.length === 0) {
      return { hasConflict: false, conflicts: [], action: 'allow' };
    }

    const highSeverity = conflicts.filter(c => c.severity === 'high').length;
    const replaceOld = conflicts.filter(c => c.suggestion === 'replace_old').length;
    const askUser = conflicts.filter(c => c.suggestion === 'ask_user').length;

    let action: ConflictResult['action'] = 'allow_with_warning';
    if (highSeverity > 0) action = 'ask_user';
    else if (replaceOld === conflicts.length) action = 'allow'; // 全部建议替换旧，直接放行
    else if (askUser > 0) action = 'ask_user';

    return { hasConflict: true, conflicts, action };
  }
}

/**
 * LLM 增强冲突检测（异步、可选）
 * 用于规则无法覆盖的复杂语义冲突
 */
export class LLMConflictDetector {
  constructor(
    private readonly llmCall: (prompt: string) => Promise<string>,
    private readonly enabled: boolean = true
  ) {}

  async detect(newFact: FactEntry, existingFacts: Map<string, FactEntry>): Promise<ConflictResult> {
    if (!this.enabled || existingFacts.size === 0) {
      return { hasConflict: false, conflicts: [], action: 'allow' };
    }

    // 只对高价值 fact 调用 LLM（节省 token）
    const candidateKeys = this.selectCandidates(newFact, existingFacts);
    if (candidateKeys.length === 0) return { hasConflict: false, conflicts: [], action: 'allow' };

    const prompt = this.buildPrompt(newFact, candidateKeys.map(k => existingFacts.get(k)!));
    try {
      const response = await this.llmCall(prompt);
      return this.parseResponse(response, newFact, candidateKeys);
    } catch (e) {
      console.warn('[LLMConflictDetector] 调用失败，回退规则检测:', e);
      return { hasConflict: false, conflicts: [], action: 'allow' };
    }
  }

  private selectCandidates(newFact: FactEntry, existing: Map<string, FactEntry>): string[] {
    // 优先选同类别、高置信度、近期的 fact
    return Array.from(existing.entries())
      .filter(([k, v]) => this.sameCategory(k, newFact.key) || v.confidence > 0.8)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 10)
      .map(([k]) => k);
  }

  private sameCategory(keyA: string, keyB: string): boolean {
    const cats = [
      ['姓名', '名字', '叫', '身份'],
      ['年龄', '岁数', '生日'],
      ['城市', '居住', '家乡', '所在'],
      ['职业', '工作', '职位', '公司'],
      ['喜欢', '偏好', '爱吃', '讨厌', '不吃', '过敏'],
      ['技能', '会', '擅长', '精通'],
    ];
    return cats.some(cat => 
      cat.some(k => keyA.includes(k)) && cat.some(k => keyB.includes(k))
    );
  }

  private buildPrompt(newFact: FactEntry, candidates: FactEntry[]): string {
    return `判断新事实与现有事实是否冲突。仅输出 JSON。

新事实：
- key: "${newFact.key}"
- value: "${newFact.value}"
- source: ${newFact.source}
- confidence: ${newFact.confidence}

候选现有事实：
${candidates.map((f, i) => `${i+1}. key="${f.key}" value="${f.value}" source=${f.source} conf=${f.confidence}`).join('\n')}

输出格式：
{
  "conflicts": [
    {"index": 1, "reason": "direct_contradiction|semantic_override|temporal_supersede|preference_change", "severity": "low|medium|high", "suggestion": "keep_both|replace_old|replace_new|ask_user"}
  ]
}

无冲突返回 {"conflicts": []}。`;
  }

  private parseResponse(response: string, newFact: FactEntry, candidateKeys: string[]): ConflictResult {
    try {
      const parsed = JSON.parse(extractJsonObject(response));
      const conflicts = (parsed.conflicts || []).map((c: any) => {
        const idx = c.index - 1;
        const existFact = candidateKeys[idx];
        return {
          existingKey: existFact,
          existingValue: '', // 实际使用时需补全
          newKey: newFact.key,
          newValue: newFact.value,
          reason: c.reason,
          severity: c.severity,
          suggestion: c.suggestion,
        };
      });
      return {
        hasConflict: conflicts.length > 0,
        conflicts,
        action: conflicts.some((c: { severity: string; suggestion: string }) => c.severity === 'high' || c.suggestion === 'ask_user') ? 'ask_user' : 'allow_with_warning',
      };
    } catch {
      return { hasConflict: false, conflicts: [], action: 'allow' };
    }
  }
}

/**
 * 统一入口：先规则后 LLM
 */
export class FactConflictDetector {
  private rule = new RuleBasedConflictDetector();
  private llm?: LLMConflictDetector;

  setLLMDetector(llm: LLMConflictDetector) {
    this.llm = llm;
  }

  async detect(newFact: FactEntry, existingFacts: Map<string, FactEntry>): Promise<ConflictResult> {
    // 1. 规则检测（同步、快速）
    const ruleResult = this.rule.detect(newFact, existingFacts);
    
    // 2. 无高严重冲突且启用 LLM -> 二次检测
    if (!ruleResult.hasConflict || ruleResult.action !== 'ask_user') {
      return ruleResult;
    }

    if (this.llm) {
      const llmResult = await this.llm.detect(newFact, existingFacts);
      // 合并：取并集，严重度取最大
      const merged = this.mergeResults(ruleResult, llmResult);
      return merged;
    }

    return ruleResult;
  }

  private mergeResults(a: ConflictResult, b: ConflictResult): ConflictResult {
    const all = [...a.conflicts, ...b.conflicts];
    // 去重（同 existingKey）
    const unique = new Map<string, ConflictResult['conflicts'][0]>();
    for (const c of all) {
      const key = c.existingKey;
      if (!unique.has(key) || this.severityRank(c.severity) > this.severityRank(unique.get(key)!.severity)) {
        unique.set(key, c);
      }
    }
    const conflicts = Array.from(unique.values());
    return {
      hasConflict: conflicts.length > 0,
      conflicts,
      action: conflicts.some((c: { severity: string; suggestion: string }) => c.severity === 'high' || c.suggestion === 'ask_user') ? 'ask_user' : 'allow_with_warning',
    };
  }

  private severityRank(s: string): number {
    return { low: 1, medium: 2, high: 3 }[s] || 0;
  }
}

// 导出单例
export const globalConflictDetector = new FactConflictDetector();

// ─────────────────────────────────────────────────────────────────────────────
// 简化版 API：直接对比两组 key->value 事实，返回可读冲突列表。
// 供主链路与测试使用（不依赖 FactEntry 的完整元数据）。
// ─────────────────────────────────────────────────────────────────────────────

export interface FactConflict {
  oldFact: string;
  newFact: string;
  type: 'numeric' | 'entity' | 'boolean';
  resolution: 'replace' | 'keep_both' | 'ask_user';
}

export interface SimpleConflictResult {
  hasConflict: boolean;
  conflicts: FactConflict[];
}

/** 把 '是/否'、'喜欢/不喜欢'、'yes/no'、'true/false' 归一化成正反两面 */
function booleanPolarity(value: string): 1 | -1 | 0 {
  const v = String(value).trim().toLowerCase();
  const positive = ['是', 'yes', 'true', '喜欢', '要', '开', '启用', 'on', '1'];
  const negative = ['否', 'no', 'false', '不喜欢', '不要', '关', '禁用', 'off', '0'];
  if (positive.includes(v)) return 1;
  if (negative.includes(v)) return -1;
  return 0;
}

/**
 * 提取「纯数值」：整个字符串必须就是一个数字（允许小数、负号、千分位）。
 *
 * [FIX] 旧实现用 /-?\d+(?:\.\d+)?/ 取第一个数字段，导致版本号 "1.0.0" 被解析成 1、
 * "2.0.0" 被解析成 2，于是版本升级被误判成「数值冲突」。
 * 只有整串确实是数字时，才算数值型事实。
 */
function firstNumber(value: string): number | null {
  const v = String(value).trim().replace(/,/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 对比现有事实与新事实，找出冲突。
 *
 * 判定规则：
 *   1. 数值冲突 —— 同一 key，两边都能解析出数字且数字不同
 *   2. 布尔取反 —— 同一 key，两边极性相反（是/否、喜欢/不喜欢、yes/no）
 *   3. 实体替换 —— 同一 key，两边都是非空文本且值不同（兜底）
 *
 * 同 key 且值完全相同 → 不算冲突。
 * 不同 key → 不算冲突（那是新增，不是冲突）。
 */
export async function detectConflicts(
  existing: Record<string, string>,
  incoming: Record<string, string>
): Promise<SimpleConflictResult> {
  const conflicts: FactConflict[] = [];

  for (const [key, newValue] of Object.entries(incoming || {})) {
    if (!(key in (existing || {}))) continue; // 新增 key，不是冲突
    const oldValue = String(existing[key] ?? '');
    const nv = String(newValue ?? '');
    if (oldValue === nv) continue; // 完全相同

    const oldNum = firstNumber(oldValue);
    const newNum = firstNumber(nv);
    const oldPol = booleanPolarity(oldValue);
    const newPol = booleanPolarity(nv);

    if (oldPol !== 0 && newPol !== 0 && oldPol !== newPol) {
      conflicts.push({ oldFact: key, newFact: key, type: 'boolean', resolution: 'replace' });
      continue;
    }

    if (oldNum !== null && newNum !== null && oldNum !== newNum) {
      conflicts.push({ oldFact: key, newFact: key, type: 'numeric', resolution: 'replace' });
      continue;
    }

    // 兜底：同 key 值不同 → 实体替换
    conflicts.push({ oldFact: key, newFact: key, type: 'entity', resolution: 'replace' });
  }

  return { hasConflict: conflicts.length > 0, conflicts };
}
