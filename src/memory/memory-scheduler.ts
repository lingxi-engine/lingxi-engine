/**
 * 回复前的记忆调度器。
 *
 * 真人不是把记得的全倒出来，而是按当前目标只提取几条。
 * 这里用规则做同一件事：作废永远入选；和当前问题/目标没有词面或实体重叠的事实不入选。
 * 身份类（名字、城市、职业）只在自我介绍、署名、地址场景入选。
 */

export interface SchedulableFact {
  key: string;
  value: string;
  updatedAt?: number;
  confidence?: number;
}

export interface MemoryScheduleInput {
  query: string;
  recentTurns?: string[];
  taskGoal?: string;
  facts: SchedulableFact[];
  summary?: string;
  maxFacts?: number;
  maxSummaryChars?: number;
}

export interface ScheduledFact extends SchedulableFact {
  reason: 'revocation' | 'query_overlap' | 'identity_context' | 'goal_overlap';
  confidence: number;
}

export interface MemoryScheduleResult {
  facts: ScheduledFact[];
  summary: string;
  dropped: number;
}

const REVOCATION = ['作废', '不用了', '不需要', '不要', '别再', '禁止', '下线', '取消', '关闭', '移除', '删除', '去掉', '停用', '废弃', '不再', '撤销', '失效', '更正', '纠正', '搞错了', '说错了'];
const IDENTITY_KEYS = ['名字', '姓名', '叫', '城市', '居住', '家乡', '所在', '职业', '工作', '职位', '公司', '身份', 'name', 'city', 'job', 'company', 'email', 'phone'];
const IDENTITY_QUERY = ['自我介绍', '介绍一下', '署名', '签名', '地址', '我是谁', '你是谁', '名字', '姓名', '城市', '职业', '公司', '邮箱', '电话'];

const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们', '一个', '这个', '那个', '什么', '怎么', '如何',
  '帮我', '请', '一下', '以及', '然后', '还是', '或者', '因为', '所以', '如果', '可以', '需要', '现在', '目前',
  'the', 'a', 'an', 'to', 'for', 'of', 'and', 'or', 'is', 'are', 'please', 'help',
]);

export function isRevocationFact(fact: { key: string; value: string }): boolean {
  const text = `${fact.key} ${fact.value}`;
  return REVOCATION.some(k => text.includes(k));
}

function isIdentityFact(fact: { key: string; value: string }): boolean {
  return IDENTITY_KEYS.some(k => fact.key.includes(k));
}

function wantsIdentity(text: string): boolean {
  return IDENTITY_QUERY.some(k => text.includes(k));
}

/** 抽 2 字中文块和英文/数字词，丢掉停用词。 */
export function memoryTokens(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const latin = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  for (const w of latin) {
    if (!STOP.has(w) && w.length >= 2) out.add(w);
  }
  const han = text.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const block of han) {
    if (block.length <= 6 && !STOP.has(block)) out.add(block);
    // 滑窗 2 字，让「德国客户」能撞上「外贸」「客户」
    for (let i = 0; i < block.length - 1 && i < 24; i++) {
      const g = block.slice(i, i + 2);
      if (!STOP.has(g)) out.add(g);
    }
  }
  return [...out];
}

function overlaps(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(b);
  return a.some(t => set.has(t));
}

function clip(text: string, max: number): string {
  const t = (text || '').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * 选出本轮允许想起的记忆。宁可不想起来，也不要把无关事实端上桌。
 */
export function scheduleMemoryForReply(input: MemoryScheduleInput): MemoryScheduleResult {
  const maxFacts = input.maxFacts ?? 5;
  const maxSummary = input.maxSummaryChars ?? 400;
  const cueText = [input.query || '', ...(input.recentTurns || []).slice(-3), input.taskGoal || ''].join('\n');
  const cueTokens = memoryTokens(cueText);
  const goalTokens = memoryTokens(input.taskGoal || '');
  const identityOn = wantsIdentity(cueText);

  const selected: ScheduledFact[] = [];
  const seen = new Set<string>();

  const push = (fact: SchedulableFact, reason: ScheduledFact['reason'], confidence: number) => {
    if (seen.has(fact.key) || selected.length >= maxFacts) return;
    seen.add(fact.key);
    selected.push({
      key: fact.key,
      value: fact.value,
      updatedAt: fact.updatedAt,
      reason,
      confidence,
    });
  };

  for (const fact of input.facts) {
    if (!fact?.key || fact.value == null || fact.value === '') continue;
    if (isRevocationFact(fact)) push(fact, 'revocation', fact.confidence ?? 0.95);
  }

  for (const fact of input.facts) {
    if (selected.length >= maxFacts) break;
    if (!fact?.key || seen.has(fact.key)) continue;
    const factTokens = memoryTokens(`${fact.key} ${fact.value}`);
    if (isIdentityFact(fact)) {
      if (identityOn) push(fact, 'identity_context', fact.confidence ?? 0.8);
      continue;
    }
    if (goalTokens.length > 0 && overlaps(factTokens, goalTokens)) {
      push(fact, 'goal_overlap', fact.confidence ?? 0.75);
      continue;
    }
    if (overlaps(factTokens, cueTokens)) {
      push(fact, 'query_overlap', fact.confidence ?? 0.7);
    }
  }

  let summary = '';
  const rawSummary = (input.summary || '').trim();
  if (rawSummary) {
    const lines = rawSummary.split(/\n+/).map(s => s.trim()).filter(Boolean);
    const hit = lines.filter(line => overlaps(memoryTokens(line), cueTokens));
    const body = (hit.length > 0 ? hit : lines.slice(-2)).join('\n');
    summary = clip(body, maxSummary);
  }

  return {
    facts: selected,
    summary,
    dropped: Math.max(0, input.facts.length - selected.length),
  };
}

export function formatScheduledMemory(result: MemoryScheduleResult, note: string): string[] {
  const lines: string[] = [];
  if (result.summary) {
    lines.push('## 和本轮有关的记忆', note, result.summary, '');
  }
  if (result.facts.length === 0) return lines;
  lines.push('## 本轮允许想起的事实', note);
  lines.push('只使用下面这些事实。没列出来的旧记忆视为本轮没想起，不要补充、不要脑补。置信度低于 0.6 的，先追问，不要写进对外内容。');
  for (const f of result.facts) {
    const conf = typeof f.confidence === 'number' ? f.confidence.toFixed(2) : '0.70';
    const tag = f.reason === 'revocation' ? '作废' : f.reason === 'identity_context' ? '身份' : '相关';
    lines.push(`- [${tag} 置信${conf}] ${f.key}: ${f.value}`);
  }
  lines.push('');
  return lines;
}
