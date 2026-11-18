/**
 * SQLite (better-sqlite3) - 高性能持久化层
 * 替代 sql.js 的全量导出落盘，支持索引、事务、WAL 模式
 * 保持与旧 db.ts 相同的导出 API，兼容现有代码
 */
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatParticipant, Agent } from '../types/index.js';

// better-sqlite3 v11 把 get()/all() 默认推断成 unknown，本文件是 sql.js 时代的机械移植，
// 对外 API 本来就是 any 形状（queryObjects 等）。这里统一按 any 持有句柄，
// 恢复迁移前的类型基线；运行时行为不变，由 388 个用例 + 实机日志兜底。
let _db: any = null;
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
  
  // ── 外键约束：显式关闭 ──
  // ★ FIX-FK(2026-11-09): 本库从 sql.js 迁到 better-sqlite3 后，后者默认
  //   PRAGMA foreign_keys = ON（sql.js 默认 OFF）。历史数据里存在孤儿行
  //   （agents.user_id / messages.chat_id / participants.chat_id 等指向已删父行），
  //   一旦外键生效，任何写入都会抛 "FOREIGN KEY constraint failed"。
  //   应用层已自行校验关联，这里明确关闭，恢复迁移前的行为。
  try {
    _db.pragma('foreign_keys = OFF');
    console.log('[DB] foreign_keys = OFF（应用层自行校验关联，避免历史孤儿行触发约束错误）');
  } catch (e: any) { console.warn('[DB] 关闭 foreign_keys 失败:', e.message); }
  
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

export function getDB() { return db; }

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

// ===== 统一数据库操作接口（兼容旧 API）=====
// 2026-11-11 FIX-RAW-API：sql.js 的 Database 有 .run(sql, params) / .exec(sql) / .prepare(sql)，
// 但 better-sqlite3 的 Database 只有 .prepare() / .exec()（.run 在 Statement 上）。
// 迁移后 `db.raw.run('UPDATE ...', [a,b])` 会抛 "dbRef.raw.run is not a function"，
// 而且调用点全在 try 外面（manager.update 等），直接变成 unhandled rejection。
// 这里给 raw 套一层 sql.js 兼容壳：run/exec/all/get 语义与旧版一致。
/**
 * 原生 prepare 直通，同时兼容 sql.js 风格调用。
 * 2026-11-11 FIX：src/routes/profile.ts 用 `prepare(sql).bind([...])` → step()/getAsObject()/free()。
 * better-sqlite3 的 Statement 没有 step/getAsObject/free，直接调会抛 "st.step is not a function"。
 * 这里返回 Proxy：原生方法（all/get/run/iterate/pluck/columns/...）直接透传给 stmt，
 * 另外补上 bind/step/getAsObject/free，语义与 sql.js 一致（bind 返回自身，链式调用不会丢状态）。
 */
function makeStatementCompat(stmt: any) {
  if (!stmt) return stmt;
  let rows: any[] | null = null;
  let idx = 0;
  const compat: any = {
    /** sql.js：bind 后返回自身，可继续 .step()/.getAsObject() */
    bind(...params: any[]) {
      const p = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      rows = p.length ? stmt.all(...p) : stmt.all();
      idx = 0;
      return compat;
    },
    step() {
      if (!rows) { rows = stmt.all(); idx = 0; }
      const list: any[] = rows || [];
      return idx < list.length ? (idx++, true) : false;
    },
    getAsObject() {
      return rows && idx > 0 && idx <= rows.length ? rows[idx - 1] : {};
    },
    free() { rows = null; idx = 0; },
  };
  return new Proxy(compat, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      const v = stmt[prop];
      return typeof v === 'function' ? v.bind(stmt) : v;
    },
    has(_t, prop: string) { return prop in compat || prop in stmt; },
  });
}

function makeRawCompat() {
  const passthrough = (fn: string) => (...args: any[]) => {
    const d: any = _db;
    if (!d) return undefined;
    if (typeof d[fn] === 'function') return d[fn](...args);
    // Database 上没有该方法 → 尝试当 Statement 方法用
    try {
      const stmt = d.prepare(args[0]);
      if (typeof stmt[fn] === 'function') return stmt[fn](...args.slice(1));
    } catch { /* ignore */ }
    return undefined;
  };
  const raw: any = {
    /** sql.js 风格：run(sql, params) —— better-sqlite3 下转成 prepare().run(...params) */
    run: (sql: string, params?: any[]) => {
      if (!_db) return { changes: 0, lastInsertRowid: 0 };
      const stmt = _db.prepare(sql);
      const r = params && params.length ? stmt.run(...params) : stmt.run();
      markDirty();
      return r;
    },
    /** sql.js 风格：exec(sql) 返回 [{columns, values}] */
    exec: (sql: string) => {
      if (!_db) return [];
      const rows: any[] = _db.prepare(sql).all();
      if (rows.length === 0) return [];
      const columns = Object.keys(rows[0]);
      return [{ columns, values: rows.map(r => columns.map(c => r[c])) }];
    },
    /** sql.js 风格：all(sql, params) */
    all: (sql: string, params?: any[]) => {
      if (!_db) return [];
      const stmt = _db.prepare(sql);
      return params && params.length ? stmt.all(...params) : stmt.all();
    },
    /** sql.js 风格：get(sql, params) */
    get: (sql: string, params?: any[]) => {
      if (!_db) return undefined;
      const stmt = _db.prepare(sql);
      return params && params.length ? stmt.get(...params) : stmt.get();
    },
    /**
     * 原生 prepare 直通，同时兼容 sql.js 风格调用（bind/step/getAsObject/free）。
     * 见 makeStatementCompat 的注释。
     */
    prepare: (sql: string) => {
      if (!_db) return undefined;
      return makeStatementCompat(_db.prepare(sql));
    },
    /** 兼容 sql.js 的 run(sql, params) 变体：也接受数组参数 */
    pragma: passthrough('pragma'),
    transaction: (fn: () => void) => {
      if (!_db) return;
      const tx = _db.transaction(fn);
      tx();
      markDirty();
    },
  };
  return raw;
}

