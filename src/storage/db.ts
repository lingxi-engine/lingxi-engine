/**
 * ?- SQLite (sql.js)
 *  DB 
 */
import initSqlJs from "sql.js";
import bcrypt from 'bcryptjs';
import { isFinitePositiveAmount } from './amount-guards.js';
import { buildFriendRequestLookup } from './friend-guards.js';

let _db: any = null;
let _dbPath: string = "";
let _saveTimer: ReturnType<typeof setInterval> | null = null;
let _dirty = false;  // P1-4: 脏标记，仅在有写入时才触发磁盘保存

/**
 * ?30 
 */
export function startAutoSave(intervalMs = 30000) {
  if (_saveTimer) clearInterval(_saveTimer);
  _saveTimer = setInterval(() => {
    // [FIX] markDirty() 全项目零调用，脏标记检查导致自动保存从不执行，聊天数据只活在内存。改为无条件保存（DB 约2.3MB，每5秒全量导出开销可忽略）。
    saveToDisk().catch((e: any) => console.error("[DB] auto-save error:", e.message));
  }, intervalMs);
  // 不调用 unref() —— 确保进程退出前定时器仍能触发保存，防止丢上下文
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
    // [FIX] 原子写入：先写临时文件再 rename，避免崩溃时写一半损坏主 DB 导致下次启动丢数据
    const tmpPath = _dbPath + '.tmp';
    fs.writeFileSync(tmpPath, Buffer.from(data));
    fs.renameSync(tmpPath, _dbPath);
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
  const fs = await import("fs");
  let fileExists = false;
  try { fileExists = fs.existsSync(dbPath); } catch {}
  if (fileExists) {
    try {
      const buf = fs.readFileSync(dbPath);
      _db = new SQL.Database(new Uint8Array(buf));
    } catch (e: any) {
      // [FIX] DB 文件损坏：备份原文件而不是静默丢弃，避免"重启后会话全部丢失"
      console.error('[DB] 数据库文件损坏，将备份后重建:', e.message);
      try {
        const bakPath = dbPath + '.corrupt-' + Date.now();
        fs.copyFileSync(dbPath, bakPath);
        console.error('[DB] 损坏文件已备份到:', bakPath);
      } catch {}
      _db = new SQL.Database();
    }
  } else {
    _db = new SQL.Database();
  }
  if (!_db) _db = new SQL.Database();
  _dbInit(_db);
  // ── P0-3 接入点：显式迁移账本 + 漂移自检（幂等、可重入）──
  try {
    const _schemaStatus = runMigrations({ autoAddMissingColumns: true, failFast: false });
    if (_schemaStatus.drift.length) console.warn('[schema] 迁移后仍有漂移:', JSON.stringify(_schemaStatus.drift));
    else console.log('[schema] ✅ 迁移账本一致 · 漂移 0 处 · checksum=' + _schemaStatus.checksum);
  } catch (e: any) { console.error('[schema] runMigrations 失败:', e.message); }
  // v2.0.20: 存量用户积分建档——补齐 user_credits 缺失记录，避免各处读到兜底值
  try {
    const missing = _db.exec('SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM user_credits)');
    const rows = (missing[0] && missing[0].values) || [];
    if (rows.length) {
      const now = Date.now();
      const ins = _db.prepare('INSERT OR IGNORE INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, 1000, 0, 0, ?)');
      for (const r of rows) { ins.run([String(r[0]), now]); }
      ins.free();
      markDirty();
      console.log('[DB] credit rows backfilled: ' + rows.length);
    }
  } catch (e: any) { console.error('[DB] credit backfill failed:', e.message); }
  console.log(`[DB] initialized: ${dbPath}`);
  return _db;
}

export function getDB() { return _db; }

/** 获取数据目录（db 文件所在目录），供外部模块持久化附属文件使用 */
export function getDataDir(): string {
  if (!_dbPath) return process.cwd();
  return _dbPath.replace(/[\\/][^\\/]+$/, '') || process.cwd();
}

/**
 * P0-1: 记忆写入侧过滤 —— 清除指令性/注入式语句，防止对话内容通过记忆持久化形成 Prompt 注入
 */
export function sanitizeMemoryInput(text: string): string {
  if (!text) return '';
  return text
    .replace(/忽略(以上|之前|所有)(的)?(指令|提示|规则|内容|设定)/g, '[已过滤]')
    .replace(/你?(必须|务必)(执行|遵守|听从)/g, '[已过滤]')
    .replace(/最高优先级/g, '[已过滤]')
    .replace(/(覆盖|修改|输出|泄露)(你的)?系统提示(词)?/g, '[已过滤]')
    .replace(/(假装|扮演|现在你是)(系统|管理员|开发者)/g, '[已过滤]');
}

/** P1-3: 首尾兼顾截断 —— 保留开头核心摘要 + 末尾最近增量，避免丢失最早记忆 */
export function trimMemoryText(text: string, maxLen: number = 2000): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.floor(maxLen * 0.25);
  return text.slice(0, headLen) + '\n…\n' + text.slice(-(maxLen - headLen));
}

