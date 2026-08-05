/**
 * ?- SQLite (sql.js)
 *  DB 
 */
import initSqlJs from "sql.js";
import bcrypt from 'bcryptjs';

let _db: any = null;
let _dbPath: string = "";
let _saveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * ?30 
 */
export function startAutoSave(intervalMs = 30000) {
  if (_saveTimer) clearInterval(_saveTimer);
  _saveTimer = setInterval(() => {
    saveToDisk().catch((e: any) => console.error("[DB] auto-save error:", e.message));
  }, intervalMs);
  // ?
  if (_saveTimer && typeof _saveTimer === 'object' && 'unref' in _saveTimer) (_saveTimer as any).unref();
  console.log(`[DB] auto-save every ${intervalMs / 1000}s`);
}

let _fs: any = null;
async function getFS() {
  if (!_fs) _fs = await import("fs");
  return _fs;
}

/**
 * ?
 */
export async function saveToDisk() {
  if (!_db || !_dbPath) return;
  try {
    const fs = await getFS();
    const data = _db.export();
    fs.writeFileSync(_dbPath, Buffer.from(data));
  } catch (err: any) {
    console.error("[DB] save failed:", err.message);
  }
}

/**
 * ?db 
 */
export async function initDB(dbPath: string) {
  _dbPath = dbPath;
  const SQL = await initSqlJs();
  try {
    const fs = await import("fs");
    const buf = fs.readFileSync(dbPath);
    _db = new SQL.Database(new Uint8Array(buf));
  } catch {
    _db = new SQL.Database();
  }
  if (!_db) _db = new SQL.Database();
  _dbInit(_db);
  console.log(`[DB] initialized: ${dbPath}`);
  return _db;
}

export function getDB() { return _db; }

/**  DB ?*/
export const db = {
  get raw() { return _db; },
  exec: (...args: any[]) => _db.exec(...args),
  run: (...args: any[]) => _db.run(...args),
  prepare: (...args: any[]) => _db.prepare(...args),
};

export async function closeDB(dbPath?: string) {
  // await 
  await saveToDisk();
  if (_saveTimer) { clearInterval(_saveTimer); _saveTimer = null; }
  if (_db) {
    _db.close();
    _db = null;
  }
}