export const db = {
  get raw() { return makeRawCompat(); },
  exec: (sql: string, params?: any[]): { columns: string[]; values: any[][] }[] => {
    if (!_db) return [];
    try {
      const head = String(sql).trimStart().slice(0, 24).toUpperCase();
      const isQuery = /^(SELECT|PRAGMA|WITH|EXPLAIN)\b/.test(head);
      if (!isQuery) {
        _db.exec(sql);
        markDirty();
        return [];
      }
      if (params && params.length) {
        const stmt = _db.prepare(sql);
        const rows: any[] = stmt.all(...params);
        if (rows.length === 0) return [];
        const columns = Object.keys(rows[0]);
        const values = rows.map(row => columns.map(col => row[col]));
        return [{ columns, values }];
      }
      const rows: any[] = _db.prepare(sql).all();
      if (rows.length === 0) return [];
      const columns = Object.keys(rows[0]);
      const values = rows.map(row => columns.map(col => row[col]));
      return [{ columns, values }];
    } catch (e: any) {
      console.error('[DB] exec error:', e.message, 'SQL:', sql);
      return [];
    }
  },
  run: (sql: string, params?: any[]): { changes: number; lastInsertRowid: number } => {
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
    if (!_db) return {
      run: () => ({}),
      all: () => [] as any[],
      get: () => undefined,
      iterate: () => [] as any[],
      bind: () => ({ step: () => false, getAsObject: () => ({}), free: () => {} }),
      step: () => false,
      getAsObject: () => ({}),
      free: () => {}
    };
    const stmt = _db.prepare(sql);
    let rows: any[] = [];
    let rowIndex = 0;
    let bound = false;

    const compat: any = {
      ...stmt,
      all: (...params: any[]) => stmt.all(...params),
      get: (...params: any[]) => stmt.get(...params),
      iterate: (...params: any[]) => stmt.iterate(...params),
      run: (...params: any[]) => stmt.run(...params),
      bind: (...params: any[]) => {
        bound = true;
        rows = stmt.all(...params);
        rowIndex = 0;
        return {
          step: () => {
            if (rowIndex < rows.length) {
              rowIndex++;
              return true;
            }
            return false;
          },
          getAsObject: () => {
            if (rowIndex > 0 && rowIndex <= rows.length) {
              return rows[rowIndex - 1];
            }
            return {};
          },
          free: () => { rows = []; rowIndex = 0; bound = false; }
        };
      },
      step: () => {
        if (!bound) {
          rows = stmt.all();
          rowIndex = 0;
          bound = true;
        }
        if (rowIndex < rows.length) {
          rowIndex++;
          return true;
        }
        return false;
      },
      getAsObject: () => {
        if (!bound) {
          rows = stmt.all();
          rowIndex = 0;
          bound = true;
        }
        if (rowIndex > 0 && rowIndex <= rows.length) {
          return rows[rowIndex - 1];
        }
        return {};
      },
      free: () => { rows = []; rowIndex = 0; bound = false; }
    };
    return compat;
  },
  markDirty: () => { _dirty = true; },
  transaction: (fn: () => void) => {
    if (!_db) return;
    const tx = _db.transaction(fn);
    tx();
    markDirty();
  },

  // Chat modes
  getChatMode: (chatId: string) => getChatMode(chatId),
  setChatMode: (chatId: string, mode: string) => setChatMode(chatId, mode),

  // Friendships - extended
  listFriends: (userId: string) => listFriends(userId),
  getFriendRequests: (userId: string) => getFriendRequests(userId),
  respondFriendRequest: (friendshipId: string, action: 'accept' | 'reject') => respondFriendRequest(friendshipId, action),
  getAgentByUserId: (userId: string) => getAgentByUserId(userId),

  // Memory
  appendMemorySummary: (agentId: string, newContent: string) => appendMemorySummary(agentId, newContent),

  // Other
  deleteFriendshipByPair: (userId1: string, userId2: string) => deleteFriendshipByPair(userId1, userId2),
  syncAgentToPrivateChats: (userId: string) => syncAgentToPrivateChats(userId),

  // Messages
  listMessages: (chatId: string, limit?: number) => listMessages(chatId, limit),
};

// 兼容旧代码的 DB 类
export class DB {
  get raw() { return makeRawCompat(); }
  exec(sql: string, params?: any[]) { return db.exec(sql, params); }
  run(sql: string, params?: any[]) { return db.run(sql, params); }
  prepare(sql: string) { return db.prepare(sql); }
  markDirty() { markDirty(); }
  transaction(fn: () => void) { db.transaction(fn); }
  
  // Users
  getUser(id: string) { return getUser(id); }
  createUser(id: string, displayName: string, email?: string, username?: string) { return createUser(id, displayName, email, username); }
  listUsers() { return listUsers(); }
  searchUsers(keyword: string, limit?: number) { return searchUsers(keyword, limit); }
  getUserByEmail(email: string) { return getUserByEmail(email); }
  getUserByDisplayName(displayName: string) { return getUserByDisplayName(displayName); }
  
  // Agents
  getAgent(id: string) { return getAgent(id); }
  listAgents() { return listAgents(); }
  updateAgent(agentId: string, updates: Record<string, any>) { return updateAgent(agentId, updates); }
  updateAgentMemory(agentId: string, summary: string, facts: Record<string, string>) { return updateAgentMemory(agentId, summary, facts); }
  /**
   * 2026-11-11 FIX：DB 类漏了这个转发方法，但 index.ts 的 ensureUserSetup()
   * 在访客连 WebSocket 时会走 manager.register() → this.db.createAgent() →
   * 抛 "this.db.createAgent is not a function"，导致每个新访客自动建档都失败
   * （新用户没 agent、没默认会话，界面看起来就是"连上 WS 什么都不会发生"）。
   */
  createAgent(id: string, userId: string, displayName: string, personality: string, autonomy: string, model?: string) {
    return createAgent(id, userId, displayName, personality, autonomy, model);
  }
  
