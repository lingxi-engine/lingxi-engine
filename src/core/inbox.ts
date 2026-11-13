/**
 * 收件箱 - Inbox Manager
 * Cron/子代理/Hook 的执行结果存到 data/inbox/ 文件夹
 * 每个收件一个 JSON 文件 + DB 记录索引
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';

export type InboxType = 'cron' | 'subagent' | 'hook' | 'system' | 'webhook' | 'audit';

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
    this.inboxDir = join(dataDir, 'inbox');
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
      filePath = join(this.inboxDir, `${id}.txt`);
      writeFileSync(filePath, content, 'utf-8');
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
      return readFileSync(item.filePath, 'utf-8');
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
      try { unlinkSync(item.filePath); } catch {}
    }
    
    this.items.delete(id);
    if (this.db) {
      try {
        this.db.run(`DELETE FROM inbox WHERE id = ?`, [id]);
      } catch {}
    }
    return true;
  }

  /**
   * 清空已读
   */
  clearRead(): number {
    let count = 0;
    for (const [id, item] of this.items) {
      if (item.read) {
        this.delete(id);
        count++;
      }
    }
    console.log(`[Inbox] 清理 ${count} 条已读`);
    return count;
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
          const data = JSON.parse(readFileSync(join(this.inboxDir, f), 'utf-8'));
          this.items.set(data.id, data);
        } catch {}
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

/**
 * 审计日志辅助函数
 * 记录 RBAC 变更、模板修改、权限调整等安全相关操作
 */
export function addAuditLog(inbox: InboxManager, action: string, details: Record<string, any>, agentId?: string) {
  return inbox.add('audit', `审计: ${action}`, JSON.stringify(details, null, 2), agentId);
}