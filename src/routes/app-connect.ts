/**
 * 手机 App 连接层（Mobile Connect）· v2
 * ================================================================
 * 目标：手机用「同一个账号」登录后，能看到自己名下的所有灵犀（云端 + 自己电脑），
 *       并且只在对方【在线且已登录账号】时才允许一键接管。
 *
 * 【v2 相比 v1 的关键改动】
 *
 * 1) 存储层：JSON 文件 → SQLite（AppDirectoryStore）
 *    v1 把全部实例写进 data/app-instances.json，每次心跳都全量读 → 全量改 → 全量写盘。
 *    几万设备时这是 O(N) 写放大 + 同步阻塞 IO，直接把 Hub 磁盘和事件循环打爆。
 *    v2 走 app_instances 表（owner_key + last_seen 复合索引），心跳只 UPDATE 一行。
 *
 * 2) instanceId 冲突（连不上电脑的直接原因）
 *    v1 复用 lan-identity.json 作为 instanceId。部署时整个 data/ 会被复制到云端，
 *    于是云端 Hub 与用户电脑拿到【完全相同】的 instanceId：
 *      电脑 register 时覆盖云端记录 → 云端 selfRecord() 又把 endpoint 刷回云端自己
 *      → 手机点「接管」永远跳回云端 → 永远连不上电脑。
 *    v2 改用独立的 app-identity.json，并加 'lingxi-app-' 前缀，天然不冲突。
 *
 * 3) endpoint 覆盖（同一个坑的第二层）
 *    v1 selfRecord() 里只要 ownerKey 为空或相同就刷新 endpoint，
 *    云端会把「电脑刚登记上来的 endpoint」抢回成云端自己的地址。
 *    v2 严格区分「本机记录」与「他人记录」，只有本机记录才允许改 endpoint。
 *
 * 4) 反向中继（公网可达性）
 *    用户电脑在 NAT 后面，endpoint 是 http://192.168.x.x:3456，手机在外网根本连不上。
 *    v2 增加「电脑主动出站连 Hub，Hub 通过这条长连接反向代理请求」的通道，
 *    电脑不需要公网 IP、不需要端口映射、不需要装 frp/cloudflared。
 *
 * 角色：
 *  - 云端灵犀（Hub）：既是普通引擎，也是「设备在线目录」。手机默认先登录它。
 *  - 电脑灵犀（Node）：在电脑端登录账号时自动把自己登记到 Hub，并每 60s 心跳。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { hostname, networkInterfaces } from 'node:os';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { signAccessToken } from '../auth/index.js';
import { WebSocket as WsClient } from 'ws';
import {
  AppDirectoryStore,
  ONLINE_WINDOW_MS,
  RETENTION_WINDOW_MS,
  generateInstanceSecret,
  type AppInstanceRecord,
} from '../storage/app-directory.js';

export interface AppConnectDeps {
  dataDir: string;
  port: number;
  version: string;
  requireAuth: any;
  db: any;
  getLanIp?: () => string;
  nextNumericId: () => number;
  /** Hub 侧使用：设备目录存储（SQLite）。桌面端可传 null，退化为内存模式。 */
  directory?: AppDirectoryStore | null;
}

/** 手机接管会话键有效期（12 小时）：一次性票据用完就废，会话键要撑着整场接管 */
const RELAY_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface TicketRecord {
  ticket: string;
  instanceId: string;
  exp: number;
  used: boolean;
  user: { id: string; numericId: number; email: string; displayName: string };
}

interface LinkStore {
  hubUrl: string;
  instanceId: string;
  secret: string;
  accounts: Array<{ email: string; userId: string; accessToken: string; refreshToken: string; linkedAt: number }>;
  updatedAt: number;
}

/** 中继通道：电脑 → Hub 的出站长连接（HTTP 升级） */
interface RelayChannel {
  instanceId: string;
  ownerKey: string;
  socket: any;
  connectedAt: number;
  lastPing: number;
  /** 待处理的反向请求队列 */
  pending: Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: any }>;
}

const TICKET_TTL_MS = 60_000;
const RELAY_PING_INTERVAL_MS = 30_000;
const RELAY_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RELAY_PENDING = 64;

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  try { return timingSafeEqual(x, y); } catch { return false; }
}

function localLanIp(): string {
  try {
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) {
        if (addr.family === 'IPv4' && !addr.internal) return addr.address;
      }
    }
  } catch { /* ignore */ }
  return '127.0.0.1';
}

function platformName(): string {
  const p = process.platform;
  if (p === 'win32') return 'Windows';
  if (p === 'darwin') return 'macOS';
  if (p === 'linux') return 'Linux';
  return p;
}

export class AppConnectService {
  private deps: AppConnectDeps;
  private directory: AppDirectoryStore | null;
  /** directory 不可用时的内存兜底（桌面端 / 单机模式） */
  private memInstances: Map<string, AppInstanceRecord> = new Map();
  private memSecrets: Map<string, string> = new Map();
  private tickets: Map<string, TicketRecord> = new Map();
  private file: string;
  private linkFile: string;
  private link: LinkStore | null = null;
  private heartbeatTimer: any = null;
  private relaySocket: any = null;
  private relayGen = 0;
  private lastRecoveryAt = 0;
  private lastHeartbeatOk = 0;
  private lastHeartbeatError = '';
  private pruneTimer: any = null;
  private relayTimer: any = null;
  /** Hub 侧：电脑 → Hub 的中继通道表 */
  private relayChannels: Map<string, RelayChannel> = new Map();
  /** Hub 侧：手机 WebSocket ↔ 电脑 WebSocket 的桥接会话 */
  private phoneBridges: Map<string, { ws: any; instanceId: string }> = new Map();
  /** 电脑侧：本机 WS 连接表（Hub 桥接过来时使用） */
  private localBridges: Map<string, any> = new Map();
  public instanceId: string;

  constructor(deps: AppConnectDeps) {
    this.deps = deps;
    this.directory = deps.directory || null;
    this.file = join(deps.dataDir, 'app-instances.json');
    this.linkFile = join(deps.dataDir, 'app-link.json');
    this.instanceId = this.resolveLocalInstanceId();
    this.load();
    this.loadLink();
    // 立即把自身记录写进目录。
    // 旧实现要等到第一次 listFor()/register() 才建自身记录，
    // 于是「云端先收到别的设备 register」时，云端自己的记录还不存在，
    // 自身 endpoint 也就无从校验 —— 容易在极端时序下把 endpoint 写错。
    try { this.selfRecord(); } catch (e: any) {
      console.warn('[AppConnect] 自身记录初始化失败:', e?.message || e);
    }
  }

  // ---------- 持久化 ----------

  /**
   * 手机连接层的专属实例身份。
   *
   * 【为什么不能复用 lan-identity.json】
   * 早期实现直接读 lan-identity.json 作为 instanceId。问题在于部署时整个 data 目录
   * 会被复制到云端服务器（连同 lan-identity.json），导致：
   *   - 云端 Hub 与用户电脑拿到【完全相同】的 instanceId
   *   - 电脑向 Hub register 时，用同一个 key 覆盖了云端自己那条记录
   *   - 云端 selfRecord() 随后又把 endpoint 刷回云端自己的地址
   *   - 手机在「我的灵犀」里看到的那台「电脑」，endpoint 其实是云端自己
   *   - 点「接管」→ 跳回云端 → 永远连不上电脑
   *
   * 现在改用独立的 app-identity.json，并加 'lingxi-app-' 前缀，
   * 保证云端与电脑的实例 ID 天然不冲突。
   */
  private resolveLocalInstanceId(): string {
    const f = join(this.deps.dataDir, 'app-identity.json');
    try {
      if (existsSync(f)) {
        const d = JSON.parse(readFileSync(f, 'utf8'));
        if (d && typeof d.instanceId === 'string' && d.instanceId) return d.instanceId;
      }
    } catch { /* ignore */ }
    const id = 'lingxi-app-' + randomUUID().slice(0, 12);
    try {
      if (!existsSync(this.deps.dataDir)) mkdirSync(this.deps.dataDir, { recursive: true });
      writeFileSync(f, JSON.stringify({ instanceId: id, createdAt: Date.now() }, null, 2));
    } catch { /* ignore */ }
    return id;
  }