  // Chats
  createChat(id: string, type: "private" | "group" = "private", sharedWorkspace?: string, name?: string) { return createChat(id, type, sharedWorkspace, name); }
  addParticipant(id: string, chatId: string, userId?: string, agentId?: string, role: string = "member") { return addParticipant(id, chatId, userId, agentId, role); }
  getChatParticipants(chatId: string) { return getChatParticipants(chatId); }
  listChats() { return listChats(); }
  getChatById(id: string) { return getChatById(id); }
  updateChatWorkspace(id: string, sharedWorkspace: string | null) { return updateChatWorkspace(id, sharedWorkspace); }
  updateChatName(id: string, name: string | null) { return updateChatName(id, name); }
  removeParticipant(chatId: string, userId: string, agentId?: string) { return removeParticipant(chatId, userId, agentId); }
  
  // Messages
  addMessage(msg: any) { return addMessage(msg); }
  listMessages(chatId: string, limit?: number) { return listMessages(chatId, limit); }
  searchMessages(q: string, opts?: { chatId?: string; limit?: number }) { return searchMessages(q, opts); }
  getRecentMessages(agentId: string, limit?: number) { return getRecentMessages(agentId, limit); }
  messageExists(msgId: string) { return messageExists(msgId); }
  
  // Friendships
  sendFriendRequest(fromUserId: string, toUserId: string, message?: string) { return sendFriendRequest(fromUserId, toUserId, message); }
  getFriendships(userId: string) { return getFriendships(userId); }
  acceptFriendRequest(friendshipId: string) { return acceptFriendRequest(friendshipId); }
  rejectFriendRequest(friendshipId: string) { return rejectFriendRequest(friendshipId); }
  blockFriendship(friendshipId: string) { return blockFriendship(friendshipId); }
  removeFriendship(userId1: string, userId2: string) { return removeFriendship(userId1, userId2); }
  makePrivateChatId(userA: string, userB: string) { return makePrivateChatId(userA, userB); }

  // Chat modes
  getChatMode(chatId: string) { return getChatMode(chatId); }
  setChatMode(chatId: string, mode: string) { return setChatMode(chatId, mode); }

  // Friendships - extended
  listFriends(userId: string) { return listFriends(userId); }
  getFriendRequests(userId: string) { return getFriendRequests(userId); }
  respondFriendRequest(friendshipId: string, action: 'accept' | 'reject') { return respondFriendRequest(friendshipId, action); }
  getAgentByUserId(userId: string) { return getAgentByUserId(userId); }

  // Memory
  appendMemorySummary(agentId: string, newContent: string) { return appendMemorySummary(agentId, newContent); }

  // Other
  deleteFriendshipByPair(userId1: string, userId2: string) { return deleteFriendshipByPair(userId1, userId2); }
  syncAgentToPrivateChats(userId: string) { return syncAgentToPrivateChats(userId); }
}

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
      last_message_at INTEGER,
      -- RBAC: group chat settings
      owner_id TEXT,
      settings TEXT DEFAULT '{}'  -- JSON: { joinPolicy: 'open'|'invite'|'approval', historyVisible: true, muteDefault: false, ... }
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      user_id TEXT,
      agent_id TEXT,
      role TEXT NOT NULL DEFAULT 'member',  -- owner, admin, member
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
      -- RBAC: role in this friendship (owner=from_user, admin, member)
      role TEXT NOT NULL DEFAULT 'member',
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

    CREATE TABLE IF NOT EXISTS e2ee_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      private_key TEXT,
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
function hasTable(db: any, name: string): boolean {
  try {
    const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    return !!row;
  } catch { return false; }
}

