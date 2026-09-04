/**
 * 收件箱 - Inbox Manager
 * Cron/子代理/Hook 的执行结果存到 data/inbox/ 文件夹
 * 每个收件一个 JSON 文件 + DB 记录索引
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import * as path from 'path';

export type InboxType = 'cron' | 'subagent' | 'hook' | 'system';

export interface InboxItem {
  id: string;
  type: InboxType;
  title: string;
  content: string;       // 摘要
  filePath?: string;     // 完整内容文件路径
  agentId?: string;
  read: boolean;
  createdAt: number;
}

export class InboxManager {
  private inboxDir: string;
  private db: any; // Database instance
  private items: Map<string, InboxItem> = new Map();

  constructor(dataDir: string, db?: any) {
    this.inboxDir = path.join(dataDir, 'inbox');
    if (!existsSync(this.inboxDir)) {
      mkdirSync(this.inboxDir, { recursive: true });
    }
    this.db = db;
    this.ensureTable();
    this.load();
  }

  /**
   * 确保数据表存在
   */
  private ensureTable() {
    if (!this.db) return;
    try {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS inbox (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT,
          file_path TEXT,
          agent_id TEXT,
          read INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL
        )
      `);
    } catch (err: any) {
      console.error('[Inbox] 建表失败:', err.message);
    }
  }

  /**
   * 添加收件项
   */
  add(type: InboxType, title: string, content: string, agentId?: string): InboxItem {
    const id = `inb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();

    // 完整内容存文件
    let filePath: string | undefined;
    if (content.length > 500) {
      filePath = path.join(this.inboxDir, `${id}.txt`);
      try {
        writeFileSync(filePath, content, 'utf-8');
      } catch (e: any) {
        console.error('[Inbox] 写入文件失败:', e.message);
        filePath = undefined;
      }
    }

    const item: InboxItem = {
      id,
      type,
      title,
      content: content.length > 500 ? content.slice(0, 500) + '...' : content,
      filePath,
      agentId,
      read: false,
      createdAt,
    };
    this.items.set(id, item);

    // 写入 DB
    if (this.db) {
      try {
        this.db.run(
          `INSERT INTO inbox (id, type, title, content, file_path, agent_id, read, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
          [id, type, title, item.content, filePath || null, agentId || null, createdAt]
        );
      } catch (err: any) {
        console.error('[Inbox] DB 写入失败:', err.message);
      }
    }

    console.log(`[Inbox] 新收件: ${id} (${type}) ${title}`);
    return item;
  }

  /**
   * 列表
   */
  list(limit = 50, unreadOnly = false): InboxItem[] {
    let items = Array.from(this.items.values())
      .sort((a, b) => b.createdAt - a.createdAt);
    if (unreadOnly) items = items.filter(i => !i.read);
    return items.slice(0, limit);
  }

  /**
   * 获取单条
   */
  get(id: string): InboxItem | undefined {
    return this.items.get(id);
  }

  /**
   * 获取完整内容
   */
  getFullContent(id: string): string {
    const item = this.items.get(id);
    if (!item) return '';
    if (item.filePath && existsSync(item.filePath)) {
      try {
        // 安全检查：确保 filePath 在 inboxDir 下，防止路径跳出
        const abs = path.resolve(item.filePath);
        const base = path.resolve(this.inboxDir);
        if (!(abs === base || abs.startsWith(base + path.sep))) {
          console.warn(`[Inbox] 拒绝访问 inbox 文件（非 inboxDir）：${item.filePath}`);
          return '';
        }
        return readFileSync(abs, 'utf-8');
      } catch (e: any) {
        console.error('[Inbox] 读取文件失败:', e.message);
        return '';
      }
    }
    return item.content;
  }

  /**
   * 标记已读
   */
  markRead(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.read = true;
    if (this.db) {
      try {
        this.db.run(`UPDATE inbox SET read = 1 WHERE id = ?`, [id]);
      } catch (err: any) {
        console.error('[Inbox] 更新失败:', err.message);
      }
    }
    return true;
  }

  /**
   * 删除
   */
  delete(id: string): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    
    // 删除文件
    if (item.filePath && existsSync(item.filePath)) {
      try {
        const abs = path.resolve(item.filePath);
        const base = path.resolve(this.inboxDir);
        if (!(abs === base || abs.startsWith(base + path.sep))) {
          console.warn(`[Inbox] 拒绝删除非 inbox 文件：${item.filePath}`);
        } else {
          unlinkSync(abs);
        }
      } catch (e: any) {
        console.error('[Inbox] 删除文件失败:', e.message);
      }
    }
    
    this.items.delete(id);
    if (this.db) {
      try {
        this.db.run(`DELETE FROM inbox WHERE id = ?`, [id]);
      } catch (e: any) {
        console.error('[Inbox] DB 删除失败:', e.message);
      }
    }
    return true;
  }

  /**
   * 清空已读
   */
  clearRead(): number {
    const toDelete: string[] = [];
    for (const [id, item] of this.items) {
      if (item.read) toDelete.push(id);
    }
    for (const id of toDelete) {
      try {
        this.delete(id);
      } catch (e: any) {
        console.error('[Inbox] 清理已读时删除项失败:', e.message);
      }
    }
    console.log(`[Inbox] 清理 ${toDelete.length} 条已读`);
    return toDelete.length;
  }

  /**
   * 未读数量
   */
  unreadCount(): number {
    return Array.from(this.items.values()).filter(i => !i.read).length;
  }

  /**
   * 从 DB 加载
   */
  private load() {
    if (!this.db) {
      // 无 DB 时从文件夹加载
      if (!existsSync(this.inboxDir)) return;
      const files = readdirSync(this.inboxDir).filter(f => f.endsWith('.meta.json'));
      for (const f of files) {
        try {
          const data = JSON.parse(readFileSync(path.join(this.inboxDir, f), 'utf-8'));
          this.items.set(data.id, data);
        } catch (e: any) {
          console.error('[Inbox] 加载元数据失败:', e.message);
        }
      }
      return;
    }

    try {
      // sql.js 不支持 .all()，用 .exec() 获取结果
      const stmt = this.db.prepare(`SELECT * FROM inbox ORDER BY created_at DESC LIMIT 200`);
      while (stmt.step()) {
        const row = stmt.getAsObject();
        this.items.set(row.id, {
          id: row.id,
          type: row.type,
          title: row.title,
          content: row.content || '',
          filePath: row.file_path || undefined,
          agentId: row.agent_id || undefined,
          read: row.read === 1,
          createdAt: row.created_at,
        });
      }
      stmt.free();
    } catch (err: any) {
      console.error('[Inbox] 加载失败:', err.message);
    }
  }
}
