/**
 * AI 使用权授权（Agent Grants）
 * ------------------------------------------------------------------
 * 需求：授权范围「某群」或「好友」；加好友后默认无授权，必须 AI 主人同意。
 *
 * 设计原则：
 *   1. 默认拒绝（default-deny）——没有 accepted 记录，一律不可调用
 *   2. 显式同意——只有 agent 的 owner 能批准/拒绝/撤销
 *   3. 可撤回——撤销后后端立即拦截（不依赖前端置灰）
 *   4. 可细分——支持「按技能/工具维度」限定授权范围（v1.2）
 *
 * 开关：FEATURE_AGENT_GRANTS
 *   - 默认 'on'（新逻辑生效）
 *   - 设为 'off' 回退到旧行为（加好友即可用对方 AI），用于紧急回滚
 *   - 设为 'enforce' 同 on（显式写法，便于阅读）
 */
import type { Express, RequestHandler } from 'express';
import { getDB } from '../storage/db.js';

export interface AgentGrantsDeps {
  requireAuth: RequestHandler;
  broadcast: (event: any) => void;
  /** 定向推送（推荐）：只发给指定用户，避免授权信息全局泄露 */
  sendToUser?: (userId: string, event: any) => void;
}

export type GrantScope = 'group' | 'friend' | 'task';
export type GrantStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';

export interface GrantCtx {
  chatId?: string;
  taskId?: string;
  peerUserId?: string; // scope=friend 时用于校验对端
  /** v1.2：被调用的具体工具/技能 id；授权里限定技能时按此校验 */
  tool?: string;
}

