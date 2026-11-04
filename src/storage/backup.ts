/**
 * 全量备份导出 / 导入（JSON 格式）
 *
 * - 导出：枚举 sqlite_master 里所有用户表，逐表 dump 成 { table: rows[] }
 * - 导入：校验格式 → 事务内 DELETE + INSERT → 跳过不存在的表
 * - 敏感字段脱敏：导出/导入时把 SENSITIVE_COLUMNS 置空，避免备份文件泄露
 *   （密码哈希、会话 refresh token、验证码、实例密钥、离线队列内容等）
 *
 * 设计取舍：sql.js 是内存库，没有 ATTACH，跨库事务不可行；
 * 因此导入走「单事务内全量替换」语义（先删后插），失败整体 ROLLBACK。
 */

import { getDB, markDirty, saveToDisk } from './db.js';
import { encryptField, decryptField } from './field-crypto.js';

/** 敏感列：<表, 列[]> —— 导出时置空，导入时拒绝回写（防备份被篡改） */
const SENSITIVE_COLUMNS: Record<string, string[]> = {
  users: ['password_hash'],
  user_sessions: ['refresh_token_hash'],
  user_verifications: ['token'],
  verification_codes: ['code'],
  app_instance_secrets: ['secret'],
  lan_outbox: ['body'], // 离线队列可能含聊天内容
};

const BACKUP_FORMAT = 'lingxi-backup';
const BACKUP_VERSION = 1;

export interface BackupFile {
  format: string;
  version: number;
  exportedAt: number;
  appVersion: string;
  tables: Record<string, any[]>;
}

function listUserTables(db: any): string[] {
  const r = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  if (!r[0]) return [];
  return r[0].values.map((v: any[]) => String(v[0]));
}

function tableColumns(db: any, table: string): string[] {
  const r = db.exec(`PRAGMA table_info("${table}")`);
  if (!r[0]) return [];
  return r[0].values.map((v: any[]) => String(v[1]));
}

function dumpTable(db: any, table: string): any[] {
  const cols = tableColumns(db, table);
  if (!cols.length) return [];
  const safeCols = cols.map((c) => `"${c}"`).join(', ');
  const r = db.exec(`SELECT ${safeCols} FROM "${table}"`);
  if (!r[0]) return [];
  const names = r[0].columns;
  return r[0].values.map((row: any[]) => {
    const obj: Record<string, any> = {};
    names.forEach((n: string, i: number) => { obj[n] = row[i]; });
    return obj;
  });
}

function sanitizeRow(table: string, row: Record<string, any>): Record<string, any> {
  const out = { ...row };
  for (const c of SENSITIVE_COLUMNS[table] || []) {
    if (c in out) out[c] = null;
  }
  return out;
}

/** 备份导出前解密 messages.content（备份文件里存明文，敏感列仍由 sanitizeRow 置空） */
function decRowForBackup(row: Record<string, any>): Record<string, any> {
  if (row && typeof row === 'object' && 'content' in row) {
    try {
      row = { ...row, content: decryptField(row.content as any) };
    } catch { /* 解密失败保持原样 */ }
  }
  return row;
}

/** 导出全量备份（敏感列脱敏） */
export function exportBackup(appVersion = '0.0.0'): BackupFile {
  const db = getDB();
  if (!db) throw new Error('DB 未初始化');
  const tables: Record<string, any[]> = {};
  for (const t of listUserTables(db)) {
    tables[t] = dumpTable(db, t).map((row) => sanitizeRow(t, t === 'messages' ? decRowForBackup(row) : row));
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    appVersion,
    tables,
  };
}

export interface ImportResult {
  ok: boolean;
  importedTables: string[];
  skippedTables: string[];
  rowCounts: Record<string, number>;
  error?: string;
}

/**
 * 导入备份（全量替换语义）。
 * mode: 'replace'（默认，清空已有数据再导入）
 */
export function importBackup(data: unknown, mode: 'replace' | 'merge' = 'replace'): ImportResult {
  const db = getDB();
  if (!db) return { ok: false, importedTables: [], skippedTables: [], rowCounts: {}, error: 'DB 未初始化' };

  const b = data as BackupFile;
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT || !b.tables || typeof b.tables !== 'object') {
    return { ok: false, importedTables: [], skippedTables: [], rowCounts: {}, error: '不是有效的灵犀备份文件（format 字段不匹配）' };
  }

  const existing = new Set(listUserTables(db));
  const importedTables: string[] = [];
  const skippedTables: string[] = [];
  const rowCounts: Record<string, number> = {};

  try {
    db.run('BEGIN');
    for (const [table, rows] of Object.entries(b.tables)) {
      if (!existing.has(table)) { skippedTables.push(table); continue; }
      if (!Array.isArray(rows)) { skippedTables.push(table + '(非数组)'); continue; }
      const cols = tableColumns(db, table);
      if (!cols.length) { skippedTables.push(table); continue; }

      if (mode === 'replace') {
        db.run(`DELETE FROM "${table}"`);
      }
      const safeCols = cols.map((c) => `"${c}"`).join(', ');
      const placeholders = cols.map(() => '?').join(', ');
      const stmt = db.prepare(`INSERT OR REPLACE INTO "${table}" (${safeCols}) VALUES (${placeholders})`);
      let count = 0;
      for (const rawRow of rows) {
        let row = sanitizeRow(table, rawRow as Record<string, any>);
        if (table === 'messages' && row && 'content' in row && row.content) {
          try {
            row = { ...row, content: encryptField(String(row.content)) };
          } catch { /* 加密失败保持明文 */ }
        }
        const values = cols.map((c) => (c in row ? row[c] : null));
        stmt.run(values);
        count++;
      }
      stmt.free();
      importedTables.push(table);
      rowCounts[table] = count;
    }
    db.run('COMMIT');
    markDirty();
    void saveToDisk();
    return { ok: true, importedTables, skippedTables, rowCounts };
  } catch (e: any) {
    try { db.run('ROLLBACK'); } catch { /* ignore */ }
    return { ok: false, importedTables, skippedTables, rowCounts, error: e?.message || String(e) };
  }
}

/** 列出当前库所有用户表名（供健康检查/调试） */
export function listTables(): string[] {
  const db = getDB();
  return db ? listUserTables(db) : [];
}
