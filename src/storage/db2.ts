/**
 * SQLite (better-sqlite3) - 高性能持久化层
 * 替代 sql.js 的全量导出落盘，支持索引、事务、WAL 模式
 */
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';

let _db: Database.Database | null = null;
let _dbPath: string = '';
let _saveTimer: ReturnType<typeof setInterval> | null = null;
let _dirty = false;

// WAL 模式检查
function enableWAL(db: Database.Database) {
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -32768'); // 32MB cache
    db.pragma('temp_store = MEMORY');
    db.pragma('mmap_size = 268435456'); // 256MB mmap
    console.log('[DB] WAL mode enabled');
  } catch (e: any) {
    console.warn('[DB] WAL enable failed:', e.message);
  }
}

/**
 * 自动保存 - better-sqlite3 是直接写磁盘，无需导出
 * 这里仅做脏标记清理和检查点
 */
export function startAutoSave(intervalMs = 30000) {
  if (_saveTimer) clearInterval(_saveTimer);
  _saveTimer = setInterval(() => {
    if (_dirty && _db) {
      try {
        _db.pragma('wal_checkpoint(TRUNCATE)');
        _dirty = false;
      } catch (e: any) {
        console.error('[DB] auto-save checkpoint error:', e.message);
      }
    }
  }, intervalMs);
  console.log(`[DB] auto-checkpoint every ${intervalMs / 1000}s`);
}

export function markDirty(): void { _dirty = true; }

/**
 * 初始化数据库
 */
export async function initDB(dbPath: string) {
  _dbPath = dbPath;
  
  // 确保目录存在
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _db = new Database(dbPath);
  enableWAL(_db);
  
  // 启用外键约束
  _db.pragma('foreign_keys = ON');
  
  _dbInit(_db);
  
  // 运行迁移
  try {
    const _schemaStatus = runMigrations({ autoAddMissingColumns: true, failFast: false });
    if (_schemaStatus.drift.length) console.warn('[schema] 迁移后仍有漂移:', JSON.stringify(_schemaStatus.drift));
    else console.log('[schema] ✅ 迁移账本一致 · 漂移 0 处 · checksum=' + _schemaStatus.checksum);
  } catch (e: any) { console.error('[schema] runMigrations 失败:', e.message); }

  // 重建去重索引
  try {
    const { rebuildDedupIndexFromDB } = await import('../memory/memory-write-integration.js');
    rebuildDedupIndexFromDB();
    console.log('[DB] dedup index rebuilt from persistent signatures');
  } catch (e: any) { console.warn('[DB] dedup index rebuild skipped:', e.message); }

  console.log(`[DB] initialized: ${dbPath} (better-sqlite3)`);
  return _db;
}

export function getDB() { return _db; }

export function getDataDir(): string {
  if (!_dbPath) return process.cwd();
  return path.dirname(_dbPath);
}

// 记忆过滤函数（保持兼容）
export function sanitizeMemoryInput(text: string): string {
  if (!text) return '';
  return text
    .replace(/忽略(以上|之前|所有)(的)?(指令|提示|规则|内容|设定)/g, '[已过滤]')
    .replace(/你?(必须|务必)(执行|遵守|听从)/g, '[已过滤]')
    .replace(/最高优先级/g, '[已过滤]')
    .replace(/(覆盖|修改|输出|泄露)(你的)?系统提示(词)?/g, '[已过滤]')
    .replace(/(假装|扮演|现在你是)(系统|管理员|开发者)/g, '[已过滤]');
}

export function trimMemoryText(text: string, maxLen: number = 2000): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.floor(maxLen * 0.25);
  return text.slice(0, headLen) + '\n…\n' + text.slice(-(maxLen - headLen));
}

// ===== 作废机制（保持兼容）=====
const REVOKE_TRIGGERS = [
  '作废', '不用了', '不需要', '不要', '别再', '别做', '禁止', '下线', '取消', '关闭',
  '移除', '删除', '去掉', '停用', '废弃', '不再', '撤销', '失效', '不用',
  '搞错了', '说错了', '更正', '纠正', '搞错',
];