export function runMigrations(opts: { autoAddMissingColumns: boolean; failFast: boolean }): MigrationStatus {
  if (!_db) return { drift: ['no db'], checksum: '' };
  const drift: string[] = [];
  
  // 期望列的完整定义：'name:TYPE' 或 'name:TYPE:DEFAULT_CLAUSE'
  // 说明：CREATE TABLE IF NOT EXISTS 对已存在的表是彻底的空操作，
  // 建表 SQL 里新加的字段在升级上来的老库里永远不会出现。
  // 所以这里必须真的执行 ALTER TABLE ... ADD COLUMN，而不是只打一行日志
  // （2026-11-11 FIX-MIGRATION：旧实现只 console.warn 一句就 return，
  //   导致「新装正常、升级必炸」，且漂移检查漏了 owner_id/settings 还谎报「漂移 0 处」）。
  const checks: Array<{ table: string; columns: Array<string | [string, string, string?]> }> = [
    { table: 'users', columns: ['numeric_id', 'email_verified', 'password_hash', 'status', 'legacy_user_id', 'invite_code', 'updated_at', 'last_active_at', 'avatar_url', 'bio'] },
    { table: 'agents', columns: ['personality_dims'] },
    { table: 'chats', columns: ['shared_workspace', 'chat_mode', 'name', ['owner_id', 'TEXT'], ['settings', 'TEXT', "'{}'"]] },
    { table: 'lan_groups', columns: ['member_count'] },
    { table: 'lan_group_members', columns: ['agent_id'] },
    { table: 'agent_market', columns: ['duration', 'duration_unit', 'item_type', 'preview_url', 'file_url', 'license', 'cover_url', 'currency'] },
    { table: 'market_orders', columns: ['hire_id'] },
    // 历史遗留：这些列在早期版本就写进建表 SQL，但老库里可能缺失。
    // 加进检查清单只影响「真的缺了才补」，不会动已有数据。
    { table: 'messages', columns: ['chat_id', 'sender_id', 'sender_type', 'content', 'type', 'timestamp'] },
    { table: 'participants', columns: ['chat_id', 'user_id', 'agent_id', 'role', 'joined_at'] },
    { table: 'chat_memories', columns: ['chat_id', 'agent_id', 'memory_summary', 'memory_facts'] },
    // 2026-11-18 修复：老库 friendships 缺 role 列 → 加好友必 400（has no column named role）。
    // role 建表为 NOT NULL DEFAULT 'member'，ALTER 补列须带常量默认值；message/updated_at 同被写入，一并纳入防漂移。
    { table: 'friendships', columns: ['from_user_id', 'to_user_id', 'status', 'created_at', 'message', ['updated_at', 'INTEGER'], ['role', 'TEXT NOT NULL', "'member'"]] },
  ];

  let added = 0;
  for (const check of checks) {
    if (!hasTable(_db, check.table)) continue;
    try {
      const cols = _db.prepare(`PRAGMA table_info(${check.table})`).all() as { name: string }[];
      const existing = new Set(cols.map(c => c.name));
      for (const spec of check.columns) {
        const [col, type, def] = Array.isArray(spec) ? spec : [spec, 'TEXT', undefined];
        if (existing.has(col)) continue;
        if (!opts.autoAddMissingColumns) {
          drift.push(`${check.table}.${col} missing`);
          continue;
        }
        // ALTER TABLE 不能加 PRIMARY KEY / UNIQUE / 非常量默认值；这里只用简单类型
        const ddl = `ALTER TABLE ${check.table} ADD COLUMN ${col} ${type}${def ? ` DEFAULT ${def}` : ''}`;
        try {
          _db.prepare(ddl).run();
          added++;
          console.log(`[migration] ✅ 已补列 ${check.table}.${col} (${type})`);
        } catch (e: any) {
          // 老库里类型不兼容等情况：记进 drift，不中断启动
          const msg = `${check.table}.${col} add failed: ${e.message}`;
          console.warn(`[migration] ⚠️ 补列失败 ${check.table}.${col}: ${e.message}`);
          drift.push(msg);
          if (opts.failFast) throw new Error(msg);
        }
      }
    } catch (e: any) {
      drift.push(`${check.table} check failed: ${e.message}`);
      if (opts.failFast) throw e;
    }
  }

  // 计算简单校验和
  const tables = _db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[];
  const checksum = tables.map(t => t.name).join(',').length.toString(16);

  if (added > 0) console.log(`[migration] 本轮共补 ${added} 列`);
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

export function initNumericIdSeq() {
  _nextNumericId = getNextNumericId();
}

export function nextNumericId(): number {
  // 每次分配都从 DB 读实时 MAX，避免「访客占号 + 内存计数器不推进」导致 UNIQUE 冲突
  // （2026-10-15 FIX：老实现是纯内存计数器，index.ts 的 ensureUserSetup 直接用 MAX()+1 写库
  //   不推进计数器，任何人访问一次官网就能让下一个真实注册必然撞 users.numeric_id 唯一键）。
  return getNextNumericId();
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

/** 完整创建用户（含密码哈希、邀请码等） */
export function createFullUser(params: {
  id: string; numericId: number; email: string; passwordHash: string;
  displayName: string; inviteCode?: string; legacyUserId?: string;
}): any {
  if (!_db) throw new Error('DB not initialized');
  const now = Date.now();
  _db.prepare(
    `INSERT INTO users (id, numeric_id, email, email_verified, password_hash, display_name, status, legacy_user_id, invite_code, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, 'offline', ?, ?, ?, ?)`
  ).run(params.id, params.numericId, params.email, params.passwordHash, params.displayName, params.legacyUserId || null, params.inviteCode || null, now, now);
  // 消费邀请码
  if (params.inviteCode) {
    _db.prepare(`UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?`).run(params.inviteCode);
    markDirty();
  }
  return getUser(params.id);
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
  return _db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id);
}

export function getAgentByUserId(userId: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM agents WHERE user_id = ?`).get(userId);
}

export function listAgents(): Agent[] {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM agents`).all() as Agent[];
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
export function createChat(id: string, type: "private" | "group" = "private", sharedWorkspace?: string, name?: string, ownerId?: string) {
  if (!_db) throw new Error('DB not initialized');
  const now = Date.now();
  _db.prepare(
    `INSERT INTO chats (id, type, shared_workspace, name, created_at, owner_id, settings) VALUES (?, ?, ?, ?, ?, ?, '{}')`
  ).run(id, type, sharedWorkspace ?? null, name ?? null, now, ownerId ?? null);
  return { id, type, sharedWorkspace, name, createdAt: now, ownerId };
}

export function addParticipant(id: string, chatId: string, userId?: string, agentId?: string, role: string = "member") {
  if (!_db) return;
  _db.prepare(
    `INSERT INTO participants (id, chat_id, user_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, chatId, userId ?? null, agentId ?? null, role, Date.now());
  markDirty();
}

export function getChatParticipants(chatId: string): ChatParticipant[] {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM participants WHERE chat_id = ?`).all(chatId) as ChatParticipant[];
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
    const validMode = CHAT_MODES.includes(mode as ChatModeType) ? mode as ChatModeType : 'free';
    
    // 启动时自动修正脏数据（非阻塞、仅修正不抛错）
    if (mode !== validMode) {
      try {
        _db.prepare(`UPDATE chats SET chat_mode = ? WHERE id = ?`).run(validMode, chatId);
        markDirty();
        console.log(`[ChatMode] 自动修正脏数据: chat=${chatId} mode="${mode}" -> "${validMode}"`);
      } catch (e) {
        console.warn(`[ChatMode] 修正脏数据失败: ${chatId}`, e);
      }
    }
    return validMode;
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

export function listMessages(chatId: string, limit = 100): Array<{ id: string; chatId: string; sender_type: string; senderId: string; content: string; type: string; replyTo?: string; timestamp: number; metadata?: string }> {
  if (!_db) return [];
  return _db.prepare(
    `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`
  ).all(chatId, limit).reverse() as Array<{ id: string; chatId: string; sender_type: string; senderId: string; content: string; type: string; replyTo?: string; timestamp: number; metadata?: string }>;
}

/** 按关键字搜索消息（LIKE 模糊匹配，可按会话过滤），按时间正序返回 */
export function searchMessages(q: string, opts: { chatId?: string; limit?: number } = {}): any[] {
  if (!_db) return [];
  const kw = String(q ?? '').trim();
  if (!kw) return [];
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
  // 转义 LIKE 通配符，避免用户输入 % / _ 把查询放大成全表匹配
  const like = '%' + kw.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const rows = opts.chatId
    ? _db.prepare(`SELECT * FROM messages WHERE chat_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY timestamp ASC LIMIT ?`).all(opts.chatId, like, limit)
    : _db.prepare(`SELECT * FROM messages WHERE content LIKE ? ESCAPE '\\' ORDER BY timestamp ASC LIMIT ?`).all(like, limit);
  return rows as any[];
}

export function getRecentMessages(agentId: string, limit = 20): Array<{ content: string; timestamp: number }> {
  if (!_db) return [];
  return _db.prepare(
    `SELECT content, timestamp FROM messages WHERE sender_id = ? OR (sender_type = 'agent' AND sender_id = ?) ORDER BY timestamp DESC LIMIT ?`
  ).all(agentId, agentId, limit).reverse();
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
  
  // F8 修复：好友请求附言长度上限 200 字符，防滥用
  message = String(message || '').slice(0, 200);
  // 解析 toUserId：如果是 numeric_id，转换为实际的 user id
  const targetUser = getUser(toUserId);
  let resolvedToUserId = toUserId;
  if (targetUser) {
    resolvedToUserId = targetUser.id;
  } else {
    // 尝试按 numeric_id 查找
    const nid = Number(toUserId);
    if (!Number.isNaN(nid) && String(nid) === String(toUserId).trim()) {
      const byNumeric = getUserByNumericId(nid);
      if (byNumeric) resolvedToUserId = byNumeric.id;
    }
  }
  
  // 再次检查目标用户是否存在
  if (!getUser(resolvedToUserId) && !resolvedToUserId.startsWith('remote-') && !getLanRemoteIdentity(resolvedToUserId)) {
    return { error: '对方用户不存在' };
  }
  
  // 也解析 fromUserId
  const fromUser = getUser(fromUserId);
  let resolvedFromUserId = fromUserId;
  if (fromUser) {
    resolvedFromUserId = fromUser.id;
  } else {
    const nid = Number(fromUserId);
    if (!Number.isNaN(nid) && String(nid) === String(fromUserId).trim()) {
      const byNumeric = getUserByNumericId(nid);
      if (byNumeric) resolvedFromUserId = byNumeric.id;
    }
  }
  
  if (resolvedFromUserId === resolvedToUserId) return { error: '不能添加自己为好友' };
  
  const now = Date.now();
  const id = 'friend-' + now + '-' + Math.random().toString(36).slice(2, 6);
  
  let existingRow = _db.prepare(`SELECT id, status FROM friendships WHERE from_user_id = ? AND to_user_id = ?`).get(resolvedFromUserId, resolvedToUserId);
  if (!existingRow) {
    existingRow = _db.prepare(`SELECT id, status FROM friendships WHERE from_user_id = ? AND to_user_id = ?`).get(resolvedToUserId, resolvedFromUserId);
  }
  if (existingRow) {
    const status = (existingRow as any).status;
    if (status === 'accepted') return { error: '已经是好友' };
    if (status === 'pending') return { error: '好友请求已发送，等待对方确认' };
    if (status === 'blocked') return { error: '无法添加该用户' };
    // F1 修复(2026-11-15)：rejected/withdrawn 旧行复用为新的 pending，
    // 避免直接 INSERT 撞 UNIQUE(from_user_id,to_user_id) 导致「被拒一次永远加不上」500。
    _db.prepare(
      `UPDATE friendships SET from_user_id = ?, to_user_id = ?, status = 'pending', message = ?, created_at = ?, updated_at = ?, role = 'member' WHERE id = ?`
    ).run(resolvedFromUserId, resolvedToUserId, message, now, now, (existingRow as any).id);
    markDirty();
    return { id: (existingRow as any).id, status: 'pending' };
  }
  
  _db.prepare(
    `INSERT INTO friendships (id, from_user_id, to_user_id, status, message, created_at, updated_at, role) VALUES (?, ?, ?, 'pending', ?, ?, ?, 'member')`
  ).run(id, resolvedFromUserId, resolvedToUserId, message, now, now);
  markDirty();
  return { id, status: 'pending' };
}

export function getFriendships(userId: string) {
  if (!_db) return [];
  return _db.prepare(
    `SELECT * FROM friendships WHERE from_user_id = ? OR to_user_id = ?`
  ).all(userId, userId);
}

export function acceptFriendRequest(friendshipId: string) {
  if (!_db) return;
  _db.prepare(`UPDATE friendships SET status = 'accepted', updated_at = ?, role = 'member' WHERE id = ?`).run(Date.now(), friendshipId);
  markDirty();
}

export function rejectFriendRequest(friendshipId: string) {
  if (!_db) return;
  _db.prepare(`UPDATE friendships SET status = 'rejected', updated_at = ? WHERE id = ?`).run(Date.now(), friendshipId);
  markDirty();
}

export function blockFriendship(friendshipId: string) {
  if (!_db) return;
  _db.prepare(`UPDATE friendships SET status = 'blocked', updated_at = ? WHERE id = ?`).run(Date.now(), friendshipId);
  markDirty();
}

export function removeFriendship(userId1: string, userId2: string) {
  if (!_db) return;
  _db.prepare(`DELETE FROM friendships WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`).run(userId1, userId2, userId2, userId1);
  markDirty();
}

export function deleteFriendshipByPair(userId1: string, userId2: string) {
  return removeFriendship(userId1, userId2);
}

// F2 修复(2026-11-15)：撤回好友请求。仅 pending 可撤回；删除该行以便重新发送。
export function withdrawFriendRequest(friendshipId: string): { ok: boolean; error?: string } {
  if (!_db) return { ok: false, error: 'DB not initialized' };
  const row = _db.prepare(`SELECT id, status FROM friendships WHERE id = ?`).get(friendshipId) as any;
  if (!row) return { ok: false, error: '好友请求不存在' };
  if (row.status !== 'pending') return { ok: false, error: '只能撤回待处理的好友请求' };
  _db.prepare(`DELETE FROM friendships WHERE id = ?`).run(friendshipId);
  markDirty();
  return { ok: true };
}

export function getFriendshipById(friendshipId: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM friendships WHERE id = ?`).get(friendshipId);
}

export function getFriendshipByPair(userId1: string, userId2: string) {
  if (!_db) return undefined;
  let row = _db.prepare(`SELECT * FROM friendships WHERE from_user_id = ? AND to_user_id = ?`).get(userId1, userId2);
  if (!row) {
    row = _db.prepare(`SELECT * FROM friendships WHERE from_user_id = ? AND to_user_id = ?`).get(userId2, userId1);
  }
  return row;
}

export function getFriendRequests(userId: string) {
  if (!_db) return { incoming: [], outgoing: [], pendingIncoming: [] };
  // 支持 userId 或 numeric_id 双形态查询
  const variants = userIdVariants(userId);
  let incoming: any[] = [];
  let outgoing: any[] = [];
  for (const v of variants) {
    const inc = _db.prepare(`SELECT * FROM friendships WHERE to_user_id = ? AND status = 'pending'`).all(v);
    const out = _db.prepare(`SELECT * FROM friendships WHERE from_user_id = ? AND status = 'pending'`).all(v);
    incoming.push(...inc);
    outgoing.push(...out);
  }
  // 去重
  const seen = new Set();
  incoming = incoming.filter(r => {
    const key = r.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  seen.clear();
  outgoing = outgoing.filter(r => {
    const key = r.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // 转换为前端期望的 camelCase 字段
  const transformIncoming = (r: any) => ({
    id: r.id,
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    status: r.status,
    message: r.message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const transformOutgoing = (r: any) => ({
    id: r.id,
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    status: r.status,
    message: r.message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const pendingIncoming = incoming.map(transformIncoming);
  return { 
    incoming: incoming.map(transformIncoming), 
    outgoing: outgoing.map(transformOutgoing), 
    pendingIncoming 
  };
}

export function listFriends(userId: string) {
  if (!_db) return [];
  // 支持 userId 或 numeric_id 双形态查询
  const variants = userIdVariants(userId);
  let allRows: any[] = [];
  for (const v of variants) {
    const rows = _db.prepare(
      `SELECT * FROM friendships WHERE (from_user_id = ? OR to_user_id = ?) AND status = 'accepted'`
    ).all(v, v);
    allRows.push(...rows);
  }
  // 去重
  const seen = new Set();
  allRows = allRows.filter(r => {
    const key = r.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // F3 修复：用归一化 canonical id 集合比较（而非原始入参），
  // 避免 numeric_id 查询时 outgoing 行返回自己（拉好友进私聊 isFriend 判否 403）。
  const selfIds = new Set(variants.map(String));
  return allRows.map((r: any) => {
    const friendId = selfIds.has(String(r.from_user_id)) ? r.to_user_id : r.from_user_id;
    // F4 修复：解析好友真实昵称与 agent，不再恒为空（前端回退「用户<id>」）。
    const friendUser = getUser(friendId);
    return {
      friendId,
      friendName: friendUser?.display_name || '',
      friendAgentId: friendUser?.agent_id || undefined,
      fromUserId: r.from_user_id,
      toUserId: r.to_user_id,
      status: r.status,
      createdAt: r.created_at,
    };
  });
}

export function respondFriendRequest(friendshipId: string, action: 'accept' | 'reject'): { ok: boolean; status: string } {
  if (!_db) return { ok: false, status: 'error' };
  const status = action === 'accept' ? 'accepted' : 'rejected';
  _db.prepare(`UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), friendshipId);
  markDirty();
  return { ok: true, status };
}