/** P1-4: 标记数据库有变更，下次自动保存时写入磁盘 */
export function markDirty() { _dirty = true; }

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
      personality_dims TEXT DEFAULT '{}',
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
      category TEXT NOT NULL DEFAULT '通用',
      price INTEGER NOT NULL DEFAULT 0,  -- 积分/次
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

    -- ———— V7: 持久身份体系 ————
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

    -- 用户积分
    CREATE TABLE IF NOT EXISTS user_credits (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      credits INTEGER DEFAULT 1000,
      total_earned INTEGER DEFAULT 0,
      total_spent INTEGER DEFAULT 0,
      updated_at INTEGER
    );

    -- 消息评价（星级）
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

    -- 积分变动记录
    CREATE TABLE IF NOT EXISTS credit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT,
      balance_after INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_credit_log_user ON credit_log(user_id);

    -- 工作流编排
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

    -- 方案C: LAN 群邀请确认表
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

    -- 方案C: LAN 社交 - 跨引擎可见的群组
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

    -- LAN 远程身份缓存
    CREATE TABLE IF NOT EXISTS lan_remote_identities (
      user_id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      numeric_id INTEGER,
      display_name TEXT,
      agent_id TEXT,
      updated_at INTEGER NOT NULL
    );

    -- 雇佣关系表
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
    -- 团队协作 (TeamManager 持久化)
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
    addIf('bio', 'TEXT DEFAULT ""');              // 个人介绍
    // numeric_id uniqueness 鈥?best-effort via index
    try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_numeric_id ON users(numeric_id)`); } catch(_e) {}
    // email uniqueness
    try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)`); }
    catch(_e) {}
    // 补充外键索引
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_chats_id ON chats(id)`); } catch(_e) {}
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_rag_docs_id ON rag_documents(id)`); } catch(_e) {}
    // set sqlite_sequence seed so next numeric_id starts at 10000
    // (sqlite_sequence may not exist if no AUTOINCREMENT column 鈥?safe to skip)
    try {
      const seqRow = queryOne(`SELECT seq FROM sqlite_sequence WHERE name = ?`, ['users']);
      if (!seqRow || (seqRow[0] as number) < 9999) {
        db.run(`INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('users', 9999)`);
      }
    } catch(_e) { /* sqlite_sequence 表不存在时忽略，我们用手动 _nextNumericId */ }
  } catch (e: any) {
    console.warn('[DB] V7 migration warning:', e.message);
  }

  // —— v1.4.0: 迁移：给 chats 表补 shared_workspace 列 ——
  try {
    const chatCols = db.exec(`PRAGMA table_info(chats)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!chatCols.includes('shared_workspace')) {
      db.run(`ALTER TABLE chats ADD COLUMN shared_workspace TEXT`);
      console.log('[DB] v1.4.0 migration: added shared_workspace to chats');
    }
  } catch (e: any) {
    console.warn('[DB] v1.4.0 migration warning:', e.message);
  }

  // —— v1.7.2: 迁移：给 chats 表补 chat_mode 列（群聊协作模式持久化）——
  try {
    const chatCols2 = db.exec(`PRAGMA table_info(chats)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!chatCols2.includes('chat_mode')) {
      db.run(`ALTER TABLE chats ADD COLUMN chat_mode TEXT NOT NULL DEFAULT 'free'`);
      console.log('[DB] v1.7.2 migration: added chat_mode to chats');
    }
  } catch (e: any) {
    console.warn('[DB] v1.7.2 migration warning:', e.message);
  }

  // —— v2.3.0: 迁移：给 chats 表补 name 列（群名持久化，修复建群后群名丢失/列表不显示名字）——
  try {
    const chatCols3 = db.exec(`PRAGMA table_info(chats)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!chatCols3.includes('name')) {
      db.run(`ALTER TABLE chats ADD COLUMN name TEXT`);
      console.log('[DB] v2.3.0 migration: added name to chats');
    }
  } catch (e: any) {
    console.warn('[DB] v2.3.0 migration warning:', e.message);
  }

  // —— v2.3.1: 迁移：存量孤儿群修复（补 owner、回填群名、type 归一、清理幽灵参与者）——
  //    孤儿群 = type in (group,team) 且没有任何 user 参与者的群（建群时 owner 写入失败被吞，
  //    会话列表 INNER JOIN participants 永远查不到 -> 群隐身）。启动时幂等修复，老库自动生效。
  try {
    // 1) 孤儿群补 owner：扫描所有无用户参与者的群聊
    const orphanGroups = db.exec(
      "SELECT id, name FROM chats WHERE type IN ('group','team')" +
      " AND NOT EXISTS (SELECT 1 FROM participants WHERE chat_id = chats.id AND user_id IS NOT NULL)"
    )[0]?.values || [];
    let fixedOwner = 0, fixedName = 0;
    for (const row of orphanGroups) {
      const gid = String(row[0]);
      const gname = row[1] == null ? null : String(row[1]);
      // 找群内 agent 的归属用户（agent-u-* 真实平台用户优先）
      const ownerRows = db.exec(
        "SELECT a.user_id FROM participants p JOIN agents a ON a.id = p.agent_id" +
        " WHERE p.chat_id = '" + gid.replace(/'/g, "''") + "' AND p.agent_id IS NOT NULL" +
        " AND a.user_id IS NOT NULL AND a.user_id != ''" +
        " ORDER BY (CASE WHEN p.agent_id LIKE 'agent-u-%' THEN 0 ELSE 1 END), p.joined_at ASC LIMIT 1"
      )[0]?.values || [];
      if (ownerRows.length) {
        const ownerId = String(ownerRows[0][0]);
        const pid = 'p-' + gid + '-creator';
        const exists = db.exec("SELECT id FROM participants WHERE id = '" + pid.replace(/'/g, "''") + "'")[0]?.values?.length || 0;
        if (!exists) {
          db.run(
            "INSERT INTO participants (id, chat_id, user_id, agent_id, role, joined_at) VALUES (?, ?, ?, NULL, 'owner', ?)",
            [pid, gid, ownerId, Date.now()]
          );
          console.log('[DB] v2.3.1 migration: owner added', gid, '->', ownerId);
          fixedOwner++;
        }
      } else {
        console.warn('[DB] v2.3.1 migration: cannot infer owner for', gid, '- skip');
      }
      // 回填 AGI进化组 群名（其他空名群提示人工处理）
      if (!gname && gid === 'team-mt7qknoh') {
        db.run("UPDATE chats SET name = ? WHERE id = ?", ['AGI进化组', gid]);
        console.log('[DB] v2.3.1 migration: name backfilled AGI进化组');
        fixedName++;
      } else if (!gname) {
        console.warn('[DB] v2.3.1 migration: group', gid, 'has no name - manual UPDATE needed if desired');
      }
    }
    // 2) type=team 归一为 group（smoke 测试残留）
    const teamRows = db.exec("SELECT id FROM chats WHERE type = 'team'")[0]?.values || [];
    if (teamRows.length) {
      db.run("UPDATE chats SET type = 'group' WHERE type = 'team'");
      console.log('[DB] v2.3.1 migration: normalized', teamRows.length, 'team -> group:', teamRows.map((r: any) => r[0]).join(', '));
    }
    // 3) 清理幽灵参与者（user_id 和 agent_id 双空）
    const ghostRows = db.exec("SELECT id FROM participants WHERE user_id IS NULL AND agent_id IS NULL")[0]?.values || [];
    if (ghostRows.length) {
      db.run("DELETE FROM participants WHERE user_id IS NULL AND agent_id IS NULL");
      console.log('[DB] v2.3.1 migration: removed', ghostRows.length, 'ghost participants:', ghostRows.map((r: any) => r[0]).join(', '));
    }
    if (fixedOwner || fixedName || teamRows.length || ghostRows.length) {
      console.log('[DB] v2.3.1 migration done: owner=' + fixedOwner + ' name=' + fixedName + ' team2group=' + teamRows.length + ' ghosts=' + ghostRows.length);
    }
  } catch (e: any) {
    console.warn('[DB] v2.3.1 migration warning:', e.message);
  }

  // —— v2.1.x: 迁移：给 agents 表补 personality_dims 列（人格演化持久化，修复老库 no such column）——
  try {
    const agentCols = db.exec(`PRAGMA table_info(agents)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!agentCols.includes('personality_dims')) {
      db.run(`ALTER TABLE agents ADD COLUMN personality_dims TEXT DEFAULT '{}'`);
      console.log('[DB] v2.1.x migration: added personality_dims to agents');
    }
  } catch (e: any) {
    console.warn('[DB] agents personality_dims migration warning:', e.message);
  }

  // —— v2.2.0: 迁移：lan_groups/lan_group_members 补列（老库表结构与新代码建表脱节，导致建群 INSERT 报 no such column）——
  try {
    const lgCols = db.exec(`PRAGMA table_info(lan_groups)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!lgCols.includes('member_count')) {
      db.run(`ALTER TABLE lan_groups ADD COLUMN member_count INTEGER DEFAULT 0`);
      console.log('[DB] v2.2.0 migration: added member_count to lan_groups');
    }
    const lgmCols = db.exec(`PRAGMA table_info(lan_group_members)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!lgmCols.includes('agent_id')) {
      db.run(`ALTER TABLE lan_group_members ADD COLUMN agent_id TEXT`);
      console.log('[DB] v2.2.0 migration: added agent_id to lan_group_members');
    }
  } catch (e: any) {
    console.warn('[DB] v2.2.0 migration warning:', e.message);
  }

  // —— v2.0.12: 迁移：AI员工市场自定义时长 + 雇佣到期时间 + 订单关联hire ——
  try {
    const mkCols = db.exec(`PRAGMA table_info(agent_market)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!mkCols.includes('duration')) {
      db.run(`ALTER TABLE agent_market ADD COLUMN duration INTEGER NOT NULL DEFAULT 0`);
      console.log('[DB] v2.0.12 migration: added duration to agent_market');
    }
    if (!mkCols.includes('duration_unit')) {
      db.run(`ALTER TABLE agent_market ADD COLUMN duration_unit TEXT NOT NULL DEFAULT 'permanent'`);
      console.log('[DB] v2.0.12 migration: added duration_unit to agent_market');
    }
    const hireCols = db.exec(`PRAGMA table_info(hires)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!hireCols.includes('expires_at')) {
      db.run(`ALTER TABLE hires ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0`);
      console.log('[DB] v2.0.12 migration: added expires_at to hires');
    }
    const orderCols = db.exec(`PRAGMA table_info(market_orders)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!orderCols.includes('hire_id')) {
      db.run(`ALTER TABLE market_orders ADD COLUMN hire_id TEXT`);
      console.log('[DB] v2.0.12 migration: added hire_id to market_orders');
    }
  } catch (e: any) {
    console.warn('[DB] v2.0.12 migration warning:', e.message);
  }

  // ---- v2.3.1: 迁移：市场多品类支持（音乐/视频/漏洞悬赏/游戏素材/MCP） ----
  try {
    const mkCols2 = db.exec(`PRAGMA table_info(agent_market)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!mkCols2.includes('item_type')) { db.run(`ALTER TABLE agent_market ADD COLUMN item_type TEXT NOT NULL DEFAULT 'agent'`); console.log('[DB] v2.3.1 migration: added item_type to agent_market'); }
    if (!mkCols2.includes('preview_url')) { db.run(`ALTER TABLE agent_market ADD COLUMN preview_url TEXT DEFAULT ''`); console.log('[DB] v2.3.1 migration: added preview_url to agent_market'); }
    if (!mkCols2.includes('file_url')) { db.run(`ALTER TABLE agent_market ADD COLUMN file_url TEXT DEFAULT ''`); console.log('[DB] v2.3.1 migration: added file_url to agent_market'); }
    if (!mkCols2.includes('license')) { db.run(`ALTER TABLE agent_market ADD COLUMN license TEXT DEFAULT ''`); console.log('[DB] v2.3.1 migration: added license to agent_market'); }
    if (!mkCols2.includes('cover_url')) { db.run(`ALTER TABLE agent_market ADD COLUMN cover_url TEXT DEFAULT ''`); console.log('[DB] v2.3.1 migration: added cover_url to agent_market'); }
    // v2.4.0: 钱包（USD/CNY 双币种，模拟结算）+ 市场币种
    db.run(`CREATE TABLE IF NOT EXISTS wallets (
      user_id TEXT PRIMARY KEY,
      balance_usd REAL NOT NULL DEFAULT 0,
      balance_cny REAL NOT NULL DEFAULT 0,
      frozen_usd REAL NOT NULL DEFAULT 0,
      frozen_cny REAL NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS wallet_tx (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      reason TEXT DEFAULT '',
      balance_after REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    try { db.run(`CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON wallet_tx(user_id, created_at DESC)`); } catch (_e) {}
    const mkCols3 = db.exec(`PRAGMA table_info(agent_market)`)[0]?.values?.map((r: any) => r[1]) || [];
    if (!mkCols3.includes('currency')) { db.run(`ALTER TABLE agent_market ADD COLUMN currency TEXT NOT NULL DEFAULT 'credits'`); console.log('[DB] v2.4.0 migration: added currency to agent_market'); }
    console.log('[DB] v2.4.0 migration: wallets ready');
  } catch (e: any) {
    console.warn('[DB] v2.3.1 migration warning:', e.message);
  }
}

// —— 辅助：带参数的 SELECT 查询（sql.js exec 不支持参数绑定）
function queryAll(sql: string, params: any[] = []): any[][] {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: any[][] = [];
  while (stmt.step()) rows.push(stmt.get());
  stmt.free();
  return rows;
}

export function queryOne(sql: string, params: any[] = []): any | null {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const result = stmt.step() ? stmt.get() : null;
  stmt.free();
  return result;
}

export function queryObjects(sql: string, params: any[] = []): any[] {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ———— Users ————
export function createUser(id: string, displayName: string, email?: string, username?: string) {
  const now = Date.now();
  _db.run("INSERT INTO users (id, display_name, email, username, created_at) VALUES (?, ?, ?, ?, ?)", [id, displayName, email ?? null, username ?? null, now]);
  // 不再自动创建 dummy agent，由 AgentManager.register 统一管理
  return { id, displayName, email, username, createdAt: now };
}

export function getUser(id: string) {
  // [FIX 个人中心] 双格式兼容：优先按主键 id 查；查不到再按 numeric_id（数字ID）查
  // 背景：旧注册接口用 String(numericId) 当 id，V7 用纯数字字符串 id，云平台用 "ouid-N" 格式，
  // 导致同一用户在不同路径下 id 格式不一致，按单一格式查询必然 404。
  let stmt = _db.prepare("SELECT * FROM users WHERE id = ?");
  stmt.bind([id]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  const nid = Number(id);
  if (!Number.isNaN(nid) && String(nid) === String(id).trim()) {
    stmt = _db.prepare("SELECT * FROM users WHERE numeric_id = ?");
    stmt.bind([nid]);
    if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
    stmt.free();
  }
  return undefined;
}

export function getUserByEmail(email: string) {
  const stmt = _db.prepare("SELECT * FROM users WHERE email = ?");
  stmt.bind([email]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return undefined;
}


export function getUserByDisplayName(displayName: string) {
  const stmt = _db.prepare("SELECT * FROM users WHERE display_name = ?");
  stmt.bind([displayName]);
  if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
  stmt.free();
  return undefined;
}

export function listUsers() {
  return queryObjects("SELECT * FROM users");
}

// SQL LIKE 搜索用户（替代全量扫描 + JS 过滤，性能优化）
export function searchUsers(keyword: string, limit: number = 50): any[] {
  const like = '%' + keyword + '%';
  return queryObjects(
    "SELECT id, numeric_id, display_name FROM users WHERE display_name LIKE ? OR CAST(numeric_id AS TEXT) LIKE ? LIMIT ?",
    [like, like, limit]
  );
}

// ———— Agents ————
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

// Bug #14 修复：SQL 参数用数组传递，不再用 spread
export function updateAgent(agentId: string, updates: Record<string, any>) {
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
  const db = getDB();
  db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, vals);
}

export function updateAgentMemory(agentId: string, summary: string, facts: Record<string, string>) {
  _db.run("UPDATE agents SET memory_summary = ?, memory_facts = ? WHERE id = ?", [summary, JSON.stringify(facts), agentId]);
}

// v1.4.0: 群聊独立记忆
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

export function listChatMemoryPairs(): Array<{ chat_id: string; agent_id: string }> {
  return queryObjects("SELECT DISTINCT chat_id, agent_id FROM chat_memories WHERE memory_summary IS NOT NULL AND length(memory_summary) >= 100");
}


export function appendMemorySummary(agentId: string, newContent: string) {
  const agent = getAgent(agentId);
  if (!agent) return;
  const existing = agent.memory_summary || '';
  const safeContent = sanitizeMemoryInput(newContent); // P0-1: 写入侧过滤指令性内容
  const updated = existing ? existing + '\n' + safeContent : safeContent;
  // P1-3: 首尾兼顾截断（原 slice(-2000) 会丢失最早的核心记忆）
  const trimmed = trimMemoryText(updated, 2000);
  _db.run("UPDATE agents SET memory_summary = ? WHERE id = ?", [trimmed, agentId]);
}

// ———— Chats ————
export function createChat(id: string, type: "private" | "group" = "private", sharedWorkspace?: string, name?: string) {
  const now = Date.now();
  _db.run("INSERT INTO chats (id, type, shared_workspace, name, created_at) VALUES (?, ?, ?, ?, ?)", [id, type, sharedWorkspace ?? null, name ?? null, now]);
  return { id, type, sharedWorkspace, name, createdAt: now };
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

export function updateChatName(id: string, name: string | null) {
  _db.run("UPDATE chats SET name = ? WHERE id = ?", [name, id]);
}

// —— 群聊协作模式（v1.7.2）——
export const CHAT_MODES = ['free', 'route', 'debate', 'chain', 'roundtable', 'vote', 'brainstorm'] as const;
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
    _db.run("DELETE FROM participants WHERE chat_id = ? AND agent_id = ?", [chatId, agentId]);
  } else {
    _db.run("DELETE FROM participants WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
  }
}

// ———— Messages ————
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

/** 获取指定 Agent 最近的消息 */
export function getRecentMessages(agentId: string, limit = 20): Array<{ content: string; timestamp: number }> {
  return queryObjects(
    `SELECT content, timestamp FROM messages 
     WHERE sender_id = ? OR sender_type = 'agent' AND sender_id = ?
     ORDER BY timestamp DESC LIMIT ?`,
    [agentId, agentId, limit]
  ).reverse();
}

// —— 验证码 ——
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

// ———— Friendships ————
/**
 * 统一生成私聊 chatId：按字典序排序两个 userId，保证 A→B 和 B→A 生成同一个 chatId。
 * 这样无论发起方是谁，所有查询、创建、删除私聊的逻辑都能用同一个 key。
 */
export function makePrivateChatId(userA: string, userB: string): string {
  const [a, b] = [userA, userB].sort();
  return `chat-${a}-${b}`;
}

export function messageExists(msgId: string): boolean {
  const row = queryOne("SELECT 1 FROM messages WHERE id = ?", [msgId]);
  return !!row;
}
export function sendFriendRequest(fromUserId: string, toUserId: string, message: string = '') {
  // DB 层兜底校验（所有调用方——API 层、LAN 层——都经过这里，无需各自重复校验）
  if (fromUserId === toUserId) return { error: '不能添加自己为好友' };
  // 对方必须是本地用户、或远程 LAN 用户（remote- 前缀 / lan_remote_identities 表中有记录）
  const targetUser = getUser(toUserId);
  if (!targetUser && !toUserId.startsWith('remote-') && !getLanRemoteIdentity(toUserId)) {
    return { error: '对方用户不存在' };
  }

  const now = Date.now();
  const id = 'friend-' + now + '-' + Math.random().toString(36).slice(2, 6);
  // Check if already exists (双向检查，防止反向重复)
  let existingRow = queryOne("SELECT id, status FROM friendships WHERE from_user_id = ? AND to_user_id = ?", [fromUserId, toUserId]);
  if (!existingRow) {
    existingRow = queryOne("SELECT id, status FROM friendships WHERE from_user_id = ? AND to_user_id = ?", [toUserId, fromUserId]);
  }
  if (existingRow) {
    // columns: id(0), ... status is at index based on column order
    // friendships columns: id, from_user_id, to_user_id, status, message, created_at, updated_at
    const existingId = existingRow[0];
    const status = existingRow[1];
    if (status === 'pending') return { error: '好友申请已发送，等待对方处理' };
    if (status === 'accepted') return { error: '你们已经是好友了' };
    // If denied, allow re-send
    _db.run("UPDATE friendships SET status='pending', message=?, created_at=?, updated_at=? WHERE id=?", [message, now, now, existingId]);
    return { ok: true, id: existingId, status: 'pending' };
  }
  _db.run("INSERT INTO friendships (id, from_user_id, to_user_id, status, message, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)", [id, fromUserId, toUserId, message, now, now]);
  return { ok: true, id, status: 'pending' };
}
export function respondFriendRequest(requestId: string, action: 'accept' | 'reject', responderUserId?: string) {
  const lookup = buildFriendRequestLookup(responderUserId);
  const stmt = _db.prepare(lookup.sql);
  stmt.bind([requestId, ...lookup.params]);
  if (!stmt.step()) { stmt.free(); return { error: "friend_request_not_found" }; }
  const row = stmt.getAsObject(); stmt.free();
  if (row.status !== "pending") return { error: "request_already_processed" };
  const status = action === 'accept' ? 'accepted' : 'denied';
  _db.run("UPDATE friendships SET status=?, updated_at=? WHERE id=?", [status, Date.now(), requestId]);
  // If accepted, create a private chat between them
  if (action === 'accept') {
    const chatId = makePrivateChatId(row.from_user_id, row.to_user_id);
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
  const incoming = queryObjects("SELECT f.id, f.from_user_id, f.to_user_id, f.status, f.message, f.created_at, f.updated_at, u.display_name as from_name FROM friendships f LEFT JOIN users u ON f.from_user_id = u.id WHERE f.to_user_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC", [userId]);
  const outgoing = queryObjects("SELECT f.id, f.from_user_id, f.to_user_id, f.status, f.message, f.created_at, f.updated_at, u.display_name as to_name FROM friendships f LEFT JOIN users u ON f.to_user_id = u.id WHERE f.from_user_id = ? AND f.status = 'pending' ORDER BY f.created_at DESC", [userId]);
  return {
    incoming: incoming.map((r: any) => ({ id: r.id, fromUserId: r.from_user_id, toUserId: r.to_user_id, status: r.status, message: r.message, createdAt: r.created_at, fromName: r.from_name })),
    // 红点修复(2026-09-14 重部署善后): incoming 已在 SQL 层过滤为 pending，
    // pendingIncoming 显式提供同口径字段，供红点计数与 LAN 链路透传使用
    pendingIncoming: incoming.map((r: any) => ({ id: r.id, fromUserId: r.from_user_id, toUserId: r.to_user_id, status: r.status, message: r.message, createdAt: r.created_at, fromName: r.from_name })),
    outgoing: outgoing.map((r: any) => ({ id: r.id, fromUserId: r.from_user_id, toUserId: r.to_user_id, status: r.status, message: r.message, createdAt: r.created_at, toName: r.to_name })),
  };
}

const isValidPositiveAmount = isFinitePositiveAmount;
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
    const chatId = makePrivateChatId(row.from_user_id, row.to_user_id);
    // 删除好友时同时清理所有关联数据（隐私保护）
    _db.run("DELETE FROM messages WHERE chat_id = ?", [chatId]);
    _db.run("DELETE FROM chat_memories WHERE chat_id = ?", [chatId]);
    _db.run("DELETE FROM entities WHERE chat_id = ?", [chatId]);
    _db.run("DELETE FROM chat_read_state WHERE chat_id = ?", [chatId]);
    _db.run("DELETE FROM participants WHERE chat_id = ?", [chatId]);
    _db.run("DELETE FROM chats WHERE id = ?", [chatId]);
    _db.run("DELETE FROM friendships WHERE id = ?", [friendshipId]);
  }
}

export function deleteFriendshipByPair(fromUserId: string, toUserId: string): void {
  const chatId = makePrivateChatId(fromUserId, toUserId);
  // 删除好友时同时清理所有关联数据（隐私保护）
  _db.run("DELETE FROM messages WHERE chat_id = ?", [chatId]);
  _db.run("DELETE FROM chat_memories WHERE chat_id = ?", [chatId]);
  _db.run("DELETE FROM entities WHERE chat_id = ?", [chatId]);
  _db.run("DELETE FROM chat_read_state WHERE chat_id = ?", [chatId]);
  _db.run("DELETE FROM participants WHERE chat_id = ?", [chatId]);
  _db.run("DELETE FROM chats WHERE id = ?", [chatId]);
  _db.run("DELETE FROM friendships WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)", [fromUserId, toUserId, toUserId, fromUserId]);
}
// ———— LAN Remote Identities ————
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

// 将用户的 agent 补到所有已有私聊（agent 延迟创建时调用）
export function syncAgentToPrivateChats(userId: string): number {
  const agent = getAgentByUserId(userId);
  if (!agent) return 0;
  const friendships = queryObjects(
    "SELECT from_user_id, to_user_id FROM friendships WHERE (from_user_id = ? OR to_user_id = ?) AND status = 'accepted'",
    [userId, userId]
  );
  let added = 0;
  for (const f of friendships) {
    const friendId = f.from_user_id === userId ? f.to_user_id : f.from_user_id;
    const chatId = makePrivateChatId(userId, friendId);
    const existing = queryOne("SELECT id FROM participants WHERE chat_id = ? AND agent_id = ?", [chatId, agent.id]);
    if (!existing) {
      const chatExists = queryOne("SELECT id FROM chats WHERE id = ?", [chatId]);
      if (chatExists) {
        addParticipant('p-' + chatId + '-sync-' + Date.now().toString(36), chatId, undefined, agent.id, 'agent');
        added++;
      }
    }
  }
  return added;
}

// ———— Types ————
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
 * DB 类 - 兼容旧版 `new DB(...)` 风格的入口，但内部用全局 _db
 * 这样 AgentManager 这种 `this.db.listAgents()` 的写法可以直接工作。
 */

// ———— 积分 CRUD ————

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
  if (!isValidPositiveAmount(amount)) {
    throw new Error('invalid_credit_amount');
  }
  ensureUserCredits(userId);
  _db.run(
    "UPDATE user_credits SET credits = credits + ?, total_earned = total_earned + ?, updated_at = ? WHERE user_id = ?",
    [amount, amount, Date.now(), userId]
  );
  const row = queryOne("SELECT credits FROM user_credits WHERE user_id = ?", [userId]);
  const balance = row ? Number(row[0]) : 0;
  try { _db.run("INSERT INTO credit_log (user_id, amount, reason, balance_after, created_at) VALUES (?, ?, ?, ?, ?)", [userId, amount, note || '系统奖励', balance, Date.now()]); } catch {}
  return balance;
}

export function spendCredits(userId: string, amount: number, note?: string): { ok: boolean; balance: number; error?: string } {
  if (!isValidPositiveAmount(amount)) {
    return { ok: false, balance: 0, error: '积分金额必须为大于 0 的有限数值' };
  }
  ensureUserCredits(userId);
  const row = queryOne("SELECT credits FROM user_credits WHERE user_id = ?", [userId]);
  const balance = row ? Number(row[0]) : 1000;
  if (balance < amount) {
    return { ok: false, balance, error: '积分不足，需要 ' + amount + '，当前 ' + balance };
  }
  _db.run(
    "UPDATE user_credits SET credits = credits - ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ?",
    [amount, amount, Date.now(), userId]
  );
  const newRow = queryOne("SELECT credits FROM user_credits WHERE user_id = ?", [userId]);
  const newBal = newRow ? Number(newRow[0]) : 0;
  try { _db.run("INSERT INTO credit_log (user_id, amount, reason, balance_after, created_at) VALUES (?, ?, ?, ?, ?)", [userId, -Math.abs(amount), note || '消费支出', newBal, Date.now()]); } catch {}
  return { ok: true, balance: newBal };
}

// 获取积分变动历史
export function getCreditHistory(userId: string, limit: number = 50): any[] {
  try {
    const stmt = _db.prepare("SELECT id, user_id, amount, reason, balance_after, created_at FROM credit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?");
    stmt.bind([userId, limit]);
    const rows: any[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject();
      rows.push({ id: r.id, userId: r.user_id, amount: r.amount, reason: r.reason, balanceAfter: r.balance_after, created_at: r.created_at });
    }
    stmt.free();
    return rows;
  } catch { return []; }
}

// ———— 钱包（USD / CNY 双币种，模拟结算，未接真实支付）————
export function ensureWallet(userId: string): void {
  try {
    _db.run("INSERT OR IGNORE INTO wallets (user_id, balance_usd, balance_cny, frozen_usd, frozen_cny, updated_at) VALUES (?, 0, 0, 0, 0, ?)", [userId, Date.now()]);
  } catch (e: any) { console.warn('[Wallet] ensure failed:', e.message); }
}

export function getWallet(userId: string): { balanceUsd: number; balanceCny: number; frozenUsd: number; frozenCny: number } {
  try {
    ensureWallet(userId);
    const row = queryOne("SELECT balance_usd, balance_cny, frozen_usd, frozen_cny FROM wallets WHERE user_id = ?", [userId]);
    return {
      balanceUsd: row ? Number(row[0]) || 0 : 0,
      balanceCny: row ? Number(row[1]) || 0 : 0,
      frozenUsd: row ? Number(row[2]) || 0 : 0,
      frozenCny: row ? Number(row[3]) || 0 : 0,
    };
  } catch { return { balanceUsd: 0, balanceCny: 0, frozenUsd: 0, frozenCny: 0 }; }
}

export function _walletTx(userId: string, currency: string, amount: number, type: string, reason: string, balanceAfter: number): void {
  try {
    const id = 'wtx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    _db.run("INSERT INTO wallet_tx (id, user_id, currency, amount, type, reason, balance_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, userId, currency, amount, type, reason || '', balanceAfter, Date.now()]);
  } catch {}
}

export function addWalletBalance(userId: string, currency: 'usd' | 'cny', amount: number, note?: string): number {
  if (!['usd', 'cny'].includes(currency) || !isValidPositiveAmount(amount)) return 0;
  ensureWallet(userId);
  _db.run(`UPDATE wallets SET balance_${currency} = balance_${currency} + ?, updated_at = ? WHERE user_id = ?`, [amount, Date.now(), userId]);
  const w = getWallet(userId);
  const bal = currency === 'usd' ? w.balanceUsd : w.balanceCny;
  _walletTx(userId, currency, amount, 'income', note || '钱包入账', bal);
  return bal;
}

export function spendWalletBalance(userId: string, currency: 'usd' | 'cny', amount: number, note?: string): { ok: boolean; balance: number; error?: string } {
  if (!['usd', 'cny'].includes(currency) || !isValidPositiveAmount(amount)) return { ok: false, balance: 0, error: '不支持的币种或金额' };
  ensureWallet(userId);
  const w = getWallet(userId);
  const bal = currency === 'usd' ? w.balanceUsd : w.balanceCny;
  if (bal < amount) return { ok: false, balance: bal, error: (currency === 'usd' ? '美元' : '人民币') + '余额不足，需要 ' + amount + '，当前 ' + bal };
  _db.run(`UPDATE wallets SET balance_${currency} = balance_${currency} - ?, updated_at = ? WHERE user_id = ?`, [amount, Date.now(), userId]);
  const newW = getWallet(userId);
  const newBal = currency === 'usd' ? newW.balanceUsd : newW.balanceCny;
  _walletTx(userId, currency, -amount, 'expense', note || '钱包支出', newBal);
  return { ok: true, balance: newBal };
}

export function listWalletTx(userId: string, limit: number = 50): any[] {
  try {
    const stmt = _db.prepare("SELECT id, user_id, currency, amount, type, reason, balance_after, created_at FROM wallet_tx WHERE user_id = ? ORDER BY created_at DESC LIMIT ?");
    stmt.bind([userId, limit]);
    const rows: any[] = [];
    while (stmt.step()) {
      const r = stmt.getAsObject();
      rows.push({ id: r.id, currency: r.currency, amount: r.amount, type: r.type, reason: r.reason, balanceAfter: r.balance_after, createdAt: r.created_at });
    }
    stmt.free();
    return rows;
  } catch { return []; }
}

// ———— 雇佣 CRUD ————

export function createHire(params: {
  id: string; listingId: string; buyerId: string; sellerId: string;
  agentId: string; title: string; price: number; chatId?: string; expiresAt?: number;
}): void {
  const now = Date.now();
  _db.run(
    "INSERT INTO hires (id, listing_id, buyer_id, seller_id, agent_id, title, price, status, chat_id, hired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)",
    [params.id, params.listingId, params.buyerId, params.sellerId,
     params.agentId, params.title, params.price, params.chatId || null, now, params.expiresAt || 0]
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
  getUserByNumericId(numericId: number) { return getUserByNumericId(numericId); }
  getUserByDisplayName(displayName: string) { return getUserByDisplayName(displayName); }
  listUsers() { return listUsers(); }
  searchUsers(keyword: string, limit?: number) { return searchUsers(keyword, limit); }
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
  createChat(id: string, type: "private" | "group" = "private", sharedWorkspace?: string, name?: string) { return createChat(id, type, sharedWorkspace, name); }
  addParticipant(id: string, chatId: string, userId?: string, agentId?: string, role: string = "member") {
    return addParticipant(id, chatId, userId, agentId, role);
  }
  getChatParticipants(chatId: string) { return getChatParticipants(chatId); }
  /** listParticipants 别名 (兼容旧代码) */
  listParticipants(chatId: string) { return getChatParticipants(chatId); }
  listChats() { return listChats(); }
  getChatMode(chatId: string) { return getChatMode(chatId); }
  setChatMode(chatId: string, mode: string) { return setChatMode(chatId, mode); }
  removeParticipant(chatId: string, userId: string, agentId?: string) {
    return removeParticipant(chatId, userId, agentId);
  }
  addMessage(msg: DBMessage) { return addMessage(msg); }
  listMessages(chatId: string, limit = 100) { return listMessages(chatId, limit); }
  getRecentMessages(agentId: string, limit = 20) { return getRecentMessages(agentId, limit); }
  saveVerificationCode(email: string, code: string, username?: string, expiresAtMs?: number) {
    return saveVerificationCode(email, code, username, expiresAtMs);
  }
  /** RAG 鎸佷箙鍖?*/
  listRagDocuments() { return listRagDocuments(); }
  listRagChunks() { return listRagChunks(); }
  insertRagDocument(doc: any) { return insertRagDocument(doc); }
  insertRagChunk(chunk: any) { return insertRagChunk(chunk); }
  deleteRagDocument(docId: string) { return deleteRagDocument(docId); }
  /** 收件箱 */
  addInboxItem(item: any) { return addInboxItem(item); }
  listInbox(agentId?: string) { return listInbox(agentId); }
  markInboxRead(id: string) { return markInboxRead(id); }
  deleteInboxItem(id: string) { return deleteInboxItem(id); }
  getVerificationCode(email: string) { return getVerificationCode(email); }
  deleteVerificationCode(email: string) { return deleteVerificationCode(email); }
  sendFriendRequest(fromUserId: string, toUserId: string, message?: string) { return sendFriendRequest(fromUserId, toUserId, message); }
  respondFriendRequest(requestId: string, action: 'accept' | 'reject', responderUserId?: string) { return respondFriendRequest(requestId, action, responderUserId); }
  getFriendRequests(userId: string) { return getFriendRequests(userId); }
  listFriends(userId: string) { return listFriends(userId); }
  /** 让 manager.update 这种 `db.db.prepare(...)` 风格也能工作 */
  getAgentByUserId(userId: string) { return getAgentByUserId(userId); }
  syncAgentToPrivateChats(userId: string) { return syncAgentToPrivateChats(userId); }
  markChatRead(userId: string, chatId: string) { return markChatRead(userId, chatId); }
  getUnreadCount(userId: string) { return getUnreadCount(userId); }
  getChatUnreadCounts(userId: string) { return getChatUnreadCounts(userId); }
  get db() { return _db; }

  // —— Entity 持久化 ——
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
      // P2-5: 实体条数上限 —— 每个 chat+agent 最多保留 100 条，超限删除最久未出现的
      _db.run(
        `DELETE FROM entities WHERE chat_id = ? AND agent_id = ? AND id NOT IN
         (SELECT id FROM entities WHERE chat_id = ? AND agent_id = ? ORDER BY last_seen DESC LIMIT 100)`,
        [chatId, agentId, chatId, agentId]
      );
    }
  }
  clearEntities(chatId: string, agentId: string): void {
    _db.run('DELETE FROM entities WHERE chat_id=? AND agent_id=?', [chatId, agentId]);
  }

  // —— 方案C: LAN 群邀请 ——
  saveLanGroupInvite(params: Parameters<typeof saveLanGroupInvite>[0]) { return saveLanGroupInvite(params); }
  listLanGroupInvites(userId: string, status?: string) { return listLanGroupInvites(userId, status); }
  updateLanGroupInviteStatus(id: string, status: string) { return updateLanGroupInviteStatus(id, status); }
  getLanGroupInviteByGroup(userId: string, groupId: string) { return getLanGroupInviteByGroup(userId, groupId); }
  getLanGroupInvite(id: string) { return getLanGroupInvite(id); }

  // ———— 方案C: LAN 群组 ————
  createLanGroup(id: string, name: string, ownerInstance: string, ownerUserId: string, chatMode?: string) { return createLanGroup(id, name, ownerInstance, ownerUserId, chatMode); }
  getLanGroup(id: string) { return getLanGroup(id); }
  listLanGroups() { return listLanGroups(); }
  deleteLanGroup(id: string) { return deleteLanGroup(id); }
  addLanGroupMember(params: Parameters<typeof addLanGroupMember>[0]) { return addLanGroupMember(params); }
  getLanGroupMembers(groupId: string) { return getLanGroupMembers(groupId); }
  // ———— 积分 ————
  getUserCredits(userId: string) { return getUserCredits(userId); }
  addCredits(userId: string, amount: number, note?: string) { return addCredits(userId, amount, note); }
  spendCredits(userId: string, amount: number) { return spendCredits(userId, amount); }
  getCreditHistory(userId: string, limit?: number) { return getCreditHistory(userId, limit); }
  // ———— 钱包 ————
  getWallet(userId: string) { return getWallet(userId); }
  addWalletBalance(userId: string, currency: 'usd' | 'cny', amount: number, note?: string) { return addWalletBalance(userId, currency, amount, note); }
  spendWalletBalance(userId: string, currency: 'usd' | 'cny', amount: number, note?: string) { return spendWalletBalance(userId, currency, amount, note); }
  listWalletTx(userId: string, limit?: number) { return listWalletTx(userId, limit); }
  // ———— 雇佣 ————
  createHire(params: Parameters<typeof createHire>[0]) { return createHire(params); }
  getHire(id: string) { return getHire(id); }
  listHiresByBuyer(userId: string, status?: string) { return listHiresByBuyer(userId, status); }
  listHiresBySeller(userId: string, status?: string) { return listHiresBySeller(userId, status); }
  fireHire(hireId: string) { return fireHire(hireId); }

}


// —————— RAG 知识库持久化 ——————

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

// —— 收件箱 ——

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


// —— 聊天已读状态 ——

/** 标记用户已读某聊天 */
export function markChatRead(userId: string, chatId: string): void {
  _db.run(
    "INSERT OR REPLACE INTO chat_read_state (user_id, chat_id, last_read_at) VALUES (?, ?, ?)",
    [userId, chatId, Date.now()]
  );
}

/** 获取用户的未读消息数 */
export function getUnreadCount(userId: string): number {
  // 统计用户参与的所有聊天的未读消息总数
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


// ———— V7: 持久身份 CRUD ————

let _nextNumericId = 10000;

/** 初始化：从 DB 读当前最大 numeric_id，保证自增 */
export function initNumericIdSeq(): void {
  const row = queryOne(`SELECT MAX(numeric_id) FROM users WHERE numeric_id IS NOT NULL`);
  if (row && row[0]) _nextNumericId = Math.max(10000, (row[0] as number) + 1);
  else _nextNumericId = 10000;
}

/** 分配下一个 numeric_id（10000 起自增）*/
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
  // 消费邀请码
  if (params.inviteCode) {
    _db.run(`UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?`, [params.inviteCode]);
  }
  return getUser(params.id);
}

/** 更新用户邮箱验证状态 */
export function verifyUserEmail(userId: string): void {
  _db.run(`UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`, [Date.now(), userId]);
}

/** 更新用户密码 */
export function updateUserPassword(userId: string, newPasswordHash: string): void {
  _db.run(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, [newPasswordHash, Date.now(), userId]);
}

/** 更新用户状态 */
export function updateUserStatus(userId: string, status: string): void {
  _db.run(`UPDATE users SET status = ?, last_active_at = ? WHERE id = ?`, [status, Date.now(), userId]);
}

/** 通过数字 ID 找用户 */
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

/** 消费验证 token */
export function consumeVerificationToken(tokenId: string): void {
  _db.run(`UPDATE user_verifications SET consumed_at = ? WHERE id = ?`, [Date.now(), tokenId]);
}

/** 清理过期 token */
export function cleanupExpiredTokens(): void {
  _db.run(`DELETE FROM user_verifications WHERE expires_at < ?`, [Date.now()]);
}

/** 验证邀请码 */
export function validateInviteCode(code: string): { valid: boolean; reason?: string } {
  const row = queryObjects(`SELECT * FROM invite_codes WHERE code = ?`, [code])[0];
  if (!row) return { valid: false, reason: "invite_code_not_found" };
  if (row.expires_at && row.expires_at < Date.now()) return { valid: false, reason: "invite_code_expired" };
  if (row.used_count >= row.max_uses) return { valid: false, reason: "invite_code_used_up" };
  return { valid: true };
}

/** 获取邀请码列表 */
export function listInviteCodes(): any[] {
  return queryObjects(`SELECT * FROM invite_codes ORDER BY created_at DESC`);
}

/** (encoding fix) */
export function createInviteCode(code: string, createdBy: string, maxUses: number, expiresAt?: number): void {
  _db.run(`INSERT INTO invite_codes (code, created_by, max_uses, used_count, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)`,
    [code, createdBy, maxUses, expiresAt || null, Date.now()]);
}

/** 创建会话记录 */
export function createUserSession(params: {
  id: string; userId: string; refreshTokenHash: string; deviceInfo?: string; expiresAtMs: number;
}): void {
  _db.run(
    `INSERT INTO user_sessions (id, user_id, refresh_token_hash, device_info, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [params.id, params.userId, params.refreshTokenHash, params.deviceInfo || null, Date.now(), params.expiresAtMs]
  );
}

/** 通过 refreshToken 找活跃会话（遍历 + bcrypt 比对）*/
export function getActiveSessionByToken(refreshToken: string): any {
  // 安全：限制最多检查 1000 条，防 DoS
  const rows = queryObjects(
    `SELECT * FROM user_sessions WHERE revoked_at IS NULL AND expires_at > ? LIMIT 1000`,
    [Date.now()]
  );
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
  _db.run(`UPDATE user_sessions SET refresh_token_hash = ? WHERE id = ?`, [newRefreshTokenHash, sessionId]);
}

/** 撤销会话 */
export function revokeSession(sessionId: string): void {
  _db.run(`UPDATE user_sessions SET revoked_at = ? WHERE id = ?`, [Date.now(), sessionId]);
}

/** 撤销用户的所有会话（用于改密/退出登录） */
export function revokeUserSessions(userId: string): void {
  _db.run(`UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, [Date.now(), userId]);
}


// —— 方案C: LAN 群邀请 CRUD ——

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

// ———— 方案C: LAN 群组 CRUD ————

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
  const validModes = ['free', 'route', 'debate', 'chain', 'roundtable', 'vote', 'brainstorm'];
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
  agentId?: string;
}): void {
  const id = 'lgm-' + params.groupId + '-' + params.userId;
  const now = Date.now();
  _db.run(
    `INSERT OR REPLACE INTO lan_group_members (id, group_id, user_id, numeric_id, display_name, instance_id, role, joined_at, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, params.groupId, params.userId, params.numericId ?? null, params.displayName ?? null, params.instanceId ?? null, params.role ?? 'member', now, params.agentId ?? null]
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

// ==================== deleteUser: cascade delete a user and all related data ====================
/**
 * [P0-1 修复 · v3 · 2026-09-18]
 *
 * v3 相对 v2 的两处实质修正（均由"真实库 schema"验证抓出，见
 * scripts/verify-deleteuser-on-live-schema.cjs）：
 *
 *   [FIX-A] 删掉"全库孤儿清理"——v2 的 `chats(orphan)` 语句是
 *           `DELETE FROM chats WHERE id NOT IN (SELECT chat_id FROM participants)`，
 *           它在**真实库上删掉了 89 条与本用户无关的 chat**。这是越界破坏。
 *           v3 改为：先收集"本用户（及其 Agent）参与过的 chat_id"白名单，
 *           只在**白名单内**做孤儿回收，绝不触碰无关数据。
 *
 *   [FIX-B] 补上"缺列"防护——v2 声明了 PlanStep.need 却从未使用（死代码），
 *           导致真实库缺 lan_groups.owner_user_id 时两条语句抛错并整体回滚，
 *           deleteUser 在真实库上**依然失败**。v3 用 SAVEPOINT 逐条隔离：
 *             · 失败原因是"缺列/缺表"（schema 漂移）→ 记录哨兵值并继续，大声告警
 *             · 其它原因 → 整个事务 ROLLBACK，保证账目与数据一致性
 *
 * 保留 v2 的正确设计：单事务、真实列名、私聊抹除/群聊保留他人、覆盖 31 张表、返回结构化结果。
 *
 * ⚠️ 顺序约束：所有"按参与关系定位 chat_id"的语句必须在删除 participants 之前执行。
 *
 * 安全性：表名/列名全部来自本文件硬编码白名单，无外部输入拼接。
 */
export function deleteUser(userId: string): { ok: boolean; deleted: Record<string, number>; skipped: string[]; error?: string } {
  const deleted: Record<string, number> = {};
  const skipped: string[] = [];

  const tableExists = (t: string): boolean => {
    try {
      const r = _db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${t}'`);
      return !!(r[0] && r[0].values.length);
    } catch { return false; }
  };

  let userEmail: string | null = null;
  try {
    const row = queryOne(`SELECT email FROM users WHERE id = ?`, [userId]);
    userEmail = row && row[0] ? String(row[0]) : null;
  } catch { /* 表缺失时忽略 */ }

  // ── [FIX-A] 前置：收集本用户（及其 Agent）参与过的 chat_id 白名单 ──
  const myChatIds: string[] = [];
  try {
    const rows = queryObjects(
      `SELECT DISTINCT chat_id FROM participants
        WHERE user_id = ? OR agent_id IN (SELECT id FROM agents WHERE user_id = ?)`,
      [userId, userId]
    );
    for (const r of rows) if (r && r[0]) myChatIds.push(String(r[0]));
  } catch { /* participants 缺失则白名单为空，后续按空处理 */ }

  interface PlanStep { label: string; table: string; sql: string; params: any[] }
  const PLAN: PlanStep[] = [
    // A. 账务 / 凭证
    { label: 'credit_log',            table: 'credit_log',            sql: `DELETE FROM credit_log WHERE user_id = ?`,         params: [userId] },
    { label: 'wallet_tx',             table: 'wallet_tx',             sql: `DELETE FROM wallet_tx WHERE user_id = ?`,          params: [userId] },
    { label: 'wallets',               table: 'wallets',               sql: `DELETE FROM wallets WHERE user_id = ?`,            params: [userId] },
    { label: 'user_credits',          table: 'user_credits',          sql: `DELETE FROM user_credits WHERE user_id = ?`,       params: [userId] },
    { label: 'user_sessions',         table: 'user_sessions',         sql: `DELETE FROM user_sessions WHERE user_id = ?`,      params: [userId] },
    { label: 'user_verifications',    table: 'user_verifications',    sql: `DELETE FROM user_verifications WHERE user_id = ?`, params: [userId] },
    { label: 'invite_codes',          table: 'invite_codes',          sql: `DELETE FROM invite_codes WHERE created_by = ?`,    params: [userId] },
    { label: 'verification_codes',    table: 'verification_codes',    sql: `DELETE FROM verification_codes WHERE email = ?`,   params: [userEmail ?? ''] },
    { label: 'message_ratings',       table: 'message_ratings',       sql: `DELETE FROM message_ratings WHERE user_id = ?`,    params: [userId] },

    // B. 社交 / 交易
    { label: 'friendships',   table: 'friendships',   sql: `DELETE FROM friendships WHERE from_user_id = ? OR to_user_id = ?`, params: [userId, userId] },
    { label: 'hires',         table: 'hires',         sql: `DELETE FROM hires WHERE buyer_id = ? OR seller_id = ?`,            params: [userId, userId] },
    { label: 'market_orders', table: 'market_orders', sql: `DELETE FROM market_orders WHERE buyer_id = ? OR listing_id IN (SELECT id FROM agent_market WHERE publisher_id = ?)`, params: [userId, userId] },
    { label: 'agent_market',  table: 'agent_market',  sql: `DELETE FROM agent_market WHERE publisher_id = ? OR agent_id IN (SELECT id FROM agents WHERE user_id = ?)`,           params: [userId, userId] },

    // C. 局域网组网
    //   注意：lan_groups 在不同血统的库里可能是 owner_user_id（代码声明）或 owner_instance（真实库），
    //   缺列由 SAVEPOINT 兜底为"跳过并告警"，绝不误删他人在群。
    { label: 'lan_group_members',     table: 'lan_group_members',     sql: `DELETE FROM lan_group_members WHERE user_id = ? OR group_id IN (SELECT id FROM lan_groups WHERE owner_user_id = ?)`, params: [userId, userId] },
    { label: 'lan_group_invites',     table: 'lan_group_invites',     sql: `DELETE FROM lan_group_invites WHERE invited_user_id = ? OR owner_user_id = ?`,                                          params: [userId, userId] },
    { label: 'lan_groups',            table: 'lan_groups',            sql: `DELETE FROM lan_groups WHERE owner_user_id = ?`,                                                                       params: [userId] },
    { label: 'lan_remote_identities', table: 'lan_remote_identities', sql: `DELETE FROM lan_remote_identities WHERE user_id = ?`,                                                                  params: [userId] },

    // D. Agent 派生数据（须在 participants 之前）
    { label: 'inbox',        table: 'inbox',        sql: `DELETE FROM inbox WHERE agent_id IN (SELECT id FROM agents WHERE user_id = ?)`, params: [userId] },
    { label: 'team_members', table: 'team_members', sql: `DELETE FROM team_members WHERE agent_id IN (SELECT id FROM agents WHERE user_id = ?) OR team_id IN (SELECT id FROM team_groups WHERE owner_id = ?)`, params: [userId, userId] },
    { label: 'team_groups',  table: 'team_groups',  sql: `DELETE FROM team_groups WHERE owner_id = ? OR chat_id IN (SELECT DISTINCT chat_id FROM participants WHERE user_id = ? OR agent_id IN (SELECT id FROM agents WHERE user_id = ?))`, params: [userId, userId, userId] },
    { label: 'workflows',    table: 'workflows',    sql: `DELETE FROM workflows WHERE created_by = ?`, params: [userId] },

    // E. 会话内容（chat_id 维度；必须在 participants 之前）
    { label: 'entities',         table: 'entities',         sql: `DELETE FROM entities WHERE chat_id IN (SELECT DISTINCT chat_id FROM participants WHERE user_id = ? OR agent_id IN (SELECT id FROM agents WHERE user_id = ?)) OR agent_id IN (SELECT id FROM agents WHERE user_id = ?)`, params: [userId, userId, userId] },
    { label: 'chat_memories',    table: 'chat_memories',    sql: `DELETE FROM chat_memories WHERE chat_id IN (SELECT DISTINCT chat_id FROM participants WHERE user_id = ? OR agent_id IN (SELECT id FROM agents WHERE user_id = ?)) OR agent_id IN (SELECT id FROM agents WHERE user_id = ?)`, params: [userId, userId, userId] },
    { label: 'messages(private)',table: 'messages',         sql: `DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE type = 'private' AND id IN (SELECT DISTINCT chat_id FROM participants WHERE user_id = ? OR agent_id IN (SELECT id FROM agents WHERE user_id = ?)))`, params: [userId, userId] },
    { label: 'chats(private)',   table: 'chats',            sql: `DELETE FROM chats WHERE type = 'private' AND id IN (SELECT DISTINCT chat_id FROM participants WHERE user_id = ? OR agent_id IN (SELECT id FROM agents WHERE user_id = ?))`, params: [userId, userId] },

    // F. 成员关系（本人及本人 Agent；群聊保留他人）
    { label: 'participants',      table: 'participants',   sql: `DELETE FROM participants WHERE user_id = ? OR agent_id IN (SELECT id FROM agents WHERE user_id = ?)`, params: [userId, userId] },
    { label: 'chat_read_state',   table: 'chat_read_state',sql: `DELETE FROM chat_read_state WHERE user_id = ?`, params: [userId] },

    // G. 主体
    { label: 'agents', table: 'agents', sql: `DELETE FROM agents WHERE user_id = ?`, params: [userId] },
    { label: 'users',  table: 'users',  sql: `DELETE FROM users WHERE id = ?`,       params: [userId] },
  ];

  // ── [FIX-A] 白名单内的孤儿回收（替换 v2 的全局清理）──
  const cleanup: PlanStep[] = [];
  if (myChatIds.length) {
    const inList = myChatIds.map(() => '?').join(',');
    cleanup.push(
      { label: 'chats(orphan-mine)', table: 'chats', sql: `DELETE FROM chats WHERE id IN (${inList}) AND id NOT IN (SELECT DISTINCT chat_id FROM participants)`, params: [...myChatIds] },
      { label: 'participants(orphan-mine)', table: 'participants', sql: `DELETE FROM participants WHERE chat_id IN (${inList}) AND chat_id NOT IN (SELECT id FROM chats)`, params: [...myChatIds] },
    );
  }

  // 执行顺序：主体删除 → 白名单孤儿回收（回收必须在 participants 删净之后）
  const ORDERED: PlanStep[] = [...PLAN.filter((s) => s.label !== 'agents' && s.label !== 'users'), ...cleanup,
    ...PLAN.filter((s) => s.label === 'agents' || s.label === 'users')];

  const runnable = ORDERED.filter((st) => {
    if (!tableExists(st.table)) { deleted[st.label] = -1; skipped.push(`${st.label}(表缺失)`); return false; }
    if (st.label === 'verification_codes' && !userEmail) { deleted[st.label] = -3; skipped.push(`${st.label}(无 email 键)`); return false; }
    return true;
  });

  try {
    _db.run('BEGIN');
    let sp = 0;
    for (const st of runnable) {
      const name = `sp_${sp++}`;
      try {
        _db.run(`SAVEPOINT ${name}`);
        _db.run(st.sql, st.params);
        _db.run(`RELEASE ${name}`);
        deleted[st.label] = _db.getRowsModified();
      } catch (e: any) {
        try { _db.run(`ROLLBACK TO ${name}`); _db.run(`RELEASE ${name}`); } catch { /* ignore */ }
        const msg = String(e?.message || e);
        const isDrift = /no such column|no such table/i.test(msg);
        if (isDrift) {
          // [FIX-B] schema 漂移：跳过该条并大声告警，不拖垮整个删除
          deleted[st.label] = -2;
          skipped.push(`${st.label}(${msg})`);
          console.warn(`[DB] deleteUser(${userId}) 跳过 ${st.label}：${msg} —— 该库 schema 与代码声明不一致，建议跑迁移`);
          continue;
        }
        throw e; // 其它错误 → 交给外层整体回滚
      }
    }
    _db.run('COMMIT');
    markDirty();
    return { ok: true, deleted, skipped };
  } catch (e: any) {
    try { _db.run('ROLLBACK'); } catch { /* ignore */ }
    console.error(`[DB] deleteUser(${userId}) 失败并已回滚: ${e.message}`);
    return { ok: false, deleted, skipped, error: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// P0-3 落地：显式迁移账本（schema_migrations）+ 漂移自检
// 来源补丁: patches/db.schema-migrations.fixed.ts
// 落地调整: 类型统一用 any（本文件已有 `export class DB`，避免类型名冲突）
// ════════════════════════════════════════════════════════════════════════════

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id           TEXT PRIMARY KEY,
    description  TEXT NOT NULL DEFAULT '',
    applied_at   INTEGER NOT NULL,
    checksum     TEXT NOT NULL DEFAULT '',
    ok           INTEGER NOT NULL DEFAULT 1
  );`;

interface Migration {
  id: string;
  description: string;
  /** 幂等：内部必须自行判断"列/索引是否已存在"后再执行 */
  up: (db: any) => void;
}

/** 列是否存在 */
function hasColumn(db: any, table: string, col: string): boolean {
  try {
    const r = db.exec(`PRAGMA table_info(${table})`);
    return !!(r[0] && r[0].values.some((v: any[]) => v[1] === col));
  } catch { return false; }
}
/** 表是否存在 */
function hasTable(db: any, table: string): boolean {
  try {
    const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`);
    return !!(r[0] && r[0].values.length);
  } catch { return false; }
}
/** 幂等加列 */
function addColumnIfMissing(db: any, table: string, col: string, ddl: string): boolean {
  if (!hasTable(db, table)) return false;
  if (hasColumn(db, table, col)) return false;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  return true;
}

// ────────────────────────── 显式迁移清单 ──────────────────────────
// 原 db.ts 里散的 16 条裸 ALTER 全部收编为具名迁移（语义不变：仍只在缺列时加）。
// 今后新增结构变更 = 往数组尾部追加一条，不再往启动流程塞 try/catch。
const MIGRATIONS: Migration[] = [
  {
    id: '20260901_001_chats_columns',
    description: 'chats 增加 shared_workspace / chat_mode / name',
    up: (db) => {
      addColumnIfMissing(db, 'chats', 'shared_workspace', 'TEXT');
      addColumnIfMissing(db, 'chats', 'chat_mode', "TEXT NOT NULL DEFAULT 'free'");
      addColumnIfMissing(db, 'chats', 'name', 'TEXT');
    },
  },
  {
    id: '20260901_002_agents_personality_dims',
    description: 'agents 增加 personality_dims',
    up: (db) => { addColumnIfMissing(db, 'agents', 'personality_dims', "TEXT DEFAULT '{}'"); },
  },
  {
    id: '20260905_001_lan_group_columns',
    description: 'lan_groups.member_count / lan_group_members.agent_id',
    up: (db) => {
      addColumnIfMissing(db, 'lan_groups', 'member_count', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'lan_group_members', 'agent_id', 'TEXT');
      addColumnIfMissing(db, 'lan_group_members', 'role', "TEXT DEFAULT 'member'");
    },
  },
  {
    id: '20260910_001_agent_market_columns',
    description: 'agent_market 增加 duration/duration_unit/item_type/preview_url/file_url/license/cover_url/currency',
    up: (db) => {
      addColumnIfMissing(db, 'agent_market', 'duration', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'agent_market', 'duration_unit', "TEXT NOT NULL DEFAULT 'permanent'");
      addColumnIfMissing(db, 'agent_market', 'item_type', "TEXT NOT NULL DEFAULT 'agent'");
      addColumnIfMissing(db, 'agent_market', 'preview_url', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'agent_market', 'file_url', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'agent_market', 'license', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'agent_market', 'cover_url', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'agent_market', 'currency', "TEXT NOT NULL DEFAULT 'credits'");
    },
  },
  {
    id: '20260912_001_hires_expires_at',
    description: 'hires 增加 expires_at（原 v2.0.12 迁移）',
    up: (db) => { addColumnIfMissing(db, 'hires', 'expires_at', 'INTEGER NOT NULL DEFAULT 0'); },
  },
  {
    id: '20260918_001_hires_align_code_schema',
    description:
      '⚠️ 对齐 hires：代码 INSERT 需要 agent_id/title/price/hired_at，' +
      '而真实库用的是 buyer_agent_id/seller_agent_id/credits_paid/created_at。' +
      '只补列 + 尽力回填，不破坏既有行。',
    up: (db) => {
      addColumnIfMissing(db, 'hires', 'agent_id', 'TEXT');
      addColumnIfMissing(db, 'hires', 'title', "TEXT DEFAULT ''");
      addColumnIfMissing(db, 'hires', 'price', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'hires', 'hired_at', 'INTEGER DEFAULT 0');
      addColumnIfMissing(db, 'hires', 'fired_at', 'INTEGER');
      if (hasColumn(db, 'hires', 'created_at')) {
        try { db.run(`UPDATE hires SET hired_at = created_at WHERE (hired_at IS NULL OR hired_at = 0) AND created_at IS NOT NULL`); } catch { /* ignore */ }
      }
      if (hasColumn(db, 'hires', 'buyer_agent_id')) {
        try { db.run(`UPDATE hires SET agent_id = buyer_agent_id WHERE agent_id IS NULL`); } catch { /* ignore */ }
      }
      if (hasColumn(db, 'hires', 'credits_paid')) {
        try { db.run(`UPDATE hires SET price = credits_paid WHERE (price IS NULL OR price = 0) AND credits_paid IS NOT NULL`); } catch { /* ignore */ }
      }
    },
  },
  {
    id: '20260918_002_market_orders_hire_id',
    description: 'market_orders 增加 hire_id',
    up: (db) => { addColumnIfMissing(db, 'market_orders', 'hire_id', 'TEXT'); },
  },
  {
    id: '20260918_003_hire_idempotency_index',
    description: 'hires 幂等键：同一买家对同一 listing 最多一条 active 雇约（P0-2 的数据库级兜底）',
    up: (db) => {
      if (!hasTable(db, 'hires')) return;
      try {
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_hire_active ON hires(buyer_id, listing_id) WHERE status = 'active'`);
      } catch (e: any) {
        console.error('[schema] ⚠️ 幂等索引创建失败（可能存在重复 active 雇约，需人工清理）:', e.message);
      }
    },
  },
  {
    id: '20260918_004_lan_groups_owner_user_id',
    description: 'lan_groups 增加 owner_user_id（代码声明列；真实库缺失）',
    up: (db) => { addColumnIfMissing(db, 'lan_groups', 'owner_user_id', 'TEXT'); },
  },
];

// ────────────────────────── 迁移执行器 ──────────────────────────
/** 迁移清单稳定摘要，用于"清单被改过"的检测 */
function migrationsChecksum(migs: Migration[]): string {
  const src = migs.map((m) => `${m.id}|${m.description}`).join('\n');
  let h = 0;
  for (let i = 0; i < src.length; i++) { h = (h * 31 + src.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface SchemaStatus {
  applied: string[];
  pending: string[];
  drift: Array<{ table: string; column: string }>;
  checksum: string;
}

/**
 * 执行迁移（幂等、可重入）。返回可观测状态。
 * @param opts.failFast 遇错是否中断启动（默认 false：只记账 + 告警，不阻断服务启动）
 */
export function runMigrations(opts: { autoAddMissingColumns?: boolean; failFast?: boolean } = {}): SchemaStatus {
  const { autoAddMissingColumns = true, failFast = false } = opts;
  const db = _db;
  try { db.exec(MIGRATIONS_TABLE); } catch (e: any) {
    console.error('[schema] 无法创建 schema_migrations 表:', e.message);
  }

  const appliedSet = new Set<string>();
  try {
    const r = db.exec('SELECT id FROM schema_migrations WHERE ok = 1');
    if (r[0]) for (const v of r[0].values) appliedSet.add(String(v[0]));
  } catch { /* ignore */ }

  const checksum = migrationsChecksum(MIGRATIONS);
  const applied: string[] = [];
  const pending: string[] = [];

  for (const m of MIGRATIONS) {
    if (appliedSet.has(m.id)) { applied.push(m.id); continue; }
    try {
      db.run('BEGIN');
      m.up(db);
      db.run(
        'INSERT OR REPLACE INTO schema_migrations (id, description, applied_at, checksum, ok) VALUES (?, ?, ?, ?, 1)',
        [m.id, m.description, Date.now(), checksum]
      );
      db.run('COMMIT');
      applied.push(m.id);
      console.log(`[schema] ✅ 迁移已应用: ${m.id} — ${m.description}`);
    } catch (e: any) {
      try { db.run('ROLLBACK'); } catch { /* ignore */ }
      pending.push(m.id);
      console.error(`[schema] ❌ 迁移失败: ${m.id} — ${e.message}`);
      try {
        db.run(
          'INSERT OR REPLACE INTO schema_migrations (id, description, applied_at, checksum, ok) VALUES (?, ?, ?, ?, 0)',
          [m.id, m.description + ' | ERROR: ' + e.message, Date.now(), checksum]
        );
      } catch { /* ignore */ }
      if (failFast) throw e;
    }
  }

  const drift = detectDrift();
  if (autoAddMissingColumns && drift.length) {
    console.warn(`[schema] ⚠️ 检测到 ${drift.length} 处 schema 漂移（缺失列）`);
  }
  markDirty();
  return { applied, pending, drift, checksum };
}

/** 漂移检测：返回"迁移清单期望但库中缺失"的列 */
export function detectDrift(): Array<{ table: string; column: string }> {
  const expected: Array<[string, string]> = [
    ['chats', 'shared_workspace'], ['chats', 'chat_mode'], ['chats', 'name'],
    ['agents', 'personality_dims'],
    ['lan_groups', 'member_count'], ['lan_groups', 'owner_user_id'],
    ['lan_group_members', 'agent_id'],
    ['lan_group_members', 'role'],
    ['agent_market', 'duration'], ['agent_market', 'duration_unit'], ['agent_market', 'item_type'],
    ['agent_market', 'preview_url'], ['agent_market', 'file_url'], ['agent_market', 'license'],
    ['agent_market', 'cover_url'], ['agent_market', 'currency'],
    ['hires', 'expires_at'], ['hires', 'agent_id'], ['hires', 'title'], ['hires', 'price'],
    ['hires', 'hired_at'], ['hires', 'fired_at'],
    ['market_orders', 'hire_id'],
  ];
  const out: Array<{ table: string; column: string }> = [];
  for (const [t, c] of expected) {
    if (!hasTable(_db, t)) { out.push({ table: t, column: `${c}(表缺失)` }); continue; }
    if (!hasColumn(_db, t, c)) out.push({ table: t, column: c });
  }
  return out;
}

/** 供 /api/health 暴露的库健康度 */
export function getSchemaStatus(): SchemaStatus & { ledgerRows: number } {
  let ledgerRows = 0;
  try { const r = _db.exec('SELECT COUNT(*) FROM schema_migrations WHERE ok = 1'); ledgerRows = r[0] ? Number(r[0].values[0][0]) : 0; } catch { /* ignore */ }
  const appliedRows: string[] = [];
  try { const r = _db.exec('SELECT id FROM schema_migrations WHERE ok = 1'); if (r[0]) for (const v of r[0].values) appliedRows.push(String(v[0])); } catch { /* ignore */ }
  const appliedSet = new Set(appliedRows);
  return {
    applied: MIGRATIONS.filter((m) => appliedSet.has(m.id)).map((m) => m.id),
    pending: MIGRATIONS.filter((m) => !appliedSet.has(m.id)).map((m) => m.id),
    drift: detectDrift(),
    checksum: migrationsChecksum(MIGRATIONS),
    ledgerRows,
  };
}