const REVOKE_STOPWORDS = [
  '从今以后', '从现在', '以后都', '以后别', '以后不', '以后再', '以后', '今后',
  '帮我把', '请把', '别再', '别做', '别搞', '不要', '不用', '不再', '不能', '不准',
  '麻烦', '帮我', '请', '把', '将', '这个', '那个', '这些', '那些',
  '我要', '我想', '我', '咱', '都', '再', '又', '也', '还', '和', '跟', '给',
];

export function extractRevocationPatterns(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const trig of REVOKE_TRIGGERS) {
    let idx = text.indexOf(trig);
    while (idx >= 0) {
      const before = text.slice(Math.max(0, idx - 14), idx);
      const m = before.match(/([\u4e00-\u9fa5A-Za-z0-9_]{2,14})$/);
      if (m && m[1].length >= 2) {
        let w = m[1];
        let changed = true;
        while (changed) {
          changed = false;
          for (const sw of REVOKE_STOPWORDS) {
            if (w.length > sw.length + 1 && w.startsWith(sw)) {
              w = w.slice(sw.length);
              changed = true;
              break;
            }
          }
        }
        const cut = w.search(/[这那]/);
        if (cut >= 2) w = w.slice(0, cut);
        if (w.length >= 2) out.push(w);
      }
      idx = text.indexOf(trig, idx + 1);
    }
  }
  return Array.from(new Set(out));
}

export function isRevocationText(text: string): boolean {
  if (!text) return false;
  return REVOKE_TRIGGERS.some(t => text.includes(t));
}

