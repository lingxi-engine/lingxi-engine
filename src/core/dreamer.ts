/**
 * Dreaming — 主动记忆整理 v1.7.0
 *
 * 空闲时 AI 主动重新审视记忆：合并重复、发现模式、生成洞察。
 * 对标 Anthropic 的 Memory Dreaming 机制。
 */

import { logger } from './logger.js';
import { getChatMemory, upsertChatMemory, listChatMemoryPairs } from '../storage/db.js';

// ─── 类型 ───

export interface DreamReport {
  chatId: string;
  agentId: string;
  timestamp: number;
  mergedFacts: number;        // 合并的重复事实
  revokedFacts?: string[];      // 本次被作废/移除的旧事实 key
  newInsights: string[];       // 新洞察
  updatedPreferences: Record<string, string>;  // 更新的偏好
}

// ─── 配置 ───

const IDLE_TIMEOUT = 30_000;  // 30 秒空闲触发
// 2026-11-12 FIX-DREAM-COST：冷却从 5 分钟提到 6 小时。
// 昨晚实测：充值 10 元后 499 次 dream 就烧掉约 8 元。根因是 5 分钟冷却对 112 组记忆
// 毫无约束力——每 10 秒扫一轮，只要有一组过了 5 分钟就再打一次，同一批记忆被反复整理。
// 记忆整理本质是「隔一段时间归纳一次」，6 小时足够，且每天最多 4 轮 × 8 组 = 32 次。
const DREAM_COOLDOWN = 21_600_000; // 6 小时内不重复 dream 同一组记忆
// 2026-11-12 新增：一组记忆「成功整理过」之后的长效抑制。
// 冷却到期只是「允许再试」，真正省钱的是「整理成功就长期不再碰」。
// 只有记忆内容真的变化了才重新排队（由 touchMemoryPair 在写入新记忆时清除抑制）。
const DREAM_SUCCESS_HOLD = 86_400_000; // 成功整理后 24 小时内不再重复
// 2026-11-11 FIX-DREAM-402：provider 余额耗尽（402 Insufficient Balance）时，
// 老实现每 10 秒扫一遍全部记忆对，每组都实打实打一次请求 → 112 组 × 每 10 秒
// ≈ 1 万次/小时，日志被刷爆（单日 2.3 万行），真实错误全被埋掉，纯烧 CPU + 磁盘。
// 这里加三重闸门：单次最多处理 N 组、402/401 等账户级错误直接熔断（冷却期内不再试）、
// 连续失败达到阈值后整体休眠一段时间。
const MAX_DREAMS_PER_ROUND = 8;        // 每轮最多处理多少组记忆
const ACCOUNT_ERROR_BACKOFF = 1_800_000; // 命中账户级错误（402/401/403/429）后整体休眠 30 分钟
const CONSECUTIVE_FAILURE_LIMIT = 5;   // 连续失败这么多次就整体休眠
const FAILURE_BACKOFF = 600_000;       // 普通连续失败休眠 10 分钟
// 2026-11-12 新增：每天最多真正发起多少次 dream（跨所有记忆对的全局预算）。
// 这是最后一道硬闸门——前面的冷却/抑制都失效时，也不能让账单失控。
const DAILY_DREAM_BUDGET = 40;

// ─── Dreamer ───

/**
 * 2026-11-11 FIX-DREAM-TRUNC：抢救被 max_tokens 截断的 JSON。
 * 模型输出 `{"a":{"b":1},"c":"未闭合` 这类残缺结构时，丢掉末尾不完整的片段，
 * 再按未闭合的 { [ 顺序补齐右括号，让本轮 dream 至少能落库已有事实。
 * 只处理「结构可推断」的截断，乱码文本仍会被 isBalanced/JSON.parse 拒绝。
 */
