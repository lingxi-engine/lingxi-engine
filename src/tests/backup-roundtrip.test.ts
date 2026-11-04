/**
 * 备份导出/导入 单元测试
 * 覆盖：格式校验、全量替换、敏感列脱敏、事务回滚
 */
import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';

// 直接操作一个独立 sql.js 实例，再通过模块内部 getDB 指向它
// 由于 db.ts 用模块级 _db，这里用 initDB 指到临时文件
import { initDB, closeDB, getDB, createFullUser, createChat, addMessage, markDirty } from '../storage/db.js';
import { exportBackup, importBackup } from '../storage/backup.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const tmpFile = path.join(os.tmpdir(), `lingxi-test-backup-${Date.now()}.db`);

beforeEach(async () => {
  try { fs.unlinkSync(tmpFile); } catch {}
  await initDB(tmpFile);
});

describe('backup export/import', () => {
  it('导出包含所有用户表，敏感列被脱敏', async () => {
    createFullUser({ id: 'u1', numericId: 10001, email: 'a@b.c', passwordHash: 'HASH_SECRET', displayName: 'A' });
    createChat('chat-1', 'private');
    addMessage({ id: 'm1', chatId: 'chat-1', senderType: 'user', senderId: 'u1', content: '你好', type: 'text', timestamp: Date.now() });

    const bak = exportBackup('2.0.37');
    expect(bak.format).toBe('lingxi-backup');
    expect(bak.tables.users.length).toBe(1);
    // 敏感列脱敏
    expect(bak.tables.users[0].password_hash).toBeNull();
    // 非敏感列保留
    expect(bak.tables.users[0].email).toBe('a@b.c');
    expect(bak.tables.messages[0].content).toBe('你好');
  });

  it('导入为全量替换：旧数据被清空', async () => {
    createFullUser({ id: 'u-old', numericId: 1, email: 'old@x.y', passwordHash: 'H', displayName: 'Old' });
    const bak = exportBackup('2.0.37');

    // 改动：删掉 u-old，加 u-new
    const db = getDB();
    db.run("DELETE FROM users WHERE id = 'u-old'");
    createFullUser({ id: 'u-new', numericId: 2, email: 'new@x.y', passwordHash: 'H2', displayName: 'New' });

    const r = importBackup(bak, 'replace');
    expect(r.ok).toBe(true);
    const users = db.exec('SELECT id FROM users')[0]?.values.map((v: any[]) => v[0]) || [];
    expect(users).toContain('u-old');
    expect(users).not.toContain('u-new');
    // 导入后敏感列仍为空（防备份被篡改回写）
    const row = db.exec("SELECT password_hash FROM users WHERE id='u-old'")[0]?.values[0]?.[0];
    expect(row === null || row === '').toBe(true);
  });

  it('拒绝非法格式', () => {
    const r = importBackup({ hello: 'world' }, 'replace');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/备份/);
  });

  it('跳过不存在的表而不报错', async () => {
    createChat('c1', 'private');
    const bak = exportBackup('2.0.37');
    bak.tables.nonexistent_table = [{ a: 1 }];
    const r = importBackup(bak, 'replace');
    expect(r.ok).toBe(true);
    expect(r.skippedTables).toContain('nonexistent_table');
  });

  it('searchMessages 能搜到内容并按时间正序返回', async () => {
    const { searchMessages } = await import('../storage/db.js');
    createChat('c1', 'private');
    addMessage({ id: 'm1', chatId: 'c1', senderType: 'user', senderId: 'u', content: '苹果好吃', type: 'text', timestamp: 1000 });
    addMessage({ id: 'm2', chatId: 'c1', senderType: 'user', senderId: 'u', content: '香蕉也好', type: 'text', timestamp: 2000 });
    addMessage({ id: 'm3', chatId: 'c1', senderType: 'user', senderId: 'u', content: '苹果派', type: 'text', timestamp: 3000 });
    const hits = searchMessages('苹果', { chatId: 'c1' });
    expect(hits.length).toBe(2);
    expect(hits[0].timestamp).toBe(1000);
    expect(hits[1].timestamp).toBe(3000);
  });
});