/**
 * 把新注册的 Agent 补挂到该用户已有的私聊里。
 * 2026-11-11 FIX：这个函数从 sql.js 时代就是空壳（注释写着"占位函数，保持兼容"），
 * 但 index.ts / auth-main.ts 都拿它的返回值判断「补了几个私聊」并打印日志。
 * 空壳返回 undefined → 调用方 `synced > 0` 恒为 false（TS 报 TS2365），
 * 功能上「新建 Agent 不会出现在已有的单聊里」这个 bug 一直没被发现。
 */
export function syncAgentToPrivateChats(userId: string): number {
  if (!_db) return 0;
  const agent = getAgentByUserId(userId);
  if (!agent) return 0;
  // 找到该用户参与的所有私聊
  const parts = _db.prepare(`SELECT DISTINCT chat_id FROM participants WHERE user_id = ?`).all(userId) as { chat_id: string }[];
  let synced = 0;
  for (const p of parts) {
    const chat = _db.prepare(`SELECT type, (SELECT COUNT(*) FROM participants WHERE chat_id = ? AND agent_id = ?) AS hasAgent FROM chats WHERE id = ?`)
      .get(p.chat_id, agent.id, p.chat_id) as { type: string; hasAgent: number } | undefined;
    if (!chat || chat.type !== 'private') continue;
    if (chat.hasAgent > 0) continue;
    _db.prepare(`INSERT OR IGNORE INTO participants (id, chat_id, user_id, agent_id, role, joined_at) VALUES (?, ?, NULL, ?, 'agent', ?)`)
      .run(`p-${p.chat_id}-${agent.id}`, p.chat_id, agent.id, Date.now());
    synced++;
  }
  if (synced > 0) markDirty();
  return synced;
}