function tryRepairTruncated(text: string, isBalanced: (s: string) => boolean): any | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  const body = text.slice(start);

  // 从末尾往前逐步截断，找到第一个「补全后能 parse」的前缀
  for (let cut = body.length; cut > 1; cut--) {
    const head = body.slice(0, cut);
    // 结尾若停在字符串中间（奇数个未转义引号），先丢掉最后半截
    let base = head;
    let quotes = 0, esc = false;
    for (const ch of head) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') quotes++;
    }
    if (quotes % 2 === 1) {
      base = head.slice(0, head.lastIndexOf('"'));
    }
    // 去掉末尾悬空的分隔符/键名残片
    base = base.replace(/[,\s]+$/, '');
    base = base.replace(/,\s*"[^"]*$/, '');   // 悬空的 "key
    base = base.replace(/:\s*$/, '');        // 悬空的 :
    base = base.replace(/,\s*$/, '');

    const stack: string[] = [];
    let inStr = false, e2 = false;
    for (const ch of base) {
      if (e2) { e2 = false; continue; }
      if (ch === '\\') { e2 = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inStr) base += '"';   // 补上未闭合的字符串
    while (stack.length) base += stack.pop() === '{' ? '}' : ']';

    if (!isBalanced(base)) continue;
    try {
      const o = JSON.parse(base);
      // 必须有实际内容才认（空对象说明什么都没捞到）
      if (o && typeof o === 'object' && Object.keys(o).length > 0) return o;
    } catch { /* 继续往前截 */ }
  }
  return null;
}

export class Dreamer {
  private lastActivity = Date.now();
  private lastDream: Map<string, number> = new Map(); // chatId:agentId → timestamp
  private timer: ReturnType<typeof setInterval> | null = null;
  private aiClient: any;
  private aiModel: string;
  private dreaming = false; // 防止并发重入
  // 熔断状态：sleepUntil 之前完全不跑（账户级错误/连续失败退避）
  private sleepUntil = 0;
  private consecutiveFailures = 0;
  private lastBackoffLog = 0;
  // 2026-11-12 FIX-DREAM-COST：成功整理后的长效抑制表 key → 抑制到期时间戳
  private successHold: Map<string, number> = new Map();
  // 每日调用预算：记录「今天已发起多少次 dream」+ 所属日期
  private dailyCount = 0;
  private dailyDate = '';

