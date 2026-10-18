/**
 * AI 使用权授权（Agent Grants）
 * ------------------------------------------------------------------
 * 需求：授权范围「某群」或「好友」；加好友后默认无授权，必须 AI 主人同意。
 *
 * 设计原则：
 *   1. 默认拒绝（default-deny）——没有 accepted 记录，一律不可调用
 *   2. 显式同意——只有 agent 的 owner 能批准/拒绝/撤销
 *   3. 可撤回——撤销后后端立即拦截（不依赖前端置灰）
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
}

const now = () => Date.now();
const uid = (p: string) => `${p}-${now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

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

/** 过期惰性判定：读取时把过期记录标记为 expired */
function expireIfNeeded(row: any): any {
  if (row && row.status === 'accepted' && row.expires_at && Number(row.expires_at) > 0 && Number(row.expires_at) < now()) {
    exec(`UPDATE agent_grants SET status='expired' WHERE id=?`, [row.id]);
    audit(row.id, 'system', 'expire', {});
    row.status = 'expired';
  }
  return row;
}

/**
 * 核心判定：grantee 能否在此上下文使用 agentId
 * 所有真正「调用他人 AI」的入口都必须调用它。
 */
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
  if (String(agent.user_id) === String(granteeId)) return { allowed: true, reason: 'owner' };

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
  const hit = accepted.find(g => {
    if (g.scope === 'group') return ctx.chatId ? String(g.chat_id) === String(ctx.chatId) : true;
    if (g.scope === 'friend') {
      if (!ctx.peerUserId) return true;
      return String(agent.user_id) === String(ctx.peerUserId) || String(g.chat_id) === String(ctx.chatId || '');
    }
    if (g.scope === 'task') return ctx.taskId ? String(g.task_id) === String(ctx.taskId) : false;
    return false;
  });
  if (!hit) return { allowed: false, reason: 'out_of_scope' };
  return { allowed: true, reason: 'granted', grant: hit };
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
 * 存量兼容迁移：上线前已经「好友 AI 被拉进群」的会话，自动补一条 7 天期的
 * accepted 授权，避免一刀切把老用户正在用的 AI 直接掐断。
 * 7 天到期后进入 expired，前端提示主人重新授权。
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
      const grantee = one(
        `SELECT user_id FROM participants WHERE chat_id=? AND user_id IS NOT NULL AND user_id != '' AND user_id != ? LIMIT 1`,
        [r.chat_id, r.owner_id]
      );
      if (!grantee) continue;
      const id = uid('grant');
      exec(
        `INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, task_id, status, note, created_at, decided_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, r.agent_id, r.owner_id, String(grantee.user_id), 'group', r.chat_id, null, 'accepted',
         'legacy_auto_migration', now(), now(), now() + 7 * 24 * 3600_000]
      );
      audit(id, 'system', 'migrate_legacy', { chatId: r.chat_id });
      created++;
    }
    if (created > 0) console.log('[grants] legacy participants migrated: ' + created);
    return created;
  } catch (e: any) {
    console.warn('[grants] legacy migration skipped: ' + e?.message);
    return 0;
  }
}

export function registerAgentGrantsRoutes(app: Express, deps: AgentGrantsDeps): void {
  const { requireAuth, broadcast } = deps;
  const push = (userId: string, event: any) => {
    try {
      if (deps.sendToUser && userId) { deps.sendToUser(String(userId), event); return; }
    } catch (_e) { /* fallthrough */ }
    try { broadcast(event); } catch (_e2) { /* ignore */ }
  };
  const me = (req: any) => String(req.user?.sub || req.user?.id || req.user?.numeric_id || '');

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
          const row = expireIfNeeded(one(
            `SELECT * FROM agent_grants WHERE agent_id=? AND grantee_id=? ORDER BY created_at DESC LIMIT 1`,
            [ag.id, userId]
          ));
          if (row) {
            status = row.status as GrantStatus;
            grant = { id: row.id, scope: row.scope, chatId: row.chat_id, expiresAt: row.expires_at };
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
      const ids: string[] = Array.isArray(req.body?.agentIds) ? req.body.agentIds.map(String) : [];
      if (!granteeId) return res.status(401).json({ error: '未登录' });
      if (!ids.length) return res.json({ ok: true, featureEnabled: grantsEnabled(), statuses: {} });
      const statuses: Record<string, any> = {};
      for (const agentId of ids.slice(0, 500)) {
        const chk = canUseAgent(agentId, granteeId, chatId ? { chatId } : {});
        let scope: string | null = null;
        let expiresAt: number | null = null;
        if (chk.grant) { scope = chk.grant.scope; expiresAt = chk.grant.expires_at || null; }
        statuses[agentId] = {
          allowed: chk.allowed,
          reason: chk.reason,
          status: chk.allowed
            ? (chk.reason === 'owner' ? 'own' : 'accepted')
            : (chk.reason === 'pending_approval' ? 'pending' : 'locked'),
          scope,
          expiresAt,
        };
      }
      res.json({ ok: true, featureEnabled: grantsEnabled(), statuses });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 2. 发起申请 ──
  app.post('/api/agent-grants', requireAuth, (req, res) => {
    try {
      const granteeId = me(req) || String(req.body?.granteeId || '');
      const { agentId, scope = 'group', chatId, taskId, note, ttlHours } = req.body || {};
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
      exec(
        `INSERT INTO agent_grants (id, agent_id, owner_id, grantee_id, scope, chat_id, task_id, status, note, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, String(agentId), ownerId, granteeId, scope, chatId || null, taskId || null, 'pending', note || '', now(), expiresAt]
      );
      audit(id, granteeId, 'apply', { scope, chatId, taskId, ttlHours: ttl });

      // 通知 AI 主人
      const u = one('SELECT display_name FROM users WHERE id=?', [granteeId]);
      push(ownerId, {
        type: 'agent_grant.request', grantId: id, toUserId: ownerId,
        fromUserId: granteeId, fromName: u?.display_name || granteeId,
        agentId, agentName: agent.display_name, scope, chatId, expiresAt
      });
      res.status(201).json({ ok: true, grantId: id, status: 'pending' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
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
      );
      res.json({ ok: true, items: rows });
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
      ).map(expireIfNeeded);
      res.json({ ok: true, items: rows });
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
      exec(`UPDATE agent_grants SET status=?, decided_at=? WHERE id=?`, [status, now(), g.id]);
      audit(g.id, uidMe, action, {});
      push(g.grantee_id, {
        type: 'agent_grant.decided', grantId: g.id, toUserId: g.grantee_id,
        status, agentId: g.agent_id, scope: g.scope, chatId: g.chat_id
      });
      res.json({ ok: true, status });
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
      if (!['accepted', 'pending'].includes(g.status)) return res.status(409).json({ error: '当前状态不可撤销：' + g.status });

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