// ===== LAN Groups (局域网群组) =====
export function createLanGroup(
  groupId: string,
  name: string,
  ownerInstance: string,
  chatMode: string = 'free'
) {
  if (!_db) return;
  const now = Date.now();
  _db.prepare(
    `INSERT INTO lan_groups (id, name, owner_instance, owner_user_id, chat_mode, member_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(groupId, name, ownerInstance, '', chatMode, 0, now);
  markDirty();
}

export function getLanGroup(groupId: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM lan_groups WHERE id = ?`).get(groupId);
}

export function listLanGroups() {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM lan_groups ORDER BY created_at DESC`).all();
}

export function setLanGroupMode(groupId: string, mode: string) {
  if (!_db) return false;
  // 验证 mode 是否在允许列表中
  if (!CHAT_MODES.includes(mode as ChatModeType)) return false;
  const result = _db.prepare(`UPDATE lan_groups SET chat_mode = ? WHERE id = ?`).run(mode, groupId);
  markDirty();
  return result.changes > 0;
}

export function deleteLanGroup(groupId: string) {
  if (!_db) return;
  _db.prepare(`DELETE FROM lan_groups WHERE id = ?`).run(groupId);
  _db.prepare(`DELETE FROM lan_group_members WHERE group_id = ?`).run(groupId);
  markDirty();
}

export function addLanGroupMember(
  groupId: string,
  userId: string,
  numericId: number,
  displayName: string,
  instanceId: string,
  role: string = 'member',
  agentId?: string
) {
  if (!_db) return;
  const now = Date.now();
  const id = `lgm-${groupId}-${userId}`;
  _db.prepare(
    `INSERT OR REPLACE INTO lan_group_members (id, group_id, user_id, numeric_id, display_name, instance_id, role, joined_at, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, groupId, userId, numericId, displayName, instanceId, role, now, agentId ?? null);
  // 更新成员计数
  _db.prepare(`UPDATE lan_groups SET member_count = (SELECT COUNT(*) FROM lan_group_members WHERE group_id = ?) WHERE id = ?`).run(groupId, groupId);
  markDirty();
}