  /** 今天是否还有预算（跨自然日自动重置） */
  private hasDailyBudget(): boolean {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyDate) {
      this.dailyDate = today;
      this.dailyCount = 0;
    }
    return this.dailyCount < DAILY_DREAM_BUDGET;
  }

  /** 记一次已发起的 dream（无论成败都计入，因为请求已经发出去了） */
  private consumeDailyBudget(): void {
    this.dailyCount++;
  }

  /** 判断这次错误是不是「账户级」——余额耗尽/未授权/无权限/限流，退避要更长 */
  private isAccountLevelError(msg: string): boolean {
    const m = String(msg || '');
    return /\b(401|402|403|429)\b|Insufficient Balance|invalid[_ ]api[_ ]key|quota|billing|usage limit|rate limit/i.test(m);
  }

  /** 进入退避休眠，并打印一次（不刷屏） */
  private enterBackoff(ms: number, reason: string) {
    this.sleepUntil = Date.now() + ms;
    const now = Date.now();
    // 同一个退避原因 60 秒内只打一次，避免每 10 秒重复刷同一行
    if (now - this.lastBackoffLog > 60_000) {
      this.lastBackoffLog = now;
      logger.warn('Dreamer', `暂停整理 ${Math.round(ms / 60000)} 分钟：${reason}`);
    }
  }

  constructor(aiClient: any, aiModel: string) {
    this.aiClient = aiClient;
    this.aiModel = aiModel;
    // 诊断：把真正生效的 baseURL 打出来，避免「明明配了 DeepSeek 却在打 Ollama」这类漂移无从排查
    try {
      const bu = aiClient?.baseURL || aiClient?.baseUrl || '(unknown)';
      logger.info('Dreamer', `客户端就绪: model=${aiModel} baseURL=${bu}`);
    } catch { /* ignore */ }
  }

  /** 记录活动，重置空闲计时 */
  touch() {
    this.lastActivity = Date.now();
  }

  /**
   * 2026-11-12 FIX-DREAM-COST：记忆内容有更新时，解除该对的「成功抑制」，
   * 让它下一轮就能重新排队整理。
   * 没有这个机制的话，successHold 会把新写入的记忆永远挡在门外（24 小时内不整理），
   * 记忆整理就等于对新内容失效。由写入 chat_memories 的路径调用。
   */
  touchMemoryPair(chatId: string, agentId: string): void {
    if (!chatId || !agentId) return;
    const k = `${chatId}:${agentId}`;
    if (this.successHold.delete(k)) {
      logger.debug('Dreamer', `记忆有更新，解除整理抑制: ${k}`);
    }
    // 同时重置冷却：新内容应当尽快被整理，而不是再等 6 小时
    this.lastDream.delete(k);
    this.lastActivity = Date.now();
  }

  /** 启动 dreaming 循环 */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkAndDream(), 10_000);
    logger.info('Dreamer', 'Dreaming 循环已启动 (30s idle)');
  }

  /** 停止 */
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private async checkAndDream() {
    // 退避休眠期内直接跳过（连 DB 都不查，彻底零成本）
    if (this.sleepUntil > Date.now()) return;
    const idle = Date.now() - this.lastActivity;
    if (idle < IDLE_TIMEOUT) return;
    if (this.dreaming) return; // 上一轮还没结束
    // 2026-11-12 FIX-DREAM-COST：当日预算用尽就不再扫 DB，彻底零成本。
    // 这是最后一道闸门，防止任何前面逻辑的疏漏把账单打爆。
    if (!this.hasDailyBudget()) return;

    this.dreaming = true;
    try {
      // v29: 补上「遍历所有有记忆的群聊」—— 从 chat_memories 表拉出所有 (chat_id, agent_id) 对
      let pairs: Array<{ chat_id: string; agent_id: string }> = [];
      try {
        pairs = listChatMemoryPairs();
      } catch (err: any) {
        logger.warn('Dreamer', `列出记忆对失败: ${err.message}`);
        return;
      }

      if (pairs.length === 0) {
        // 没有可整理的记忆，诚实记录而不是假装在跑
        logger.debug('Dreamer', '无待整理记忆（chat_memories 为空）');
        return;
      }

      const nowTs = Date.now();
      // 一轮只处理前 N 组（按最久没 dream 的优先），避免 112 组 × 每 10 秒的雪崩
      const candidates = pairs
        .filter(p => p?.chat_id && p?.agent_id)
        .filter(p => {
          const k = `${p.chat_id}:${p.agent_id}`;
          // 成功整理过的，在抑制期内直接跳过（省钱的关键一道）
          const holdUntil = this.successHold.get(k) || 0;
          if (holdUntil > nowTs) return false;
          return true;
        })
        .map(p => ({ p, last: this.lastDream.get(`${p.chat_id}:${p.agent_id}`) || 0 }))
        .filter(x => nowTs - x.last >= DREAM_COOLDOWN)
        .sort((a, b) => a.last - b.last)
        .slice(0, MAX_DREAMS_PER_ROUND);

      if (candidates.length === 0) return; // 全部在冷却/抑制期内

      let dreamed = 0;
      for (const { p } of candidates) {
        // 每处理完一个就刷新活动时间，避免长时间批量 dream 时被判定空闲
        try {
          const report = await this.dream(p.chat_id, p.agent_id);
          if (report) {
            dreamed++;
            this.consecutiveFailures = 0;
            // 2026-11-12：成功整理过就长期不再碰，除非有新记忆写入（touchMemoryPair 清除）
            this.successHold.set(`${p.chat_id}:${p.agent_id}`, Date.now() + DREAM_SUCCESS_HOLD);
          }
        } catch (err: any) {
          this.consecutiveFailures++;
          const msg = err?.message || String(err);
          logger.warn('Dreamer', `Dream ${p.chat_id}/${p.agent_id} 失败: ${msg}`);
          if (this.isAccountLevelError(msg)) {
            // 账户级错误（余额/额度/鉴权）：整个 Dreamer 停 30 分钟，别继续烧
            this.enterBackoff(ACCOUNT_ERROR_BACKOFF, `账户级错误，整理已暂停：${msg.slice(0, 120)}`);
            break;
          }
          if (this.consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
            this.enterBackoff(FAILURE_BACKOFF, `连续 ${this.consecutiveFailures} 次失败`);
            break;
          }
        }
      }
      if (dreamed > 0) {
        logger.audit('Dreamer', 'auto-dream', `本轮整理 ${dreamed}/${candidates.length} 组记忆`);
      }
    } finally {
      this.dreaming = false;
    }
  }

  /**
   * 对指定群聊的指定 Agent 执行 dreaming
   */
  async dream(chatId: string, agentId: string): Promise<DreamReport | null> {
    const key = `${chatId}:${agentId}`;
    const lastTime = this.lastDream.get(key) || 0;

    // 冷却检查
    if (Date.now() - lastTime < DREAM_COOLDOWN) return null;

    const mem = getChatMemory(chatId, agentId);
    if (!mem?.memory_summary || mem.memory_summary.length < 100) return null;

    // 2026-11-12 FIX-DREAM-COST：预算用尽的最后拦截（防止直接调 dream() 的调用点绕过 checkAndDream）
    if (!this.hasDailyBudget()) return null;

    logger.info('Dreamer', `Dreaming: ${chatId}/${agentId}`);
    // 请求即将发出，立刻计入当日预算（不管成败，钱已经要花了）
    this.consumeDailyBudget();

    try {
      // 解析现有事实
      let facts: Record<string, string> = {};
      try { facts = JSON.parse(mem.memory_facts || '{}'); } catch {}
      // __insights 是 Dreamer 自己的元数据，不能当成「用户事实」喂给模型
      delete (facts as any).__insights;

      // 解析现有洞察
      // 2026-11-11 FIX：insights 存在 memory_facts 的 $.__insights 键里（见下方写入逻辑），
      // 老代码读的是 (mem as any).insights —— chat_memories 表根本没有 insights 列，
      // 所以每次 dream 都从空洞察开始，历史洞察永远丢失。改为从 facts.__insights 读。
      let insights: string[] = [];
      try {
        const rawInsights = (facts as any).__insights;
        if (Array.isArray(rawInsights)) insights = rawInsights.filter((x: any) => typeof x === 'string');
      } catch { /* ignore */ }

      // AI Dreaming
      const prompt = `你是一个记忆整理助手。请审视以下 AI 的记忆，完成四件事：

1. 合并重复的事实（如果多条事实说同一件事，合并为一条）
2. 发现隐藏的模式或洞察（例如"用户连续三次提到性能问题，可能优先级很高"）
3. 更新用户偏好（如果发现新偏好，记录下来）
4. **作废与纠正（最重要）**：如果记忆摘要或事实中出现用户后来明确否定、作废、取消、更正的内容
   （例如"市场不用了""XX 功能下线了""之前说的作废""别再提 XX"），
   必须把对应的旧事实标记为作废并从结果中移除，**绝对不允许新旧两条并存**。
   作废 = 用新事实覆盖旧事实，而不是在旧事实旁边再追加一条新的。

当前记忆摘要：
${mem.memory_summary}

当前已知事实：
${JSON.stringify(facts, null, 2)}

已有洞察：
${insights.join('\n')}

请以 JSON 格式输出（不要有其他内容）：
{
  "mergedFacts": { "key": "value", ... },   // 合并后的事实（更新已有的）
  "revokedFacts": ["被作废的旧事实的key", ...], // 必须被移除的旧事实 key（没有就填 []）
  "newInsights": ["洞察1", "洞察2", ...],    // 新发现的模式
  "summaryUpdate": "优化后的记忆摘要"        // 如果摘要需要更新
}`;

      const resp = await this.aiClient.chat.completions.create({
        model: this.aiModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        // 2026-11-12 FIX-DREAM-COST：从 8000 降到 4000。
        // 8000 是为了修「JSON 被截断」加的，但实测 deepseek-flash 单次 completion 只用了
        // 约 1800 token（推理 ~1300 + JSON ~500），8000 属于严重超配。
        // 昨晚 499 次整理烧掉约 8 元，其中大部分是这多出来的预算在陪跑。
        // 4000 足够覆盖「推理 4300 字」的极端情况 + 完整 JSON 输出，成本直接砍半。
        max_tokens: 4000,
      });

      const choice: any = resp.choices?.[0] || {};
      const text = choice?.message?.content || '';

      // 2026-11-11 FIX-DREAM-EMPTY：实测 deepseek-flash 会偶发返回「content 为空、
      // 内容全落在 reasoning_content」的响应（finish_reason 正常 stop）。
      // 老代码只看 content，空串一路走到 JSON 解析必然失败，日志还只报「解析失败」，
      // 完全看不出真实原因。这里先识别这种情况，并把 finish_reason / 空响应如实记下来。
      const finish = choice?.finish_reason || '';
      const reasoning = choice?.message?.reasoning_content || choice?.message?.reasoning || '';
      const usage = resp.usage || {};
      if (!String(text).trim()) {
        logger.warn(
          'Dreamer',
          `Dreaming 返回空内容（finish_reason=${finish || 'unknown'}，reasoning ${String(reasoning).length} 字，` +
          `tokens: prompt=${usage.prompt_tokens ?? '?'}/completion=${usage.completion_tokens ?? '?'}）`
        );
        return null;
      }

      // 2026-11-11 FIX-DREAM-JSON：老正则是非贪婪的 \{...\:\|\} —— 遇到嵌套对象
      // （mergedFacts 本身是个对象）会在第一个 } 处截断，导致 JSON.parse 100% 失败。
      // 实测 deepseek-flash 返回的合法 JSON 也被判成"解析失败"，记忆整理功能等于完全没生效。
      // 改为：① 去掉 ```json 围栏；② 取第一个 { 到最后一个 }（贪婪），覆盖嵌套；
      //       ③ 逐个候选做括号配平校验，只认真正配平的那段，避免把尾部说明文字吞进来。
      const stripFence = text.replace(/```(?:json)?/gi, '').trim();

      const candidates: string[] = [];
      const first = stripFence.indexOf('{');
      const last = stripFence.lastIndexOf('}');
      if (first !== -1 && last > first) {
        candidates.push(stripFence.slice(first, last + 1)); // 贪婪：覆盖嵌套对象
        candidates.push(stripFence.slice(first));           // 兜底：末尾有多余文字时
      }

      /** 括号配平校验（忽略字符串内的括号/转义），配平才认为是完整 JSON */
      const isBalanced = (s: string): boolean => {
        let depth = 0, inStr = false, esc = false;
        for (const ch of s) {
          if (esc) { esc = false; continue; }
          if (ch === '\\') { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (inStr) continue;
          if (ch === '{' || ch === '[') depth++;
          else if (ch === '}' || ch === ']') { depth--; if (depth < 0) return false; }
        }
        return depth === 0;
      };

      let parsed: any = null;
      const tried = candidates.filter(c => isBalanced(c));
      for (const c of tried) {
        try { parsed = JSON.parse(c); break; } catch { /* 试下一个 */ }
      }
      // 最后兜底：在原文本里逐个 '{' 起点试配平截取（模型偶发在 JSON 前加说明文字）
      if (!parsed) {
        for (let i = 0; i < stripFence.length && !parsed; i++) {
          if (stripFence[i] !== '{') continue;
          const sub = stripFence.slice(i);
          if (!isBalanced(sub)) continue;
          try { parsed = JSON.parse(sub); } catch { /* 继续找下一个起点 */ }
        }
      }
      if (!parsed) {
        // 2026-11-11 FIX-DREAM-TRUNC：模型被 max_tokens 截断时 JSON 缺右括号。
        // 只要已经拿到了能用的字段（mergedFacts / summaryUpdate 等），补全闭合括号抢救一次，
        // 总比整轮 dream 白跑一趟强（前面 8000 的预算已能覆盖绝大多数情况，这里是最后一道网）。
        const salvage = tryRepairTruncated(stripFence, isBalanced);
        if (salvage) {
          parsed = salvage;
          logger.warn('Dreamer', 'Dreaming JSON 被截断，已自动补全闭合括号抢救');
        }
      }
      if (!parsed) {
        logger.warn('Dreamer', `Dreaming JSON 解析失败（原文前 200 字）: ${stripFence.slice(0, 200)}`);
        return null;
      }
      const result = parsed;
      const mergedCount = Object.keys(result.mergedFacts || {}).length;

      // 更新记忆
      // 更新记忆：合并 + **真正移除被作废的旧事实**
      // 原实现是纯展开 { ...facts, ...mergedFacts }，没有任何删除通道，
      // 导致被否定的旧事实永远残留、与新事实并存（"市场已屏蔽"与"AI员工市场"同时存在）。
      // 这里按 key 显式 delete，把"否决"从模型的隐式推断变成代码里的确定行为。
      const updatedFacts: Record<string, string> = { ...facts, ...(result.mergedFacts || {}) };
      const revokedKeys: string[] = Array.isArray(result.revokedFacts) ? result.revokedFacts : [];
      for (const k of revokedKeys) {
        if (k) delete updatedFacts[k];
      }
      if (revokedKeys.length > 0) {
        logger.audit('Dreamer', 'revoke', `${chatId}/${agentId}: revoked=${revokedKeys.join(',')}`);
      }
      const newSummary = result.summaryUpdate || mem.memory_summary;
      // 2026-11-11 FIX：老写法 [...new Set([...a, ...b])] 在 downlevelIteration 下会炸；
      // 用 filter 判重等价且更省内存。
      const mergedInsights: string[] = insights.slice();
      for (const s of (result.newInsights || [])) {
        if (s && !mergedInsights.includes(s)) mergedInsights.push(s);
      }
      const allInsights = mergedInsights.slice(-20); // 最多 20 条

      upsertChatMemory(chatId, agentId, newSummary, updatedFacts);

      // 存储 insights 到 metadata
      // 2026-11-11 FIX：老代码读 globalThis.__db，但全仓库从来没给它赋过值
      // → insights 永远写不进库（功能等于没接线）。改为走 db.js 的导出函数。
      try {
        const { getDB } = await import('../storage/db.js');
        const d = getDB() as any;
        d.run(
          `UPDATE chat_memories SET memory_facts = json_set(
            COALESCE(memory_facts, '{}'), '$.__insights', ?
          ) WHERE chat_id = ? AND agent_id = ?`,
          [JSON.stringify(allInsights), chatId, agentId]
        );
      } catch (e: any) {
        logger.warn('Dreamer', `insights 写入失败: ${e?.message || e}`);
      }

      this.lastDream.set(key, Date.now());

      logger.audit('Dreamer', 'dream', `${chatId}/${agentId}: merged=${mergedCount}, insights=${allInsights.length}`);

      return {
        chatId, agentId,
        timestamp: Date.now(),
        mergedFacts: mergedCount,
        revokedFacts: revokedKeys,
        newInsights: result.newInsights || [],
        updatedPreferences: result.mergedFacts || {},
      };
    } catch (err: any) {
      const msg = err?.message || String(err);
      // 2026-11-11 FIX：402/401/403/429 这类账户级错误要标记出来，供 checkAndDream 熔断判断。
      // 老实现只 logger.error 一句就 return null，调用方看不出「这是余额问题还是网络抖动」，
      // 结果 112 组记忆每 10 秒全部重打一遍，日志被刷到 2.3 万行/天。
      const tag = this.isAccountLevelError(msg) ? ' [ACCOUNT]' : '';
      logger.error('Dreamer', `Dreaming 失败${tag}: ${msg}`);
      const e: any = new Error(msg);
      e.accountLevel = !!tag;
      throw e;
    }
  }
}