  /** 旧 JSON 目录 → SQLite（一次性，幂等） */
  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      const list = (raw.instances || []) as any[];
      if (this.directory) {
        const n = this.directory.migrateFromLegacyJson(list, {});
        if (n > 0) console.log(`[AppConnect] 已从旧 JSON 目录迁移 ${n} 台设备到 SQLite`);
      } else {
        for (const it of list) {
          if (!it || !it.instanceId) continue;
          this.memInstances.set(it.instanceId, {
            instanceId: String(it.instanceId),
            ownerKey: String(it.ownerKey || ''),
            name: String(it.name || ''),
            kind: it.kind === 'cloud' ? 'cloud' : 'desktop',
            endpoint: String(it.endpoint || ''),
            platform: String(it.platform || ''),
            version: String(it.version || ''),
            lastSeen: Number(it.lastSeen || 0),
            createdAt: Number(it.createdAt || Date.now()),
            agentCount: Number(it.agentCount || 0),
            relayCapable: false,
          });
          if (it.secret) this.memSecrets.set(String(it.instanceId), String(it.secret));
        }
      }
    } catch (e: any) {
      console.error('[AppConnect] 旧目录加载失败:', e?.message || e);
    }
  }

  private loadLink(): void {
    try {
      if (!existsSync(this.linkFile)) return;
      const raw = JSON.parse(readFileSync(this.linkFile, 'utf8')) as LinkStore;
      if (raw && raw.hubUrl) this.link = raw;
    } catch { /* ignore */ }
  }

  private saveLink(): void {
    try {
      if (!this.link) return;
      this.link.updatedAt = Date.now();
      this.link.instanceId = this.instanceId;
      if (!existsSync(this.deps.dataDir)) mkdirSync(this.deps.dataDir, { recursive: true });
      writeFileSync(this.linkFile, JSON.stringify(this.link, null, 2));
    } catch { /* ignore */ }
  }

  // ---------- 目录读写（SQLite 优先，内存兜底） ----------

  public getInstance(instanceId: string): AppInstanceRecord | null {
    if (this.directory) return this.directory.get(instanceId);
    return this.memInstances.get(instanceId) || null;
  }

  public getSecret(instanceId: string): string | null {
    if (this.directory) return this.directory.getSecret(instanceId);
    return this.memSecrets.get(instanceId) || null;
  }

  private setSecret(instanceId: string, secret: string): void {
    if (this.directory) { this.directory.setSecret(instanceId, secret); return; }
    this.memSecrets.set(instanceId, secret);
  }

  private upsertInstance(rec: AppInstanceRecord): void {
    if (this.directory) { this.directory.upsert(rec); return; }
    this.memInstances.set(rec.instanceId, rec);
  }

  private listByOwner(ownerKey: string, limit = 50): AppInstanceRecord[] {
    if (this.directory) return this.directory.listByOwner(ownerKey, limit);
    const cutoff = Date.now() - RETENTION_WINDOW_MS;
    return Array.from(this.memInstances.values())
      .filter(i => i.ownerKey === ownerKey && i.lastSeen > cutoff)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit);
  }

  // ---------- 身份 ----------

  private publicEndpoint(): string {
    const env = (process.env.APP_PUBLIC_URL || process.env.LINGXI_PUBLIC_URL || '').trim();
    if (env) return env.replace(/\/+$/, '');
    const lan = this.deps.getLanIp ? this.deps.getLanIp() : localLanIp();
    return `http://${lan}:${this.deps.port}`;
  }

  /** 本机在 Hub 上的 ownerKey（已绑定账号时为该账号邮箱，否则为空）。 */
  private localOwnerKey(): string {
    return String(this.link?.accounts?.[0]?.email || '').trim().toLowerCase();
  }

  private ownerKeyOf(user: any): string {
    try {
      const email = String(user?.email || '').trim().toLowerCase();
      if (email) return email;
      const sub = String(user?.sub || user?.id || '');
      const u = sub ? this.deps.db.getUser(sub) : null;
      if (u?.email) return String(u.email).trim().toLowerCase();
      return 'uid:' + (user?.numeric_id ?? user?.numericId ?? sub ?? '');
    } catch {
      return 'uid:' + (user?.numeric_id ?? '');
    }
  }

  private selfRecord(): AppInstanceRecord {
    // 【关键】自身记录必须按 instanceId 精确定位，绝不能用 ownerKey 兜底。
    //
    // 旧实现的判据是「ownerKey 为空 或 ownerKey 与本机相同 → 刷新 endpoint」。
    // 这在云端 Hub 上是错的：
    //   云端自身注册时 ownerKey 是空的（还没人登录），
    //   于是任何一台电脑 register 之后，云端下一次 selfRecord() 就会
    //   把【电脑的 endpoint】抢回成云端自己的地址，
    //   手机点「接管」永远跳到云端 —— 这正是「连不上电脑」的直接原因。
    //
    // 现在：selfRecord() 只操作 getInstance(this.instanceId) 这一行，
    // 别的设备记录再也不会被碰到。
    let existing = this.getInstance(this.instanceId);
    if (!existing) {
      existing = {
        instanceId: this.instanceId,
        ownerKey: '',
        name: hostname() || 'LingXi',
        kind: this.link ? 'desktop' : 'cloud',
        endpoint: this.publicEndpoint(),
        platform: platformName(),
        version: this.deps.version,
        lastSeen: Date.now(),
        createdAt: Date.now(),
        agentCount: 0,
        relayCapable: true,
      };
    }
    // 自身记录永远是本机的 endpoint，不接受任何外部写入。
    existing.endpoint = this.publicEndpoint();
    existing.lastSeen = Date.now();
    existing.version = this.deps.version;
    existing.platform = platformName();
    existing.relayCapable = true;
    this.upsertInstance(existing);
    return existing;
  }

  // ---------- 对外：清单 ----------

  listFor(user: any): any[] {
    const key = this.ownerKeyOf(user);
    const now = Date.now();
    const out: any[] = [];
    // 云端自己一定在列表里（手机登录的就是它）
    const self = this.selfRecord();
    if (!self.ownerKey) { self.ownerKey = key; this.upsertInstance(self); }
    // [HUB_ONLY] v2.0.43 纯连接 Hub：目录里不展示 Hub 自身（它不提供 AI，接管它没有意义），
    // 手机「我的灵犀」只看到用户自己的电脑/自部署实例。
    const hubOnly = /^(1|true|on)$/i.test(String(process.env.HUB_ONLY || ''));
    if (!hubOnly) out.push(this.serialize(self, true, self.kind || 'cloud'));
    for (const it of this.listByOwner(key, 100)) {
      if (it.instanceId === self.instanceId) continue;
      // 只展示「登录过同一账号」且近 7 天活跃过的设备
      if (now - it.lastSeen > RETENTION_WINDOW_MS) continue;
      out.push(this.serialize(it, now - it.lastSeen < ONLINE_WINDOW_MS, 'desktop'));
    }
    // 在线优先
    return out.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
  }

  /** 电脑端也能看到云端的设备：本机列表 + 云端列表合并去重 */
  async listMerged(user: any): Promise<any[]> {
    const local = this.listFor(user);
    const hub = this.hubUrl;
    if (!hub || hub === this.publicEndpoint()) return local;
    const acct = this.link?.accounts?.[0];
    if (!acct?.accessToken) return local;
    try {
      const r = await fetch(hub + '/api/app/instances', {
        headers: { Authorization: 'Bearer ' + acct.accessToken },
        signal: AbortSignal.timeout(6000),
      });
      const d: any = await r.json();
      if (r.ok && d?.ok && Array.isArray(d.instances)) {
        const seen = new Set(local.map((x: any) => x.instanceId));
        for (const it of d.instances) {
          if (!seen.has(it.instanceId)) {
            // 云端视角里的本机记录，用本机信息修正
            if (it.instanceId === this.instanceId) continue;
            local.push(it);
          }
        }
      }
    } catch { /* 云端不可达时只显示本机已知设备 */ }
    return local.sort((a: any, b: any) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
  }

  private serialize(it: AppInstanceRecord, online: boolean, kind: 'cloud' | 'desktop'): any {
    return {
      instanceId: it.instanceId,
      name: it.name,
      kind: kind === 'cloud' ? 'cloud' : 'desktop',
      endpoint: it.endpoint,
      platform: it.platform,
      version: it.version,
      online,
      lastSeen: it.lastSeen,
      agentCount: it.agentCount || 0,
      isThisDevice: it.instanceId === this.instanceId,
      /** 该设备是否已建立反向中继通道（手机据此决定走中继还是直连） */
      relayConnected: this.relayChannels.has(it.instanceId),
    };
  }

  // ---------- 对外：登记 / 心跳 ----------

  register(user: any, body: any, kind: 'cloud' | 'desktop'): any {
    const instanceId = String(body?.instanceId || '').trim();
    if (!instanceId) throw new Error('缺少 instanceId');
    const ownerKey = this.ownerKeyOf(user);
    const old = this.getInstance(instanceId);
    const secret = this.getSecret(instanceId) || generateInstanceSecret();
    const rec: AppInstanceRecord = {
      instanceId,
      ownerKey,
      name: String(body?.name || 'My LingXi').slice(0, 60),
      kind,
      endpoint: String(body?.endpoint || '').replace(/\/+$/, ''),
      platform: String(body?.platform || platformName()),
      version: String(body?.version || this.deps.version),
      lastSeen: Date.now(),
      createdAt: old?.createdAt || Date.now(),
      agentCount: Number(body?.agentCount || 0) || 0,
      relayCapable: body?.relayCapable !== false,
    };
    this.upsertInstance(rec);
    this.setSecret(instanceId, secret);
    return { ok: true, instanceId, secret, ownerKey };
  }

  heartbeat(instanceId: string, secret: string, body: any): boolean {
    const it = this.getInstance(instanceId);
    const known = this.getSecret(instanceId);
    if (!it || !known || !safeEq(known, secret)) return false;
    it.lastSeen = Date.now();
    if (body?.endpoint) it.endpoint = String(body.endpoint).replace(/\/+$/, '');
    if (body?.agentCount !== undefined) it.agentCount = Number(body.agentCount) || 0;
    if (body?.name) it.name = String(body.name).slice(0, 60);
    if (body?.version) it.version = String(body.version);
    if (body?.platform) it.platform = String(body.platform);
    if (body?.relayCapable !== undefined) it.relayCapable = !!body.relayCapable;
    this.upsertInstance(it);
    return true;
  }

  // ---------- 对外：票据（一键接管） ----------

  issueTicket(user: any, instanceId: string): TicketRecord {
    const email = (() => {
      try {
        const sub = String(user?.sub || user?.id || '');
        const u = sub ? this.deps.db.getUser(sub) : null;
        return String(u?.email || '').trim();
      } catch { return ''; }
    })();
    const displayName = (() => {
      try {
        const sub = String(user?.sub || user?.id || '');
        const u = sub ? this.deps.db.getUser(sub) : null;
        return String(u?.display_name || u?.displayName || email || 'User');
      } catch { return 'User'; }
    })();
    const rec: TicketRecord = {
      ticket: randomBytes(24).toString('base64url'),
      instanceId,
      exp: Date.now() + TICKET_TTL_MS,
      used: false,
      user: {
        id: String(user?.sub || user?.id || ''),
        numericId: Number(user?.numeric_id ?? user?.numericId ?? 0) || 0,
        email,
        displayName,
      },
    };
    this.tickets.set(rec.ticket, rec);
    // 顺手清理过期票据
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.exp < now - 60_000) this.tickets.delete(k);
    return rec;
  }

  verifyTicket(instanceId: string, secret: string, ticket: string): TicketRecord | null {
    const it = this.getInstance(instanceId);
    const known = this.getSecret(instanceId);
    if (!it || !known || !safeEq(known, secret)) return null;
    return this.consumeTicket(ticket, instanceId);
  }

  /** 只凭 ticket 消费（ticket 自带 instanceId，用于 /app/connect 页无凭据兑换） */
  consumeTicket(ticket: string, expectInstanceId?: string): TicketRecord | null {
    const t = this.tickets.get(String(ticket || ''));
    if (!t || t.used || t.exp < Date.now()) return null;
    if (expectInstanceId && t.instanceId !== expectInstanceId) return null;
    t.used = true;
    this.tickets.delete(t.ticket);
    return t;
  }

  /** 目标引擎本地：按邮箱找用户，没有则按 Hub 身份建一个（一次登录，处处可用） */
  ensureLocalUser(info: { id: string; numericId: number; email: string; displayName: string }): any {
    const db = this.deps.db;
    let u = info.email ? db.getUserByEmail(info.email) : null;
    if (u) {
      try { db.updateUserStatus(u.id, 'online'); } catch { /* ignore */ }
      return u;
    }
    const raw = (globalThis as any).__getDB ? (globalThis as any).__getDB() : null;
    let nid = Number(info.numericId) || 0;
    if (!nid) {
      try { nid = this.deps.nextNumericId(); } catch { nid = Date.now() % 100000; }
    }
    const name = info.displayName || info.email || 'User';
    const id = (info.id && !db.getUser(info.id)) ? info.id : ('ext-' + randomUUID().slice(0, 8));
    // users.numeric_id 是 NOT NULL：必须 INSERT 时就带上。
    // 旧代码「先 createUser 再 UPDATE」在建表为 NOT NULL 的库上第一步就失败，
    // 手机端表现为：点「接管」→ redeem 500 → 提示连不上电脑。
    const nowMs = Date.now();
    let created: any = null;
    if (raw) {
      for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
        const useNid = attempt === 0 ? nid : ((nid + attempt * 7919) % 900000000) + 100000000;
        try {
          raw.run('INSERT INTO users (id, numeric_id, display_name, email, username, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id, useNid, name, info.email || '', info.email || '', 'online', nowMs]);
          created = db.getUser(id);
          if (created) nid = useNid;
        } catch { created = null; }
      }
    }
    if (!created) {
      try { created = db.createUser(id, name, info.email || '', info.email || ''); } catch { created = null; }
      try {
        if (raw && nid) raw.run('UPDATE users SET numeric_id = ?, display_name = ?, status = ? WHERE id = ?', [nid, name, 'online', id]);
      } catch { /* ignore */ }
    }
    u = created || db.getUser(id);
    try {
      const mgr = (globalThis as any).__agentManager;
      if (mgr && !db.getAgentByUserId(id)) mgr.register(id, 'AI助手', '你是一个友好实用的AI助手。', 'semi');
    } catch { /* ignore */ }
    return db.getUser(id) || { id, numeric_id: nid, email: info.email, display_name: name };
  }

  // ---------- 电脑端：登记到 Hub + 心跳 ----------

  get hubUrl(): string {
    const env = (process.env.LINGXI_HUB_URL || process.env.APP_HUB_URL || '').trim();
    if (/^(off|none|disabled|false)$/i.test(env)) return '';
    if (env) return env.replace(/\/+$/, '');
    const linked = this.link?.hubUrl;
    if (linked) return linked.replace(/\/+$/, '');
    // 零配置：默认连官方云端账号目录。自建/离线部署可用 LINGXI_HUB_URL=off 关闭。
    return 'https://lingxi-engine.com';
  }

  async linkAccount(email: string, password: string, hubUrl?: string): Promise<{ ok: boolean; error?: string }> {
    const hub = (hubUrl || this.hubUrl).replace(/\/+$/, '');
    if (!hub) return { ok: false, error: 'no_hub' };
    if (hub === this.publicEndpoint()) return { ok: true }; // 自己就是云端
    try {
      const r = await fetch(hub + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(8000),
      });
      const d: any = await r.json();
      const token = d?.accessToken || d?.token;
      if (!r.ok || !token) return { ok: false, error: d?.error || 'login_failed' };

      const self = this.selfRecord();
      self.kind = 'desktop';
      self.ownerKey = String(email || '').toLowerCase();
      self.name = this.deviceName();
      self.endpoint = this.publicEndpoint();
      self.relayCapable = true;

      const reg = await fetch(hub + '/api/app/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          instanceId: this.instanceId,
          name: self.name,
          endpoint: self.endpoint,
          platform: platformName(),
          version: this.deps.version,
          agentCount: this.safeAgentCount(),
          relayCapable: true,
        }),
        signal: AbortSignal.timeout(8000),
      });
      const rd: any = await reg.json();
      if (!reg.ok || !rd?.ok) return { ok: false, error: rd?.error || 'register_failed' };

      this.link = {
        hubUrl: hub,
        instanceId: this.instanceId,
        secret: String(rd.secret || ''),
        accounts: [{
          email: String(email || '').toLowerCase(),
          userId: String(d?.user?.id || ''),
          accessToken: String(token),
          refreshToken: String(d?.refreshToken || ''),
          linkedAt: Date.now(),
        }],
        updatedAt: Date.now(),
      };
      this.saveLink();
      this.startHeartbeat();
      this.startRelayClient();
      console.log(`[AppConnect] 已登记到云端 ${hub}，账号 ${email}，实例 ${this.instanceId}`);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  private deviceName(): string {
    try {
      return String(hostname() || 'My LingXi').slice(0, 60);
    } catch { return 'My LingXi'; }
  }

  private safeAgentCount(): number {
    try {
      const raw = (globalThis as any).__getDB?.();
      if (!raw) return 0;
      const s = raw.prepare('SELECT COUNT(*) AS c FROM agents');
      if (!s.step()) return 0;
      const c = Number((s.getAsObject() as any).c || 0);
      s.free();
      return c;
    } catch { return 0; }
  }

  /** 心跳 401 自愈：云端目录里的实例记录/密钥失效（云端重启换库、目录被清、instanceId 变化）。
   *  用本机保存的账号 token 重新登记，拿新密钥，重建反向中继。 */
  async recoverInstance(hub: string): Promise<boolean> {
    const acct = this.link?.accounts?.[0];
    if (!acct || !this.link) return false;
    const now = Date.now();
    if (now - (this.lastRecoveryAt || 0) < 60_000) return false;
    this.lastRecoveryAt = now;

    const doRegister = async (tk: string) => {
      const r = await fetch(hub + '/api/app/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
        body: JSON.stringify({
          instanceId: this.instanceId,
          name: this.deviceName(),
          endpoint: this.publicEndpoint(),
          platform: platformName(),
          version: this.deps.version,
          agentCount: this.safeAgentCount(),
          relayCapable: true,
        }),
        signal: AbortSignal.timeout(8000),
      });
      let d: any = null;
      try { d = await r.json(); } catch { d = null; }
      return { status: r.status, d };
    };

    try {
      let token = acct.accessToken || '';
      let { status, d } = await doRegister(token);
      if ((status === 401 || status === 403) && acct.refreshToken) {
        const rr = await fetch(hub + '/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: acct.refreshToken }),
          signal: AbortSignal.timeout(8000),
        });
        let rd: any = null;
        try { rd = await rr.json(); } catch { rd = null; }
        const nt = rd?.accessToken || rd?.token;
        if (rr.ok && nt) {
          token = String(nt);
          acct.accessToken = token;
          if (rd?.refreshToken) acct.refreshToken = String(rd.refreshToken);
          this.saveLink();
          const again = await doRegister(token);
          status = again.status;
          d = again.d;
        }
      }
      if (status !== 200 || !d?.ok || !d?.secret) {
        this.lastHeartbeatError = 'reregister_' + status;
        console.warn('[AppConnect] 重登记失败 · HTTP ' + status + ' · ' + (d?.error || ''));
        return false;
      }
      this.link.secret = String(d.secret);
      this.saveLink();
      this.lastHeartbeatError = '';
      console.log('[AppConnect] 实例密钥已重新登记 · ' + this.instanceId + ' · 重建反向中继');
      this.restartRelay();
      return true;
    } catch (e: any) {
      this.lastHeartbeatError = 'reregister_error:' + (e?.message || e);
      return false;
    }
  }

  /** 密钥变了：关旧通道，按新密钥重连（用代号防止旧闭包抢着重连） */
  private restartRelay(): void {
    this.relayGen = (this.relayGen || 0) + 1;
    try { if (this.relayTimer) clearInterval(this.relayTimer); } catch { /* ignore */ }
    this.relayTimer = null;
    try { this.relaySocket?.close?.(); } catch { /* ignore */ }
    this.relaySocket = null;
    setTimeout(() => { try { this.startRelayClient(); } catch { /* ignore */ } }, 500);
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    const tick = async () => {
      try {
        const hub = this.hubUrl;
        if (!hub || !this.link?.accounts?.length) return;
        if (hub === this.publicEndpoint()) return;
        const acct = this.link.accounts[0];
        const r = await fetch(hub + '/api/app/heartbeat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Instance-Id': this.instanceId,
            'X-Instance-Secret': this.link.secret || '',
          },
          body: JSON.stringify({
            endpoint: this.publicEndpoint(),
            platform: platformName(),
            version: this.deps.version,
            agentCount: this.safeAgentCount(),
            name: this.deviceName(),
            relayCapable: true,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) { this.lastHeartbeatOk = Date.now(); this.lastHeartbeatError = ''; }
        if (r.status === 401) { try { await this.recoverInstance(hub); } catch { /* ignore */ } }
        if (r.status === 401 && acct.refreshToken) {
          // 尝试刷新
          const rr = await fetch(hub + '/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: acct.refreshToken }),
            signal: AbortSignal.timeout(8000),
          });
          const rd: any = await rr.json();
          if (rr.ok && (rd.accessToken || rd.token)) {
            acct.accessToken = rd.accessToken || rd.token;
            acct.refreshToken = rd.refreshToken || acct.refreshToken;
            this.saveLink();
          }
        }
      } catch { /* 网络抖动忽略，下一轮再试 */ }
    };
    void tick();
    this.heartbeatTimer = setInterval(tick, 60_000);
    if (typeof this.heartbeatTimer?.unref === 'function') this.heartbeatTimer.unref();
  }

  status(): any {
    return {
      ok: true,
      hubUrl: this.hubUrl,
      instanceId: this.instanceId,
      endpoint: this.publicEndpoint(),
      linked: !!this.link,
      email: this.link?.accounts?.[0]?.email || '',
      platform: platformName(),
      version: this.deps.version,
      storage: this.directory ? 'sqlite' : 'memory',
      relayConnected: this.relayChannels.has(this.instanceId),
      /** 本机是否已建立到 Hub 的反向中继（出站长连接） */
      relayClientActive: !!this.relayTimer,
      lastHeartbeatOk: this.lastHeartbeatOk,
      lastHeartbeatAgoMs: this.lastHeartbeatOk ? Date.now() - this.lastHeartbeatOk : -1,
      lastHeartbeatError: this.lastHeartbeatError,
    };
  }

  // ════════════════════════════════════════════════════════════
  // 反向中继（Reverse Relay）
  // ════════════════════════════════════════════════════════════
  //
  // 【为什么需要】
  // 用户电脑在 NAT/防火墙后面，endpoint 是 http://192.168.x.x:3456。
  // 手机在外网拿到这个地址根本连不上 → 「手机 App 连不上电脑」。
  //
  // 【怎么做】
  // 电脑主动出站连 Hub（WebSocket），Hub 侧登记这条通道。
  // 手机要访问电脑时，Hub 把 HTTP 请求通过这条通道「反向」送到电脑，
  // 电脑执行后把响应回传，Hub 再返回给手机。
  // 电脑不需要公网 IP、不需要端口映射、不需要 frp/cloudflared。

  /** Hub 侧：注册电脑来的中继通道 */
  public attachRelayChannel(instanceId: string, ownerKey: string, socket: any): void {
    const prev = this.relayChannels.get(instanceId);
    if (prev) {
      try { prev.socket.close(); } catch { /* ignore */ }
    }
    const ch: RelayChannel = {
      instanceId,
      ownerKey,
      socket,
      connectedAt: Date.now(),
      lastPing: Date.now(),
      pending: new Map(),
    };
    this.relayChannels.set(instanceId, ch);
    if (this.directory) this.directory.markRelayConnected(instanceId, ownerKey, '');
    console.log(`[AppConnect] 反向中继已连接: ${instanceId}（当前 ${this.relayChannels.size} 条通道）`);

    socket.on('message', (raw: any) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg?.type === 'pong') { ch.lastPing = Date.now(); if (this.directory) this.directory.markRelayPing(instanceId); return; }
      if (msg?.type === 'ws-ack' || msg?.type === 'ws-data' || msg?.type === 'ws-close') {
        this.handleRelayBridgeFrame(msg);
        return;
      }
      if (msg?.type === 'response') {
        const p = ch.pending.get(String(msg.id));
        if (!p) return;
        ch.pending.delete(String(msg.id));
        try { clearTimeout(p.timer); } catch { /* ignore */ }
        if (msg.ok === false) p.reject(new Error(String(msg.error || 'relay_error')));
        else p.resolve(msg.data);
        return;
      }
    });

    const cleanup = () => {
      if (this.relayChannels.get(instanceId) !== ch) return;
      this.relayChannels.delete(instanceId);
      if (this.directory) this.directory.markRelayDisconnected(instanceId);
      for (const [, p] of ch.pending) {
        try { clearTimeout(p.timer); } catch { /* ignore */ }
        p.reject(new Error('relay_closed'));
      }
      console.log(`[AppConnect] 反向中继断开: ${instanceId}（剩余 ${this.relayChannels.size} 条通道）`);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  // ---------- 反向中继：会话键 / 前缀代理 / WS 桥接 ----------

  /**
   * 手机接管时签发的会话键。
   * 一次性票据只负责「打开界面」那一下；界面里的每一个接口、每一条聊天流
   * 都要带着会话键穿过中继，所以有效期 12 小时且可重复使用。
   */
  public issueRelayKey(instanceId: string, userId: string): { key: string; exp: number } {
    const key = randomBytes(24).toString('hex');
    const exp = Date.now() + RELAY_SESSION_TTL_MS;
    this.tickets.set(key, {
      ticket: key,
      instanceId,
      exp,
      used: false,
      user: { id: userId, numericId: 0, email: '', displayName: '' },
    });
    return { key, exp };
  }

  public verifyRelayKey(key: string, instanceId: string): boolean {
    if (!key || !instanceId) return false;
    const rec = this.tickets.get(String(key));
    if (!rec) return false;
    if (rec.exp < Date.now()) return false;
    return rec.instanceId === instanceId;
  }

  /** Hub 侧：手机 WebSocket → 电脑 WebSocket 的桥接（打字机回复必须走这条） */
  public bridgePhoneWs(phoneWs: any, instanceId: string, key: string, targetPath: string): void {
    if (!this.verifyRelayKey(key, instanceId)) {
      try { phoneWs.close(4001, 'relay_key_invalid'); } catch { /* ignore */ }
      return;
    }
    const ch = this.relayChannels.get(instanceId);
    if (!ch) {
      try { phoneWs.close(4009, 'instance_relay_offline'); } catch { /* ignore */ }
      return;
    }
    const sid = randomUUID();
    this.phoneBridges.set(sid, { ws: phoneWs, instanceId });
    const sendFrame = (frame: any) => {
      const c = this.relayChannels.get(instanceId);
      if (!c) return false;
      try { c.socket.send(JSON.stringify(frame)); return true; } catch { return false; }
    };
    if (!sendFrame({ type: 'ws-open', sid, path: targetPath })) {
      this.phoneBridges.delete(sid);
      try { phoneWs.close(4009, 'relay_send_failed'); } catch { /* ignore */ }
      return;
    }
    phoneWs.on('message', (raw: any) => {
      const data = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
      sendFrame({ type: 'ws-data', sid, data, binary: false });
    });
    const done = () => {
      if (!this.phoneBridges.delete(sid)) return;
      sendFrame({ type: 'ws-close', sid });
    };
    phoneWs.on('close', done);
    phoneWs.on('error', done);
  }

  /** Hub 侧：电脑回传的桥接帧 → 手机 */
  private handleRelayBridgeFrame(msg: any): void {
    const sid = String(msg?.sid || '');
    const b = this.phoneBridges.get(sid);
    if (!b) return;
    if (msg.type === 'ws-ack') {
      if (msg.ok === false) {
        this.phoneBridges.delete(sid);
        try { b.ws.close(4014, String(msg.error || 'relay_ws_failed')); } catch { /* ignore */ }
      }
      return;
    }
    if (msg.type === 'ws-data') {
      try { b.ws.send(String(msg.data ?? '')); } catch { /* ignore */ }
      return;
    }
    if (msg.type === 'ws-close') {
      this.phoneBridges.delete(sid);
      try { b.ws.close(); } catch { /* ignore */ }
    }
  }

  /** 电脑侧：Hub 要求开一条本机 WebSocket（手机聊天流） */
  private openRelayBridge(msg: any): void {
    const sid = String(msg?.sid || '');
    const rawPath = String(msg?.path || '/ws');
    const path = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
    const sendFrame = (frame: any) => {
      const ws = this.relaySocket;
      if (!ws) return;
      try { ws.send(JSON.stringify(frame)); } catch { /* ignore */ }
    };
    try {
      const conn = new WsClient('ws://127.0.0.1:' + this.deps.port + path, { handshakeTimeout: 15000 });
      this.localBridges.set(sid, conn);
      conn.on('open', () => sendFrame({ type: 'ws-ack', sid, ok: true }));
      conn.on('message', (d: any) => {
        const data = typeof d === 'string' ? d : Buffer.from(d).toString('utf8');
        sendFrame({ type: 'ws-data', sid, data, binary: false });
      });
      conn.on('close', () => {
        this.localBridges.delete(sid);
        sendFrame({ type: 'ws-close', sid });
      });
      conn.on('error', (e: any) => {
        this.localBridges.delete(sid);
        sendFrame({ type: 'ws-ack', sid, ok: false, error: e?.message || 'local_ws_failed' });
      });
    } catch (e: any) {
      sendFrame({ type: 'ws-ack', sid, ok: false, error: e?.message || 'local_ws_failed' });
    }
  }

  /** Hub 侧：通过中继通道把请求送到目标电脑 */
  private relayRequest(instanceId: string, method: string, path: string, headers: any, body: any, opts?: { keepAuth?: boolean }): Promise<any> {
    const ch = this.relayChannels.get(instanceId);
    if (!ch) return Promise.reject(new Error('relay_not_connected'));
    if (ch.pending.size >= MAX_RELAY_PENDING) return Promise.reject(new Error('relay_overloaded'));

    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ch.pending.delete(id);
        reject(new Error('relay_timeout'));
      }, RELAY_REQUEST_TIMEOUT_MS);
      ch.pending.set(id, { resolve, reject, timer });
      try {
        ch.socket.send(JSON.stringify({
          type: 'request',
          id,
          method,
          path,
          headers: sanitizeRelayHeaders(headers, !!opts?.keepAuth),
          body: body ?? null,
        }));
      } catch (e: any) {
        ch.pending.delete(id);
        try { clearTimeout(timer); } catch { /* ignore */ }
        reject(e);
      }
    });
  }

  /** 电脑侧：主动出站连 Hub，建立中继通道 */
  public startRelayClient(): void {
    if (this.relayTimer) return;
    const hub = this.hubUrl;
    if (!hub || !this.link?.secret) return;
    if (hub === this.publicEndpoint()) return; // 自己就是 Hub，不需要中继

    const wsUrl = hub.replace(/^http/i, 'ws') + '/api/app/relay?instanceId=' + encodeURIComponent(this.instanceId);
    const gen = ++this.relayGen;
    let ws: any = null;
    let closed = false;

    const connect = () => {
      if (closed || gen !== this.relayGen) return;
      try {
        const headers: any = {
          'X-Instance-Id': this.instanceId,
          'X-Instance-Secret': this.link?.secret || '',
          'Authorization': 'Bearer ' + (this.link?.accounts?.[0]?.accessToken || ''),
        };
        // 【必须用 ws 包】Node 内置的 globalThis.WebSocket 不支持自定义握手头：
        // 第二个参数只认 subprotocol，传 { headers } 会被静默丢弃 →
        // 服务端拿不到实例密钥，握手被拒，客户端只能看到一个 close 1006。
        // 这就是「手机显示电脑在线、一点接管就报错」的直接原因。
        if (!WsClient) { console.warn('[AppConnect] 缺少 ws 包，无法建立反向中继'); closed = true; return; }
        ws = new WsClient(wsUrl, { headers, handshakeTimeout: 15000 });
        this.relaySocket = ws;
      } catch (e: any) {
        console.warn('[AppConnect] 反向中继连接失败:', e?.message || e);
        return;
      }

      ws.onopen = () => {
        console.log(`[AppConnect] 反向中继已建立 → ${hub}`);
      };
      ws.onmessage = async (ev: any) => {
        let msg: any;
        try { msg = JSON.parse(String(ev.data)); } catch { return; }
        // WS 桥接帧：手机在 Hub 那边开 WebSocket，Hub 转给本机执行
        if (msg?.type === 'ws-open') { this.openRelayBridge(msg); return; }
        if (msg?.type === 'ws-data') {
          const c = this.localBridges.get(String(msg.sid || ''));
          try { c?.send(String(msg.data ?? '')); } catch { /* ignore */ }
          return;
        }
        if (msg?.type === 'ws-close') {
          const sid = String(msg.sid || '');
          const c = this.localBridges.get(sid);
          this.localBridges.delete(sid);
          try { c?.close(); } catch { /* ignore */ }
          return;
        }
        if (msg?.type !== 'request') return;
        try {
          const data = await this.handleRelayRequest(msg);
          ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, data }));
        } catch (e: any) {
          try { ws.send(JSON.stringify({ type: 'response', id: msg.id, ok: false, error: e?.message || 'relay_failed' })); } catch { /* ignore */ }
        }
      };
      ws.onclose = () => {
        // 通道断了，本机所有桥接连接一起回收，避免泄漏
        for (const [, c] of this.localBridges) { try { c?.close?.(); } catch { /* ignore */ } }
        this.localBridges.clear();
        if (closed || gen !== this.relayGen) return;
        console.warn('[AppConnect] 反向中继断开，5 秒后重连');
        setTimeout(connect, 5000);
      };
      ws.onerror = () => { /* onclose 会接手重连 */ };
    };
    connect();

    // 心跳 ping
    this.relayTimer = setInterval(() => {
      try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
    }, RELAY_PING_INTERVAL_MS);
    if (typeof this.relayTimer?.unref === 'function') this.relayTimer.unref();
  }

  /** 电脑侧：执行 Hub 反向过来的请求（走本机 HTTP，绕开 NAT） */
  private async handleRelayRequest(msg: any): Promise<any> {
    const method = String(msg.method || 'GET').toUpperCase();
    const path = String(msg.path || '/');
    if (!path.startsWith('/')) throw new Error('bad_path');
    const headers = msg.headers || {};
    let body: any = msg.body;
    if (body && typeof body === 'object') body = JSON.stringify(body);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), RELAY_REQUEST_TIMEOUT_MS - 2000);
    try {
      const r = await fetch(`http://127.0.0.1:${this.deps.port}${path}`, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        signal: ctl.signal,
      });
      const text = await r.text();
      const outHeaders: any = {};
      try {
        r.headers.forEach((v: any, k: string) => { outHeaders[k] = v; });
      } catch { /* ignore */ }
      return { status: r.status, headers: outHeaders, body: text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 定期清理过期设备（不在读路径上做，避免拖慢查询） */
  startPrune(): void {
    if (this.pruneTimer) return;
    const tick = () => {
      try { this.directory?.prune(); } catch { /* ignore */ }
      // 内存模式兜底
      if (!this.directory) {
        const cutoff = Date.now() - RETENTION_WINDOW_MS;
        for (const [k, v] of this.memInstances) if (v.lastSeen < cutoff) this.memInstances.delete(k);
        for (const [k] of this.memSecrets) if (!this.memInstances.has(k)) this.memSecrets.delete(k);
      }
      // 清理过期票据
      const now = Date.now();
      for (const [k, v] of this.tickets) if (v.exp < now - 60_000) this.tickets.delete(k);
    };
    this.pruneTimer = setInterval(tick, 10 * 60_000);
    if (typeof this.pruneTimer?.unref === 'function') this.pruneTimer.unref();
  }

  // ---------- 路由 ----------

  registerRoutes(app: any): void {
    const self = this;

    // 探活：手机用它判断「这台引擎在不在线」，无需登录（不返回任何账号信息）
    app.get('/api/app/ping', (_req: any, res: any) => {
      res.json({
        ok: true,
        engine: true,
        app: 'lingxi',
        instanceId: self.instanceId,
        version: self.deps.version,
        platform: platformName(),
        time: Date.now(),
      });
    });

    // 本机连接状态（供电脑端设置页显示）
    app.get('/api/app/status', self.deps.requireAuth, (_req: any, res: any) => {
      res.json(self.status());
    });

    // 手动把本机绑定到云端账号（电脑端 UI 也可调用）
    app.post('/api/app/link', self.deps.requireAuth, async (req: any, res: any) => {
      try {
        const { email, password, hubUrl } = req.body || {};
        if (!email || !password) return res.status(400).json({ ok: false, error: 'email_password_required' });
        const r = await self.linkAccount(String(email), String(password), hubUrl ? String(hubUrl) : undefined);
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'link_failed' });
      }
    });

    // 手机：我名下的所有灵犀（云端 + 电脑），含在线状态
    app.get('/api/app/instances', self.deps.requireAuth, async (req: any, res: any) => {
      try {
        const instances = await self.listMerged(req.user);
        res.json({ ok: true, instances, count: instances.length, instanceId: self.instanceId });
      } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'list_failed' });
      }
    });

    // 电脑：登记（必须带 Hub 账号的 JWT → 只有登录过同账号才会出现在手机列表）
    app.post('/api/app/register', self.deps.requireAuth, (req: any, res: any) => {
      try {
        const r = self.register(req.user, req.body, 'desktop');
        res.json(r);
      } catch (e: any) {
        res.status(400).json({ ok: false, error: e?.message || 'register_failed' });
      }
    });

    // 电脑：心跳（实例密钥）
    app.post('/api/app/heartbeat', (req: any, res: any) => {
      const id = String(req.headers['x-instance-id'] || req.body?.instanceId || '');
      const secret = String(req.headers['x-instance-secret'] || req.body?.secret || '');
      if (!self.heartbeat(id, secret, req.body)) {
        return res.status(401).json({ ok: false, error: 'bad_instance_credentials' });
      }
      res.json({ ok: true, serverTime: Date.now() });
    });

    // 手机：为某台在线设备申请一次性接管票据
    app.post('/api/app/ticket', self.deps.requireAuth, async (req: any, res: any) => {
      try {
        const instanceId = String(req.body?.instanceId || '');
        const it = self.getInstance(instanceId);
        if (!it) {
          // 电脑端代取云端票据：手机只连到局域网 PC 时也能一键接管云端灵犀
          const hub = self.hubUrl;
          const acct = self.link?.accounts?.[0];
          if (hub && acct?.accessToken && hub !== self.publicEndpoint()) {
            try {
              const r = await fetch(hub + '/api/app/ticket', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acct.accessToken },
                body: JSON.stringify({ instanceId }),
                signal: AbortSignal.timeout(8000),
              });
              const d: any = await r.json();
              return res.status(r.status).json(d);
            } catch (e: any) {
              return res.status(502).json({ ok: false, error: 'hub_unreachable' });
            }
          }
          return res.status(404).json({ ok: false, error: 'instance_not_found' });
        }
        if (instanceId !== self.instanceId && Date.now() - it.lastSeen > ONLINE_WINDOW_MS) {
          return res.status(409).json({ ok: false, error: 'instance_offline' });
        }
        const t = self.issueTicket(req.user, instanceId);
        // 有中继通道 → 走 Hub 中继（公网可达）；否则直连 endpoint（局域网场景）
        const viaRelay = self.relayChannels.has(instanceId);
        const hubBase = self.publicEndpoint();
        let connectUrl: string;
        let relayKey = '';
        if (viaRelay) {
          // 有中继通道：手机留在 Hub 上，所有请求经 /api/app/relay/x/<id>/ 转发到电脑
          const rk = self.issueRelayKey(instanceId, String(req.user?.sub || req.user?.id || ''));
          relayKey = rk.key;
          connectUrl = hubBase + '/app/relay.html?instanceId=' + encodeURIComponent(instanceId)
            + '&rt=' + encodeURIComponent(rk.key)
            + '&t=' + encodeURIComponent(t.ticket);
        } else {
          connectUrl = it.endpoint.replace(/\/+$/, '') + '/app/connect?ticket=' + encodeURIComponent(t.ticket) + '&hub=' + encodeURIComponent(hubBase);
        }
        res.json({
          ok: true,
          ticket: t.ticket,
          exp: t.exp,
          instanceId,
          endpoint: it.endpoint,
          viaRelay,
          relayKey,
          connectUrl,
        });
      } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'ticket_failed' });
      }
    });

    // 目标引擎：校验票据（实例密钥），并换成本地登录态
    app.post('/api/app/ticket/redeem', async (req: any, res: any) => {
      try {
        const id = String(req.headers['x-instance-id'] || req.body?.instanceId || '');
        const secret = String(req.headers['x-instance-secret'] || req.body?.secret || '');
        const ticket = String(req.body?.ticket || '');
        // 情况 A：票据就在本机（云端就是目标）
        let info = self.consumeTicket(ticket) || self.verifyTicket(id, secret, ticket);
        // 情况 B：本机是电脑端，票据在 Hub 上 → 用实例密钥回源校验
        if (!info) {
          const hub = (self.hubUrl || String(req.body?.hub || '')).replace(/\/+$/, '');
          const linkSecret = self.link?.secret || '';
          if (hub && linkSecret) {
            const r = await fetch(hub + '/api/app/ticket/verify', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Instance-Id': this.instanceId,
                'X-Instance-Secret': linkSecret,
              },
              body: JSON.stringify({ ticket }),
              signal: AbortSignal.timeout(8000),
            });
            const d: any = await r.json();
            if (r.ok && d?.ok && d.user) {
              info = { ticket, instanceId: this.instanceId, exp: 0, used: true, user: d.user };
            }
          }
        }
        if (!info) return res.status(401).json({ ok: false, error: 'ticket_invalid_or_expired' });

        const user = self.ensureLocalUser(info.user);
        const token = signAccessToken({
          sub: String(user.id),
          numeric_id: Number(user.numeric_id || info.user.numericId || 0),
          sid: 'mobile-' + randomUUID().slice(0, 8),
        });
        res.json({
          ok: true,
          accessToken: token,
          token,
          user: {
            id: user.id,
            numericId: user.numeric_id,
            displayName: user.display_name || user.displayName || info.user.displayName,
            email: user.email || info.user.email,
          },
        });
        console.log(`[AppConnect] 手机接管成功: ${info.user.email || info.user.id} → 实例 ${self.instanceId}`);
      } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || 'redeem_failed' });
      }
    });

    // Hub：电脑端来核验票据
    app.post('/api/app/ticket/verify', (req: any, res: any) => {
      const id = String(req.headers['x-instance-id'] || req.body?.instanceId || '');
      const secret = String(req.headers['x-instance-secret'] || req.body?.secret || '');
      const t = self.verifyTicket(id, secret, String(req.body?.ticket || ''));
      if (!t) return res.status(401).json({ ok: false, error: 'ticket_invalid_or_expired' });
      res.json({ ok: true, user: t.user });
    });

    // ── 反向中继：Hub 侧入口 ──

    // 电脑 → Hub：建立中继通道（WebSocket 升级）
    app.get('/api/app/relay', self.deps.requireAuth, (req: any, res: any, next: any) => {
      try {
        const instanceId = String(req.query?.instanceId || req.headers['x-instance-id'] || '').trim();
        const secret = String(req.headers['x-instance-secret'] || '').trim();
        if (!instanceId || !secret) return res.status(400).json({ ok: false, error: 'missing_credentials' });
        const known = self.getSecret(instanceId);
        if (!known || !safeEq(known, secret)) return res.status(401).json({ ok: false, error: 'bad_instance_credentials' });
        const ownerKey = self.ownerKeyOf(req.user);
        // 交给 WebSocketServer 升级（在 index.ts 里挂 wss.on('upgrade') 处理）
        const handler = (globalThis as any).__appRelayUpgrade;
        if (typeof handler !== 'function') return res.status(501).json({ ok: false, error: 'relay_not_supported' });
        handler(req, res, instanceId, ownerKey);
      } catch (e: any) {
        try { res.status(500).json({ ok: false, error: e?.message || 'relay_failed' }); } catch { /* ignore */ }
      }
    });

    // Hub → 电脑：把手机请求反向代理过去（手机侧透明访问）
    app.all('/api/app/relay/proxy', self.deps.requireAuth, async (req: any, res: any) => {
      try {
        const instanceId = String(req.query?.instanceId || '').trim();
        const ticket = String(req.query?.ticket || '').trim();
        if (!instanceId) return res.status(400).json({ ok: false, error: 'missing_instance_id' });
        // 票据校验：手机必须持有有效票据才能通过中继访问电脑
        if (ticket) {
          const known = self.getSecret(instanceId);
          const t = self.tickets.get(ticket);
          if (!known || !t || t.used || t.exp < Date.now() || t.instanceId !== instanceId) {
            return res.status(401).json({ ok: false, error: 'ticket_invalid_or_expired' });
          }
        }
        const body = ['GET', 'HEAD'].includes(req.method) ? null : req.body;
        const out = await self.relayRequest(instanceId, req.method, req.originalUrl || req.url, req.headers, body);
        const headers = out?.headers || {};
        // 只透传安全的基础头，避免 set-cookie / hop-by-hop 干扰
        const passthrough: any = {};
        for (const k of ['content-type', 'cache-control', 'etag', 'last-modified']) {
          if (headers[k]) passthrough[k] = headers[k];
        }
        res.status(Number(out?.status || 502));
        if (Object.keys(passthrough).length) res.set(passthrough);
        res.send(out?.body ?? '');
      } catch (e: any) {
        const msg = String(e?.message || 'relay_failed');
        const code = msg === 'relay_not_connected' ? 409 : msg === 'relay_timeout' ? 504 : 502;
        res.status(code).json({ ok: false, error: msg });
      }
    });

    // Hub → 电脑：前缀式反向代理。
    // 手机接管后，界面仍然由 Hub 提供（同版本静态资源），但每一个 /api/ 请求
    // 都改走 /api/app/relay/x/<instanceId>/api/... 转发到用户自己的电脑。
    // 这样手机不需要公网 IP、不需要端口映射，电脑在 NAT 后面也能被操控。
    app.all('/api/app/relay/x/:instanceId/*', async (req: any, res: any) => {
      const instanceId = String(req.params.instanceId || '');
      const key = String(req.query?.rt || req.headers['x-relay-key'] || '');
      if (!self.verifyRelayKey(key, instanceId)) {
        return res.status(401).json({ ok: false, error: 'relay_key_invalid_or_expired' });
      }
      const rest = String(req.params[0] || '');
      const qIdx = String(req.originalUrl || '').indexOf('?');
      let query = qIdx >= 0 ? String(req.originalUrl).slice(qIdx + 1) : '';
      if (query) {
        query = query.split('&').filter((p: string) => p && !/^rt(=|$)/.test(p)).join('&');
      }
      const target = '/' + rest + (query ? '?' + query : '');
      try {
        const body = ['GET', 'HEAD'].includes(req.method) ? null : req.body;
        // keepAuth：转发用户自己的 token（电脑端签发的），否则每个接口都会 401
        const out = await self.relayRequest(instanceId, req.method, target, req.headers, body, { keepAuth: true });
        const headers = out?.headers || {};
        const passthrough: any = {};
        for (const k of ['content-type', 'cache-control', 'etag', 'last-modified', 'location']) {
          if (headers[k]) passthrough[k] = headers[k];
        }
        if (passthrough['location']) {
          const loc = String(passthrough['location']);
          if (loc.startsWith('/')) {
            passthrough['location'] = '/api/app/relay/x/' + encodeURIComponent(instanceId) + loc
              + (loc.includes('?') ? '&' : '?') + 'rt=' + encodeURIComponent(key);
          }
        }
        res.status(Number(out?.status || 502));
        if (Object.keys(passthrough).length) res.set(passthrough);
        res.send(out?.body ?? '');
      } catch (e: any) {
        const msg = String(e?.message || 'relay_failed');
        const code = msg === 'relay_not_connected' ? 409 : msg === 'relay_timeout' ? 504 : 502;
        res.status(code).json({ ok: false, error: msg });
      }
    });

    // 电脑端界面：查这台机器有没有绑定云端
    app.get('/api/app/link', self.deps.requireAuth, (_req: any, res: any) => {
      res.json({
        ok: true,
        linked: !!self.link,
        hubUrl: self.hubUrl,
        email: self.link?.accounts?.[0]?.email || '',
        instanceId: self.instanceId,
      });
    });

    app.post('/api/app/unlink', self.deps.requireAuth, (_req: any, res: any) => {
      self.link = null;
      try {
        if (self.heartbeatTimer) clearInterval(self.heartbeatTimer);
        self.heartbeatTimer = null;
        if (self.relayTimer) clearInterval(self.relayTimer);
        self.relayTimer = null;
      } catch { /* ignore */ }
      res.json({ ok: true });
    });
  }
}