const now = () => Date.now();
const uid = (p: string) => `${p}-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const DAY_MS = 24 * 3600_000;

/** 功能开关：未设置时默认开启 */
export function grantsEnabled(): boolean {
  const v = (process.env.FEATURE_AGENT_GRANTS || 'on').toLowerCase();
  return v === 'on' || v === 'enforce' || v === 'true' || v === '1';
}

/** 建表（幂等，随服务启动调用） */
export function ensureAgentGrantsSchema(): void {
  const db = getDB();
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_grants (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL,
      owner_id      TEXT NOT NULL,
      grantee_id    TEXT NOT NULL,
      scope         TEXT NOT NULL DEFAULT 'group',
      chat_id       TEXT,
      task_id       TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      note          TEXT,
      created_at    INTEGER NOT NULL,
      decided_at    INTEGER,
      expires_at    INTEGER,
      revoke_reason TEXT
    )
  `);
  try {
    db.run(`CREATE INDEX IF NOT EXISTS idx_grant_lookup ON agent_grants(agent_id, grantee_id, status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_grant_owner ON agent_grants(owner_id, status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_grant_chat ON agent_grants(chat_id)`);
  } catch (_e) { /* 索引已存在 */ }

  // ── v1.2 增量列（幂等） ──
  try {
    const cols: string[] = db.exec(`PRAGMA table_info(agent_grants)`)[0]?.values?.map((r: any) => String(r[1])) || [];
    const addIf = (col: string, ddl: string) => {
      if (!cols.includes(col)) db.run(`ALTER TABLE agent_grants ADD COLUMN ${col} ${ddl}`);
    };
    addIf('skills', "TEXT DEFAULT ''");      // JSON 字符串数组；空 = 全部技能
    addIf('reminded_at', 'INTEGER');          // 续期提醒已发出时间（去重）
    addIf('batch_id', 'TEXT');                // 批量授权批次号
  } catch (e: any) {
    console.warn('[grants] column migration skipped: ' + e?.message);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_grant_events (
      id         TEXT PRIMARY KEY,
      grant_id   TEXT NOT NULL,
      actor_id   TEXT NOT NULL,
      action     TEXT NOT NULL,
      meta       TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_grant_events ON agent_grant_events(grant_id, created_at)`); } catch (_e) {}
  console.log('[grants] schema ready, feature=' + (grantsEnabled() ? 'on' : 'off'));
}

function q(sql: string, params: any[] = []): any[] {
  const db = getDB();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function one(sql: string, params: any[] = []): any | null {
  return q(sql, params)[0] || null;
}
function exec(sql: string, params: any[] = []) {
  const db = getDB();
  db.run(sql, params);
}

function audit(grantId: string, actorId: string, action: string, meta?: any) {
  exec(
    `INSERT INTO agent_grant_events (id, grant_id, actor_id, action, meta, created_at) VALUES (?,?,?,?,?,?)`,
    [uid('evt'), grantId, actorId, action, JSON.stringify(meta || {}), now()]
  );
}

function getAgent(agentId: string): any | null {
  return one('SELECT * FROM agents WHERE id = ?', [agentId]);
}

/** 解析技能白名单（JSON 数组 / 逗号分隔 / 空） */
export function parseSkillList(raw: any): string[] {
  if (raw === null || raw === undefined) return [];
  const s = String(raw).trim();
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch (_e) { /* 逗号分隔 */ }
  return s.split(',').map(x => x.trim()).filter(Boolean);
}

function normalizeSkillsInput(v: any): string {
  const list = Array.isArray(v) ? v : (typeof v === 'string' ? parseSkillList(v) : []);
  return JSON.stringify(list.map(String).filter(Boolean));
}

/** 过期惰性判定：读取时把过期记录标记为 expired */
function expireIfNeeded(row: any): any {
  if (row && row.status === 'accepted' && row.expires_at && Number(row.expires_at) > 0 && Number(row.expires_at) < now()) {
    exec(`UPDATE agent_grants SET status='expired' WHERE id=?`, [row.id]);
    audit(row.id, 'system', 'expire', {});
    row.status = 'expired';
  }
  return row;
}

/** agent 是否属于该用户（owner 判定，兼容 users.agent_id 绑定与 numeric_id 别名） */
function isOwnAgent(agent: any, userId: string): boolean {
  const uid = String(userId || '');
  if (!agent || !uid) return false;
  if (String(agent.user_id) === uid) return true;
  try {
    const u = one('SELECT id, agent_id, numeric_id FROM users WHERE id=? OR numeric_id=? LIMIT 1', [uid, Number(uid) || -1]);
    if (u) {
      if (u.agent_id && String(u.agent_id) === String(agent.id)) return true;
      if (String(u.id) === String(agent.user_id)) return true;
      if (u.numeric_id != null) {
        const owner = one('SELECT id, numeric_id FROM users WHERE id=?', [String(agent.user_id)]);
        if (owner && String(owner.numeric_id) === String(u.numeric_id)) return true;
      }
    }
  } catch (_e) { /* ignore */ }
  return false;
}

/** 两人是否为已接受的好友 */
function areFriends(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  try {
    return !!one(
      "SELECT id FROM friendships WHERE status='accepted' AND ((from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?)) LIMIT 1",
      [a, b, b, a]
    );
  } catch (_e) { return false; }
}

/** 统一的拒绝文案：把内部 reason 翻译成用户看得懂的话 */
export function grantDeniedMessage(reason: string): string {
  switch (String(reason || '')) {
    case 'pending_approval': return '该 AI 的授权申请正在等待主人同意';
    case 'not_friend_agent': return '只能使用好友的 AI，请先加对方为好友并申请授权';
    case 'out_of_scope': return '该 AI 的授权不覆盖当前会话，请重新申请授权';
    case 'agent_not_found': return '该 AI 不存在或已删除';
    default: return '该 AI 尚未授权给你使用，请先申请授权';
  }
}

/** 授权记录是否覆盖给定上下文 */
function grantCovers(g: any, ctx: GrantCtx): boolean {
  if (g.scope === 'group') return ctx.chatId ? String(g.chat_id) === String(ctx.chatId) : true;
  if (g.scope === 'friend') {
    if (!ctx.peerUserId) return true;
    return String(g.owner_id) === String(ctx.peerUserId) || String(g.chat_id) === String(ctx.chatId || '');
  }
  if (g.scope === 'task') return ctx.taskId ? String(g.task_id) === String(ctx.taskId) : false;
  return false;
}

export function canUseAgent(
  agentId: string,
  granteeId: string,
  ctx: GrantCtx = {}
): { allowed: boolean; reason: string; grant?: any } {
  if (!grantsEnabled()) return { allowed: true, reason: 'feature_disabled' };
  // Local no-login / admin virtual identity bypass (same as jwt-auth admin-auto mode)
  const BYPASS = ['admin', 'admin-auto', 'admin-token', 'platform-admin', 'system'];
  if (!granteeId || BYPASS.includes(String(granteeId))) {
    return { allowed: true, reason: 'bypass_identity' };
  }
  const agent = getAgent(agentId);
  if (!agent) return { allowed: false, reason: 'agent_not_found' };
  // 自己的 AI 永远可用
  if (isOwnAgent(agent, granteeId)) return { allowed: true, reason: 'owner' };

  // 只对「好友的 AI」强制授权：本机/共享 Agent 保持历史行为，
  // 需求范围是「加好友后默认没有授权」，不误伤老用户正在用的 AI。
  if (!areFriends(String(agent.user_id), String(granteeId))) {
    // [安全] 陌生人默认拒绝；唯一例外：该 AI 本来就在这个群里（不打断存量群聊）
    let alreadyIn = false;
    if (ctx.chatId) {
      try {
        alreadyIn = !!one('SELECT 1 AS x FROM participants WHERE chat_id=? AND agent_id=? LIMIT 1', [String(ctx.chatId), String(agentId)]);
      } catch (_e) { alreadyIn = false; }
    }
    if (alreadyIn) return { allowed: true, reason: 'already_participant' };
    return { allowed: false, reason: 'not_friend_agent' };
  }

  const rows = q(
    `SELECT * FROM agent_grants WHERE agent_id=? AND grantee_id=? AND status IN ('accepted','expired') ORDER BY created_at DESC`,
    [agentId, granteeId]
  ).map(expireIfNeeded);

  const accepted = rows.filter(r => r.status === 'accepted');
  if (accepted.length === 0) {
    const pending = one(
      `SELECT id FROM agent_grants WHERE agent_id=? AND grantee_id=? AND status='pending'`,
      [agentId, granteeId]
    );
    return { allowed: false, reason: pending ? 'pending_approval' : 'no_grant' };
  }

  // 范围匹配
  const hits = accepted.filter(g => grantCovers(g, ctx));
  if (hits.length === 0) return { allowed: false, reason: 'out_of_scope' };

  // v1.2 技能/工具维度：任一「未限定技能」的授权放行；否则必须命中白名单
  if (ctx.tool) {
    const tool = String(ctx.tool);
    const unrestricted = hits.find(g => parseSkillList(g.skills).length === 0);
    if (unrestricted) return { allowed: true, reason: 'granted', grant: unrestricted };
    const specific = hits.find(g => parseSkillList(g.skills).includes(tool));
    if (specific) return { allowed: true, reason: 'granted', grant: specific };
    return { allowed: false, reason: 'tool_not_granted', grant: hits[0] };
  }

  return { allowed: true, reason: 'granted', grant: hits[0] };
}

/** 撤销该 agent 在某群的全部有效授权（群解散/踢人时用） */
export function revokeGrantsForChat(agentId: string, chatId: string, actorId: string) {
  const rows = q(`SELECT id FROM agent_grants WHERE agent_id=? AND chat_id=? AND status='accepted'`, [agentId, chatId]);
  for (const r of rows) {
    exec(`UPDATE agent_grants SET status='revoked', revoke_reason='participant_removed', decided_at=? WHERE id=?`, [now(), r.id]);
    audit(r.id, actorId, 'revoke', { reason: 'participant_removed' });
  }
  return rows.length;
}

/**
 * 存量兼容迁移：上线前已经「好友 AI 被拉进群」的会话，自动补授权。
 * v1.2：给群里**每一个**好友成员各补一条，不再只补第一个人
 *       （3 人以上群聊不再是「只有第一个人能用」）。
 */
export function migrateLegacyAgentParticipants(): number {
  if (!grantsEnabled()) return 0;
  try {
    const rows = q(
      `SELECT p.chat_id AS chat_id, p.agent_id AS agent_id, a.user_id AS owner_id
         FROM participants p
         JOIN agents a ON a.id = p.agent_id
        WHERE p.agent_id IS NOT NULL AND p.agent_id != ''`
    );
    let created = 0;
    for (const r of rows) {
      const exists = one(
        `SELECT id FROM agent_grants WHERE agent_id=? AND chat_id=? AND status IN ('pending','accepted')`,
        [r.agent_id, r.chat_id]
      );
      if (exists) continue;
      // 该群所有其它成员（好友才需要授权；非好友本来直接放行）
      const members = q(
        `SELECT DISTINCT user_id FROM participants
          WHERE chat_id=? AND user_id IS NOT NULL AND user_id != '' AND user_id != ?`,
        [r.chat_id, r.owner_id]
      );
      let seeded = false;
      for (const m of members) {
        const gid = String(m.user_id);
        if (!areFriends(String(r.owner_id), gid)) continue;
        const dup = one(
          `SELECT id FROM agent_grants WHERE agent_id=? AND chat_id=? AND grantee_id=? AND status IN ('pending','accepted')`,
          [r.agent_id, r.chat_id, gid]
        );
        if (dup) continue;
        const id = uid('grant');
        exec(
          `INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, task_id, status, note, skills, created_at, decided_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, r.agent_id, r.owner_id, gid, 'group', r.chat_id, null, 'accepted',
           'legacy_auto_migration', '', now(), now(), now() + 7 * DAY_MS]
        );
        audit(id, 'system', 'migrate_legacy', { chatId: r.chat_id });
        created++;
        seeded = true;
      }
      if (!seeded) continue;
    }
    if (created > 0) console.log('[grants] legacy participants migrated: ' + created);
    return created;
  } catch (e: any) {
    console.warn('[grants] legacy migration skipped: ' + e?.message);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────
// v1.2 续期提醒
// ─────────────────────────────────────────────────────────────
let _pushRef: ((userId: string, event: any) => void) | null = null;
const REMIND_WINDOW_MS = DAY_MS; // 到期前 1 天

/** 扫一遍「即将到期且未提醒」的授权，推送给借用人与主人。返回提醒条数。 */
export function runGrantReminders(): number {
  if (!grantsEnabled()) return 0;
  try {
    const t = now();
    const rows = q(
      `SELECT g.*, a.display_name AS agent_name
         FROM agent_grants g
         LEFT JOIN agents a ON a.id = g.agent_id
        WHERE g.status='accepted'
          AND g.expires_at IS NOT NULL AND g.expires_at > 0
          AND g.expires_at > ? AND g.expires_at <= ?
          AND (g.reminded_at IS NULL OR g.reminded_at = 0)`,
      [t, t + REMIND_WINDOW_MS]
    );
    for (const r of rows) {
      exec(`UPDATE agent_grants SET reminded_at=? WHERE id=?`, [t, r.id]);
      audit(r.id, 'system', 'remind', { expiresAt: r.expires_at });
      const base = {
        type: 'agent_grant.expiring',
        grantId: r.id,
        agentId: r.agent_id,
        agentName: r.agent_name,
        scope: r.scope,
        chatId: r.chat_id,
        expiresAt: r.expires_at,
        hoursLeft: Math.max(1, Math.round((Number(r.expires_at) - t) / 3600_000)),
      };
      try { _pushRef?.(String(r.grantee_id), { ...base, toUserId: r.grantee_id, forRole: 'grantee' }); } catch (_e) {}
      try { _pushRef?.(String(r.owner_id), { ...base, toUserId: r.owner_id, forRole: 'owner' }); } catch (_e) {}
    }
    if (rows.length) console.log('[grants] expiry reminders sent: ' + rows.length);
    return rows.length;
  } catch (e: any) {
    console.warn('[grants] reminder sweep failed: ' + e?.message);
    return 0;
  }
}

/** 启动定时提醒（幂等）。默认每 30 分钟扫一次。 */
export function startGrantReminders(intervalMs = 30 * 60 * 1000): () => number {
  const sweep = () => runGrantReminders();
  try {
    sweep(); // 启动即扫一次，重启后立刻补发漏掉的提醒
    const timer = setInterval(sweep, Math.max(60_000, intervalMs));
    if (typeof (timer as any).unref === 'function') (timer as any).unref();
    console.log('[grants] reminder scheduler started, interval=' + Math.round(Math.max(60_000, intervalMs) / 60000) + 'min');
  } catch (e: any) {
    console.warn('[grants] reminder scheduler skipped: ' + e?.message);
  }
  return sweep;
}

export function registerAgentGrantsRoutes(app: Express, deps: AgentGrantsDeps): void {
  const { requireAuth, broadcast } = deps;
  const push = (userId: string, event: any) => {
    try {
      if (deps.sendToUser && userId) { deps.sendToUser(String(userId), event); return; }
    } catch (_e) { /* fallthrough */ }
    try { broadcast(event); } catch (_e2) { /* ignore */ }
  };
  _pushRef = push;
  const me = (req: any) => String(req.user?.sub || req.user?.id || req.user?.numeric_id || '');

  /** 取该群所有「非主人」成员 id */
  const chatMembersExcept = (chatId: string, ownerId: string): string[] => {
    if (!chatId) return [];
    try {
      return q(
        `SELECT DISTINCT user_id FROM participants
          WHERE chat_id=? AND user_id IS NOT NULL AND user_id != '' AND user_id != ?`,
        [chatId, ownerId]
      ).map((r: any) => String(r.user_id));
    } catch (_e) { return []; }
  };

  // ── 1. 我可见的 AI 及授权状态（供成员面板使用） ──
  app.get('/api/agent-grants/available', requireAuth, (req, res) => {
    try {
      const userId = String((req.query.userId as string) || me(req));
      const chatId = (req.query.chatId as string) || '';
      const db = getDB();

      // 好友列表
      const stmt = db.prepare(`SELECT from_user_id, to_user_id FROM friendships WHERE (from_user_id=? OR to_user_id=?) AND status='accepted'`);
      stmt.bind([userId, userId]);
      const friends: string[] = [];
      while (stmt.step()) {
        const r: any = stmt.getAsObject();
        friends.push(String(r.from_user_id) === userId ? String(r.to_user_id) : String(r.from_user_id));
      }
      stmt.free();

      const out: any[] = [];
      for (const fid of friends) {
        const u = one('SELECT id, numeric_id, display_name FROM users WHERE id=?', [fid]);
        if (u) out.push({ id: u.id, numericId: u.numeric_id, displayName: u.display_name, type: 'friend', grantStatus: 'n/a' });

        const ag = one('SELECT id, display_name, user_id FROM agents WHERE user_id=?', [fid]);
        if (!ag) continue;
        let status: GrantStatus | 'locked' = 'locked';
        let grant: any = null;
        if (!grantsEnabled()) status = 'accepted';
        else if (String(ag.user_id) === userId) status = 'accepted';
        else {
          // v1.2：优先取「覆盖当前群」的那条，避免显示成别的群的授权状态
          const cands = q(
            `SELECT * FROM agent_grants WHERE agent_id=? AND grantee_id=? AND status IN ('pending','accepted','expired')
              ORDER BY created_at DESC`,
            [ag.id, userId]
          ).map(expireIfNeeded);
          const scoped = chatId ? cands.find(r => r.status === 'accepted' && grantCovers(r, { chatId })) : null;
          const row = scoped || cands.find(r => r.status === 'accepted') || cands[0];
          if (row) {
            status = row.status as GrantStatus;
            grant = {
              id: row.id, scope: row.scope, chatId: row.chat_id, expiresAt: row.expires_at,
              skills: parseSkillList(row.skills),
            };
          }
        }
        out.push({
          id: ag.id, displayName: ag.display_name, type: 'agent',
          ownerId: ag.user_id, ownerName: u?.display_name,
          grantStatus: status, grant
        });
      }
      res.json({ ok: true, members: out, featureEnabled: grantsEnabled() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 1.5 批量查询授权状态（供聊天成员面板一次性拿全量） ──
  app.post('/api/agent-grants/status', requireAuth, (req, res) => {
    try {
      const granteeId = me(req) || String(req.body?.userId || '');
      const chatId = String(req.body?.chatId || '');
      const tool = req.body?.tool ? String(req.body.tool) : '';
      const ids: string[] = Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String) : [];
      if (!granteeId) return res.status(401).json({ error: '未登录' });
      if (!ids.length) return res.json({ ok: true, featureEnabled: grantsEnabled(), statuses: {} });
      const statuses: Record<string, any> = {};
      for (const agentId of ids.slice(0, 500)) {
        const chk = canUseAgent(agentId, granteeId, chatId ? { chatId, tool: tool || undefined } : { tool: tool || undefined });
        let scope: string | null = null;
        let expiresAt: number | null = null;
        let skills: string[] = [];
        if (chk.grant) {
          scope = chk.grant.scope;
          expiresAt = chk.grant.expires_at || null;
          skills = parseSkillList(chk.grant.skills);
        }
        statuses[agentId] = {
          allowed: chk.allowed,
          reason: chk.reason,
          status: chk.allowed
            ? (chk.reason === 'owner' ? 'own' : ((chk.reason === 'not_friend_agent' || chk.reason === 'already_participant') ? 'shared' : 'accepted'))
            : (chk.reason === 'pending_approval' ? 'pending'
              : chk.reason === 'tool_not_granted' ? 'tool_locked' : 'locked'),
          scope,
          expiresAt,
          skills,
        };
      }
      res.json({ ok: true, featureEnabled: grantsEnabled(), statuses });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 1.6 工具级检查（v1.2：按技能细分） ──
  app.post('/api/agent-grants/check-tool', requireAuth, (req, res) => {
    try {
      const granteeId = me(req) || String(req.body?.userId || '');
      const agentId = String(req.body?.agentId || '');
      const tool = String(req.body?.tool || req.body?.skill || '');
      const chatId = String(req.body?.chatId || '');
      if (!granteeId) return res.status(401).json({ error: '未登录' });
      if (!agentId || !tool) return res.status(400).json({ error: 'agentId 与 tool 必填' });
      const chk = canUseAgent(agentId, granteeId, { chatId: chatId || undefined, tool });
      res.json({
        ok: true, allowed: chk.allowed, reason: chk.reason,
        skills: chk.grant ? parseSkillList(chk.grant.skills) : [],
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 2. 发起申请 ──
  app.post('/api/agent-grants', requireAuth, (req, res) => {
    try {
      const granteeId = me(req) || String(req.body?.granteeId || '');
      const { agentId, scope = 'group', chatId, taskId, note, ttlHours, skills } = req.body || {};
      if (!granteeId) return res.status(401).json({ error: '未登录' });
      if (!agentId) return res.status(400).json({ error: 'agentId 必填' });
      if (!['group', 'friend', 'task'].includes(scope)) return res.status(400).json({ error: 'scope 只能是 group/friend/task' });
      if (scope === 'group' && !chatId) return res.status(400).json({ error: 'scope=group 时 chatId 必填' });
      if (scope === 'task' && !taskId) return res.status(400).json({ error: 'scope=task 时 taskId 必填' });

      const agent = getAgent(String(agentId));
      if (!agent) return res.status(404).json({ error: '该 AI 不存在' });
      const ownerId = String(agent.user_id);
      if (ownerId === granteeId) return res.status(400).json({ error: '这是你自己的 AI，无需申请' });

      // 必须是好友关系
      const isFriend = one(
        `SELECT id FROM friendships WHERE status='accepted' AND ((from_user_id=? AND to_user_id=?) OR (from_user_id=? AND to_user_id=?))`,
        [granteeId, ownerId, ownerId, granteeId]
      );
      if (!isFriend) return res.status(403).json({ error: '只能向好友申请使用其 AI' });

      // 防重复：已有 pending 或 accepted 同类申请
      const dup = one(
        `SELECT * FROM agent_grants WHERE agent_id=? AND grantee_id=? AND status IN ('pending','accepted')
           AND scope=? AND IFNULL(chat_id,'')=? AND IFNULL(task_id,'')=?`,
        [String(agentId), granteeId, scope, chatId || '', taskId || '']
      );
      if (dup) {
        const d = expireIfNeeded(dup);
        return res.status(409).json({ error: d.status === 'accepted' ? '已有生效中的授权' : '申请已提交，等待对方处理', grantId: d.id, status: d.status });
      }

      const ttl = Number(ttlHours || 0);
      const expiresAt = ttl > 0 ? now() + ttl * 3600_000 : null;
      const id = uid('grant');
      // v1.2：允许申请人主动写明技能范围（主人仍可改）
      const skillJson = normalizeSkillsInput(skills);
      exec(
        `INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, task_id, status, note, skills, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, String(agentId), ownerId, granteeId, scope, chatId || null, taskId || null, 'pending', note || '', skillJson, now(), expiresAt]
      );
      audit(id, granteeId, 'apply', { scope, chatId, taskId, ttlHours: ttl, skills: parseSkillList(skillJson) });

      // 通知 AI 主人
      const u = one('SELECT display_name FROM users WHERE id=?', [granteeId]);
      push(ownerId, {
        type: 'agent_grant.request', grantId: id, toUserId: ownerId,
        fromUserId: granteeId, fromName: u?.display_name || granteeId,
        agentId, agentName: agent.display_name, scope, chatId, expiresAt,
        skills: parseSkillList(skillJson),
      });
      res.status(201).json({ ok: true, grantId: id, status: 'pending' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 2.5 主人批量授权（v1.2：一次授权某个群全员 / 多个好友） ──
  app.post('/api/agent-grants/bulk', requireAuth, (req, res) => {
    try {
      const ownerId = me(req);
      const { agentId, scope = 'group', chatId, taskId, ttlHours, skills, note } = req.body || {};
      let grantees: string[] = Array.isArray(req.body?.granteeIds) ? req.body.granteeIds.map(String).filter(Boolean) : [];
      if (!ownerId) return res.status(401).json({ error: '未登录' });
      if (!agentId) return res.status(400).json({ error: 'agentId 必填' });
      const agent = getAgent(String(agentId));
      if (!agent) return res.status(404).json({ error: '该 AI 不存在' });

      // 只有主人（或 admin）能批量授权
      const isOwner = String(agent.user_id) === ownerId || isAdminIdentity(ownerId);
      if (!isOwner) return res.status(403).json({ error: '只有该 AI 的主人可以批量授权' });
      if (!['group', 'friend', 'task'].includes(scope)) return res.status(400).json({ error: 'scope 只能是 group/friend/task' });
      if (scope === 'group' && !chatId) return res.status(400).json({ error: 'scope=group 时 chatId 必填' });

      // 未指定名单 + 给了群 → 该群全员
      if (grantees.length === 0 && scope === 'group' && chatId) {
        grantees = chatMembersExcept(String(chatId), String(agent.user_id));
      }
      grantees = Array.from(new Set(grantees.filter(g => g !== String(agent.user_id))));
      if (grantees.length === 0) return res.status(400).json({ error: '没有可授权的对象' });
      if (grantees.length > 500) return res.status(400).json({ error: '单次最多 500 人' });

      const ttl = Number(ttlHours || 0);
      const expiresAt = ttl > 0 ? now() + ttl * 3600_000 : null;
      const skillJson = normalizeSkillsInput(skills);
      const batchId = uid('gbatch');
      const grantIds: string[] = [];
      const skipped: string[] = [];

      for (const gid of grantees) {
        const dup = one(
          `SELECT * FROM agent_grants WHERE agent_id=? AND grantee_id=? AND status IN ('pending','accepted')
             AND scope=? AND IFNULL(chat_id,'')=? AND IFNULL(task_id,'')=?`,
          [String(agentId), gid, scope, chatId || '', taskId || '']
        );
        if (dup) {
          const d = expireIfNeeded(dup);
          if (d.status === 'accepted') {
            // 已生效：同步更新有效期与技能范围（相当于「续期/改范围」）
            exec(`UPDATE agent_grants SET expires_at=?, skills=?, reminded_at=0 WHERE id=?`,
              [expiresAt, skillJson, d.id]);
            audit(d.id, ownerId, 'bulk_update', { expiresAt, skills: parseSkillList(skillJson) });
            grantIds.push(d.id);
            continue;
          }
          skipped.push(gid);
          continue;
        }
        const id = uid('grant');
        exec(
          `INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, task_id, status, note, skills, batch_id, created_at, decided_at, expires_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, String(agentId), String(agent.user_id), gid, scope, chatId || null, taskId || null,
           'accepted', note || 'owner_bulk_grant', skillJson, batchId, now(), now(), expiresAt]
        );
        audit(id, ownerId, 'bulk_grant', { batchId, scope, chatId, expiresAt, skills: parseSkillList(skillJson) });
        push(gid, {
          type: 'agent_grant.decided', grantId: id, toUserId: gid,
          status: 'accepted', agentId, agentName: agent.display_name, scope, chatId, expiresAt,
          skills: parseSkillList(skillJson), byBulk: true,
        });
        grantIds.push(id);
      }

      res.json({ ok: true, batchId, created: grantIds.length, skipped, grantIds });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 3. 主人收件箱（待审批） ──
  app.get('/api/agent-grants/inbox', requireAuth, (req, res) => {
    try {
      const uidMe = me(req);
      const rows = q(
        `SELECT g.*, a.display_name AS agent_name, u.display_name AS grantee_name, c.name AS chat_name
           FROM agent_grants g
           LEFT JOIN agents a ON a.id = g.agent_id
           LEFT JOIN users u  ON u.id = g.grantee_id
           LEFT JOIN chats c  ON c.id = g.chat_id
          WHERE g.owner_id = ? AND g.status = 'pending'
          ORDER BY g.created_at DESC`,
        [uidMe]
      ).map(r => ({ ...r, skills: parseSkillList(r.skills) }));
      res.json({ ok: true, items: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 3.5 批量同意 / 拒绝（v1.2：收件箱一次处理多条） ──
  app.patch('/api/agent-grants/batch-decide', requireAuth, (req, res) => {
    try {
      const uidMe = me(req);
      const action = String(req.body?.action || '');
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      const ttlHours = Number(req.body?.ttlHours || 0);
      const skillsProvided = req.body?.skills !== undefined;
      const skillJson = skillsProvided ? normalizeSkillsInput(req.body.skills) : null;
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action 只能是 accept 或 reject' });
      if (!ids.length) return res.status(400).json({ error: 'ids 不能为空' });

      const done: string[] = [];
      const failed: Array<{ id: string; reason: string }> = [];
      for (const id of ids.slice(0, 200)) {
        const g = one('SELECT * FROM agent_grants WHERE id=?', [id]);
        if (!g) { failed.push({ id, reason: 'not_found' }); continue; }
        if (String(g.owner_id) !== uidMe) { failed.push({ id, reason: 'not_owner' }); continue; }
        if (g.status !== 'pending') { failed.push({ id, reason: 'status_' + g.status }); continue; }

        const status = action === 'accept' ? 'accepted' : 'rejected';
        const expiresAt = action === 'accept' && ttlHours > 0 ? now() + ttlHours * 3600_000 : g.expires_at;
        if (action === 'accept' && skillJson !== null) {
          exec(`UPDATE agent_grants SET status=?, decided_at=?, expires_at=?, skills=?, reminded_at=0 WHERE id=?`,
            [status, now(), expiresAt, skillJson, id]);
        } else {
          exec(`UPDATE agent_grants SET status=?, decided_at=?, expires_at=? WHERE id=?`,
            [status, now(), expiresAt, id]);
        }
        audit(id, uidMe, action, { batch: true, ttlHours, skills: skillJson ? parseSkillList(skillJson) : undefined });
        push(g.grantee_id, {
          type: 'agent_grant.decided', grantId: id, toUserId: g.grantee_id,
          status, agentId: g.agent_id, scope: g.scope, chatId: g.chat_id, expiresAt,
        });
        done.push(id);
      }
      res.json({ ok: true, action, done, failed });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 4. 主人给出的授权 ──
  app.get('/api/agent-grants/outbox', requireAuth, (req, res) => {
    try {
      const uidMe = me(req);
      const rows = q(
        `SELECT g.*, a.display_name AS agent_name, u.display_name AS grantee_name, c.name AS chat_name
           FROM agent_grants g
           LEFT JOIN agents a ON a.id = g.agent_id
           LEFT JOIN users u  ON u.id = g.grantee_id
           LEFT JOIN chats c  ON c.id = g.chat_id
          WHERE g.owner_id = ? AND g.status IN ('accepted','expired')
          ORDER BY g.created_at DESC`,
        [uidMe]
      ).map(r => expireIfNeeded({ ...r, skills: parseSkillList(r.skills) }));
      res.json({ ok: true, items: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 4.5 即将到期（v1.2：给前端做续期提醒横幅） ──
  app.get('/api/agent-grants/expiring', requireAuth, (req, res) => {
    try {
      const uidMe = me(req);
      const hours = Math.min(24 * 30, Math.max(1, Number(req.query.withinHours || 24)));
      const t = now();
      const limit = t + hours * 3600_000;
      const base = `SELECT g.*, a.display_name AS agent_name,
                           uo.display_name AS owner_name, ug.display_name AS grantee_name, c.name AS chat_name
                      FROM agent_grants g
                      LEFT JOIN agents a ON a.id = g.agent_id
                      LEFT JOIN users uo ON uo.id = g.owner_id
                      LEFT JOIN users ug ON ug.id = g.grantee_id
                      LEFT JOIN chats c  ON c.id = g.chat_id
                     WHERE g.status='accepted' AND g.expires_at IS NOT NULL AND g.expires_at > 0
                       AND g.expires_at > ? AND g.expires_at <= ?`;
      const asOwner = q(base + ` AND g.owner_id=? ORDER BY g.expires_at ASC`, [t, limit, uidMe]);
      const asGrantee = q(base + ` AND g.grantee_id=? ORDER BY g.expires_at ASC`, [t, limit, uidMe]);
      const shape = (r: any, role: string) => ({
        ...r, role, skills: parseSkillList(r.skills),
        hoursLeft: Math.max(1, Math.round((Number(r.expires_at) - t) / 3600_000)),
      });
      res.json({
        ok: true, withinHours: hours,
        asOwner: asOwner.map(r => shape(r, 'owner')),
        asGrantee: asGrantee.map(r => shape(r, 'grantee')),
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 4.6 群内授权总览（v1.2：谁能在本群用谁的 AI） ──
  app.get('/api/agent-grants/chat/:chatId', requireAuth, (req, res) => {
    try {
      const uidMe = me(req);
      const chatId = String(req.params.chatId);
      const isMember = one(
        `SELECT id FROM participants WHERE chat_id=? AND (user_id=? OR agent_id IN (SELECT id FROM agents WHERE user_id=?))`,
        [chatId, uidMe, uidMe]
      );
      if (!isMember && !isAdminIdentity(uidMe)) return res.status(403).json({ error: '你不在该会话中' });

      const agents = q(
        `SELECT p.agent_id AS agent_id, a.display_name AS agent_name, a.user_id AS owner_id, u.display_name AS owner_name
           FROM participants p
           JOIN agents a ON a.id = p.agent_id
           LEFT JOIN users u ON u.id = a.user_id
          WHERE p.chat_id=? AND p.agent_id IS NOT NULL AND p.agent_id != ''`,
        [chatId]
      );
      const members = q(
        `SELECT DISTINCT u.id AS user_id, u.display_name AS display_name
           FROM participants p JOIN users u ON u.id = p.user_id
          WHERE p.chat_id=? AND p.user_id IS NOT NULL AND p.user_id != ''`,
        [chatId]
      );
      const matrix = agents.map((ag: any) => ({
        agentId: ag.agent_id, agentName: ag.agent_name, ownerId: ag.owner_id, ownerName: ag.owner_name,
        grants: members.map((m: any) => {
          if (String(m.user_id) === String(ag.owner_id)) {
            return { userId: m.user_id, userName: m.display_name, status: 'owner', expiresAt: null, skills: [] };
          }
          const row = expireIfNeeded(one(
            `SELECT * FROM agent_grants WHERE agent_id=? AND grantee_id=? AND chat_id=? AND status IN ('pending','accepted','expired')
              ORDER BY created_at DESC LIMIT 1`,
            [ag.agent_id, m.user_id, chatId]
          ));
          return {
            userId: m.user_id, userName: m.display_name,
            status: row ? row.status : 'locked',
            expiresAt: row?.expires_at || null,
            skills: row ? parseSkillList(row.skills) : [],
            grantId: row?.id || null,
          };
        }),
      }));
      res.json({ ok: true, chatId, members, agents: matrix });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 5. 同意 / 拒绝（仅 owner） ──
  app.patch('/api/agent-grants/:id', requireAuth, (req, res) => {
    try {
      const uidMe = me(req);
      const action = String(req.body?.action || '');
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action 只能是 accept 或 reject' });
      const g = one('SELECT * FROM agent_grants WHERE id=?', [req.params.id]);
      if (!g) return res.status(404).json({ error: '授权申请不存在' });
      if (String(g.owner_id) !== uidMe) return res.status(403).json({ error: '只有该 AI 的主人可以处理此申请' });
      if (g.status !== 'pending') return res.status(409).json({ error: '该申请已处理（当前状态：' + g.status + '）' });

      const status = action === 'accept' ? 'accepted' : 'rejected';
      const ttlHours = Number(req.body?.ttlHours || 0);
      const expiresAt = action === 'accept' && ttlHours > 0 ? now() + ttlHours * 3600_000 : g.expires_at;
      if (action === 'accept' && req.body?.skills !== undefined) {
        exec(`UPDATE agent_grants SET status=?, decided_at=?, expires_at=?, skills=?, reminded_at=0 WHERE id=?`,
          [status, now(), expiresAt, normalizeSkillsInput(req.body.skills), g.id]);
      } else {
        exec(`UPDATE agent_grants SET status=?, decided_at=?, expires_at=? WHERE id=?`, [status, now(), expiresAt, g.id]);
      }
      audit(g.id, uidMe, action, { ttlHours, skills: req.body?.skills !== undefined ? parseSkillList(normalizeSkillsInput(req.body.skills)) : undefined });
      push(g.grantee_id, {
        type: 'agent_grant.decided', grantId: g.id, toUserId: g.grantee_id,
        status, agentId: g.agent_id, scope: g.scope, chatId: g.chat_id, expiresAt,
      });
      res.json({ ok: true, status, expiresAt });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 5.5 续期 / 改范围（owner） ──
  app.post('/api/agent-grants/:id/renew', requireAuth, (req, res) => {
    try {
      const uidMe = me(req);
      const g = one('SELECT * FROM agent_grants WHERE id=?', [req.params.id]);
      if (!g) return res.status(404).json({ error: '授权不存在' });
      if (String(g.owner_id) !== uidMe) return res.status(403).json({ error: '只有该 AI 的主人可以续期' });
      if (!['accepted', 'expired'].includes(g.status)) return res.status(409).json({ error: '当前状态不可续期：' + g.status });

      const ttlHours = Number(req.body?.ttlHours || 0);
      const base = g.status === 'accepted' && Number(g.expires_at) > now() ? Number(g.expires_at) : now();
      const expiresAt = ttlHours > 0 ? base + ttlHours * 3600_000 : null;
      const skillsProvided = req.body?.skills !== undefined;
      if (skillsProvided) {
        exec(`UPDATE agent_grants SET status='accepted', expires_at=?, skills=?, reminded_at=0, decided_at=? WHERE id=?`,
          [expiresAt, normalizeSkillsInput(req.body.skills), now(), g.id]);
      } else {
        exec(`UPDATE agent_grants SET status='accepted', expires_at=?, reminded_at=0, decided_at=? WHERE id=?`,
          [expiresAt, now(), g.id]);
      }
      audit(g.id, uidMe, 'renew', { ttlHours, expiresAt, skills: skillsProvided ? parseSkillList(normalizeSkillsInput(req.body.skills)) : undefined });
      push(g.grantee_id, {
        type: 'agent_grant.renewed', grantId: g.id, toUserId: g.grantee_id,
        agentId: g.agent_id, expiresAt, status: 'accepted',
      });
      res.json({ ok: true, status: 'accepted', expiresAt });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 6. 撤销（owner） / 主动放弃（grantee） ──
  app.delete('/api/agent-grants/:id', requireAuth, (req, res) => {
    try {
      const uidMe = me(req);
      const g = one('SELECT * FROM agent_grants WHERE id=?', [req.params.id]);
      if (!g) return res.status(404).json({ error: '授权不存在' });
      const isOwner = String(g.owner_id) === uidMe;
      const isGrantee = String(g.grantee_id) === uidMe;
      if (!isOwner && !isGrantee) return res.status(403).json({ error: '无权操作此授权' });
      if (!['accepted', 'pending', 'expired'].includes(g.status)) return res.status(409).json({ error: '当前状态不可撤销：' + g.status });

      exec(`UPDATE agent_grants SET status='revoked', revoke_reason=?, decided_at=? WHERE id=?`,
        [req.body?.reason || (isOwner ? 'owner_revoked' : 'grantee_released'), now(), g.id]);
      audit(g.id, uidMe, 'revoke', { by: isOwner ? 'owner' : 'grantee' });

      // 撤销后把该 AI 从相关群里踢出去（保证「已撤销」不是嘴上说说）
      if (g.chat_id) {
        try {
          getDB().run('DELETE FROM participants WHERE chat_id=? AND agent_id=?', [g.chat_id, g.agent_id]);
        } catch (_e) {}
      }
      push(isOwner ? g.grantee_id : g.owner_id, {
        type: 'agent_grant.revoked', grantId: g.id,
        toUserId: isOwner ? g.grantee_id : g.owner_id,
        agentId: g.agent_id, chatId: g.chat_id, by: isOwner ? 'owner' : 'grantee'
      });
      res.json({ ok: true, status: 'revoked' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 扩展：授权审计流水（排查用） ──
  app.get('/api/agent-grants/:id/events', requireAuth, (req, res) => {
    try {
      const uidMe = me(req);
      const g = one('SELECT * FROM agent_grants WHERE id=?', [req.params.id]);
      if (!g) return res.status(404).json({ error: '授权不存在' });
      if (String(g.owner_id) !== uidMe && String(g.grantee_id) !== uidMe) return res.status(403).json({ error: '无权查看' });
      res.json({ ok: true, events: q(`SELECT * FROM agent_grant_events WHERE grant_id=? ORDER BY created_at ASC`, [g.id]) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
}

/** 平台管理身份（批量授权 / 总览时的放行名单） */
function isAdminIdentity(userId: string): boolean {
  return ['admin', 'admin-auto', 'admin-token', 'platform-admin', 'system'].includes(String(userId || ''));
}
