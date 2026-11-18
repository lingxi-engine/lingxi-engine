/**
 * 2026-11-18 friendships.role 迁移回归测试
 * 根因复现：老库 friendships 无 role 列（建表 SQL 后加的列，CREATE IF NOT EXISTS 对老库空操作，
 *           迁移清单又漏了 role）→ sendFriendRequest/acceptFriendRequest 写 role 必炸
 *           "table friendships has no column named role" → 加好友永远 400。
 * 验证：initDB 迁移自动补 role（NOT NULL DEFAULT 'member'），三条写入路径全通。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { initDB, closeDB, getDB, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, runMigrations } from '../storage/db.js';

let tmpDir: string;
let dbFile: string;
let firstRequestId = '';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingxi-rolefix-'));
  dbFile = path.join(tmpDir, 'main.db');
  // 预建「老版本」friendships 表：无 role 列，模拟升级上来的历史库
  const legacy = new Database(dbFile);
  legacy.exec(`CREATE TABLE friendships (
    id TEXT PRIMARY KEY,
    from_user_id TEXT NOT NULL,
    to_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    message TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    UNIQUE(from_user_id, to_user_id)
  )`);
  legacy.close();
  // initDB：CREATE IF NOT EXISTS 对已有表空操作 → 迁移必须真的 ALTER 补列
  await initDB(dbFile);
  const db = getDB();
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-r1','r1','甲',10001,'online',1)");
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-r2','r2','乙',10002,'online',1)");
  db.run("INSERT INTO users (id, username, display_name, numeric_id, status, created_at) VALUES ('u-r3','r3','丙',10003,'online',1)");
});

afterAll(() => {
  try { closeDB(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('friendships.role 迁移补列（升级库加好友必炸修复）', () => {
  it('迁移后 role 列存在：TEXT NOT NULL DEFAULT member', () => {
    const ro = new Database(dbFile, { readonly: true });
    const cols = ro.prepare('PRAGMA table_info(friendships)').all() as any[];
    ro.close();
    const role = cols.find(c => c.name === 'role');
    expect(role).toBeTruthy();
    expect(String(role.type).toUpperCase()).toBe('TEXT');
    expect(role.notnull).toBe(1);
    expect(String(role.dflt_value)).toContain('member');
  });

  it('INSERT 路径：sendFriendRequest 不再炸 role，新行 role=member', () => {
    const r = sendFriendRequest('u-r1', 'u-r2', '你好，交个朋友');
    expect(r.error).toBeUndefined();
    expect(r.status).toBe('pending');
    firstRequestId = r.id;
    const ro = new Database(dbFile, { readonly: true });
    const row = ro.prepare('SELECT role, message FROM friendships WHERE id = ?').get(r.id) as any;
    ro.close();
    expect(row.role).toBe('member');
    expect(row.message).toBe('你好，交个朋友');
  });

  it('UPDATE 路径：acceptFriendRequest 写 role 不炸', () => {
    expect(firstRequestId).toBeTruthy();
    acceptFriendRequest(firstRequestId);
    const ro = new Database(dbFile, { readonly: true });
    const after = ro.prepare('SELECT status, role FROM friendships WHERE id = ?').get(firstRequestId) as any;
    ro.close();
    expect(after.status).toBe('accepted');
    expect(after.role).toBe('member');
  });

  it('F1 复用路径：拒绝后重加走 UPDATE（含 role）不再 500', () => {
    const first = sendFriendRequest('u-r1', 'u-r3', '第一次');
    expect(first.error).toBeUndefined();
    rejectFriendRequest(first.id);
    const again = sendFriendRequest('u-r1', 'u-r3', '第二次');
    expect(again.error).toBeUndefined();
    expect(again.status).toBe('pending');
    expect(again.id).toBe(first.id); // 复用旧行而非 INSERT 撞 UNIQUE
    const ro = new Database(dbFile, { readonly: true });
    const row = ro.prepare('SELECT status, role, message FROM friendships WHERE id = ?').get(first.id) as any;
    ro.close();
    expect(row.status).toBe('pending');
    expect(row.role).toBe('member');
    expect(row.message).toBe('第二次');
  });

  it('迁移账本：friendships 无漂移残留', () => {
    const st = runMigrations({ autoAddMissingColumns: true, failFast: false });
    expect(st.drift.filter(d => d.startsWith('friendships'))).toEqual([]);
  });
});
