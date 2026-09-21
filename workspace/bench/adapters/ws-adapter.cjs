#!/usr/bin/env node
/**
 * bench/adapters/ws-adapter.cjs —— 灵犀引擎真实任务入口适配器（WebSocket）
 *
 * 真实入口：WS /ws（index.ts 挂载 → src/core/ws-handler.ts:handleWSMessage）
 * 协议：{type:"message"|"agent.task", chatId, content, meta?}
 *
 * 版本沿革（每条都对应一次实测量到的坑，非推测）：
 *   v1.0  初版 WS 适配器，能连上但事件恒为空。
 *   v1.1  [FIX] chatId 契约断裂：曾自造 `bench-<task>-<group>` →
 *            router 用 getChatParticipants(chatId) 过滤 → 查无此 chat → 零应答。
 *            改为从 ?id=<clientId> 推导真 chatId，查 participants 端点取真 agentId。
 *   v1.2  [FIX] 事件字段契约断裂：总正文取 e.chunk（服务端从不发 delta/content）；
 *            streaming.end 不再立即 resolve（真终稿在紧随的 message.new）。
 *   v1.3  [FIX] 任务隔离 + 判据归一化 + agentId 轮询重试。
 *   v1.5  [FIX] 六处尺子级缺陷：violation 词边界匹配(修 Format-Table 误伤) / file_exists mtime 残留守卫 /
 *               L2-005 判据客观化 / L3-001 去锚定 / L2-004 去锚定 / manual_rubric 单列不计分母。
 *               → 首次在正确路由的快模型上产出可复现受控 Δ（见 BENCHMARK-REPORT-v19.md）
 *   v1.4  [FIX] 四项尺子级缺陷（本轮实测坐实）：
 *            (a) 路径契约：题库用 /workspace/xxx，沙箱关闭时 Windows 会解析到
 *                C:\workspace\xxx（实测该目录已存在 21 个误落文件），
 *                而判据查的是 <repo>/workspace/xxx → 必假阴性。
 *                统一改写 `/workspace/` → 相对路径，prompt 与判据同源。
 *            (b) 多选题支持：L3-003/L3-005 是**跨轮记忆**题，单轮结构上不可能过。
 *                新增 task.turns[]，同一 chat/agent 顺序发多轮，判据取末轮。
 *            (c) tool_call_args 路径容错：`bench/data` vs `bench/data/` 不再误杀。
 *            (d) exact_match 数字 token 兜底：`答案是 7097663。` 这类包裹可命中。
 *
 * 已知边界（诚实声明）：
 *   ⚠️ 服务端 ws-handler.ts `case "message"` 只解构 {chatId,content,replyTo}，**meta 整段丢弃**。
 *      group 上的 memory/reflect/metacog 开关在真实链路里空转。
 *      当前**真实可测**的分组差异仅：G1(type=message 单Agent工具循环) vs
 *      G6(type=agent.task DAG编排)。G2/G3/G4 需服务端改契约，见文件末 TODO。
 *   ⚠️ L3 的「跨任务记忆」尚未做：隔离模式下每题都是干净记忆，因此 L3-003/L3-005
 *      只测「同一任务内跨轮记忆」，不是「跨任务召回」。要测后者需要「记忆播种阶段」设计。
 *
 * 用法：
 *   node bench/adapters/ws-adapter.cjs --layers L1,L2 --group G1,G6 --url ws://localhost:3599/ws?id=x
 *   node bench/adapters/ws-adapter.cjs --selftest      # 判据层离线自检
 *
 * 环境变量：LINGXI_BENCH_CLIENT / LINGXI_BENCH_AGENT / LINGXI_BENCH_STAMP
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─────────────────────────── 仓库定位 ───────────────────────────
const REPO = process.env.LINGXI_REPO || path.resolve(__dirname, '..', '..', '..', '..', 'lingxi-engine');
const WORKSPACE = process.env.LINGXI_WORKSPACE || path.resolve(REPO, 'workspace');

// 隔离 run 戳记：默认进程启动时刻，保证每次调用都是干净房间
const RUN_STAMP = process.env.LINGXI_BENCH_STAMP || Date.now().toString(36);

let WebSocket;
function loadWS() {
  if (WebSocket) return WebSocket;
  const cands = [path.join(REPO, 'node_modules', 'ws'), path.join(WORKSPACE, 'node_modules', 'ws'), 'ws'];
  for (const c of cands) { try { WebSocket = require(c); return WebSocket; } catch (_) {} }
  throw new Error('找不到 ws 模块，请确认已 npm install');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── 路径契约 ───────────────────────────
/**
 * 题库里写 `/workspace/bench/out/x`，但沙箱根 = <repo>/workspace。
 * 沙箱关闭时 `/workspace/...` 是绝对路径 → Windows 解析到 C:\workspace\...（错位）。
 * 统一剥掉前缀，让 prompt 与判据都落在 <repo>/workspace 下，同源可比。
 */
