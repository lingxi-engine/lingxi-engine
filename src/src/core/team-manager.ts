/**
 * 团队管理器 - 多 AI 团队协作 + 持久化
 * 
 * 修复:
 * - Bug #6: 纯内存 → 写入 hires 和 chats 表 (持久化)
 * - Bug #8: ownerId: number → ownerId: string
 * - Bug #9: 创建团队时在 DB 中创建群聊和参与者
 * - Bug #10: 4字节随机 → 8字节随机 + 时间戳前缀防碰撞
 */

import { randomBytes } from 'crypto';
import { getDB, createChat, addParticipant } from '../storage/db.js';

export interface TeamMember {
  agentId: string;
  role: string;        // 角色：如 "leader"、"coder"、"reviewer"、"writer"
  displayName: string;
  joinedAt: number;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  ownerId: string;     // 修复: number -> string (用户ID是字符串)
  members: TeamMember[];
  chatId: string;       // 团队群聊 ID
  createdAt: number;
  status: 'active' | 'archived';
}

// In-memory cache, synced to DB on changes
const teamsCache = new Map<string, Team>();

// Load existing teams from DB on startup
function loadTeamsFromDB(): void {
  try {
    const d = getDB();
    if (!d) return;
    const stmt = d.prepare("SELECT id, name, description, owner_id, chat_id, created_at, status FROM team_groups");
    const rows: any[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push(row);
    }
    stmt.free();
    
    for (const row of rows) {
      // Load members
      const memStmt = d.prepare("SELECT agent_id, role, display_name, joined_at FROM team_members WHERE team_id = ?");
      memStmt.bind([row.id]);
      const members: TeamMember[] = [];
      while (memStmt.step()) {
        const m = memStmt.getAsObject();
        members.push({
          agentId: m.agent_id,
          role: m.role,
          displayName: m.display_name,
          joinedAt: m.joined_at,
        });
      }
      memStmt.free();
      
      teamsCache.set(row.id, {
        id: row.id,
        name: row.name,
        description: row.description || '',
        ownerId: String(row.owner_id),
        members,
        chatId: row.chat_id,
        createdAt: row.created_at,
        status: row.status || 'active',
      });
    }
    console.log(`[TeamManager] 已从DB恢复 ${teamsCache.size} 个团队`);
  } catch (e: any) {
    // First boot, table may not exist — silently ignore
    if (!e.message?.includes('no such table')) {
      console.warn('[TeamManager] DB加载警告:', e.message);
    }
  }
}

export class TeamManager {
  constructor() {
    loadTeamsFromDB();
  }

  create(name: string, description: string, ownerId: string, chatId?: string): Team {
    // Fix #10: 8字节随机 + 时间戳前缀
    const timestamp = Date.now().toString(36);
    const teamId = 'team-' + timestamp + '-' + randomBytes(8).toString('hex');
    const teamChatId = chatId || `team-chat-${teamId}`;
    
    const team: Team = {
      id: teamId,
      name,
      description: description || '',
      ownerId,
      members: [],
      chatId: teamChatId,
      createdAt: Date.now(),
      status: 'active',
    };
    
    // Fix #9: 在 DB 中创建群聊
    try {
      const existingChat = getDB().prepare("SELECT id FROM chats WHERE id = ?");
      existingChat.bind([teamChatId]);
      if (!existingChat.step()) {
        existingChat.free();
        createChat(teamChatId, 'group');
        // 添加创建者(owner)为参与者
        addParticipant('p-team-' + teamId + '-owner', teamChatId, ownerId, undefined, 'owner');
      } else {
        existingChat.free();
      }
    } catch (e: any) {
      console.warn('[TeamManager] 创建群聊失败:', e.message);
    }
    
    // 写入DB (team_groups 表)
    this.saveTeamToDB(team);
    
    teamsCache.set(teamId, team);
    return team;
  }

  addMember(teamId: string, agentId: string, role: string, displayName: string): boolean {
    const team = teamsCache.get(teamId);
    if (!team) return false;
    if (team.members.some(m => m.agentId === agentId)) return false;
    
    team.members.push({
      agentId,
      role: role || 'member',
      displayName,
      joinedAt: Date.now(),
    });
    
    // 同步到DB
    this.saveMemberToDB(teamId, agentId, role || 'member', displayName);
    
    // 将AI作为参与者添加到群聊
    try {
      addParticipant('p-team-' + teamId + '-' + agentId, team.chatId, undefined, agentId, role || 'member');
    } catch (_e) { /* 可能已存在 */ }
    
    return true;
  }

  removeMember(teamId: string, agentId: string): boolean {
    const team = teamsCache.get(teamId);
    if (!team) return false;
    const idx = team.members.findIndex(m => m.agentId === agentId);
    if (idx === -1) return false;
    team.members.splice(idx, 1);
    
    // 从DB删除
    try {
      const d = getDB();
      d.run("DELETE FROM team_members WHERE team_id = ? AND agent_id = ?", [teamId, agentId]);
    } catch (_e) {}
    
    return true;
  }

  get(teamId: string): Team | undefined {
    return teamsCache.get(teamId);
  }

  list(ownerId?: string): Team[] {
    const all = Array.from(teamsCache.values());
    if (ownerId) return all.filter(t => t.ownerId === ownerId);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  }

  getChatId(teamId: string): string | undefined {
    return teamsCache.get(teamId)?.chatId;
  }

  findByChatId(chatId: string): Team | undefined {
    for (const team of teamsCache.values()) {
      if (team.chatId === chatId) return team;
    }
    return undefined;
  }

  dispatchTask(teamId: string, taskDescription: string, targetRole?: string): string[] {
    const team = teamsCache.get(teamId);
    if (!team) return [];
    
    let targets = team.members;
    if (targetRole) {
      targets = targets.filter(m => m.role === targetRole);
    }
    
    return targets.map(m => m.agentId);
  }

  archive(teamId: string): boolean {
    const team = teamsCache.get(teamId);
    if (!team) return false;
    team.status = 'archived';
    this.saveTeamToDB(team);
    return true;
  }

  delete(teamId: string): boolean {
    const existed = teamsCache.delete(teamId);
    if (existed) {
      try {
        const d = getDB();
        d.run("DELETE FROM team_members WHERE team_id = ?", [teamId]);
        d.run("DELETE FROM team_groups WHERE id = ?", [teamId]);
      } catch (_e: any) { console.error('[Team] 删除团队 DB 清理失败:', _e?.message); }
    }
    return existed;
  }

  toJSON(teamId: string): Team | null {
    return teamsCache.get(teamId) || null;
  }

  private saveTeamToDB(team: Team): void {
    try {
      const d = getDB();
      // 使用 team_groups 表（需要先在 _dbInit 中创建）
      d.run(`INSERT OR REPLACE INTO team_groups (id, name, description, owner_id, chat_id, created_at, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [team.id, team.name, team.description, team.ownerId, team.chatId, team.createdAt, team.status]);
    } catch (e: any) {
      // First boot, table may not exist
      if (!e.message?.includes('no such table')) {
        console.warn('[TeamManager] 保存失败:', e.message);
      }
    }
  }

  private saveMemberToDB(teamId: string, agentId: string, role: string, displayName: string): void {
    try {
      const d = getDB();
      d.run(`INSERT OR REPLACE INTO team_members (team_id, agent_id, role, display_name, joined_at)
             VALUES (?, ?, ?, ?, ?)`,
        [teamId, agentId, role, displayName, Date.now()]);
    } catch (e: any) {
      if (!e.message?.includes('no such table')) {
        console.warn('[TeamManager] 保存成员失败:', e.message);
      }
    }
  }
}