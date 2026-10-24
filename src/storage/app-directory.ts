/**
 * 手机 App 连接层 · 设备目录存储
 * ================================================================
 * 目标：支撑「几千到几万」台设备在线登记，不把 Hub 的内存和磁盘打爆。
 *
 * 【为什么不用 JSON 文件】
 * 旧实现把全部实例写进 data/app-instances.json：
 *   - 每次心跳都全量读 → 全量改 → 全量写盘，几万设备时是 O(N) 写放大，
 *     60s 一次心跳直接把 Hub 的磁盘 IO 打满；
 *   - 全量 JSON.parse/writeFileSync 是同步阻塞调用，阻塞 Node 事件循环；
 *   - 多实例部署时没有任何一致性保证。
 *
 * 【现在的做法】
 *   - 设备目录落 SQLite（与主库同一个 main.db），走索引查询；
 *   - owner_key + last_seen 建复合索引，「我名下有哪些设备」是 O(log N + K)；
 *   - 心跳只 UPDATE 一行（UPSERT），不再全量重写；
 *   - 过期设备用惰性清理 + 定时批量清理，不在读路径上做。
 *
 * 【表结构】
 *   app_instances        设备目录（Hub 侧权威表）
 *   app_instance_secrets 实例密钥（与目录分离，便于将来独立轮换）
 *   app_relay_channels  反向中继通道（电脑 → Hub 的出站长连接）
 */

import { randomBytes } from 'crypto';

export interface AppInstanceRecord {
  instanceId: string;
  ownerKey: string;
  name: string;
  kind: 'cloud' | 'desktop';
  endpoint: string;
  platform: string;
  version: string;
  lastSeen: number;
  createdAt: number;
  agentCount: number;
  /** 是否支持反向中继（电脑主动出站连 Hub）—— 老版本客户端没有这个能力 */
  relayCapable: boolean;
}