/** 过滤中继转发的请求头：去掉 hop-by-hop 与敏感头 */
function sanitizeRelayHeaders(headers: any, keepAuth = false): any {
  const out: any = {};
  const blocked = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
    'content-length', 'cookie', 'x-instance-secret',
  ]);
  try {
    if (!keepAuth) blocked.add('authorization');
  for (const [k, v] of Object.entries(headers || {})) {
      const lk = String(k).toLowerCase();
      if (blocked.has(lk)) continue;
      if (typeof v === 'string' || typeof v === 'number') out[k] = v;
      else if (Array.isArray(v)) out[k] = v.join(', ');
    }
  } catch { /* ignore */ }
  return out;
}

let _svc: AppConnectService | null = null;

export function registerAppConnectRoutes(app: any, deps: AppConnectDeps): AppConnectService {
  const svc = new AppConnectService(deps);
  svc.registerRoutes(app);
  svc.startPrune();
  (globalThis as any).__appConnect = svc;
  _svc = svc;
  return svc;
}

export function getAppConnect(): AppConnectService | null {
  return _svc;
}

/** 电脑端登录成功后调用：把本机登记到云端（失败不阻塞登录） */
export async function linkAccountToHub(email: string, password: string): Promise<void> {
  const svc = _svc;
  if (!svc) return;
  const hub = svc.hubUrl;
  if (!hub) return;
  try { await svc.linkAccount(email, password, hub); } catch { /* ignore */ }
}