function _dbInit(db: any) {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      email TEXT,
      username TEXT,
      agent_id TEXT,
      created_at INTEGER NOT NULL
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
      status TEXT NOT NULL DEFAULT 'offline',
      created_at INTEGER NOT NULL
    );
    -- v1.7.1: AI 鍛樺伐甯傚満
    CREATE TABLE IF NOT EXISTS agent_market (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      publisher_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '閫氱敤',
      price INTEGER NOT NULL DEFAULT 0,  -- 绉垎/娆?
      tags TEXT NOT NULL DEFAULT '[]',
      rating REAL DEFAULT 0,
      hire_count INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',  -- active|sold|paused
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_orders (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending|completed|disputed
      rating INTEGER,  -- 1-5
      review TEXT,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'private',
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
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_participants_chat ON participants(chat_id);
    CREATE TABLE IF NOT EXISTS chat_memories (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id),
      agent_id TEXT NOT NULL,
      memory_summary TEXT DEFAULT '',
      memory_facts TEXT DEFAULT '{}',
      updated_at INTEGER NOT NULL,
      UNIQUE(chat_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_memories_chat ON chat_memories(chat_id);
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
    CREATE INDEX IF NOT EXISTS idx_friendships_from ON friendships(from_user_id);
    CREATE INDEX IF NOT EXISTS idx_friendships_to ON friendships(to_user_id);
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
      doc_id TEXT NOT NULL REFERENCES rag_documents(id),
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      vector BLOB,
      metadata TEXT DEFAULT '{}',
      FOREIGN KEY (doc_id) REFERENCES rag_documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);
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
    CREATE INDEX IF NOT EXISTS idx_inbox_agent ON inbox(agent_id, created_at DESC);

    -- 鈹€鈹€ V7: 鎸佷箙韬唤浣撶郴 鈹€鈹€
    CREATE TABLE IF NOT EXISTS user_verifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      token TEXT UNIQUE NOT NULL,
      type TEXT NOT NULL,                    -- 'email_verify' | 'password_reset'
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_verif_token ON user_verifications(token);
    CREATE INDEX IF NOT EXISTS idx_user_verif_user ON user_verifications(user_id);

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
    CREATE INDEX IF NOT EXISTS idx_entities_chat ON entities(chat_id, agent_id);

    -- 鐢ㄦ埛绉垎
    CREATE TABLE IF NOT EXISTS user_credits (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      credits INTEGER DEFAULT 1000,
      total_earned INTEGER DEFAULT 0,
      total_spent INTEGER DEFAULT 0,
      updated_at INTEGER
    );

    -- 娑堟伅璇勪环锛堟槦绾э級
    CREATE TABLE IF NOT EXISTS message_ratings (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      rating INTEGER NOT NULL,  -- 1-5 鏄?
      comment TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ratings_msg ON message_ratings(message_id);
    CREATE INDEX IF NOT EXISTS idx_ratings_user ON message_ratings(user_id);

    -- 宸ヤ綔娴佺紪鎺?
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      data TEXT NOT NULL,  -- JSON
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
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);

    -- 鏂规C: LAN 缇ら個璇风‘璁よ〃
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
    CREATE INDEX IF NOT EXISTS idx_lan_group_invites_user ON lan_group_invites(invited_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_lan_group_invites_group ON lan_group_invites(group_id);

    -- 鏂规C: LAN 绀句氦 - 璺ㄥ紩鎿庡彲瑙佺殑缇ょ粍
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
      UNIQUE(group_id, user_id)
    );
        CREATE INDEX IF NOT EXISTS idx_lan_group_members_group ON lan_group_members(group_id);

    -- LAN 杩滅▼韬唤缂撳瓨
    CREATE TABLE IF NOT EXISTS lan_remote_identities (
      user_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      numeric_id INTEGER,
      display_name TEXT,
      agent_id TEXT,
      updated_at INTEGER NOT NULL
    );

    -- 闆囦剑鍏崇郴琛?
    CREATE TABLE IF NOT EXISTS hires (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL,
      buyer_id TEXT NOT NULL,
      seller_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      chat_id TEXT,
      hired_at INTEGER NOT NULL,
      fired_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hires_buyer ON hires(buyer_id, status);
    CREATE INDEX IF NOT EXISTS idx_hires_seller ON hires(seller_id, status);
    -- 鍥㈤槦鍗忎綔 (TeamManager 鎸佷箙鍖?
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
    CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

  `);

  //  V7:  ? users ?
  try {
    const cols = db.exec(`PRAGMA table_info(users)`)[0]?.values?.map((r: any) => r[1]) || [];
    const addIf = (col: string, def: string) => {
      // ? //?/
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(col)) return;
      if (!/^[A-Z][A-Z\s()0-9'\"]*$/i.test(def)) return;
      if (!cols.includes(col)) { db.run(`ALTER TABLE users ADD COLUMN ${col} ${def}`); }
    };
    addIf('numeric_id', 'INTEGER');
    addIf('email_verified', 'INTEGER NOT NULL DEFAULT 0');
    addIf('password_hash', 'TEXT NOT NULL DEFAULT ""');
    addIf('status', 'TEXT NOT NULL DEFAULT "offline"');
    addIf('legacy_user_id', 'TEXT');
    addIf('invite_code', 'TEXT');
    addIf('updated_at', 'INTEGER NOT NULL DEFAULT 0');
    addIf('last_active_at', 'INTEGER');
    addIf('avatar_url', 'TEXT DEFAULT ""');       // 澶村儚URL
    addIf('bio', 'TEXT DEFAULT ""');              // 涓汉浠嬬粛
    // numeric_id uniqueness 鈥?best-effort via index
    try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_numeric_id ON users(numeric_id)`); } catch(_e) {}
    // email uniqueness
    try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`); }
    catch(_e) {}
    // 琛ュ厖澶栭敭绱㈠紩
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_id ON chats(id)`); } catch(_e) {}
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_docs_id ON rag_documents(id)`); } catch(_e) {}
    // set sqlite_sequence seed so next numeric_id starts at 10000
    // (sqlite_sequence may not exist if no AUTOINCREMENT column 鈥?safe to skip)
    try {
      const seqRow = queryOne(`SELECT seq FROM sqlite_sequence WHERE name = ?`, ['users']);
      if (!seqRow || (seqRow[0] as number) < 9999) {
        db.run(`INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('users', 9999)`);
      }
    } catch(_e) { /* sqlite_sequence 琛ㄤ笉瀛樺湪鏃跺拷鐣?鈥?鎴戜滑鐢ㄦ墜鍔?_nextNumericId */ }
  } catch (e: any) {
    console.warn('[DB] V7 migration warning:', e.message);
  }

  // 鈹€鈹€ v1.4.0: 杩佺Щ 鈥?缁?chats 琛ㄨˉ shared_workspace 鍒?鈹€鈹€
  try {
    const chatCols = db.exec(`PRAGMA table_info(chats)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!chatCols.includes('shared_workspace')) {
      db.run(`ALTER TABLE chats ADD COLUMN shared_workspace TEXT`);
      console.log('[DB] v1.4.0 migration: added shared_workspace to chats');
    }
  } catch (e: any) {
    console.warn('[DB] v1.4.0 migration warning:', e.message);
  }

  // 鈹€鈹€ v1.7.2: 杩佺Щ 鈥?缁?chats 琛ㄨˉ chat_mode 鍒楋紙缇よ亰鍗忎綔妯″紡鎸佷箙鍖栵級鈹€鈹€
  try {
    const chatCols2 = db.exec(`PRAGMA table_info(chats)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!chatCols2.includes('chat_mode')) {
      db.run(`ALTER TABLE chats ADD COLUMN chat_mode TEXT NOT NULL DEFAULT 'free'`);
      console.log('[DB] v1.7.2 migration: added chat_mode to chats');
    }
  } catch (e: any) {
    console.warn('[DB] v1.7.2 migration warning:', e.message);
  }
}

// 鈹€鈹€ 杈呭姪锛氬甫鍙傛暟鐨?SELECT 鏌ヨ锛坰ql.js exec 涓嶆敮鎸佸弬鏁扮粦瀹氾級
function queryAll(sql: string, params: any[] = []): any[][] {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: any[][] = [];
  while (stmt.step()) rows.push(stmt.get());
  stmt.free();
  return rows;
}

function queryOne(sql: string, params: any[] = []): any | null {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const result = stmt.step() ? stmt.get() : null;
  stmt.free();
  return result;
}

function queryObjects(sql: string, params: any[] = []): any[] {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// 鈹€鈹€ Users 鈹€鈹€
export function createUser(id: string, displayName: string, email?: string, username?: string) {
  const now = Date.now();
  _db.run("INSERT INTO users (id, display_name, email, username, created_at) VALUES (?, ?, ?, ?, ?)", [id, displayName, email ?? null, username ?? null, now]);
  // 涓嶅啀鑷姩寤?dummy agent锛岀敱 AgentManager.register 缁熶竴绠＄悊
  return { id, displayName, email, username, createdAt: now };
}

export function getUser(id: string) {
  const stmt = _db.prepare("SELECT * FROM users WHERE id = ?");
  stmt.bind([id]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return undefined;
}

export function getUserByEmail(email: string) {
  const stmt = _db.prepare("SELECT * FROM users WHERE email = ?");
  stmt.bind([email]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return undefined;
}

export function listUsers() {
  return queryObjects("SELECT * FROM users");
}

// 鈹€鈹€ Agents 鈹€鈹€
export function createAgent(id: string, userId: string, displayName: string, personality: string, autonomy: string, model?: string) {
  const now = Date.now();
  _db.run(
    "INSERT INTO agents (id, user_id, display_name, model, personality, autonomy, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, userId, displayName, model || '', personality, autonomy, now]
  );
  return getAgent(id);
}

export function getAgent(id: string) {
  const stmt = _db.prepare("SELECT * FROM agents WHERE id = ?");
  stmt.bind([id]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return undefined;
}

export function listAgents() {
  return queryObjects("SELECT * FROM agents");
}

// Bug #14 淇锛歋QL 鍙傛暟鐢ㄦ暟缁勪紶閫掞紝涓嶅啀鐢?spread
export function updateAgent(agentId: string, updates: Record<string, any>) {
  const allowed = ['personality', 'memory_summary', 'memory_facts', 'status', 'model', 'display_name'];
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
  const db = getDB();
  db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, vals);
}

export function updateAgentMemory(agentId: string, summary: string, facts: Record<string, string>) {
  _db.run("UPDATE agents SET memory_summary = ?, memory_facts = ? WHERE id = ?", [summary, JSON.stringify(facts), agentId]);
}

// v1.4.0: 缇よ亰鐙珛璁板繂
export function upsertChatMemory(chatId: string, agentId: string, summary: string, facts: Record<string, string>) {
  const id = `${chatId}:${agentId}`;
  const now = Date.now();
  _db.run(
    `INSERT INTO chat_memories (id, chat_id, agent_id, memory_summary, memory_facts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET memory_summary = ?, memory_facts = ?, updated_at = ?`,
    [id, chatId, agentId, summary, JSON.stringify(facts), now, summary, JSON.stringify(facts), now]
  );
}

export function getChatMemory(chatId: string, agentId: string) {
  const stmt = _db.prepare("SELECT * FROM chat_memories WHERE chat_id = ? AND agent_id = ?");
  stmt.bind([chatId, agentId]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return undefined;
}

export function getChatMemories(chatId: string) {
  return queryObjects("SELECT * FROM chat_memories WHERE chat_id = ?", [chatId]);
}


export function appendMemorySummary(agentId: string, newContent: string) {
  const agent = getAgent(agentId);
  if (!agent) return;
  const existing = agent.memory_summary || '';
  const updated = existing ? existing + '\n' + newContent : newContent;
  // Keep last 2000 chars to avoid unbounded growth
  const trimmed = updated.length > 2000 ? updated.slice(-2000) : updated;
  _db.run("UPDATE agents SET memory_summary = ? WHERE id = ?", [trimmed, agentId]);
}

// 鈹€鈹€ Chats 鈹€鈹€
export function createChat(id: string, type: "private" | "group" = "private", sharedWorkspace?: string) {
  const now = Date.now();
  _db.run("INSERT INTO chats (id, type, shared_workspace, created_at) VALUES (?, ?, ?, ?)", [id, type, sharedWorkspace ?? null, now]);
  return { id, type, sharedWorkspace, createdAt: now };
}

export function addParticipant(id: string, chatId: string, userId?: string, agentId?: string, role: string = "member") {
  _db.run(
    "INSERT INTO participants (id, chat_id, user_id, agent_id, role, joined_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, chatId, userId ?? null, agentId ?? null, role, Date.now()]
  );
}

export function getChatParticipants(chatId: string) {
  return queryObjects("SELECT * FROM participants WHERE chat_id = ?", [chatId]);
}

export function listChats() {
  return queryObjects("SELECT * FROM chats ORDER BY created_at DESC");
}

export function getChatById(id: string) {
  const stmt = _db.prepare("SELECT * FROM chats WHERE id = ?");
  stmt.bind([id]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return undefined;
}

export function updateChatWorkspace(id: string, sharedWorkspace: string | null) {
  _db.run("UPDATE chats SET shared_workspace = ? WHERE id = ?", [sharedWorkspace, id]);
}

// 鈹€鈹€ 缇よ亰鍗忎綔妯″紡锛坴1.7.2锛夆攢鈹€
export const CHAT_MODES = ['free', 'route', 'debate', 'chain', 'roundtable', 'vote'] as const;
export type ChatModeType = typeof CHAT_MODES[number];

export function getChatMode(chatId: string): ChatModeType {
  try {
    const row = queryOne("SELECT chat_mode FROM chats WHERE id = ?", [chatId]);
    const mode = row?.[0] as ChatModeType;
    return CHAT_MODES.includes(mode) ? mode : 'free';
  } catch {
    return 'free';
  }
}

export function setChatMode(chatId: string, mode: string): boolean {
  if (!CHAT_MODES.includes(mode as ChatModeType)) return false;
  try {
    _db.run("UPDATE chats SET chat_mode = ? WHERE id = ?", [mode, chatId]);
    return true;
  } catch {
    return false;
  }
}


export function removeParticipant(chatId: string, userId: string, agentId?: string) {
  if (agentId) {
    _db.run("DELETE FROM participants WHERE chat_id = ? AND user_id = ? AND agent_id = ?", [chatId, userId, agentId]);
  } else {
    _db.run("DELETE FROM participants WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
  }
}

// 鈹€鈹€ Messages 鈹€鈹€
export function addMessage(msg: DBMessage) {
  _db.run(
    "INSERT INTO messages (id, chat_id, sender_type, sender_id, content, type, reply_to, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      msg.id, msg.chatId, msg.senderType, msg.senderId,
      msg.content, msg.type, msg.replyTo ?? null,
      JSON.stringify(msg.metadata ?? {}), msg.timestamp
    ]
  );
  _db.run("UPDATE chats SET last_message_at = ? WHERE id = ?", [msg.timestamp, msg.chatId]);
}

export function listMessages(chatId: string, limit = 100) {
  return queryObjects("SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?", [chatId, limit]).reverse();
}

// 鈹€鈹€ 楠岃瘉鐮?鈹€鈹€
export function saveVerificationCode(email: string, code: string, username?: string, expiresAtMs?: number) {
  const now = Date.now();
  const exp = expiresAtMs ?? now + 5 * 60 * 1000;
  _db.run(
    "INSERT OR REPLACE INTO verification_codes (email, code, username, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    [email, code, username ?? null, exp, now]
  );
}

export function getVerificationCode(email: string) {
  const stmt = _db.prepare("SELECT * FROM verification_codes WHERE email = ?");
  stmt.bind([email]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return undefined;
}

export function deleteVerificationCode(email: string) {
  _db.run("DELETE FROM verification_codes WHERE email = ?", [email]);
}

// 鈹€鈹€ Friendships 鈹€鈹€
export function messageExists(msgId: string): boolean {
  const row = queryOne("SELECT 1 FROM messages WHERE id = ?", [msgId]);
  return !!row;
}
export function sendFriendRequest(fromUserId: string, toUserId: string, message: string = '') {
  const now = Date.now();
  const id = 'friend-' + now + '-' + Math.random().toString(36).slice(2, 6);
  // Check if already exists (鍙屽悜妫€鏌ワ紝闃叉鍙嶅悜閲嶅)
  let existingRow = queryOne("SELECT id, status FROM friendships WHERE from_user_id = ? AND to_user_id = ?", [fromUserId, toUserId]);
  if (!existingRow) {
    existingRow = queryOne("SELECT id, status FROM friendships WHERE from_user_id = ? AND to_user_id = ?", [toUserId, fromUserId]);
  }
  if (existingRow) {
    // columns: id(0), ... status is at index based on column order
    // friendships columns: id, from_user_id, to_user_id, status, message, created_at, updated_at
    const existingId = existingRow[0];
    const status = existingRow[1];
    if (status === 'pending') return { error: '濂藉弸鐢宠宸插彂閫侊紝绛夊緟瀵规柟澶勭悊' };
    if (status === 'accepted') return { error: '浣犱滑宸茬粡鏄ソ鍙嬩簡' };
    // If denied, allow re-send
    _db.run("UPDATE friendships SET status='pending', message=?, created_at=?, updated_at=? WHERE id=?", [message, now, now, existingId]);
    return { ok: true, id: existingId, status: 'pending' };
  }
  _db.run("INSERT INTO friendships (id, from_user_id, to_user_id, status, message, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)", [id, fromUserId, toUserId, message, now, now]);
  return { ok: true, id, status: 'pending' };
}
export function respondFriendRequest(requestId: string, action: 'accept' | 'reject') {
  const stmt = _db.prepare("SELECT * FROM friendships WHERE id = ?");
  stmt.bind([requestId]);
  if (!stmt.step()) { stmt.free(); return { error: "friend_request_not_found" }; }
  const row = stmt.getAsObject(); stmt.free();
  if (row.status !== "pending") return { error: "request_already_processed" };
  const status = action === 'accept' ? 'accepted' : 'denied';
  _db.run("UPDATE friendships SET status=?, updated_at=? WHERE id=?", [status, Date.now(), requestId]);
  // If accepted, create a private chat between them
  if (action === 'accept') {
    const chatId = 'chat-' + row.from_user_id + '-' + row.to_user_id;
    const existingChat = queryOne("SELECT id FROM chats WHERE id = ?", [chatId]);
    if (!existingChat) {
      createChat(chatId, 'private');
      addParticipant('p-' + chatId + '-1', chatId, row.from_user_id, undefined, 'member');
      addParticipant('p-' + chatId + '-2', chatId, row.to_user_id, undefined, 'member');
      // Also add their agents
      const agent1 = getAgentByUserId(row.from_user_id);
      const agent2 = getAgentByUserId(row.to_user_id);
      if (agent1) addParticipant('p-' + chatId + '-a1', chatId, undefined, agent1.id, 'agent');
      if (agent2) addParticipant('p-' + chatId + '-a2', chatId, undefined, agent2.id, 'agent');
    }
  }
  return { ok: true, status };
}
export function getFriendRequests(userId: string) {
  const incoming = queryObjects("SELECT f.id, f.from_user_id, f.to_user_id, f.status, f.message, f.created_at, f.updated_at, u.display_name as from_name FROM friendships f LEFT JOIN users u ON f.from_user_id = u.id WHERE f.to_user_id = ? ORDER BY f.created_at DESC", [userId]);
  const outgoing = queryObjects("SELECT f.id, f.from_user_id, f.to_user_id, f.status, f.message, f.created_at, f.updated_at, u.display_name as to_name FROM friendships f LEFT JOIN users u ON f.to_user_id = u.id WHERE f.from_user_id = ? ORDER BY f.created_at DESC", [userId]);
  return {
    incoming: incoming.map((r: any) => ({ id: r.id, fromUserId: r.from_user_id, toUserId: r.to_user_id, status: r.status, message: r.message, createdAt: r.created_at, fromName: r.from_name })),
    outgoing: outgoing.map((r: any) => ({ id: r.id, fromUserId: r.from_user_id, toUserId: r.to_user_id, status: r.status, message: r.message, createdAt: r.created_at, toName: r.to_name })),
  };
}
export function listFriends(userId: string) {
  const rows = queryObjects(
    `SELECT f.id, f.from_user_id, f.to_user_id, f.status, f.message, f.created_at, f.updated_at, u.display_name as friend_name, u.agent_id as friend_agent_id
     FROM friendships f
     LEFT JOIN users u ON (CASE WHEN f.from_user_id = ? THEN f.to_user_id ELSE f.from_user_id END) = u.id
     WHERE (f.from_user_id = ? OR f.to_user_id = ?) AND f.status = 'accepted'
     ORDER BY f.updated_at DESC`,
    [userId, userId, userId]
  );
  return rows.map((row: any) => ({
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    status: row.status,
    friendId: row.from_user_id === userId ? row.to_user_id : row.from_user_id,
    friendName: row.friend_name,
    friendAgentId: row.friend_agent_id,
    createdAt: row.created_at,
  }));
}
export function getFriendshipById(id: string) {
  return queryObjects("SELECT * FROM friendships WHERE id = ?", [id])[0] || null;
}
export function getFriendshipByPair(fromUserId: string, toUserId: string) {
  return queryObjects("SELECT * FROM friendships WHERE from_user_id = ? AND to_user_id = ?", [fromUserId, toUserId])[0] || null;
}

export function deleteFriendship(friendshipId: string): void {
  const row = queryObjects("SELECT * FROM friendships WHERE id = ?", [friendshipId])[0];
  if (row) {
    // Remove associated private chat participants
    const chatId = "chat-" + row.from_user_id + "-" + row.to_user_id;
    _db.run("DELETE FROM participants WHERE chat_id = ?", [chatId]);
    _db.run("DELETE FROM friendships WHERE id = ?", [friendshipId]);
  }
}

export function deleteFriendshipByPair(fromUserId: string, toUserId: string): void {
  _db.run("DELETE FROM participants WHERE chat_id = ?", ["chat-" + fromUserId + "-" + toUserId]);
  _db.run("DELETE FROM friendships WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)", [fromUserId, toUserId, toUserId, fromUserId]);
}
// 鈹€鈹€ LAN Remote Identities 鈹€鈹€
export function upsertLanRemoteIdentity(params: {
  userId: string;
  instanceId: string;
  numericId?: number;
  displayName?: string;
  agentId?: string;
}): void {
  const now = Date.now();
  _db.run(
    `INSERT OR REPLACE INTO lan_remote_identities
     (user_id, instance_id, numeric_id, display_name, agent_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [params.userId, params.instanceId, params.numericId ?? null,
     params.displayName ?? null, params.agentId ?? null, now]
  );
}

export function getLanRemoteIdentity(userId: string): any {
  return queryObjects("SELECT * FROM lan_remote_identities WHERE user_id = ?", [userId])[0] || null;
}

export function listLanRemoteIdentities(): any[] {
  return queryObjects("SELECT * FROM lan_remote_identities ORDER BY updated_at DESC");
}

export function getAgentByUserId(userId: string) {
  const stmt = _db.prepare("SELECT * FROM agents WHERE user_id = ?");
  stmt.bind([userId]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return null;
}

// 鈹€鈹€ Types 鈹€鈹€
export interface DBMessage {
  id: string;
  chatId: string;
  senderType: "user" | "agent";
  senderId: string;
  content: string;
  type: string;
  replyTo?: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

/**
 * DB 绫?- 鍏煎鏃х増 `new DB(...)` 椋庢牸鐨勫叆鍙ｏ紝浣嗗唴閮ㄧ敤鍏ㄥ眬 _db
 * 杩欐牱 AgentManager 杩欑 `this.db.listAgents()` 鐨勫啓娉曞彲浠ョ洿鎺ュ伐浣溿€?
 */

// 鈹€鈹€ 绉垎 CRUD 鈹€鈹€

export function ensureUserCredits(userId: string): void {
  const existing = queryOne("SELECT user_id FROM user_credits WHERE user_id = ?", [userId]);
  if (!existing) {
    _db.run(
      "INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, 1000, 0, 0, ?)",
      [userId, Date.now()]
    );
  }
}

export function getUserCredits(userId: string): { credits: number; totalEarned: number; totalSpent: number } {
  ensureUserCredits(userId);
  const row = queryOne("SELECT credits, total_earned, total_spent FROM user_credits WHERE user_id = ?", [userId]);
  return {
    credits: row ? Number(row[0]) : 1000,
    totalEarned: row ? Number(row[1]) : 0,
    totalSpent: row ? Number(row[2]) : 0,
  };
}

export function addCredits(userId: string, amount: number, note?: string): number {
  ensureUserCredits(userId);
  _db.run(
    "UPDATE user_credits SET credits = credits + ?, total_earned = total_earned + ?, updated_at = ? WHERE user_id = ?",
    [amount, amount, Date.now(), userId]
  );
  const row = queryOne("SELECT credits FROM user_credits WHERE user_id = ?", [userId]);
  return row ? Number(row[0]) : 0;
}

export function spendCredits(userId: string, amount: number, note?: string): { ok: boolean; balance: number; error?: string } {
  ensureUserCredits(userId);
  const row = queryOne("SELECT credits FROM user_credits WHERE user_id = ?", [userId]);
  const balance = row ? Number(row[0]) : 1000;
  if (balance < amount) {
    return { ok: false, balance, error: '绉垎涓嶈冻锛岄渶瑕?' + amount + '锛屽綋鍓?' + balance };
  }
  _db.run(
    "UPDATE user_credits SET credits = credits - ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ?",
    [amount, amount, Date.now(), userId]
  );
  const newRow = queryOne("SELECT credits FROM user_credits WHERE user_id = ?", [userId]);
  return { ok: true, balance: newRow ? Number(newRow[0]) : 0 };
}

// 鈹€鈹€ 闆囦剑 CRUD 鈹€鈹€

export function createHire(params: {
  id: string; listingId: string; buyerId: string; sellerId: string;
  agentId: string; title: string; price: number; chatId?: string;
}): void {
  const now = Date.now();
  _db.run(
    "INSERT INTO hires (id, listing_id, buyer_id, seller_id, agent_id, title, price, status, chat_id, hired_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
    [params.id, params.listingId, params.buyerId, params.sellerId,
     params.agentId, params.title, params.price, params.chatId || null, now]
  );
}

export function getHire(id: string): any {
  return queryObjects("SELECT * FROM hires WHERE id = ?", [id])[0] || null;
}

export function listHiresByBuyer(userId: string, status?: string): any[] {
  if (status) {
    return queryObjects("SELECT * FROM hires WHERE buyer_id = ? AND status = ? ORDER BY hired_at DESC", [userId, status]);
  }
  return queryObjects("SELECT * FROM hires WHERE buyer_id = ? ORDER BY hired_at DESC", [userId]);
}

export function listHiresBySeller(userId: string, status?: string): any[] {
  if (status) {
    return queryObjects("SELECT * FROM hires WHERE seller_id = ? AND status = ? ORDER BY hired_at DESC", [userId, status]);
  }
  return queryObjects("SELECT * FROM hires WHERE seller_id = ? ORDER BY hired_at DESC", [userId]);
}

export function fireHire(hireId: string): void {
  _db.run("UPDATE hires SET status = 'fired', fired_at = ? WHERE id = ?", [Date.now(), hireId]);
}

export class DB {
  public raw: any;
  constructor(_dummy?: any) { this.raw = _db; }
  createUser(id: string, displayName: string, email?: string, username?: string) {
    return createUser(id, displayName, email, username);
  }
  getUser(id: string) { return getUser(id); }
  getUserByEmail(email: string) { return getUserByEmail(email); }
  listUsers() { return listUsers(); }
  createAgent(id: string, userId: string, displayName: string, personality: string, autonomy: string, model?: string) {
    return createAgent(id, userId, displayName, personality, autonomy, model);
  }
  getAgent(id: string) { return getAgent(id); }
  listAgents() { return listAgents(); }
  updateAgent(agentId: string, updates: Record<string, any>) {
    return updateAgent(agentId, updates);
  }
  updateAgentMemory(agentId: string, summary: string, facts: Record<string, string>) {
    return updateAgentMemory(agentId, summary, facts);
  }
  appendMemorySummary(agentId: string, newContent: string) {
    return appendMemorySummary(agentId, newContent);
  }
  createChat(id: string, type: "private" | "group" = "private") { return createChat(id, type); }
  addParticipant(id: string, chatId: string, userId?: string, agentId?: string, role: string = "member") {
    return addParticipant(id, chatId, userId, agentId, role);
  }
  getChatParticipants(chatId: string) { return getChatParticipants(chatId); }
  /** listParticipants 鍒悕 (鍏煎鏃т唬鐮? */
  listParticipants(chatId: string) { return getChatParticipants(chatId); }
  listChats() { return listChats(); }
  getChatMode(chatId: string) { return getChatMode(chatId); }
  setChatMode(chatId: string, mode: string) { return setChatMode(chatId, mode); }
  removeParticipant(chatId: string, userId: string, agentId?: string) {
    return removeParticipant(chatId, userId, agentId);
  }
  addMessage(msg: DBMessage) { return addMessage(msg); }
  listMessages(chatId: string, limit = 100) { return listMessages(chatId, limit); }
  saveVerificationCode(email: string, code: string, username?: string, expiresAtMs?: number) {
    return saveVerificationCode(email, code, username, expiresAtMs);
  }
  /** RAG 鎸佷箙鍖?*/
  listRagDocuments() { return listRagDocuments(); }
  listRagChunks() { return listRagChunks(); }
  insertRagDocument(doc: any) { return insertRagDocument(doc); }
  insertRagChunk(chunk: any) { return insertRagChunk(chunk); }
  deleteRagDocument(docId: string) { return deleteRagDocument(docId); }
  /** 鏀朵欢绠?*/
  addInboxItem(item: any) { return addInboxItem(item); }
  listInbox(agentId?: string) { return listInbox(agentId); }
  markInboxRead(id: string) { return markInboxRead(id); }
  deleteInboxItem(id: string) { return deleteInboxItem(id); }
  getVerificationCode(email: string) { return getVerificationCode(email); }
  deleteVerificationCode(email: string) { return deleteVerificationCode(email); }
  sendFriendRequest(fromUserId: string, toUserId: string, message?: string) { return sendFriendRequest(fromUserId, toUserId, message); }
  respondFriendRequest(requestId: string, action: 'accept' | 'reject') { return respondFriendRequest(requestId, action); }
  getFriendRequests(userId: string) { return getFriendRequests(userId); }
  listFriends(userId: string) { return listFriends(userId); }
  /** 璁?manager.update 杩欑 `db.db.prepare(...)` 椋庢牸涔熻兘宸ヤ綔 */
  getAgentByUserId(userId: string) { return getAgentByUserId(userId); }
  markChatRead(userId: string, chatId: string) { return markChatRead(userId, chatId); }
  getUnreadCount(userId: string) { return getUnreadCount(userId); }
  getChatUnreadCounts(userId: string) { return getChatUnreadCounts(userId); }
  get db() { return _db; }

  // 鈹€鈹€ Entity 鎸佷箙鍖?鈹€鈹€
  getEntities(chatId: string, agentId: string): any[] {
    return queryObjects('SELECT * FROM entities WHERE chat_id = ? AND agent_id = ? ORDER BY count DESC LIMIT 50', [chatId, agentId]);
  }
  upsertEntity(chatId: string, agentId: string, type: string, value: string, context: string, confidence: number): void {
    const now = Date.now();
    const existing = queryOne('SELECT id, count FROM entities WHERE chat_id=? AND agent_id=? AND type=? AND value=?', [chatId, agentId, type, value]);
    if (existing) {
      _db.run('UPDATE entities SET count=?, last_seen=?, context=? WHERE id=?', [existing.count + 1, now, context, existing.id]);
    } else {
      _db.run('INSERT INTO entities (id, chat_id, agent_id, type, value, context, confidence, first_seen, last_seen, count) VALUES (?,?,?,?,?,?,?,?,?,1)',
        ['ent-' + now + '-' + Math.random().toString(36).slice(2, 8), chatId, agentId, type, value, context, confidence, now, now]);
    }
  }
  clearEntities(chatId: string, agentId: string): void {
    _db.run('DELETE FROM entities WHERE chat_id=? AND agent_id=?', [chatId, agentId]);
  }

  // 鈹€鈹€ 鏂规C: LAN 缇ら個璇?鈹€鈹€
  saveLanGroupInvite(params: Parameters<typeof saveLanGroupInvite>[0]) { return saveLanGroupInvite(params); }
  listLanGroupInvites(userId: string, status?: string) { return listLanGroupInvites(userId, status); }
  updateLanGroupInviteStatus(id: string, status: string) { return updateLanGroupInviteStatus(id, status); }
  getLanGroupInviteByGroup(userId: string, groupId: string) { return getLanGroupInviteByGroup(userId, groupId); }
  getLanGroupInvite(id: string) { return getLanGroupInvite(id); }

  // 鈹€鈹€ 鏂规C: LAN 缇ょ粍 鈹€鈹€
  createLanGroup(id: string, name: string, ownerInstance: string, ownerUserId: string, chatMode?: string) { return createLanGroup(id, name, ownerInstance, ownerUserId, chatMode); }
  getLanGroup(id: string) { return getLanGroup(id); }
  listLanGroups() { return listLanGroups(); }
  deleteLanGroup(id: string) { return deleteLanGroup(id); }
  addLanGroupMember(params: Parameters<typeof addLanGroupMember>[0]) { return addLanGroupMember(params); }
  getLanGroupMembers(groupId: string) { return getLanGroupMembers(groupId); }
  // 鈹€鈹€ 绉垎 鈹€鈹€
  getUserCredits(userId: string) { return getUserCredits(userId); }
  addCredits(userId: string, amount: number, note?: string) { return addCredits(userId, amount, note); }
  spendCredits(userId: string, amount: number) { return spendCredits(userId, amount); }
  // 鈹€鈹€ 闆囦剑 鈹€鈹€
  createHire(params: Parameters<typeof createHire>[0]) { return createHire(params); }
  getHire(id: string) { return getHire(id); }
  listHiresByBuyer(userId: string, status?: string) { return listHiresByBuyer(userId, status); }
  listHiresBySeller(userId: string, status?: string) { return listHiresBySeller(userId, status); }
  fireHire(hireId: string) { return fireHire(hireId); }

}


// 鈹€鈹€鈹€ RAG 鐭ヨ瘑搴撴寔涔呭寲 鈹€鈹€鈹€

export function insertRagDocument(doc: {
  id: string; title: string; source: string; mimeType: string; content: string;
  metadata?: Record<string, any>; createdAt?: number;
}): void {
  const now = doc.createdAt || Date.now();
  _db.run(
    "INSERT OR REPLACE INTO rag_documents (id, title, source, mime_type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [doc.id, doc.title, doc.source, doc.mimeType || 'text/plain', doc.content, JSON.stringify(doc.metadata || {}), now]
  );
}

export function listRagDocuments(): any[] {
  return queryObjects("SELECT * FROM rag_documents ORDER BY created_at DESC");
}

export function listRagChunks(): any[] {
  return queryObjects("SELECT id, doc_id as docId, chunk_index as idx, content, metadata FROM rag_chunks");
}

export function insertRagChunk(chunk: {
  id: string; docId: string; index: number; content: string;
  vector?: number[]; metadata?: Record<string, any>;
}): void {
  let vectorBuffer: any = null;
  if (chunk.vector && Array.isArray(chunk.vector)) {
    const f32 = new Float32Array(chunk.vector);
    vectorBuffer = Buffer.from(f32.buffer);
  }
  _db.run(
    "INSERT OR REPLACE INTO rag_chunks (id, doc_id, chunk_index, content, vector, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    [chunk.id, chunk.docId, chunk.index, chunk.content, vectorBuffer, JSON.stringify(chunk.metadata || {})]
  );
}

export function deleteRagDocument(docId: string): void {
  _db.run("DELETE FROM rag_chunks WHERE doc_id = ?", [docId]);
  _db.run("DELETE FROM rag_documents WHERE id = ?", [docId]);
}

// 鈹€鈹€鈹€ 鏀朵欢绠?鈹€鈹€鈹€

export function addInboxItem(item: {
  id: string;
  agentId: string;
  type: string;
  title: string;
  content: string;
  filePath: string;
  read: boolean;
  createdAt: number;
}): void {
  _db.run(
    "INSERT INTO inbox (id, agent_id, type, title, content, file_path, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [item.id, item.agentId, item.type, item.title, item.content, item.filePath, item.read ? 1 : 0, item.createdAt]
  );
}

export function listInbox(agentId?: string): any[] {
  if (agentId) {
    return queryObjects("SELECT * FROM inbox WHERE agent_id = ? ORDER BY created_at DESC", [agentId]);
  }
  return queryObjects("SELECT * FROM inbox ORDER BY created_at DESC");
}

export function markInboxRead(id: string): void {
  _db.run("UPDATE inbox SET read = 1 WHERE id = ?", [id]);
}

export function deleteInboxItem(id: string): void {
  _db.run("DELETE FROM inbox WHERE id = ?", [id]);
}


// 鈹€鈹€ 鑱婂ぉ宸茶鐘舵€?鈹€鈹€

/** 鏍囪鐢ㄦ埛宸茶鏌愯亰澶?*/
export function markChatRead(userId: string, chatId: string): void {
  _db.run(
    "INSERT OR REPLACE INTO chat_read_state (user_id, chat_id, last_read_at) VALUES (?, ?, ?)",
    [userId, chatId, Date.now()]
  );
}

/** 鑾峰彇鐢ㄦ埛鐨勬湭璇绘秷鎭暟 */
export function getUnreadCount(userId: string): number {
  // 缁熻鐢ㄦ埛鍙備笌鐨勬墍鏈夎亰澶╃殑鏈娑堟伅鎬绘暟
  const row = queryOne(`
    SELECT COUNT(*) as cnt FROM messages m
    INNER JOIN participants p ON p.chat_id = m.chat_id
    WHERE (p.user_id = ? OR p.agent_id = ?)
    AND m.timestamp > COALESCE(
      (SELECT crs.last_read_at FROM chat_read_state crs WHERE crs.user_id = ? AND crs.chat_id = m.chat_id),
      0
    )
  `, [userId, userId, userId]);
  return row ? Number(row[0]) : 0;
}

/** 鑾峰彇姣忎釜鑱婂ぉ鐨勬湭璇绘暟 */
export function getChatUnreadCounts(userId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const rows = queryAll(`
    SELECT m.chat_id, COUNT(*) as cnt FROM messages m
    INNER JOIN participants p ON p.chat_id = m.chat_id
    WHERE (p.user_id = ? OR p.agent_id = ?)
    AND m.timestamp > COALESCE(
      (SELECT crs.last_read_at FROM chat_read_state crs WHERE crs.user_id = ? AND crs.chat_id = m.chat_id),
      0
    )
    GROUP BY m.chat_id
  `, [userId, userId, userId]);
  for (const row of rows) {
    counts[row[0]] = Number(row[1]);
  }
  return counts;
}


// 鈹€鈹€ V7: 鎸佷箙韬唤 CRUD 鈹€鈹€

let _nextNumericId = 10000;

/** 鍏嗗垵濮嬪寲锛氫粠 DB 璇诲綋鍓嶆渶澶?numeric_id锛屼繚璇佽嚜澧?*/
export function initNumericIdSeq(): void {
  const row = queryOne(`SELECT MAX(numeric_id) FROM users WHERE numeric_id IS NOT NULL`);
  if (row && row[0]) _nextNumericId = Math.max(10000, (row[0] as number) + 1);
  else _nextNumericId = 10000;
}

/** 鍒嗛厤涓嬩竴涓?numeric_id锛?0000 璧疯嚜澧烇級*/
export function nextNumericId(): number {
  return _nextNumericId++;
}

/** (encoding fix) */
export function createFullUser(params: {
  id: string; numericId: number; email: string; passwordHash: string;
  displayName: string; inviteCode?: string; legacyUserId?: string;
}): any {
  const now = Date.now();
  _db.run(
    `INSERT INTO users (id, numeric_id, email, email_verified, password_hash, display_name, status, legacy_user_id, invite_code, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, 'offline', ?, ?, ?, ?)`,
    [params.id, params.numericId, params.email, params.passwordHash, params.displayName, params.legacyUserId || null, params.inviteCode || null, now, now]
  );
  // 娑堣垂閭€璇风爜
  if (params.inviteCode) {
    _db.run(`UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?`, [params.inviteCode]);
  }
  return getUser(params.id);
}

/** 鏇存柊鐢ㄦ埛閭楠岃瘉鐘舵€?*/
export function verifyUserEmail(userId: string): void {
  _db.run(`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`, [Date.now(), userId]);
}

/** 鏇存柊鐢ㄦ埛瀵嗙爜 */
export function updateUserPassword(userId: string, newPasswordHash: string): void {
  _db.run(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [newPasswordHash, Date.now(), userId]);
}

/** 鏇存柊鐢ㄦ埛鐘舵€?*/
export function updateUserStatus(userId: string, status: string): void {
  _db.run(`UPDATE users SET status = ?, last_active_at = ? WHERE id = ?`, [status, Date.now(), userId]);
}

/** 閫氳繃鏁板瓧 ID 鎵剧敤鎴?*/
export function getUserByNumericId(numericId: number): any {
  return queryObjects(`SELECT * FROM users WHERE numeric_id = ?`, [numericId])[0] || null;
}

/** (encoding fix) */
export function createVerificationToken(params: {
  id: string; userId: string; token: string; type: string; expiresAtMs: number;
}): void {
  _db.run(
    `INSERT INTO user_verifications (id, user_id, token, type, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [params.id, params.userId, params.token, params.type, params.expiresAtMs, Date.now()]
  );
}

/** 鏌ユ壘楠岃瘉 token */
export function getVerificationToken(token: string): any {
  return queryObjects(`SELECT * FROM user_verifications WHERE token = ? AND consumed_at IS NULL`, [token])[0] || null;
}

/** 娑堣垂楠岃瘉 token */
export function consumeVerificationToken(tokenId: string): void {
  _db.run(`UPDATE user_verifications SET consumed_at = ? WHERE id = ?`, [Date.now(), tokenId]);
}

/** 娓呯悊杩囨湡 token */
export function cleanupExpiredTokens(): void {
  _db.run(`DELETE FROM user_verifications WHERE expires_at < ?`, [Date.now()]);
}

/** 楠岃瘉閭€璇风爜 */
export function validateInviteCode(code: string): { valid: boolean; reason?: string } {
  const row = queryObjects(`SELECT * FROM invite_codes WHERE code = ?`, [code])[0];
  if (!row) return { valid: false, reason: "invite_code_not_found" };
  if (row.expires_at && row.expires_at < Date.now()) return { valid: false, reason: "invite_code_expired" };
  if (row.used_count >= row.max_uses) return { valid: false, reason: "invite_code_used_up" };
  return { valid: true };
}

/** 鑺濆彇閭€璇风爜鍒楄〃 */
export function listInviteCodes(): any[] {
  return queryObjects(`SELECT * FROM invite_codes ORDER BY created_at DESC`);
}

/** (encoding fix) */
export function createInviteCode(code: string, createdBy: string, maxUses: number, expiresAt?: number): void {
  _db.run(`INSERT INTO invite_codes (code, created_by, max_uses, used_count, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)`,
    [code, createdBy, maxUses, expiresAt || null, Date.now()]);
}

/** 鍒涘缓浼氳瘽璁板綍 */
export function createUserSession(params: {
  id: string; userId: string; refreshTokenHash: string; deviceInfo?: string; expiresAtMs: number;
}): void {
  _db.run(
    `INSERT INTO user_sessions (id, user_id, refresh_token_hash, device_info, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [params.id, params.userId, params.refreshTokenHash, params.deviceInfo || null, Date.now(), params.expiresAtMs]
  );
}

/** 閫氳繃 refreshToken 鎵炬椿璺冧細璇濓紙閬嶅巻 + bcrypt 姣斿锛*/
export function getActiveSessionByToken(refreshToken: string): any {
  // 瀹夊叏锛氶檺鍒舵渶澶氭鏌?1000 鏉★紝闃?DoS
  const rows = queryObjects(
    `SELECT * FROM user_sessions WHERE revoked_at IS NULL AND expires_at > ? LIMIT 1000`,
    [Date.now()]
  );
  // bcrypt.compare 鏄亽瀹氭椂闂寸殑锛涢亶鍘嗗父閲忎笂闄愪粛鏄嚎鎬э紝浣嗙敤鎴烽噺灏忕殑閮ㄧ讲鍙帴鍙?
  for (const row of rows) {
    try {
      if (bcrypt.compareSync(refreshToken, row.refresh_token_hash)) {
        return row;
      }
    } catch {
      // hash 鎹熷潖鐨?session 璺宠繃
      continue;
    }
  }
  return null;
}

/** 婊氬姩鍒锋柊锛氭浛鎹細璇濋噷鐨?refresh_token_hash */
export function rotateUserSession(sessionId: string, newRefreshTokenHash: string): void {
  _db.run(`UPDATE user_sessions SET refresh_token_hash = ? WHERE id = ?`, [newRefreshTokenHash, sessionId]);
}

/** 鎾ら攢浼氳瘽 */
export function revokeSession(sessionId: string): void {
  _db.run(`UPDATE user_sessions SET revoked_at = ? WHERE id = ?`, [Date.now(), sessionId]);
}

/** 鎾ら攢鐢ㄦ埛鐨勬墍鏈変細璇濓紙鐢ㄤ簬鏀瑰瘑/閫€鍑虹櫥褰曪級 */
export function revokeUserSessions(userId: string): void {
  _db.run(`UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [Date.now(), userId]);
}


// 鈹€鈹€ 鏂规C: LAN 缇ら個璇?CRUD 鈹€鈹€

export function saveLanGroupInvite(params: {
  id: string;
  groupId: string;
  groupName: string;
  ownerInstance: string;
  ownerUserId: string;
  invitedUserId: string;
  invitedUserNumericId?: number;
  inviterName?: string;
  groupDef: any;
}): void {
  const now = Date.now();
  _db.run(
    `INSERT OR REPLACE INTO lan_group_invites
     (id, group_id, group_name, owner_instance, owner_user_id, invited_user_id, invited_user_numeric_id, inviter_name, status, group_def, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      params.id, params.groupId, params.groupName,
      params.ownerInstance, params.ownerUserId,
      params.invitedUserId, params.invitedUserNumericId ?? null,
      params.inviterName ?? null,
      JSON.stringify(params.groupDef), now, now,
    ]
  );
}

export function getLanGroupInvite(id: string): any {
  return queryObjects("SELECT * FROM lan_group_invites WHERE id = ?", [id])[0] || null;
}

export function listLanGroupInvites(userId: string, status: string = 'pending'): any[] {
  return queryObjects(
    "SELECT * FROM lan_group_invites WHERE invited_user_id = ? AND status = ? ORDER BY created_at DESC",
    [userId, status]
  );
}

export function updateLanGroupInviteStatus(id: string, status: string): void {
  _db.run("UPDATE lan_group_invites SET status = ?, updated_at = ? WHERE id = ?", [status, Date.now(), id]);
}

export function getLanGroupInviteByGroup(userId: string, groupId: string): any {
  return queryObjects(
    "SELECT * FROM lan_group_invites WHERE invited_user_id = ? AND group_id = ? ORDER BY created_at DESC LIMIT 1",
    [userId, groupId]
  )[0] || null;
}

// 鈹€鈹€ 鏂规C: LAN 缇ょ粍 CRUD 鈹€鈹€

export function createLanGroup(id: string, name: string, ownerInstance: string, ownerUserId: string, chatMode: string = 'free'): void {
  const now = Date.now();
  _db.run(
    "INSERT OR REPLACE INTO lan_groups (id, name, owner_instance, owner_user_id, chat_mode, member_count, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    [id, name, ownerInstance, ownerUserId, chatMode, now]
  );
}

export function getLanGroup(id: string): any {
  return queryObjects("SELECT * FROM lan_groups WHERE id = ?", [id])[0] || null;
}

export function listLanGroups(): any[] {
  return queryObjects("SELECT * FROM lan_groups ORDER BY created_at DESC");
}

export function setLanGroupMode(groupId: string, mode: string): boolean {
  const validModes = ['free', 'structured', 'debate', 'brainstorm'];
  if (!validModes.includes(mode)) return false;
  _db.run("UPDATE lan_groups SET chat_mode = ? WHERE id = ?", [mode, groupId]);
  return true;
}
export function deleteLanGroup(id: string): void {
  _db.run("DELETE FROM lan_group_members WHERE group_id = ?", [id]);
  _db.run("DELETE FROM lan_groups WHERE id = ?", [id]);
}

export function removeLanGroup(id: string): void {
  deleteLanGroup(id);
}
export function addLanGroupMember(params: {
  groupId: string;
  userId: string;
  numericId?: number;
  displayName?: string;
  instanceId?: string;
  role?: string;
}): void {
  const id = 'lgm-' + params.groupId + '-' + params.userId;
  const now = Date.now();
  _db.run(
    `INSERT OR REPLACE INTO lan_group_members (id, group_id, user_id, numeric_id, display_name, instance_id, role, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.groupId, params.userId, params.numericId ?? null, params.displayName ?? null, params.instanceId ?? null, params.role ?? 'member', now]
  );
  // Update member count
  const count = queryOne("SELECT COUNT(*) as cnt FROM lan_group_members WHERE group_id = ?", [params.groupId]);
  if (count) _db.run("UPDATE lan_groups SET member_count = ? WHERE id = ?", [count[0], params.groupId]);
}

export function getLanGroupMembers(groupId: string): any[] {
  return queryObjects("SELECT * FROM lan_group_members WHERE group_id = ? ORDER BY joined_at", [groupId]);
}

export function removeLanGroupMember(groupId: string, userId: string): void {
  _db.run("DELETE FROM lan_group_members WHERE group_id = ? AND user_id = ?", [groupId, userId]);
  const count = queryOne("SELECT COUNT(*) as cnt FROM lan_group_members WHERE group_id = ?", [groupId]);
  if (count) _db.run("UPDATE lan_groups SET member_count = ? WHERE id = ?", [count[0], groupId]);
}

export function deleteFriendRequest(requestId: string): void {
  _db.run("DELETE FROM friendships WHERE id = ?", [requestId]);
}