export interface AppInstanceSecret {
  instanceId: string;
  secret: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_instances (
  instance_id   TEXT PRIMARY KEY,
  owner_key     TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'desktop',
  endpoint      TEXT NOT NULL DEFAULT '',
  platform      TEXT NOT NULL DEFAULT '',
  version       TEXT NOT NULL DEFAULT '',
  last_seen     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  agent_count   INTEGER NOT NULL DEFAULT 0,
  relay_capable INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_app_instances_owner ON app_instances(owner_key, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_app_instances_seen  ON app_instances(last_seen);

CREATE TABLE IF NOT EXISTS app_instance_secrets (
  instance_id TEXT PRIMARY KEY,
  secret      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_relay_channels (
  instance_id TEXT PRIMARY KEY,
  owner_key   TEXT NOT NULL DEFAULT '',
  connected_at INTEGER NOT NULL DEFAULT 0,
  last_ping   INTEGER NOT NULL DEFAULT 0,
  remote_ip   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_app_relay_owner ON app_relay_channels(owner_key);
`;

/** 设备离线判定窗口：超过这个时间没心跳就算离线 */
export const ONLINE_WINDOW_MS = 150_000;
/** 设备记录保留窗口：超过这个时间没心跳就彻底清理（防止目录无限膨胀） */
export const RETENTION_WINDOW_MS = 7 * 24 * 3600_000;

function nowMs(): number {
  return Date.now();
}

/**
 * 设备目录存储。持有 db 句柄（sql.js Database），所有写操作同步且极快
 * （单行 UPSERT 在 SQLite 里是微秒级），不阻塞事件循环。
 */
export class AppDirectoryStore {
  private db: any;

  constructor(db: any) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    try {
      this.db.exec(SCHEMA);
    } catch (e: any) {
      console.error('[AppDirectory] 建表失败:', e.message);
    }
  }

  /** 从旧 JSON 文件迁移（一次性，幂等） */
  migrateFromLegacyJson(instances: any[], secrets: Record<string, string> = {}): number {
    let n = 0;
    try {
      for (const it of instances || []) {
        if (!it || !it.instanceId) continue;
        if (this.get(it.instanceId)) continue; // 已存在则跳过
        this.upsert({
          instanceId: String(it.instanceId),
          ownerKey: String(it.ownerKey || ''),
          name: String(it.name || ''),
          kind: it.kind === 'cloud' ? 'cloud' : 'desktop',
          endpoint: String(it.endpoint || ''),
          platform: String(it.platform || ''),
          version: String(it.version || ''),
          lastSeen: Number(it.lastSeen || 0),
          createdAt: Number(it.createdAt || nowMs()),
          agentCount: Number(it.agentCount || 0),
          relayCapable: false,
        });
        const sec = secrets[it.instanceId] || it.secret;
        if (sec) this.setSecret(String(it.instanceId), String(sec));
        n++;
      }
    } catch (e: any) {
      console.error('[AppDirectory] 旧数据迁移失败:', e.message);
    }
    return n;
  }

  get(instanceId: string): AppInstanceRecord | null {
    try {
      const stmt = this.db.prepare(
        `SELECT instance_id, owner_key, name, kind, endpoint, platform, version,
                last_seen, created_at, agent_count, relay_capable
         FROM app_instances WHERE instance_id = ?`,
      );
      stmt.bind([String(instanceId || '')]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return row ? rowToRecord(row) : null;
    } catch (e: any) {
      console.error('[AppDirectory] get 失败:', e.message);
      return null;
    }
  }

  getSecret(instanceId: string): string | null {
    try {
      const stmt = this.db.prepare(`SELECT secret FROM app_instance_secrets WHERE instance_id = ?`);
      stmt.bind([String(instanceId || '')]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return row ? String(row.secret || '') : null;
    } catch (e: any) {
      return null;
    }
  }

  setSecret(instanceId: string, secret: string): void {
    try {
      this.db.run(
        `INSERT INTO app_instance_secrets(instance_id, secret) VALUES (?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET secret = excluded.secret`,
        [String(instanceId), String(secret)],
      );
    } catch (e: any) {
      console.error('[AppDirectory] setSecret 失败:', e.message);
    }
  }

  /** 登记 / 更新设备（单行 UPSERT，O(1)） */
  upsert(rec: AppInstanceRecord): void {
    try {
      this.db.run(
        `INSERT INTO app_instances
           (instance_id, owner_key, name, kind, endpoint, platform, version,
            last_seen, created_at, agent_count, relay_capable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           owner_key     = excluded.owner_key,
           name          = excluded.name,
           kind          = excluded.kind,
           endpoint      = excluded.endpoint,
           platform      = excluded.platform,
           version       = excluded.version,
           last_seen     = excluded.last_seen,
           agent_count   = excluded.agent_count,
           relay_capable = excluded.relay_capable`,
        [
          rec.instanceId,
          rec.ownerKey,
          rec.name,
          rec.kind,
          rec.endpoint,
          rec.platform,
          rec.version,
          rec.lastSeen,
          rec.createdAt,
          rec.agentCount,
          rec.relayCapable ? 1 : 0,
        ],
      );
    } catch (e: any) {
      console.error('[AppDirectory] upsert 失败:', e.message);
    }
  }

  /** 心跳：只更新可变字段，不动 created_at / owner_key */
  heartbeat(instanceId: string, patch: {
    endpoint?: string;
    agentCount?: number;
    name?: string;
    version?: string;
    platform?: string;
    relayCapable?: boolean;
  }): boolean {
    try {
      const cur = this.get(instanceId);
      if (!cur) return false;
      this.upsert({
        ...cur,
        endpoint: patch.endpoint ?? cur.endpoint,
        agentCount: patch.agentCount ?? cur.agentCount,
        name: patch.name ?? cur.name,
        version: patch.version ?? cur.version,
        platform: patch.platform ?? cur.platform,
        relayCapable: patch.relayCapable ?? cur.relayCapable,
        lastSeen: nowMs(),
      });
      return true;
    } catch (e: any) {
      console.error('[AppDirectory] heartbeat 失败:', e.message);
      return false;
    }
  }

  /** 列出某账号名下的设备（在线优先） */
  listByOwner(ownerKey: string, limit = 50): AppInstanceRecord[] {
    try {
      const stmt = this.db.prepare(
        `SELECT instance_id, owner_key, name, kind, endpoint, platform, version,
                last_seen, created_at, agent_count, relay_capable
         FROM app_instances
         WHERE owner_key = ? AND last_seen > ?
         ORDER BY last_seen DESC
         LIMIT ?`,
      );
      stmt.bind([String(ownerKey || ''), nowMs() - RETENTION_WINDOW_MS, Number(limit) || 50]);
      const out: AppInstanceRecord[] = [];
      while (stmt.step()) out.push(rowToRecord(stmt.getAsObject()));
      stmt.free();
      return out;
    } catch (e: any) {
      console.error('[AppDirectory] listByOwner 失败:', e.message);
      return [];
    }
  }

  /** 列出全部在线设备（Hub 自身用） */
  listOnline(limit = 200): AppInstanceRecord[] {
    try {
      const stmt = this.db.prepare(
        `SELECT instance_id, owner_key, name, kind, endpoint, platform, version,
                last_seen, created_at, agent_count, relay_capable
         FROM app_instances
         WHERE last_seen > ?
         ORDER BY last_seen DESC
         LIMIT ?`,
      );
      stmt.bind([nowMs() - ONLINE_WINDOW_MS, Number(limit) || 200]);
      const out: AppInstanceRecord[] = [];
      while (stmt.step()) out.push(rowToRecord(stmt.getAsObject()));
      stmt.free();
      return out;
    } catch (e: any) {
      return [];
    }
  }

  count(): number {
    try {
      const stmt = this.db.prepare(`SELECT COUNT(*) AS c FROM app_instances`);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return row ? Number(row.c || 0) : 0;
    } catch { return 0; }
  }

  /** 清理长期不活跃的设备（定时调用，不在读路径上） */
  prune(retentionMs = RETENTION_WINDOW_MS): boolean {
    try {
      const cutoff = nowMs() - retentionMs;
      this.db.run(`DELETE FROM app_instances WHERE last_seen < ?`, [cutoff]);
      this.db.run(`DELETE FROM app_instance_secrets WHERE instance_id NOT IN (SELECT instance_id FROM app_instances)`);
      this.db.run(`DELETE FROM app_relay_channels WHERE last_ping < ?`, [cutoff]);
      return true;
    } catch (e: any) {
      console.error('[AppDirectory] prune 失败:', e.message);
      return false;
    }
  }

  // ---------- 反向中继通道 ----------

  markRelayConnected(instanceId: string, ownerKey: string, remoteIp: string): void {
    try {
      this.db.run(
        `INSERT INTO app_relay_channels(instance_id, owner_key, connected_at, last_ping, remote_ip)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           owner_key    = excluded.owner_key,
           connected_at = excluded.connected_at,
           last_ping    = excluded.last_ping,
           remote_ip    = excluded.remote_ip`,
        [String(instanceId), String(ownerKey || ''), nowMs(), nowMs(), String(remoteIp || '')],
      );
    } catch (e: any) {
      console.error('[AppDirectory] markRelayConnected 失败:', e.message);
    }
  }

  markRelayPing(instanceId: string): void {
    try {
      this.db.run(`UPDATE app_relay_channels SET last_ping = ? WHERE instance_id = ?`, [nowMs(), String(instanceId)]);
    } catch { /* ignore */ }
  }

  markRelayDisconnected(instanceId: string): void {
    try {
      this.db.run(`DELETE FROM app_relay_channels WHERE instance_id = ?`, [String(instanceId)]);
    } catch { /* ignore */ }
  }

  isRelayConnected(instanceId: string): boolean {
    try {
      const stmt = this.db.prepare(`SELECT instance_id FROM app_relay_channels WHERE instance_id = ?`);
      stmt.bind([String(instanceId)]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return !!row;
    } catch { return false; }
  }

  listRelayChannels(): Array<{ instanceId: string; ownerKey: string; lastPing: number }> {
    try {
      const stmt = this.db.prepare(`SELECT instance_id, owner_key, last_ping FROM app_relay_channels`);
      const out: Array<{ instanceId: string; ownerKey: string; lastPing: number }> = [];
      while (stmt.step()) {
        const r = stmt.getAsObject();
        out.push({ instanceId: String(r.instance_id), ownerKey: String(r.owner_key || ''), lastPing: Number(r.last_ping || 0) });
      }
      stmt.free();
      return out;
    } catch { return []; }
  }
}

function rowToRecord(r: any): AppInstanceRecord {
  return {
    instanceId: String(r.instance_id || ''),
    ownerKey: String(r.owner_key || ''),
    name: String(r.name || ''),
    kind: r.kind === 'cloud' ? 'cloud' : 'desktop',
    endpoint: String(r.endpoint || ''),
    platform: String(r.platform || ''),
    version: String(r.version || ''),
    lastSeen: Number(r.last_seen || 0),
    createdAt: Number(r.created_at || 0),
    agentCount: Number(r.agent_count || 0),
    relayCapable: Number(r.relay_capable || 0) === 1,
  };
}

/** 生成实例密钥 */
export function generateInstanceSecret(): string {
  return randomBytes(24).toString('hex');
}
