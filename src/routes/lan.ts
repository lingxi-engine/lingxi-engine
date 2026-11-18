/**
 * LAN 社交路由 — 从根 index.ts 巨石原样抽取（巨石拆分迁移 批次 9/N）
 *
 * 抽取范围: 原 index.ts L2426-L2808（迁移前坐标），共 383 行
 *   - getLocalLanUsers(): 本机用户列表（含数字 ID 与各自灵犀引擎）
 *   - lanSocial: LanSocialHub 实例（含离线补发队列）
 *   - startLanDiscovery: UDP 发现启动（LAN_DISCOVERY=off 可关）
 *   - lanUserId: LAN 写操作身份绑定（v5 安全修复）
 *   - 30 条路由: /api/lan/* 状态/邻居/搜索/好友/群组/peer 回调/群邀请 + /api/users/search
 *
 * 原则: 业务代码逐行保真，仅做依赖注入改造
 *   （app/db/manager/router/broadcast/requireAuth/port/dataDir 由宿主传入；
 *     getDB 与 lan-discovery/lan-transport/lan-social 改为模块内 import）
 * 安全网: tests/baseline/routes-baseline.json 路由快照 + tsc 全量类型检查 + 冒烟 v2
 */
import type { Express, RequestHandler } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDB, getFriendshipById } from '../storage/db.js';
import { startLanDiscovery, getLanPeers, getLanSelfInfo, getLanIps, directedBroadcastAddrs, type LanUser } from '../net/lan-discovery.js';
import { verifyLanRequest } from '../net/lan-transport.js';
import { LanSocialHub, LAN_SOCIAL_CHANNEL } from '../net/lan-social.js';
import { ensureIdentityKey } from '../security/e2ee.js';