function revokedId(): string {
  return 'rev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function revokeMemoryPattern(
  chatId: string | null,
  agentId: string,
  pattern: string,
  reason: string,
  supersededBy?: string,
): void {
  if (!pattern || !_db) return;
  try {
    _db.prepare(
      `INSERT INTO revoked_memory (id, chat_id, agent_id, pattern, reason, revoked_at, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(revokedId(), chatId, agentId, pattern, reason, Date.now(), supersededBy || null);
    markDirty();
  } catch (e) {
    console.warn('[db] revokeMemoryPattern failed:', (e as Error).message);
  }
}

export function listRevokedPatterns(chatId: string | null, agentId: string): string[] {
  if (!_db) return [];
  try {
    const stmt = chatId
      ? _db.prepare(`SELECT pattern FROM revoked_memory WHERE agent_id = ? AND (chat_id = ? OR chat_id IS NULL)`)
      : _db.prepare(`SELECT pattern FROM revoked_memory WHERE agent_id = ? AND chat_id IS NULL`);
    const rows = stmt.all(chatId ? [agentId, chatId] : [agentId]) as { pattern: string }[];
    return rows.map(r => r.pattern);
  } catch { return []; }
}

export function applyRevocations(text: string, patterns: string[]): string {
  if (!text || patterns.length === 0) return text;
  let out = text;
  for (const p of patterns) {
    if (!p || p.length < 2) continue;
    out = out.split('\n').filter(line => !line.includes(p)).join('\n');
  }
  return out.trim();
}

// ===== 统一数据库操作接口 =====
export const db = {
  get raw() { return _db; },
  exec: (sql: string, params?: any[]) => {
    if (!_db) return [];
    try {
      if (params && params.length) {
        const stmt = _db.prepare(sql);
        return stmt.all(...params);
      }
      return _db.prepare(sql).all();
    } catch (e: any) {
      console.error('[DB] exec error:', e.message, 'SQL:', sql);
      return [];
    }
  },
  run: (sql: string, params?: any[]) => {
    if (!_db) return { changes: 0, lastInsertRowid: 0 };
    try {
      const stmt = _db.prepare(sql);
      const result = params && params.length ? stmt.run(...params) : stmt.run();
      markDirty();
      return result;
    } catch (e: any) {
      console.error('[DB] run error:', e.message, 'SQL:', sql);
      return { changes: 0, lastInsertRowid: 0 };
    }
  },
  prepare: (sql: string) => {
    if (!_db) return { run: () => ({}), all: () => [], get: () => undefined, iterate: () => [] };
    return _db.prepare(sql);
  },
  markDirty: () => { _dirty = true; },
  transaction: (fn: () => void) => {
    if (!_db) return;
    const tx = _db.transaction(fn);
    tx();
    markDirty();
  },
};

export async function closeDB() {
  if (_saveTimer) { clearInterval(_saveTimer); _saveTimer = null; }
  if (_db) {
    try { _db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
    _db.close();
    _db = null;
  }
}

function _dbInit(db: Database.Database) {
  // 使用事务批量建表
  const initSql = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      numeric_id INTEGER UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      email TEXT,
      username TEXT,
      agent_id TEXT,
      created_at INTEGER NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT NOT NULL DEFAULT "",
      status TEXT NOT NULL DEFAULT "offline",
      legacy_user_id TEXT,
      invite_code TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0,
      last_active_at INTEGER,
      avatar_url TEXT DEFAULT "",
      bio TEXT DEFAULT ""
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      display_name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      model_source TEXT NOT NULL DEFAULT 'local',
      personality TEXT NOT NULL DEFAULT '',
      autonomy TEXT NOT NULL DEFAULT 'semi',
      skills TEXT NOT NULL DEFAULT '[]',
      memory_summary TEXT DEFAULT '',
      memory_facts TEXT DEFAULT '{}',
      personality_dims TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'offline',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_market (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '通用',
      price INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]',
      rating REAL DEFAULT 0,
      hire_count INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      duration INTEGER NOT NULL DEFAULT 0,
      duration_unit TEXT NOT NULL DEFAULT 'permanent',
      item_type TEXT NOT NULL DEFAULT 'agent',
      preview_url TEXT DEFAULT '',
      file_url TEXT DEFAULT '',
      license TEXT DEFAULT '',
      cover_url TEXT DEFAULT '',
      currency TEXT NOT NULL DEFAULT 'credits'
    );

    CREATE TABLE IF NOT EXISTS market_orders (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      rating INTEGER,
      review TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      hire_id TEXT
    );

    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'private',
      name TEXT,
      shared_workspace TEXT,
      chat_mode TEXT NOT NULL DEFAULT 'free',
      created_at INTEGER NOT NULL,
      last_message_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      user_id TEXT,
      agent_id TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      sender_type TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      reply_to TEXT,
      metadata TEXT DEFAULT '{}',
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      username TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_memories (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      agent_id TEXT NOT NULL,
      memory_summary TEXT DEFAULT '',
      memory_facts TEXT DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      UNIQUE(chat_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS revoked_memory (
      id TEXT PRIMARY KEY,
      chat_id TEXT,
      agent_id TEXT,
      pattern TEXT NOT NULL,
      reason TEXT,
      revoked_at INTEGER NOT NULL,
      superseded_by TEXT
    );

    CREATE TABLE IF NOT EXISTS friendships (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      message TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(from_user_id, to_user_id)
    );

    CREATE TABLE IF NOT EXISTS rag_documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'text/plain',
      content TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rag_chunks (
      id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      vector BLOB,
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS inbox (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      file_path TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      refresh_token_hash TEXT NOT NULL,
      device_info TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      context TEXT,
      confidence REAL DEFAULT 0.8,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      count INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS message_ratings (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT,
      balance_after INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS chat_read_state (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      last_read_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, chat_id)
    );

    CREATE TABLE IF NOT EXISTS lan_group_invites (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      group_name TEXT NOT NULL,
      owner_instance TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      invited_user_id TEXT NOT NULL,
      invited_user_numeric_id INTEGER,
      inviter_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      group_def TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lan_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_instance TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      chat_mode TEXT NOT NULL DEFAULT 'free',
      member_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lan_group_members (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      numeric_id INTEGER,
      display_name TEXT,
      instance_id TEXT,
      role TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      agent_id TEXT,
      UNIQUE(group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS lan_remote_identities (
      user_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      numeric_id INTEGER,
      display_name TEXT,
      agent_id TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      owner_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      display_name TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (team_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY,
      balance_usd REAL NOT NULL DEFAULT 0,
      balance_cny REAL NOT NULL DEFAULT 0,
      frozen_usd REAL NOT NULL DEFAULT 0,
      frozen_cny REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    -- 索引
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_participants_chat ON participants(chat_id);
    CREATE INDEX IF NOT EXISTS idx_chat_memories_chat ON chat_memories(chat_id);
    CREATE INDEX IF NOT EXISTS idx_revoked_memory_scope ON revoked_memory(chat_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_friendships_from ON friendships(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_friendships_to ON friendships(to_user_id);
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_agent ON inbox(agent_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_verif_token ON user_verifications(token);
    CREATE INDEX IF NOT EXISTS idx_user_verif_user ON user_verifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_entities_chat ON entities(chat_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_msg ON message_ratings(message_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_user ON message_ratings(user_id);
    CREATE INDEX IF NOT EXISTS idx_credit_log_user ON credit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_lan_group_invites_user ON lan_group_invites(invited_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_lan_group_invites_group ON lan_group_invites(group_id);
    CREATE INDEX IF NOT EXISTS idx_lan_group_members_group ON lan_group_members(group_id);
    CREATE INDEX IF NOT EXISTS idx_users_numeric_id ON users(numeric_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_chats_id ON chats(id);
    CREATE INDEX IF NOT EXISTS idx_rag_docs_id ON rag_documents(id);
    CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
  `;

  db.exec(initSql);

  // 设置 sqlite_sequence 种子
  try {
    const row = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get('users') as { seq: number } | undefined;
    if (!row || row.seq < 9999) {
      db.prepare(`INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('users', 9999)`).run();
    }
  } catch (_e) { /* ignore */ }
}

// 迁移系统（简化版，保持兼容）
interface MigrationStatus { drift: string[]; checksum: string; }
function hasTable(db: Database.Database, name: string): boolean {
  try {
    const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    return !!row;
  } catch { return false; }
}

export function runMigrations(opts: { autoAddMissingColumns: boolean; failFast: boolean }): MigrationStatus {
  if (!_db) return { drift: ['no db'], checksum: '' };
  const drift: string[] = [];
  
  // 检查关键表和列
  const checks = [
    { table: 'users', columns: ['numeric_id', 'email_verified', 'password_hash', 'status', 'legacy_user_id', 'invite_code', 'updated_at', 'last_active_at', 'avatar_url', 'bio'] },
    { table: 'agents', columns: ['personality_dims'] },
    { table: 'chats', columns: ['shared_workspace', 'chat_mode', 'name'] },
    { table: 'lan_groups', columns: ['member_count'] },
    { table: 'lan_group_members', columns: ['agent_id'] },
    { table: 'agent_market', columns: ['duration', 'duration_unit', 'item_type', 'preview_url', 'file_url', 'license', 'cover_url', 'currency'] },
    { table: 'market_orders', columns: ['hire_id'] },
  ];

  for (const check of checks) {
    if (!hasTable(_db, check.table)) continue;
    try {
      const cols = _db.prepare(`PRAGMA table_info(${check.table})`).all() as { name: string }[];
      const existing = new Set(cols.map(c => c.name));
      for (const col of check.columns) {
        if (!existing.has(col)) {
          drift.push(`${check.table}.${col} missing`);
          if (opts.autoAddMissingColumns) {
            // 这里简化处理，实际需要根据类型添加
            console.warn(`[migration] Would add ${check.table}.${col} but skipped in better-sqlite3 version`);
          }
        }
      }
    } catch (e: any) {
      drift.push(`${check.table} check failed: ${e.message}`);
    }
  }

  // 计算简单校验和
  const tables = _db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[];
  const checksum = tables.map(t => t.name).join(',').length.toString(16);
  
  return { drift, checksum };
}

// ===== Users =====
let _nextNumericId = 10000;

function getNextNumericId(): number {
  if (!_db) return _nextNumericId++;
  try {
    const row = _db.prepare(`SELECT MAX(numeric_id) as max FROM users`).get() as { max: number } | undefined;
    return (row?.max ?? 9999) + 1;
  } catch {
    return _nextNumericId++;
  }
}

export function createUser(id: string, displayName: string, email?: string, username?: string) {
  if (!_db) throw new Error('DB not initialized');
  const now = Date.now();
  const numericId = getNextNumericId();
  _db.prepare(
    `INSERT INTO users (id, numeric_id, display_name, email, username, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, numericId, displayName, email ?? null, username ?? null, now);
  return { id, numericId, displayName, email, username, createdAt: now };
}

export function getUser(id: string) {
  if (!_db) return undefined;
  // 双格式兼容
  let stmt = _db.prepare(`SELECT * FROM users WHERE id = ?`);
  let row = stmt.get(id);
  if (row) return row;
  const nid = Number(id);
  if (!Number.isNaN(nid) && String(nid) === String(id).trim()) {
    stmt = _db.prepare(`SELECT * FROM users WHERE numeric_id = ?`);
    row = stmt.get(nid);
    if (row) return row;
  }
  return undefined;
}

export function getUserByEmail(email: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
}

export function getUserByDisplayName(displayName: string) {
  if (!_db) return undefined;
  markDirty();
  return _db.prepare(`SELECT * FROM users WHERE display_name = ?`).get(displayName);
}

export function listUsers() {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM users`).all();
}

export function searchUsers(keyword: string, limit: number = 50): any[] {
  if (!_db) return [];
  const like = '%' + keyword + '%';
  return _db.prepare(
    `SELECT id, numeric_id, display_name FROM users WHERE display_name LIKE ? OR CAST(numeric_id AS TEXT) LIKE ? LIMIT ?`
  ).all(like, like, limit);
}

// ===== Agents =====
export function createAgent(id: string, userId: string, displayName: string, personality: string, autonomy: string, model?: string) {
  if (!_db) throw new Error('DB not initialized');
  const now = Date.now();
  _db.prepare(
    `INSERT INTO agents (id, user_id, display_name, model, personality, autonomy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, displayName, model || '', personality, autonomy, now);
  return getAgent(id);
}

export function getAgent(id: string) {
  if (!_db) return undefined;
  // better-sqlite3 的 get() 返回 unknown；这个文件里到处当对象用，统一断言
  return _db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as any;
}

export function listAgents() {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM agents`).all();
}

export function updateAgent(agentId: string, updates: Record<string, any>) {
  if (!_db) return;
  const allowed = ['personality', 'memory_summary', 'memory_facts', 'personality_dims', 'status', 'model', 'display_name'];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (allowed.includes(k) && v !== undefined) {
      sets.push(`${k} = ?`);
      vals.push(typeof v === 'object' ? JSON.stringify(v) : v);
    }
  }
  if (!sets.length) return;
  vals.push(agentId);
  markDirty();
  _db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function updateAgentMemory(agentId: string, summary: string, facts: Record<string, string>) {
  if (!_db) return;
  _db.prepare(`UPDATE agents SET memory_summary = ?, memory_facts = ? WHERE id = ?`).run(summary, JSON.stringify(facts), agentId);
  markDirty();
}

// ===== Chat Memories =====
export function upsertChatMemory(chatId: string, agentId: string, summary: string, facts: Record<string, string>) {
  if (!_db) return;
  const id = `${chatId}:${agentId}`;
  const now = Date.now();
  _db.prepare(
    `INSERT INTO chat_memories (id, chat_id, agent_id, memory_summary, memory_facts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET memory_summary = ?, memory_facts = ?, updated_at = ?`
  ).run(id, chatId, agentId, summary, JSON.stringify(facts), now, summary, JSON.stringify(facts), now);
  markDirty();
}

export function getChatMemory(chatId: string, agentId: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM chat_memories WHERE chat_id = ? AND agent_id = ?`).get(chatId, agentId);
}

export function getChatMemories(chatId: string) {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM chat_memories WHERE chat_id = ?`).all(chatId);
}

export function listChatMemoryPairs(): Array<{ chat_id: string; agent_id: string }> {
  if (!_db) return [];
  return _db.prepare(
    `SELECT DISTINCT chat_id, agent_id FROM chat_memories WHERE memory_summary IS NOT NULL AND length(memory_summary) >= 100`
  ).all() as any[];
}

// ===== Memory Summary with Revocation =====
export function appendMemorySummary(agentId: string, newContent: string) {
  if (!_db) return;
  const agent = getAgent(agentId);
  if (!agent) return;
  const existing = agent.memory_summary || '';
  const safeContent = sanitizeMemoryInput(newContent);
  if (!safeContent) return;

  const isRevoke = isRevocationText(safeContent);
  let revokedPatterns: string[] = [];
  if (isRevoke) {
    revokedPatterns = extractRevocationPatterns(safeContent);
    for (const pat of revokedPatterns) {
      revokeMemoryPattern(null, agentId, pat, safeContent);
    }
  }

  const known = listRevokedPatterns(null, agentId);
  const allPatterns = Array.from(new Set([...known, ...revokedPatterns]));
  let base = allPatterns.length > 0 ? applyRevocations(existing, allPatterns) : existing;

  if (base.includes(safeContent)) return;

  const updated = base ? base + '\n' + safeContent : safeContent;
  const trimmed = trimMemoryText(updated, 2000);
  _db.prepare(`UPDATE agents SET memory_summary = ? WHERE id = ?`).run(trimmed, agentId);
  markDirty();
}

// ===== Chats =====
export function createChat(id: string, type: "private" | "group" = "private", sharedWorkspace?: string, name?: string) {
  if (!_db) throw new Error('DB not initialized');
  const now = Date.now();
  _db.prepare(
    `INSERT INTO chats (id, type, shared_workspace, name, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, type, sharedWorkspace ?? null, name ?? null, now);
  return { id, type, sharedWorkspace, name, createdAt: now };
}

export function addParticipant(id: string, chatId: string, userId?: string, agentId?: string, role: string = "member") {
  if (!_db) return;
  _db.prepare(
    `INSERT INTO participants (id, chat_id, user_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, chatId, userId ?? null, agentId ?? null, role, Date.now());
  markDirty();
}

export function getChatParticipants(chatId: string) {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM participants WHERE chat_id = ?`).all(chatId);
}

export function listChats() {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM chats ORDER BY created_at DESC`).all();
}

export function getChatById(id: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM chats WHERE id = ?`).get(id);
}

export function updateChatWorkspace(id: string, sharedWorkspace: string | null) {
  if (!_db) return;
  _db.prepare(`UPDATE chats SET shared_workspace = ? WHERE id = ?`).run(sharedWorkspace, id);
  markDirty();
}

export function updateChatName(id: string, name: string | null) {
  if (!_db) return;
  _db.prepare(`UPDATE chats SET name = ? WHERE id = ?`).run(name, id);
  markDirty();
}

export const CHAT_MODES = ['free', 'route', 'debate', 'chain', 'roundtable', 'vote', 'brainstorm'] as const;
export type ChatModeType = typeof CHAT_MODES[number];

export function getChatMode(chatId: string): ChatModeType {
  if (!_db) return 'free';
  try {
    const row = _db.prepare(`SELECT chat_mode FROM chats WHERE id = ?`).get(chatId) as { chat_mode: string } | undefined;
    const mode = row?.chat_mode;
    return CHAT_MODES.includes(mode as ChatModeType) ? mode as ChatModeType : 'free';
  } catch { return 'free'; }
}

export function setChatMode(chatId: string, mode: string): boolean {
  if (!_db || !CHAT_MODES.includes(mode as ChatModeType)) return false;
  try {
    _db.prepare(`UPDATE chats SET chat_mode = ? WHERE id = ?`).run(mode, chatId);
    markDirty();
    return true;
  } catch { return false; }
}

export function removeParticipant(chatId: string, userId: string, agentId?: string) {
  if (!_db) return;
  if (agentId) {
    _db.prepare(`DELETE FROM participants WHERE chat_id = ? AND agent_id = ?`).run(chatId, agentId);
  } else {
    _db.prepare(`DELETE FROM participants WHERE chat_id = ? AND user_id = ?`).run(chatId, userId);
  }
  markDirty();
}

// ===== Messages =====
export interface DBMessage {
  id: string;
  chatId: string;
  senderType: string;
  senderId: string;
  content: string;
  type: string;
  replyTo?: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export function addMessage(msg: DBMessage) {
  if (!_db) return;
  _db.prepare(
    `INSERT INTO messages (id, chat_id, sender_type, sender_id, content, type, reply_to, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    msg.id, msg.chatId, msg.senderType, msg.senderId,
    msg.content, msg.type, msg.replyTo ?? null,
    JSON.stringify(msg.metadata ?? {}), msg.timestamp
  );
  _db.prepare(`UPDATE chats SET last_message_at = ? WHERE id = ?`).run(msg.timestamp, msg.chatId);
  markDirty();
}

export function listMessages(chatId: string, limit = 100) {
  if (!_db) return [];
  return _db.prepare(
    `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`
  ).all(chatId, limit).reverse();
}

export function getRecentMessages(agentId: string, limit = 20): Array<{ content: string; timestamp: number }> {
  if (!_db) return [];
  return _db.prepare(
    `SELECT content, timestamp FROM messages WHERE sender_id = ? OR (sender_type = 'agent' AND sender_id = ?) ORDER BY timestamp DESC LIMIT ?`
  ).all(agentId, agentId, limit).reverse() as Array<{ content: string; timestamp: number }>;
}

export function messageExists(msgId: string): boolean {
  if (!_db) return false;
  return !!_db.prepare(`SELECT 1 FROM messages WHERE id = ?`).get(msgId);
}

// ===== Verification Codes =====
export function saveVerificationCode(email: string, code: string, username?: string, expiresAtMs?: number) {
  if (!_db) return;
  const now = Date.now();
  const exp = expiresAtMs ?? now + 5 * 60 * 1000;
  _db.prepare(
    `INSERT OR REPLACE INTO verification_codes (email, code, username, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(email, code, username ?? null, exp, now);
  markDirty();
}

export function getVerificationCode(email: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM verification_codes WHERE email = ?`).get(email);
}

export function deleteVerificationCode(email: string) {
  if (!_db) return;
  _db.prepare(`DELETE FROM verification_codes WHERE email = ?`).run(email);
  markDirty();
}

// ===== Friendships =====
export function makePrivateChatId(userA: string, userB: string): string {
  const [a, b] = [userA, userB].sort();
  return `chat-${a}-${b}`;
}

export function sendFriendRequest(fromUserId: string, toUserId: string, message: string = '') {
  if (!_db) return { error: 'DB not initialized' };
  if (fromUserId === toUserId) return { error: '不能添加自己为好友' };
  
  const targetUser = getUser(toUserId);
  if (!targetUser && !toUserId.startsWith('remote-') && !getLanRemoteIdentity(toUserId)) {
    return { error: '对方用户不存在' };
  }

  const now = Date.now();
  const id = 'friend-' + now + '-' + Math.random().toString(36).slice(2, 6);
  
  let existingRow = _db.prepare(`SELECT id, status FROM friendships WHERE from_user_id = ? AND to_user_id = ?`).get(fromUserId, toUserId);
  if (!existingRow) {
    existingRow = _db.prepare(`SELECT id, status FROM friendships WHERE from_user_id = ? AND to_user_id = ?`).get(toUserId, fromUserId);
  }
  if (existingRow) {
    const status = (existingRow as any).status;
    if (status === 'accepted') return { error: '已经是好友' };
    if (status === 'pending') return { error: '好友请求已发送，等待对方确认' };
    if (status === 'blocked') return { error: '无法添加该用户' };
  }

  _db.prepare(
    `INSERT INTO friendships (id, from_user_id, to_user_id, status, message, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)`
  ).run(id, fromUserId, toUserId, message, now, now);
  markDirty();
  return { id, status: 'pending' };
}

export function getLanRemoteIdentity(userId: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM lan_remote_identities WHERE user_id = ?`).get(userId);
}

// 需要补充的其他函数占位（保持接口兼容）
export function getFriendships(userId: string) { return []; }
export function acceptFriendRequest(friendshipId: string) { }
export function rejectFriendRequest(friendshipId: string) { }
export function blockFriendship(friendshipId: string) { }
export function removeFriendship(userId1: string, userId2: string) { }

// ===== 导出查询辅助 =====
export function queryAll(sql: string, params: any[] = []): any[][] {
  if (!_db) return [];
  // better-sqlite3 的 all() 返回对象数组，这里保持 sql.js 的二维数组语义
  const stmt = _db.prepare(sql);
  const rows = (params.length ? stmt.all(...params) : stmt.all()) as any[];
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  return rows.map(r => cols.map(c => r[c]));
}

export function queryOne(sql: string, params: any[] = []): any | null {
  if (!_db) return null;
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  return stmt.get() ?? null;
}

export function queryObjects(sql: string, params: any[] = []): any[] {
  if (!_db) return [];
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  return stmt.all() as any[];
}