export function getLanGroupMembers(groupId: string) {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM lan_group_members WHERE group_id = ?`).all(groupId);
}

export function removeLanGroupMember(groupId: string, userId: string) {
  if (!_db) return;
  _db.prepare(`DELETE FROM lan_group_members WHERE group_id = ? AND user_id = ?`).run(groupId, userId);
  _db.prepare(`UPDATE lan_groups SET member_count = (SELECT COUNT(*) FROM lan_group_members WHERE group_id = ?) WHERE id = ?`).run(groupId, groupId);
  markDirty();
}

// ===== LAN Remote Identities (局域网远程身份) =====
export function upsertLanRemoteIdentity(data: {
  userId: string;
  instanceId: string;
  numericId: number;
  displayName: string;
  agentId?: string;
}) {
  if (!_db) return;
  const now = Date.now();
  _db.prepare(
    `INSERT INTO lan_remote_identities (user_id, instance_id, numeric_id, display_name, agent_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       instance_id = excluded.instance_id,
       numeric_id = excluded.numeric_id,
       display_name = excluded.display_name,
       agent_id = excluded.agent_id,
       updated_at = excluded.updated_at`
  ).run(data.userId, data.instanceId, data.numericId, data.displayName, data.agentId ?? null, now);
  markDirty();
}

export function getLanRemoteIdentity(userId: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM lan_remote_identities WHERE user_id = ?`).get(userId);
}

export function getLanRemoteIdentityByNumericId(numericId: number) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM lan_remote_identities WHERE numeric_id = ?`).get(numericId);
}

export function listLanRemoteIdentities() {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM lan_remote_identities ORDER BY updated_at DESC`).all();
}

// ===== LAN Group Invites (局域网群邀请) =====
export function saveLanGroupInvite(data: {
  id: string;
  groupId: string;
  groupName: string;
  ownerInstance: string;
  ownerUserId: string;
  invitedUserId: string;
  invitedUserNumericId: number;
  inviterName: string;
  groupDef: any;
}) {
  if (!_db) return;
  const now = Date.now();
  _db.prepare(
    `INSERT INTO lan_group_invites (id, group_id, group_name, owner_instance, owner_user_id, invited_user_id, invited_user_numeric_id, inviter_name, status, group_def, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(
    data.id, data.groupId, data.groupName, data.ownerInstance, data.ownerUserId,
    data.invitedUserId, data.invitedUserNumericId, data.inviterName,
    JSON.stringify(data.groupDef), now, now
  );
  markDirty();
}

export function getLanGroupInvite(inviteId: string) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM lan_group_invites WHERE id = ?`).get(inviteId);
}

export function listLanGroupInvites(invitedUserId: string, status?: string) {
  if (!_db) return [];
  if (status) {
    return _db.prepare(`SELECT * FROM lan_group_invites WHERE invited_user_id = ? AND status = ? ORDER BY created_at DESC`).all(invitedUserId, status);
  }
  return _db.prepare(`SELECT * FROM lan_group_invites WHERE invited_user_id = ? ORDER BY created_at DESC`).all(invitedUserId);
}

export function updateLanGroupInviteStatus(inviteId: string, status: string) {
  if (!_db) return;
  _db.prepare(`UPDATE lan_group_invites SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), inviteId);
  markDirty();
}

export function getLanGroupInviteByGroup(groupId: string, invitedUserId?: string) {
  if (!_db) return undefined;
  if (invitedUserId) {
    return _db.prepare(`SELECT * FROM lan_group_invites WHERE group_id = ? AND invited_user_id = ?`).get(groupId, invitedUserId);
  }
  return _db.prepare(`SELECT * FROM lan_group_invites WHERE group_id = ?`).get(groupId);
}

export function getUserByNumericId(numericId: number) {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM users WHERE numeric_id = ?`).get(numericId);
}

export function userIdVariants(userId: string): string[] {
  if (!_db) return [userId];
  // 首先尝试按原值查找（支持 id 或 numeric_id）
  const user = getUser(userId);
  if (!user) {
    // 尝试按 numeric_id 查找
    const nid = Number(userId);
    if (!Number.isNaN(nid) && String(nid) === String(userId).trim()) {
      const byNumeric = getUserByNumericId(nid);
      if (byNumeric) {
        const variants = [byNumeric.id];
        if (byNumeric.numeric_id) variants.push(String(byNumeric.numeric_id));
        return variants;
      }
    }
    return [userId];
  }
  // 返回用户的实际 id 和 numeric_id（不是原始参数）
  const variants = [user.id];
  if (user.numeric_id) variants.push(String(user.numeric_id));
  return variants;
}