function normalizePathText(s) {
  return String(s == null ? '' : s).replace(/\/workspace\//g, '');
}

// ── [V23] 判据隔离：每个 (group,task) 独立输出沙箱，杜绝跨组残留污染 ──
const SBX_ROOT = 'bench/out/_sbx'; // ADAPTER_V23
function sbxSlugOf(groupId, taskId) {
  return String(groupId + '-' + taskId).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}
function rewriteOutPath(s, slug) {
  if (typeof s !== 'string' || !slug) return s;
  return s.replace(/(?:\/workspace\/)?bench\/out\/(?!_sbx\/)/g, SBX_ROOT + '/' + slug + '/');
}
function prepareSbx(slug) {
  if (!slug) return null;
  const abs = path.resolve(WORKSPACE, SBX_ROOT, slug);
  try { fs.rmSync(abs, { recursive: true, force: true }); } catch (_) {}
  try { fs.mkdirSync(abs, { recursive: true }); } catch (_) {}
  return abs;
}

// ─────────────────────────── HTTP / URL 工具 ───────────────────────────
function httpBaseOf(url) {
  const m = String(url).match(/^(wss?):\/\/([^/]+)/i);
  if (!m) throw new Error('非法 WS URL: ' + url);
  return `${m[1].toLowerCase() === 'wss' ? 'https' : 'http'}://${m[2]}`;
}

function withClientId(url, clientId) {
  try { const u = new URL(String(url)); u.searchParams.set('id', clientId); return u.toString(); }
  catch (_) { return String(url).replace(/([?&]id=)[^&]*/, `$1${encodeURIComponent(clientId)}`); }
}

function httpGetJson(base, pathname, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let mod;
    try { mod = base.startsWith('https') ? require('https') : require('http'); } catch (_) { return resolve(null); }
    const u = new URL(base + pathname);
    const req = mod.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const resolveChatId = (clientId) => 'chat-' + clientId;

async function resolveAgentId(base, chatId) {
  const j = await httpGetJson(base, `/api/chats/${encodeURIComponent(chatId)}/participants`);
  const ps = (j && (j.participants || j.data)) || [];
  const hit = ps.find((p) => p && (p.agent_id || (p.role === 'agent' && p.agentId)));
  return hit ? (hit.agent_id || hit.agentId) : null;
}

async function resolveAgentIdRetry(base, chatId, explicit, tries = 10, gapMs = 350) {
  if (explicit) return explicit;
  if (process.env.LINGXI_BENCH_AGENT) return process.env.LINGXI_BENCH_AGENT;
  for (let i = 0; i < tries; i++) {
    const id = await resolveAgentId(base, chatId);
    if (id) return id;
    await sleep(gapMs);
  }
  return null;
}

// ─────────────────────────── 判据层 ───────────────────────────
function normalize(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/^\s*#{1,6}\s*/gm, '').replace(/\*\*|__|~~|\*|`/g, '');
  t = t.replace(/[\s\u00a0,，]+/g, '');
  t = t.replace(/^[。．.!！?？、,，:：;；"'“”‘’()（）\[\]【】<>《》]+|[。．.!！?？、,，:：;；"'“”‘’()（）\[\]【】<>《》]+$/g, '');
  return t.trim();
}

const safeRegExp = (p) => { try { return new RegExp(p); } catch (_) { return null; } };

function judge(criteria, rec, ctx) {
  ctx = ctx || {};
  const out = rec.output || '';
  const flag = (ok, reason) => ({ ok: !!ok, reason: reason || '' });
  if (!criteria || typeof criteria !== 'object') return flag(false, 'no criteria');
  // v27c: 兼容 run.ts 传入 task 对象（解包 success_criteria）
  if (criteria && typeof criteria === 'object' && !criteria.type && criteria.success_criteria) {
    criteria = criteria.success_criteria;
  }

  switch (criteria.type) {
    case 'file_exists': {
      const rel = normalizePathText(criteria.path);
      const p = path.resolve(WORKSPACE, rel);
      if (!fs.existsSync(p)) return flag(false, `文件不存在: ${rel} (${p})`);
      const st = fs.statSync(p);
      // V19c fix: 残留物防护 —— 交付物必须写于本轮任务开始之后
      if (rec.startedAt && st.mtimeMs < rec.startedAt - 3000) {
        return flag(false, `残留文件（早于本轮 ${Math.round((rec.startedAt - st.mtimeMs) / 1000)}s）: ${rel}`);
      }
      if (criteria.min_bytes && st.size < criteria.min_bytes) return flag(false, `过小 ${st.size}B < ${criteria.min_bytes}B`);
      if (criteria.must_contain_any && criteria.must_contain_any.length) {
        const txt = fs.readFileSync(p, 'utf8');
        if (!criteria.must_contain_any.some((k) => txt.includes(k))) return flag(false, '未包含任一关键词');
      }
      return flag(true, `${rel} ok(${st.size}B)`);
    }

    case 'exact_match': {
      const want = criteria.value;
      if (out === want) return flag(true, 'exact(raw)');
      const wn = normalize(want);
      if (normalize(out) === wn) return flag(true, 'exact(normalized)');
      // 数字答案 token 兜底：`答案是 7097663。` 也应命中，但 `312` 不含 `12`
      if (/^\d+(\.\d+)?$/.test(wn)) {
        // 去千分位逗号：`7,097,663` 应等于 `7097663`（L1-002 实测踩坑）
        const outNum = out.replace(/(\d),(\d)/g, '$1$2');
        const re = new RegExp('(^|[^0-9.])' + wn.replace('.', '\\.') + '([^0-9.]|$)');
        if (re.test(outNum)) return flag(true, 'exact(numeric-token)');
        // V16 fix: 数值等价兜底 —— `03` 应等于 `3`，`3.0` 应等于 `3`（L1-003 实测踩坑）
        {
          const toks = outNum.match(/\d+(?:\.\d+)?/g) || [];
          if (toks.some((t) => Number(t) === Number(wn))) return flag(true, 'exact(numeric-value)');
        }
      }
      return flag(false, `期望 "${want}" 实得 "${String(out).slice(0, 40)}"`);
    }

    case 'regex': {
      const re = safeRegExp(criteria.pattern);
      if (!re) return flag(false, 'bad regex');
      if (re.test(out)) return flag(true, 'regex(raw)');
      if (re.test(normalize(out))) return flag(true, 'regex(normalized)');
      return flag(false, `未命中 /${criteria.pattern}/`);
    }

    case 'tool_call_args': {
      const call = (rec.toolCalls || []).find((t) => t && t.name === criteria.tool);
      if (!call) return flag(false, `未调用工具 ${criteria.tool}`);
      const args = call.args || {};
      for (const [k, v] of Object.entries(criteria.args_contain || {})) {
        if (k === 'time_contains') {
          if (!JSON.stringify(args).includes(String(v))) return flag(false, `args 未含时间 ${v}`);
          continue;
        }
        const a = String(args[k] == null ? '' : args[k]).replace(/\\/g, '/').replace(/\/+$/, '');
        const b = String(v).replace(/\\/g, '/').replace(/\/+$/, '');
        // 路径类参数容忍 `bench/data` vs `/workspace/bench/data`
        const okPath = b.includes('/') && (a === b || a.includes(b) || normalizePathText(a).includes(b));
        if (a !== b && !okPath) return flag(false, `args.${k}="${args[k]}" ≠ "${v}"`);
      }
      return flag(true, `${criteria.tool} args ok`);
    }

    case 'manual_rubric':
      return flag(ctx.humanScore != null ? ctx.humanScore >= (criteria.min_score || 0.7) : null, '需人工评分');

    default:
      return flag(false, '未知判据类型 ' + criteria.type);
  }
}

function scanViolations(rec, forbidden) {
  const v = [];
  for (const rule of forbidden || []) {
    const [tool, frag] = String(rule).split(':');
    for (const c of rec.toolCalls || []) {
      if (c.name !== tool) continue;
      const blob = JSON.stringify(c.args || {});
      // V19 fix: 词边界匹配 —— 修复 Format-Table / performance 等含 'rm' 子串的误伤
      let hit = false;
      try {
        const safe = String(frag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        hit = new RegExp('(?:^|[^A-Za-z0-9_-])' + safe + '(?![A-Za-z0-9_-])').test(blob);
      } catch (_) { hit = blob.includes(String(frag)); }
      if (hit) v.push(rule);
    }
  }
  return v;
}

// ─────────────────────────── WS 会话（支持多轮） ───────────────────────────
function createSession({ url, chatId, clientId, group, agentId, useTaskMode, criteria, taskCtx, earlyExit, sbx }) {
  const WS = loadWS();
  const ws = new WS(url);
  let cur = null;

  const openPromise = new Promise((resolve, reject) => {
    ws.on('open', () => {
      // V14 修复(events=0 根因): 服务端 broadcast 只投递给已订阅该 chatId 的连接。
      // 未订阅 => subs 为空 => 所有带 chatId 的事件被整条丢弃 => events=0 + 静默超时。
      try { ws.send(JSON.stringify({ type: 'subscribe', chatId })); } catch (_) {}
      resolve();
    });
    ws.on('error', (e) => reject(e));
  });

  const finalize = (why) => {
    if (!cur) return;
    const c = cur; cur = null;
    clearTimeout(c.timer); clearTimeout(c.endTimer);
    // V15 fix: client 收敛后主动中止服务端生成（否则客户端放弃后服务端仍跑 CHAT_TIMEOUT=1200s，
    // 单张本地模型被僵尸生成打满 → 后续任务全部空返回。用现成的 case 'stop' 路径，零服务端改动）。
    try { ws.send(JSON.stringify({ type: 'stop', chatId })); } catch (_) {}
    c.resolve({ output: (c.authority || c.buffer || '').trim(), toolCalls: c.toolCalls, events: c.events, error: c.error || null, finishReason: why });
  };

  const handleEv = (ev) => {
    const t = ev.type;
    if (t === 'agent.streaming.chunk' || t === 'agent.chunk') {
      cur.buffer += ev.chunk != null ? ev.chunk : (ev.delta != null ? ev.delta : (ev.content || ''));
      return;
    }
    if (t === 'agent.tool_call' || t === 'agent.tool.called' || t === 'agent.tool.call' || t === 'tool.call' || t === 'tool_call') {
      cur.toolCalls.push({ name: ev.toolName || ev.tool || ev.name || (ev.call && ev.call.name) || '?', args: ev.args || ev.arguments || (ev.call && ev.call.args) || {} });
      return;
    }
    if (t === 'agent.streaming.end' || t === 'agent.done') {
      clearTimeout(cur.endTimer); cur.endTimer = setTimeout(() => finalize('end-grace'), 1500); return;
    }
    if (t === 'message.new') {
      const m = ev.message || ev;
      const isAgent = (m.senderType === 'agent') || (m.fromUserId == null && m.agentId) || m.role === 'agent' || m.isAgent;
      if (isAgent && typeof m.content === 'string' && m.content.length) {
        cur.authority = m.content;
        clearTimeout(cur.endTimer); cur.endTimer = setTimeout(() => finalize('message.new'), 250);
      }
      return;
    }
    if (t === 'agent.error' || t === 'error') { cur.error = ev.message || 'agent error'; finalize('error'); return; }
  };

  ws.on('message', (raw) => {
    if (!cur) return;
    let ev; try { ev = JSON.parse(raw.toString()); } catch (_) { return; }
    cur.events++;
    try { handleEv(ev); } catch (_) {}
    if (!cur) return;
    // V14 达标即停：每收到事件即评估判据，满足立刻收敛（不再等 agent 自己收工）
    if (earlyExit && criteria && criteria.type && criteria.type !== 'manual_rubric') {
      try {
        const j = judge(criteria, { output: (cur.authority || cur.buffer || ''), toolCalls: cur.toolCalls }, taskCtx || {});
        if (j.ok) { cur.criteriaMet = true; finalize('criteria-met'); }
      } catch (_) {}
    }
  });

  ws.on('close', () => finalize('closed'));

  return {
    openPromise,
    async send(prompt, timeoutMs, agentIdOverride) {
      await openPromise;
      try { ws.send(JSON.stringify({ type: 'subscribe', chatId })); } catch (_) {}
      const payload = useTaskMode
        ? { type: 'agent.task', chatId, clientId, agentId: agentIdOverride || agentId, goal: prompt, meta: { bench: true, group: group && group.id, tools: group && group.tools, memory: group && group.memory, reflect: group && group.reflect, metacog: group && group.metacog, multiAgent: group && group.multiAgent, model: group && group.model, sbx: (sbx || null) } }
        : { type: 'message', chatId, clientId, content: prompt, replyTo: null, meta: { bench: true, group: group && group.id, tools: group && group.tools, memory: group && group.memory, reflect: group && group.reflect, metacog: group && group.metacog, multiAgent: group && group.multiAgent, model: group && group.model, sbx: (sbx || null) } };
      // agentId 已在载荷中显式带上（agentIdOverride 优先），此处不再回填
      return await new Promise((resolve) => {
        cur = { resolve, buffer: '', authority: '', toolCalls: [], events: 0, timer: null, endTimer: null, error: null };
        cur.timer = setTimeout(() => { cur.error = `timeout>${Math.round(timeoutMs / 1000)}s`; finalize('timeout'); }, timeoutMs);
        try { ws.send(JSON.stringify(payload)); } catch (e) { cur.error = 'send 失败: ' + e.message; finalize('send-error'); }
      });
    },
    close() { try { ws.close(); } catch (_) {} },
  };
}

// ─────────────────────────── 单任务执行 ───────────────────────────
// 环境错误分类：区分"能力失败"与"环境故障"（429/网络/供应商过载），后者不计入能力达标率
function classifyEnvError(rec) {
  const blob = ((rec.error || '') + ' ' + (rec.output || '')).toLowerCase();
  const pats = [
    ['rate_limit', /429|rate[\s_-]?limit|too many requests/],
    ['provider_down', /连续失败\s*\d+\s*次|ai 调用连续失败/],
    ['network', /econnreset|etimedout|socket hang up|fetch failed|enotfound|eai_again|econnrefused/],
    ['overloaded', /overloaded|server_error|5\d\d status code/],
    ['external_block', /akamai|captcha|403 forbidden|access denied|robot check|perimeterx/], // V33 外网封锁是环境问题不是能力问题
  ];
  for (const [reason, re] of pats) if (re.test(blob)) return { envError: true, envReason: reason };
  return { envError: false, envReason: '' };
}

// V36: 每题有效超时 = 显式 timeoutMs > budget.seconds*1000 > 60s，再乘倍率、再抬到下限。
function computeTimeoutMs(task, opts) {
  let ms = (opts && opts.timeoutMs) || (task && task.budget && task.budget.seconds ? task.budget.seconds * 1000 : 60000);
  if (opts && opts.timeoutMult) ms = Math.round(ms * Number(opts.timeoutMult));
  if (opts && opts.minTimeoutMs) ms = Math.max(ms, Number(opts.minTimeoutMs));
  return ms;
}

async function runTask(opts) {
  const { task, group, url } = opts;
  const timeoutMs = computeTimeoutMs(task, opts);
  const isolate = opts.isolate !== false;

  const clientId = opts.clientId
    || process.env.LINGXI_BENCH_CLIENT
    || (isolate ? `bench-${RUN_STAMP}-${group.id}-${task.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '-') : 'bench-runner');

  const useUrl = withClientId(url, clientId);
  const base = httpBaseOf(useUrl);
  const chatId = opts.chatId || resolveChatId(clientId);
  const useTaskMode = !!(group && group.multiAgent);

  const rawTurns = (Array.isArray(task.turns) && task.turns.length) ? task.turns : [task.prompt];
  const turns = rawTurns.map(normalizePathText);

  // [V23] 判据隔离：把本题产物重定向到专属沙箱
  const sbxSlugV23 = isolate ? sbxSlugOf(group.id, task.id) : null;
  if (sbxSlugV23) for (let i = 0; i < turns.length; i++) turns[i] = rewriteOutPath(turns[i], sbxSlugV23);
  const criteriaV23 = JSON.parse(JSON.stringify(task.success_criteria || {}));
  if (typeof criteriaV23.path === 'string') criteriaV23.path = rewriteOutPath(criteriaV23.path, sbxSlugV23);
  prepareSbx(sbxSlugV23);

  const rec = {
    taskId: task.id, group: group.id, isolate, clientId, chatId, agentId: null,
    multiTurn: turns.length > 1, turnCount: turns.length,
    success: false, steps: 0, toolCalls: [], tokensIn: 0, tokensOut: 0, usd: 0,
    startedAt: Date.now(),
    latencyMs: 0, violations: [], events: 0, output: '', turnOutputs: [], judge: null, error: null,
  };

  // V14: 跑前清理 file_exists 目标，避免上轮遗留文件造成 judge 假阳性
  try {
    const sc = task.success_criteria;
    if (sc && sc.type === 'file_exists' && typeof sc.path === 'string') {
      let rel = sc.path;
      if (rel.startsWith('/workspace/')) rel = rel.slice(11);
      else if (rel.startsWith('workspace/')) rel = rel.slice(10);
      else rel = rel.replace(/^\/+/, '');
      const abs = path.resolve(WORKSPACE, rel);
      if (abs.startsWith(WORKSPACE) && fs.existsSync(abs)) fs.unlinkSync(abs);
    }
  } catch (_) {}

  const maxAttempts = opts.maxAttempts || Number(process.env.LINGXI_BENCH_MAXATTEMPTS || 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    rec.turnOutputs = []; rec.toolCalls = []; rec.events = 0; rec.error = null;
    const t0 = Date.now();
    const session = createSession({ url: useUrl, chatId, clientId, group, agentId: opts.agentId, useTaskMode, criteria: criteriaV23, taskCtx: task, earlyExit: turns.length === 1, sbx: sbxSlugV23 });
    try {
      await session.openPromise;
      rec.agentId = await resolveAgentIdRetry(base, chatId, opts.agentId);
      for (const turn of turns) {
        const out = await session.send(turn, timeoutMs, rec.agentId);
        rec.events += out.events;
        rec.toolCalls.push(...out.toolCalls);
        rec.turnOutputs.push(out.output);
        if (out.error) { rec.error = out.error; break; }
      }
    } catch (e) {
      rec.error = rec.error || ('session 失败: ' + (e && e.message));
    } finally {
      session.close();
    }
    rec.latencyMs = Date.now() - t0;
    rec.output = rec.turnOutputs.length ? rec.turnOutputs[rec.turnOutputs.length - 1] : '';
    rec.attempts = attempt;
    const env = classifyEnvError(rec);
    if (!env.envError || attempt >= maxAttempts) { rec.envError = env.envError; rec.envReason = env.envReason; break; }
    const wait = 5000 * attempt;
    console.log('   [env-error] attempt ' + attempt + '/' + maxAttempts + ': ' + env.envReason + ' -> backoff ' + wait + 'ms retry');
    await new Promise((r) => setTimeout(r, wait));
  }

  rec.steps = rec.toolCalls.length;
  // V35 [FIX] steps=0 度量自检：工具疑似跑了但事件没回传（见 bench/L5-STEPS0-ROOTCAUSE.md）
  try {
    const TOOLISH = /(read_file|list_dir|shell_exec|write_file|web_search|web_fetch|delegate_task|collab_task|子代理|已调用|调用工具|读取文件|列出目录|执行命令)/;
    rec.metricSuspect = (rec.toolCalls.length === 0 && rec.events > 0 && TOOLISH.test(String(rec.output || '')));
  } catch (_) { rec.metricSuspect = false; }
  rec.output = rec.turnOutputs.length ? rec.turnOutputs[rec.turnOutputs.length - 1] : '';

  const j = judge(criteriaV23, rec, {});
  rec.judge = j;
  rec.manual = !!(task.success_criteria && task.success_criteria.type === 'manual_rubric');
  rec.preScreen = (task.success_criteria && task.success_criteria.pre_screen) || null; // V33
  rec.violations = scanViolations(rec, task.forbidden);
  rec.success = j.ok === true && rec.violations.length === 0 && !rec.error && !rec.envError;
  return rec;
}

// ─────────────────────────── 判据层自检 ───────────────────────────
function selftest() {
  const mk = (over) => Object.assign({ output: '', toolCalls: [] }, over);
  const cases = [
    ['exact_match 命中', judge({ type: 'exact_match', value: '7097663' }, mk({ output: '7097663' })).ok === true],
    ['exact_match 千分位+粗体归一', judge({ type: 'exact_match', value: '7097663' }, mk({ output: '**7,097,663**' })).ok === true],
    ['exact_match 中文包裹 token', judge({ type: 'exact_match', value: '7097663' }, mk({ output: '答案是 7097663。' })).ok === true],
    ['exact_match 数值边界不误伤', judge({ type: 'exact_match', value: '12' }, mk({ output: '共 312 个' })).ok === false],
    ['exact_match 未命中', judge({ type: 'exact_match', value: '答案' }, mk({ output: '别的' })).ok === false],
    ['regex 纯数字', judge({ type: 'regex', pattern: '^\\d+$' }, mk({ output: '12' })).ok === true],
    ['regex 归一后命中', judge({ type: 'regex', pattern: '^\\d+$' }, mk({ output: '**12。**' })).ok === true],
    ['regex 未命中', judge({ type: 'regex', pattern: '^\\d+$' }, mk({ output: 'abc' })).ok === false],
    ['tool_call_args 命中', judge({ type: 'tool_call_args', tool: 'calendar_create', args_contain: { title: '灵犀周会', time_contains: '19:30' } },
      mk({ toolCalls: [{ name: 'calendar_create', args: { title: '灵犀周会', time: '19:30' } }] })).ok === true],
    ['tool_call_args 路径容错', judge({ type: 'tool_call_args', tool: 'list_dir', args_contain: { path: 'bench/data' } },
      mk({ toolCalls: [{ name: 'list_dir', args: { path: '/workspace/bench/data/' } }] })).ok === true],
    ['tool_call_args 缺工具', judge({ type: 'tool_call_args', tool: 'x' }, mk({ toolCalls: [] })).ok === false],
    ['violation 命中', scanViolations(mk({ toolCalls: [{ name: 'shell_exec', args: { cmd: 'rm -rf /' } }] }), ['shell_exec:rm']).length === 1],
    ['violation 不误伤', scanViolations(mk({ toolCalls: [{ name: 'read_file', args: {} }] }), ['shell_exec:rm']).length === 0],
    ['file_exists 缺文件', judge({ type: 'file_exists', path: '__nope__.txt' }, mk({})).ok === false],
    ['path 归一', normalizePathText('/workspace/bench/out/x.txt') === 'bench/out/x.txt'],
  ];
  let pass = 0;
  for (const [name, ok] of cases) { console.log(`${ok ? '✅' : '❌'} ${name}`); if (ok) pass++; }
  console.log(`\n判据自检 ${pass}/${cases.length} ${pass === cases.length ? 'PASS' : 'FAIL'}`);
  return pass === cases.length;
}

// ─────────────────────────── CLI ───────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2), next = argv[i + 1];
      if (next && !next.startsWith('--')) { a[k] = next; i++; } else a[k] = true;
    } else a._.push(t);
  }
  return a;
}

const LAYER_FILE = {
  L1: 'bench/tasks/L1-single-tool.json',
  L2: 'bench/tasks/L2-multi-step.json',
  L3: 'bench/tasks/L3-long-horizon.json',
  L4: 'bench/tasks/L4-adversarial.json',
  L5: 'bench/tasks/L5-multi-agent.json',
};

const GROUPS = {
  G0: { id: 'G0', name: '纯模型基线(无工具/无记忆/无反思)', multiAgent: false, tools: false, memory: false, reflect: false, metacog: false },
  G1: { id: 'G1', name: '单Agent+工具', multiAgent: false, tools: true, memory: false, reflect: false, metacog: false },
  G2: { id: 'G2', name: 'G1+记忆', multiAgent: false, tools: true, memory: true, reflect: false, metacog: false },
  G3: { id: 'G3', name: 'G2+反思', multiAgent: false, tools: true, memory: true, reflect: true, metacog: false },
  G4: { id: 'G4', name: 'G3+元认知', multiAgent: false, tools: true, memory: true, reflect: true, metacog: true },
  G6: { id: 'G6', name: '多Agent编排', multiAgent: true },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) process.exit(selftest() ? 0 : 1);
  if (args.summarize) return summarizeDir(args.summarize); // V39b: 离线重算 SUMMARY，不连引擎

  const url = args.url || process.env.LINGXI_BENCH_URL || 'ws://localhost:3599/ws?id=bench-runner';
  const layers = (args.layers || args.layer || 'L1').split(',').map((s) => s.trim()).filter(Boolean);
  const groupIds = (args.group ? String(args.group).split(',') : ['G1']).map((s) => s.trim()).filter(Boolean);
  const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : null;
  const isolate = args.shared ? false : (args.isolate !== false);
  const benchModel = args['bench-model'] || process.env.LINGXI_BENCH_MODEL || '';
  const outDir = path.resolve(WORKSPACE, args.out || `bench/results/${new Date().toISOString().slice(0, 10).replace(/-/g, '')}live`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`▶ 适配器 v1.5  隔离=${isolate}  stamp=${RUN_STAMP}  url=${url}`);
  console.log(`▶ 层=${layers.join(',')}  组=${groupIds.join(',')}  输出=${outDir}\n`);

  const rows = [];
  for (const layer of layers) {
    const file = LAYER_FILE[layer];
    if (!file) { console.warn('跳过未知层 ' + layer); continue; }
    const spec = JSON.parse(fs.readFileSync(path.resolve(WORKSPACE, file), 'utf8'));
    const tasks = spec.tasks.filter((t) => !only || only.includes(t.id));
    for (const gid of groupIds) {
      const group = GROUPS[gid] || { id: gid, name: gid, multiAgent: false };
      if (benchModel) group.model = benchModel;
      for (const task of tasks) {
        const rec = await runTask({ task, group, url, isolate, timeoutMs: args.timeout ? Number(args.timeout) * 1000 : undefined, timeoutMult: args['timeout-mult'], minTimeoutMs: args['min-timeout'] ? Number(args['min-timeout']) * 1000 : undefined });
        rows.push(rec);
        console.log(`${rec.success ? '✅' : '❌'} ${gid} ${task.id}  steps=${rec.steps} tools=${rec.toolCalls.length} ` +
          `turns=${rec.turnCount} ${rec.latencyMs}ms judge=${JSON.stringify(rec.judge)} err=${rec.error || '-'}`);
        console.log(`   chat=${rec.chatId} agent=${rec.agentId || '?'}`);
        console.log(`   out=${JSON.stringify((rec.output || '').slice(0, 120))}`);
        fs.writeFileSync(path.join(outDir, `${gid}-${task.id}.json`), JSON.stringify(rec, null, 2));
      }
    }
  }

  const summary = buildSummary(rows);
  console.log('\n' + summary);
  fs.writeFileSync(path.join(outDir, 'SUMMARY.txt'), summary + '\n');
  fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify(rows, null, 2));
  console.log(`\n✔ 结果写入 ${outDir}`);
}

// V39b: 由 rows 生成 SUMMARY 文本（main 与 --summarize 共用，口径唯一）
function buildSummary(rows) {
  const byGroup = {};
  for (const r of rows) {
    const g = (byGroup[r.group || 'UNKNOWN'] = byGroup[r.group || 'UNKNOWN'] || { n: 0, ok: 0, all: 0, allSteps: 0, allTools: 0, steps: 0, tools: 0, ms: [], env: 0, manual: 0, mrows: [] }); // V39
    g.all++; g.allSteps += (r.steps || 0); g.allTools += ((r.toolCalls || []).length); // V39: manual 也跑过，实测指标照收
    if (r.manual) { g.manual++; g.ms.push(r.latencyMs); g.mrows.push({ t: r.taskId, env: !!r.envError, ps: r.preScreen || null, out: String(r.output || '').replace(/\s+/g, ' ').slice(0, 90) }); continue; } // V33
    g.n++; if (r.success) g.ok++; g.steps += (r.steps || 0); g.tools += ((r.toolCalls || []).length); g.ms.push(r.latencyMs || 0); // V39: 容错残缺 JSON
    if (r.envError) g.env++;
  }
  const lines = ['组别\t达标率(去环境错误)\t达标率(原始)\t环境错误\t需人工\t平均步数\t工具调用\tP50ms', '─'.repeat(66)];
  for (const [gid, g] of Object.entries(byGroup)) {
    const ms = g.ms.slice().sort((a, b) => a - b);
    const valid = g.n - g.env;
    const rateValid = valid > 0 ? Math.round((g.ok / valid) * 100) + '%' : '-';
    const rateRaw = g.n > 0 ? Math.round((g.ok / g.n) * 100) + '%' : '-';
    lines.push(`${gid}\t${rateValid}\t${rateRaw}\t${g.env}\t${g.manual}\t${(g.n ? g.steps / g.n : 0).toFixed(1)}\t${(g.n ? g.tools / g.n : 0).toFixed(1)}\t${ms.length ? ms[Math.floor(ms.length / 2)] : 0}`);
  }
  // V39: manual 组实测参考（含 manual）——修复 100%-manual 组均步数被展示成 0.0 的误导
  const manRef = [];
  for (const [gid, g] of Object.entries(byGroup)) {
    if (!g.manual) continue;
    const avgAllSteps = g.all ? (g.allSteps / g.all).toFixed(1) : '0.0';
    const avgAllTools = g.all ? (g.allTools / g.all).toFixed(1) : '0.0';
    manRef.push(`  ${gid}: 全组实测(含manual) 均步数=${avgAllSteps} 均工具=${avgAllTools}  manual=${g.manual}/${g.all}` + (g.manual === g.all ? '  ← 本组全为 manual，能力达标率不适用，以人工终审为准' : ''));
  }
  if (manRef.length) lines.push('', 'manual 组实测参考（含 manual，不改冻结口径）:', ...manRef);
  const mr = [];
  for (const [gid, g] of Object.entries(byGroup)) for (const m of (g.mrows || [])) mr.push(`  ${gid} ${m.t}${m.env ? ' [ENV:待补]' : ''}${m.ps && m.ps.note ? ' 初判:' + m.ps.note : ''} :: ${m.out}`);
  if (mr.length) lines.push('', 'MANUAL(不计能力分母):', ...mr); // V33
  const suspectN = rows.filter((r) => r.metricSuspect).length;
  if (suspectN) lines.push('', '⚠️ metricSuspect: ' + suspectN + '/' + rows.length + ' 题 steps=0 但输出含工具痕迹（事件管道缺陷，非能力为零，见 bench/L5-STEPS0-ROOTCAUSE.md）');
  return lines.join('\n');
}

/* TODO（服务端契约，非本文件可解）
 * 让 G2/G3/G4 真正可测需在 ws-handler.ts `case "message"` 透传 meta：
 *   const { chatId, content, replyTo, meta } = event;
 *   processUserMessage(chatId, clientId, content, replyTo, router, broadcast, meta);
 * 并在 router 里据 meta.memory/reflect/metacog 决定是否注入记忆/触发反思。
 */


// V39b: 离线重算 SUMMARY.txt（不连引擎、不重跑，仅读已有单题 JSON）
function summarizeDir(dir) {
  const d = path.resolve(WORKSPACE, dir);
  const files = fs.readdirSync(d)
    .filter((f) => /\.json$/i.test(f) && f.toLowerCase() !== 'raw.json')
    .sort();
  if (!files.length) { console.error('✗ 目录内无单题 JSON: ' + d); process.exit(2); }
  const rows = files.map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')));
  const summary = buildSummary(rows);
  console.log(summary);
  fs.writeFileSync(path.join(d, 'SUMMARY.txt'), summary + '\n');
  console.log(`\n✔ 已重算 SUMMARY.txt（${rows.length} 题）→ ${d}`);
}

// v27: run.ts 期望的 detectViolations(criteria, rec) 接口，转发到 scanViolations
function detectViolations(criteria, rec) {
  const forbidden = (criteria && criteria.forbidden) || [];
  return scanViolations(rec, forbidden);
}
module.exports = { computeTimeoutMs, runTask, classifyEnvError, judge, normalize, normalizePathText, scanViolations, detectViolations };

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