export function registerLanRoutes(app: Express, deps: {
  db: any;
  manager: any;
  router: any;
  broadcast: (event: any) => void;
  requireAuth: RequestHandler;
  port: number;
  dataDir: string;
}) {
  const { db, manager, router, broadcast, requireAuth, port, dataDir } = deps;

  // ────────────────────────────────────────
  // 局域网社交 (LAN Social) — 同网段引擎自动发现 + ID 加好友 + 群组双聊天 + 多智能体
  // ────────────────────────────────────────
  // 本机用户列表（含数字 ID 与各自灵犀引擎），供灯塔广播与社交层共用
  function getLocalLanUsers(): LanUser[] {
    const agentByUser = new Map<string, string>();
    for (const a of manager.list() as any[]) {
      const owner = a.userId || a.user_id;
      if (owner && !agentByUser.has(owner)) agentByUser.set(owner, a.id);
    }
    return (db.listUsers() as any[])
      .filter((u) => u.numeric_id)
      .map((u) => ({
        id: u.id,
        numericId: u.numeric_id,
        displayName: u.display_name || u.username || u.id,
        agentId: agentByUser.get(u.id),
      }));
  }

  const lanSocial = new LanSocialHub({ router, manager, broadcast, getLocalUsers: getLocalLanUsers });

  // 启动 UDP 发现（可用 LAN_DISCOVERY=off 关闭）
  if ((process.env.LAN_DISCOVERY || 'on').toLowerCase() !== 'off') {
    startLanDiscovery({
      port,
      version: (() => { try { return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })(),
      dataDir,
      getUsers: getLocalLanUsers,
      discoveryPort: process.env.LAN_DISCOVERY_PORT ? Number(process.env.LAN_DISCOVERY_PORT) : undefined,
      // E2EE: 鍙戠幇鏂伴偦灞呮椂鑷姩浜ゆ崲鍏挜
      onPeerSeen: (peer) => {
        try {
          const _db = getDB();
          if (_db) ensureIdentityKey(_db); // 确保 e2ee_keys 表存在且本机身份密钥已生成
        } catch (_e) {}
        lanSocial.exchangeKeyWithPeer(peer).catch(() => {});
      },
    });
  }

  // v5 修复: LAN 写操作身份绑定 — 本地免登录模式信任 body.userId；真实 JWT 强制使用登录身份，防伪造他人身份
  const lanUserId = (req: any, bodyUserId?: string): string | null => {
    const u = (req as any).user;
    if (!u) return null;
    const sid = String(u.sid || '');
    const isBootstrap = sid === 'admin-auto' || sid === 'platform-admin' || sid === 'admin-token' || u.sub === 'admin';
    if (isBootstrap) return bodyUserId || String(u.sub);
    return String(u.sub || u.numeric_id || '');
  };

  // ── 前端用：状态 / 邻居 / 搜索 ──
  app.get('/api/lan/status', requireAuth, (_req, res) => {
    // FIX-ALL(2026-11-04): 暴露全部网卡 IP 与定向广播地址，前端/诊断可判断跨网段发现是否可达
    res.json({ ok: true, ...getLanSelfInfo(), lanIps: getLanIps(), broadcastAddrs: directedBroadcastAddrs(), socialChannel: LAN_SOCIAL_CHANNEL });
  });

  app.get('/api/lan/peers', requireAuth, (_req, res) => {
    const peers = getLanPeers().map((p) => ({
      instanceId: p.instanceId, lanIp: p.lanIp, port: p.port, version: p.version, lastSeen: p.lastSeen,
      users: p.users.map((u) => ({ numericId: u.numericId, displayName: u.displayName, userId: u.id, agentId: u.agentId })),
    }));
    res.json({ ok: true, peers, count: peers.length });
  });

  app.get('/api/lan/search', requireAuth, (req, res) => {
    const q = (req.query.q as string) || '';
    res.json({ ok: true, results: lanSocial.search(q) });
  });

  // ── 全局用户搜索：按数字 ID 或用户名搜索 ──
  app.get('/api/users/search', requireAuth, async (req, res) => {
    try {
      const q = (req.query.q as string || '').trim();
      if (!q) return res.json({ ok: true, results: [] });
      const platformApiUrl = (globalThis as any).__platformApiUrl || '';
      const platformAdminToken = (globalThis as any).__platformAdminToken || '';
      let platformResults: any[] = [];
      // 优先从平台搜索用户
      if (platformApiUrl && platformAdminToken) {
        try {
          const resp = await fetch(`${platformApiUrl}/api/admin/search?q=${encodeURIComponent(q)}&token=${platformAdminToken}`);
          const d = await resp.json() as any;
          if (d.ok && d.results) {
            platformResults = d.results.map((u: any) => ({
              numericId: u.id,
              displayName: u.username,
              email: u.email || '',
              userId: String(u.id),
              status: u.status || 'active',
              online: (u.status || 'active') !== 'offline' && (u.status || 'active') !== 'inactive',
              source: 'platform',
              points: u.points || 0,
              createdAt: u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '-',
            }));
          }
        } catch (e: any) {
          console.warn('[Platform] 用户搜索失败，回退本地:', e.message);
        }
      }
      // 本地数据库搜索（补充平台未覆盖的本地用户）
      const raw = getDB();
      let localResults: any[] = [];
      const nid = parseInt(q);
      if (!isNaN(nid)) {
        const s1 = raw.prepare('SELECT id, numeric_id, display_name, email, status, created_at FROM users WHERE numeric_id = ?');
        s1.bind([nid]);
        if (s1.step()) { localResults.push(s1.getAsObject()); }
        s1.free();
      }
      const s2 = raw.prepare('SELECT id, numeric_id, display_name, email, status, created_at FROM users WHERE display_name LIKE ? OR id LIKE ? LIMIT 20');
      s2.bind(['%' + q + '%', '%' + q + '%']);
      while (s2.step()) {
        const row = s2.getAsObject();
        if (!localResults.find(r => r.id === row.id)) localResults.push(row);
      }
      s2.free();
      // 局域网邻居中的用户搜索
      let lanResults: any[] = [];
      for (const peer of getLanPeers()) {
        for (const u of peer.users) {
          if (String(u.numericId) === q || (u.displayName || '').includes(q)) {
            lanResults.push({
              numericId: u.numericId,
              displayName: u.displayName,
              userId: u.id,
              lanIp: peer.lanIp,
              port: peer.port,
              source: 'lan',
            });
          }
        }
      }
      // 合并结果，去重（平台优先）
      const platformIds = new Set(platformResults.map((r: any) => String(r.numericId)));
      const localFiltered = localResults
        .filter((r: any) => !platformIds.has(String(r.numeric_id)))
        .map((r: any) => ({
          // S8 修复：不再向任意登录用户返回 email/status/created_at（防邮箱枚举/隐私泄露）
          numericId: r.numeric_id, displayName: r.display_name,
          userId: r.id, online: r.status === 'online', source: 'local',
        }));
      const results = [...platformResults, ...localFiltered, ...lanResults];
      res.json({ ok: true, results });
    } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── 前端用：好友 ──
  app.post('/api/lan/friend-request', requireAuth, async (req, res) => {
    try {
      // v2.0.11: 优先使用 body 中的 fromUserId（前端传的是本地用户ID），
      // 仅在 body 没有时才从 JWT 中取。之前优先取 JWT sub 导致 auto-admin
      // 模式下 fromUserId 恒为 'admin'，好友申请记错发送者，接收方看不到申请。
      const { toNumericId, message } = req.body || {};
      // S10 修复：fromUserId 一律经 lanUserId 绑定 JWT（非 bootstrap 忽略 body，防冒充他人发请求）
      const fromUserId = lanUserId(req, req.body?.fromUserId) || '';
      if (!fromUserId || !toNumericId) return res.status(400).json({ error: 'fromUserId 和 toNumericId 必填' });
      const r = await lanSocial.sendFriendRequest(fromUserId, Number(toNumericId), message || '');
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/lan/friend-requests', requireAuth, (req, res) => {
    // S9 修复：userId 经 lanUserId 绑定 JWT（非 bootstrap 忽略 query，防看他人好友请求）
    const userId = lanUserId(req, String(req.query.userId || '')) || '';
    res.json({ ok: true, ...lanSocial.friendRequests(userId) });
  });

  app.post('/api/lan/friend-respond', requireAuth, async (req, res) => {
    try {
      const { requestId, action } = req.body || {};
      if (!requestId || !action) return res.status(400).json({ error: 'requestId 和 action 必填' });
      // S11 修复：校验当前用户是该请求的接收者（bootstrap 本地模式豁免），防替他人同意/拒绝
      const uRsp = (req as any).user;
      const sidRsp = String(uRsp?.sid || '');
      const isBootstrapRsp = sidRsp === 'admin-auto' || sidRsp === 'platform-admin' || sidRsp === 'admin-token' || uRsp?.sub === 'admin';
      if (!isBootstrapRsp) {
        const rowRsp = getFriendshipById(String(requestId)) as any;
        if (!rowRsp) return res.status(404).json({ error: '好友请求不存在' });
        const myIdsRsp = [String(uRsp?.sub || ''), String(uRsp?.numeric_id || '')].filter(Boolean);
        if (!myIdsRsp.includes(String(rowRsp.to_user_id))) return res.status(403).json({ error: '无权处理他人的好友请求' });
      }
      const r = await lanSocial.respondFriendRequest(requestId, action);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/lan/friends', requireAuth, (req, res) => {
    // S9 修复：userId 经 lanUserId 绑定 JWT（非 bootstrap 忽略 query，防看他人好友列表）
    const userId = lanUserId(req, String(req.query.userId || '')) || '';
    res.json({ ok: true, friends: lanSocial.friends(userId) });
  });

  // ── 前端用：群组 ──
  app.post('/api/lan/group-create', requireAuth, async (req, res) => {
    try {
      const { name, memberNumericIds, chatMode } = req.body || {};
      const ownerUserId = lanUserId(req, req.body?.ownerUserId);
      if (!ownerUserId || !name) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.createGroup(ownerUserId, name, Array.isArray(memberNumericIds) ? memberNumericIds.map(Number) : [], chatMode || 'free');
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/lan/groups', requireAuth, (_req, res) => {
    res.json({ ok: true, groups: lanSocial.listGroups() });
  });

  app.get('/api/lan/group', requireAuth, (req, res) => {
    const groupId = (req.query.groupId as string) || '';
    const g = lanSocial.getGroup(groupId);
    if (!g) return res.status(404).json({ error: '群组不存在' });
    res.json({ ok: true, group: g });
  });

  app.post('/api/lan/group-mode', requireAuth, async (req, res) => {
    try {
      const { groupId, mode } = req.body || {};
      const r = await lanSocial.setGroupMode(groupId, mode);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // 群人类聊天发消息
  app.post('/api/lan/group-message', requireAuth, async (req, res) => {
    try {
      const { groupId, content } = req.body || {};
      const senderUserId = lanUserId(req, req.body?.senderUserId);
      if (!senderUserId || !groupId || !content) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.sendHumanMessage(senderUserId, groupId, content);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // 群智能体聊天发话题（触发多智能体编排）
  app.post('/api/lan/group-agent-topic', requireAuth, async (req, res) => {
    try {
      const { groupId, topic } = req.body || {};
      const senderUserId = lanUserId(req, req.body?.senderUserId);
      if (!senderUserId || !groupId || !topic) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.postAgentTopic(senderUserId, groupId, topic);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── 邻居引擎互调接收端（X-LingXi-LAN-Proto 鉴权）──
  // 处理结果若含 error，则返回非 2xx（默认 400），让发送方 sendToPeer 能通过 !resp.ok 感知失败，
  // 而不是把逻辑错误伪装成 HTTP 200。
  const sendPeerResult = (res: any, result: any) => {
    if (result && result.error) res.status(result.status || 400).json(result);
    else res.json(result);
  };
  app.post('/api/lan/peer/friend-request', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleIncomingFriendRequest(req.body));
  });
  app.post('/api/lan/peer/friend-accept', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleFriendAccept(req.body));
  });
  app.post('/api/lan/peer/group-invite', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleGroupInvite(req.body));
  });
  // E2EE: peer key exchange (X25519 public keys)
  app.post('/api/lan/peer/key-exchange', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleKeyExchange(req.body));
  });
  app.post('/api/lan/peer/private-message', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handlePrivateMessage(req.body));
  });
  app.post('/api/lan/peer/group-message', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleGroupMessage(req.body));
  });
  app.post('/api/lan/peer/group-mode', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleGroupMode(req.body));
  });
  app.post('/api/lan/peer/agent-invoke', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    try {
      // P0-1: pass request IP for source validation
      (req.body as any)._requestIp = String((req as any).ip || (req as any).socket?.remoteAddress || '').replace(/^::ffff:/, '');
      sendPeerResult(res, await lanSocial.handleAgentInvoke(req.body));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 新增：删除好友/群组 API ──
  app.post('/api/lan/remove-friend', requireAuth, async (req, res) => {
    try {
      const { friendId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!userId || !friendId) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.removeFriend!(userId, friendId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/lan/delete-group', requireAuth, async (req, res) => {
    try {
      const { groupId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!userId || !groupId) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.deleteGroup!(userId, groupId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/lan/leave-group', requireAuth, async (req, res) => {
    try {
      const { groupId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!userId || !groupId) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.leaveGroup!(userId, groupId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── 新增 peer 路由：跨实例通知 ──
  app.post('/api/lan/peer/friend-remove', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    const { userId, friendId } = req.body || {};
    if (!userId || !friendId) return res.status(400).json({ error: 'userId/friendId 必填' });
    try {
      const r = await lanSocial.removeFriend!(userId, friendId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/lan/peer/group-deleted', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    const { groupId } = req.body || {};
    if (!groupId) return res.status(400).json({ error: 'groupId 必填' });
    try {
      const r = await lanSocial.deleteGroup!('', groupId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/lan/peer/group-member-left', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    const { groupId, userId } = req.body || {};
    if (!groupId || !userId) return res.status(400).json({ error: 'groupId/userId 必填' });
    try {
      const r = await lanSocial.leaveGroup!(userId, groupId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── 个人中心 + 积分 + 评价 ──
  // ── 方案C：群邀请确认 API ──

  /** 查看待确认的群邀请 */
  app.get('/api/lan/group-invites', requireAuth, (req, res) => {
    try {
      const userId = lanUserId(req, String(req.query.userId || ''));
      if (!userId) return res.status(401).json({ error: '未登录或身份无效' });
      const invites = lanSocial.listPendingInvites(userId);
      res.json({ ok: true, invites });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** 接受群邀请（A手动确认） */
  app.post('/api/lan/group-invite/accept', requireAuth, async (req, res) => {
    try {
      const { inviteId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!inviteId || !userId) return res.status(401).json({ error: '未登录或身份无效' });
      const result = await lanSocial.acceptGroupInvite(inviteId, userId);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** 拒绝群邀请 */
  app.post('/api/lan/group-invite/reject', requireAuth, (req, res) => {
    try {
      const { inviteId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!inviteId || !userId) return res.status(401).json({ error: '未登录或身份无效' });
      const result = lanSocial.rejectGroupInvite(inviteId, userId);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** 接收远程接受回调（创建者引擎接收到被邀请者已接受的通知） */
  app.post('/api/lan/peer/group-invite-accepted', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    try {
      const result = lanSocial.handleGroupInviteAccepted(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

}