// ===== 导出查询辅助 =====
export function queryAll(sql: string, params: any[] = []): any[][] {
  if (!_db) return [];
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: any[][] = [];
  for (const row of stmt.iterate()) rows.push(row);
  return rows;
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

export function cleanupExpiredTokens() {
  if (!_db) return;
  const now = Date.now();
  _db.prepare(`DELETE FROM user_verifications WHERE expires_at < ?`).run(now);
  _db.prepare(`DELETE FROM verification_codes WHERE expires_at < ?`).run(now);
  _db.prepare(`DELETE FROM user_sessions WHERE expires_at < ?`).run(now);
  markDirty();
}

export function createInviteCode(code: string, createdBy: string, maxUses: number = 1, expiresAt?: number) {
  if (!_db) return;
  _db.prepare(
    `INSERT INTO invite_codes (code, created_by, max_uses, used_count, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)`
  ).run(code, createdBy, maxUses, expiresAt ?? null, Date.now());
  markDirty();
}

export function listInviteCodes() {
  if (!_db) return [];
  return _db.prepare(`SELECT * FROM invite_codes`).all();
}

// ── 认证相关缺失函数（从 sql.js 迁移时保留）──

/** 更新用户密码 */
export function updateUserPassword(userId: string, newPasswordHash: string): void {
  if (!_db) return;
  _db.prepare(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`).run(newPasswordHash, Date.now(), userId);
  markDirty();
}

/** 更新用户状态 */
export function updateUserStatus(userId: string, status: string): void {
  if (!_db) return;
  _db.prepare(`UPDATE users SET status = ?, last_active_at = ? WHERE id = ?`).run(status, Date.now(), userId);
  markDirty();
}

/** 验证用户邮箱 */
export function verifyUserEmail(userId: string): void {
  if (!_db) return;
  _db.prepare(`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`).run(Date.now(), userId);
  markDirty();
}

/** 创建验证 token */
export function createVerificationToken(params: {
  id: string; userId: string; token: string; type: string; expiresAtMs: number;
}): void {
  if (!_db) return;
  _db.prepare(
    `INSERT INTO user_verifications (id, user_id, token, type, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(params.id, params.userId, params.token, params.type, params.expiresAtMs, Date.now());
  markDirty();
}

/** 查找验证 token */
export function getVerificationToken(token: string): any {
  if (!_db) return undefined;
  return _db.prepare(`SELECT * FROM user_verifications WHERE token = ? AND consumed_at IS NULL`).get(token) || null;
}

/** 消费验证 token */
export function consumeVerificationToken(tokenId: string): void {
  if (!_db) return;
  _db.prepare(`UPDATE user_verifications SET consumed_at = ? WHERE id = ?`).run(Date.now(), tokenId);
  markDirty();
}

/** 验证邀请码 */
export function validateInviteCode(code: string): { valid: boolean; reason?: string } {
  if (!_db) return { valid: false, reason: "invite_code_not_found" };
  const row = _db.prepare(`SELECT * FROM invite_codes WHERE code = ?`).get(code);
  if (!row) return { valid: false, reason: "invite_code_not_found" };
  if (row.expires_at && row.expires_at < Date.now()) return { valid: false, reason: "invite_code_expired" };
  if (row.used_count >= row.max_uses) return { valid: false, reason: "invite_code_used_up" };
  return { valid: true };
}

/** 创建会话记录 */
export function createUserSession(params: {
  id: string; userId: string; refreshTokenHash: string; deviceInfo?: string; expiresAtMs: number;
}): void {
  if (!_db) return;
  _db.prepare(
    `INSERT INTO user_sessions (id, user_id, refresh_token_hash, device_info, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(params.id, params.userId, params.refreshTokenHash, params.deviceInfo || null, Date.now(), params.expiresAtMs);
  markDirty();
}

/** 通过 refreshToken 找活跃会话（遍历 + bcrypt 比对） */
export function getActiveSessionByToken(refreshToken: string): any {
  if (!_db) return null;
  // 安全：限制最多检查 1000 条，防 DoS
  const rows = _db.prepare(
    `SELECT * FROM user_sessions WHERE revoked_at IS NULL AND expires_at > ? LIMIT 1000`
  ).all(Date.now());
  // bcrypt.compare 是恒定时间的；遍历常量上限仍是线性，但用户量小的部署可接受
  for (const row of rows) {
    try {
      if (bcrypt.compareSync(refreshToken, row.refresh_token_hash)) {
        return row;
      }
    } catch {
      // hash 损坏的 session 跳过
      continue;
    }
  }
  return null;
}

/** 滚动刷新：替换会话里的 refresh_token_hash */
export function rotateUserSession(sessionId: string, newRefreshTokenHash: string): void {
  if (!_db) return;
  _db.prepare(`UPDATE user_sessions SET refresh_token_hash = ? WHERE id = ?`).run(newRefreshTokenHash, sessionId);
  markDirty();
}

/** 撤销会话 */
export function revokeSession(sessionId: string): void {
  if (!_db) return;
  _db.prepare(`UPDATE user_sessions SET revoked_at = ? WHERE id = ?`).run(Date.now(), sessionId);
  markDirty();
}

/** 撤销用户的所有会话（用于改密/退出登录） */
export function revokeUserSessions(userId: string): void {
  if (!_db) return;
  _db.prepare(`UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(Date.now(), userId);
  markDirty();
}

// 保持兼容的 saveToDisk（better-sqlite3 直接写磁盘，这里做 checkpoint）
export async function saveToDisk() {
  if (!_db) return;
  try {
    _db.pragma('wal_checkpoint(TRUNCATE)');
    _dirty = false;
  } catch (e: any) {
    console.error('[DB] saveToDisk checkpoint error:', e.message);
  }
}