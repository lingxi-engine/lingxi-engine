/**
 * 会话管理器 - Session Manager
 * 
 * v2.0.5: 增加自动跟踪、聊天恢复、重启恢复功能
 * 支持多会话持久化、会话列表、会话切换
 * 解决重启后 session 丢失的问题
 * v2.0.6: 增加 getAllForRestore 方法，完整恢复数据
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

export interface SessionInfo {
  id: string;           // 会话 ID
  label: string;        // 显示名，如 "和松仔聊天"
  chatId: string;       // 关联的聊天 ID
  userId: string;       // 所属用户
  agentIds: string[];   // 参与 Agent
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  pinned: boolean;      // 置顶
  muted: boolean;       // 免打扰
}

export interface SessionMessage {
  id: string;
  chatId: string;
  senderType: 'user' | 'agent' | 'system';
  senderId: string;
  senderName: string;
  content: string;
  type: string;         // text / image / file / system
  replyTo?: string;
  timestamp: number;
}

export interface SessionStore {
  sessions: SessionInfo[];
  activeSessionId: string | null;  // 当前活跃会话
  lastUserId: string | null;
}

/**
 * 会话管理器
 * 
 * - 持久化到 data/sessions.json
 * - 启动时自动加载
 * - 提供增删改查 API
 * - 自动跟踪消息活动（v2.0.5）
 * - 提供完整恢复数据（v2.0.6）
 */
export class SessionManager {
  private store: SessionStore;
  private storePath: string;
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dataDir: string) {
    this.storePath = join(dataDir, 'sessions.json');
    this.store = this.load();
  }

  /** 启动自动保存 */
  startAutoSave(intervalMs: number = 10000): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = setInterval(() => {
      if (this.dirty) { this.save(); this.dirty = false; }
    }, intervalMs);
    if (this.saveTimer && typeof this.saveTimer === 'object' && 'unref' in this.saveTimer) {
      (this.saveTimer as any).unref();
    }
  }

  /** 保存到磁盘 */
  save(): void {
    try {
      writeFileSync(this.storePath, JSON.stringify(this.store, null, 2), 'utf8');
    } catch (err: any) {
      console.error('[SessionManager] 保存失败:', err.message);
    }
  }

  /** 从磁盘加载 */
  private load(): SessionStore {
    try {
      if (existsSync(this.storePath)) {
        const raw = readFileSync(this.storePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch (err: any) {
      console.error('[SessionManager] 加载失败:', err.message);
    }
    return { sessions: [], activeSessionId: null, lastUserId: null };
  }

  // ── 会话 CRUD ──

  /** 创建会话 */
  create(info: Omit<SessionInfo, 'createdAt' | 'lastActiveAt' | 'messageCount' | 'pinned' | 'muted'>): SessionInfo {
    const session: SessionInfo = {
      ...info,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      messageCount: 0,
      pinned: false,
      muted: false,
    };
    this.store.sessions.push(session);
    this.dirty = true;
    return session;
  }

  /** 获取会话 */
  get(id: string): SessionInfo | undefined {
    return this.store.sessions.find(s => s.id === id);
  }

  /** 按 chatId 查找会话 */
  getByChatId(chatId: string): SessionInfo | undefined {
    return this.store.sessions.find(s => s.chatId === chatId);
  }

  /** 获取用户的所有会话 */
  listByUser(userId: string): SessionInfo[] {
    return this.store.sessions
      .filter(s => s.userId === userId)
      .sort((a, b) => {
        // 置顶优先，然后按最后活跃时间倒序
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.lastActiveAt - a.lastActiveAt;
      });
  }

  /** 获取所有会话 */
  listAll(): SessionInfo[] {
    return this.store.sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /** 更新会话 */
  update(id: string, updates: Partial<Pick<SessionInfo, 'label' | 'pinned' | 'muted' | 'agentIds'>>): SessionInfo | undefined {
    const session = this.get(id);
    if (!session) return undefined;
    if (updates.label !== undefined) session.label = updates.label;
    if (updates.pinned !== undefined) session.pinned = updates.pinned;
    if (updates.muted !== undefined) session.muted = updates.muted;
    if (updates.agentIds !== undefined) session.agentIds = updates.agentIds;
    this.dirty = true;
    return session;
  }

  /** 删除会话 */
  delete(id: string): boolean {
    const idx = this.store.sessions.findIndex(s => s.id === id);
    if (idx < 0) return false;
    this.store.sessions.splice(idx, 1);
    if (this.store.activeSessionId === id) this.store.activeSessionId = null;
    this.dirty = true;
    return true;
  }

  /** 活跃会话（标记已读/当前打开） */
  setActive(id: string | null): void {
    this.store.activeSessionId = id;
    if (id) {
      const session = this.get(id);
      if (session) session.lastActiveAt = Date.now();
    }
    this.dirty = true;
  }

  /** 获取活跃会话 */
  getActive(): SessionInfo | null {
    if (!this.store.activeSessionId) return null;
    return this.get(this.store.activeSessionId) || null;
  }

  /** 更新消息计数 */
  bumpMessageCount(id: string): void {
    const session = this.get(id);
    if (session) {
      session.messageCount++;
      session.lastActiveAt = Date.now();
      this.dirty = true;
    }
  }

  /**
   * v2.0.5: 确保 chatId 对应的 session 存在，不存在则自动创建
   * 自动跟踪聊天活动
   */
  ensureSessionForChat(chatId: string, userId: string, label?: string): SessionInfo {
    // 先找已有 session
    let session = this.getByChatId(chatId);
    if (!session) {
      // 自动创建
      session = this.create({
        id: 'sess-' + chatId,
        label: label || chatId.replace(/^(chat-|team-)/, ''),
        chatId,
        userId,
        agentIds: [],
      });
      console.log(`[SessionManager] 自动创建会话: ${session.id} (${session.label})`);
    }
    return session;
  }

  /**
   * v2.0.5: 当收到新消息时调用，自动追踪活跃会话
   */
  onNewMessage(chatId: string, userId: string, label?: string): void {
    const session = this.ensureSessionForChat(chatId, userId, label);
    session.lastActiveAt = Date.now();
    session.messageCount++;
    this.dirty = true;
  }

  /**
   * v2.0.5: 获取重启后用于前端恢复的信息
   * 返回 { lastChatId, sessions }
   */
  getRestoreInfo(): { lastChatId: string | null; activeSessionId: string | null } {
    return {
      lastChatId: this.store.activeSessionId
        ? (this.getActive()?.chatId || null)
        : null,
      activeSessionId: this.store.activeSessionId,
    };
  }

  /**
   * v2.0.6: 获取指定用户的完整恢复数据
   * 返回用户的所有会话列表 + 最后活跃会话ID
   */
  getAllForRestore(userId: string): {
    sessions: SessionInfo[];
    lastChatId: string | null;
    activeSessionId: string | null;
  } {
    const userSessions = this.listByUser(userId);
    const active = this.getActive();
    return {
      sessions: userSessions,
      lastChatId: active?.chatId || (userSessions.length > 0 ? userSessions[0].chatId : null),
      activeSessionId: this.store.activeSessionId,
    };
  }

  /** 设置最后登录用户 */
  setLastUser(userId: string): void {
    this.store.lastUserId = userId;
    this.dirty = true;
  }

  /** 获取最后登录用户 */
  getLastUser(): string | null {
    return this.store.lastUserId;
  }

  /** 关闭 */
  close(): void {
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.save();
  }
}
