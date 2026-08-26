/**
 * 项目目标追踪器 v1.7.1
 * 
 * 功能：
 * - 持久化项目目标到 SQLite（重启不丢，不受 compaction 影响）
 * - 支持子目标嵌套（parent_id）
 * - 自动注入到 system prompt（压缩格式，~200 token/轮）
 * - 完成自动触发 outcome-tracker
 * 
 * Token 开销: 每轮 +200~500 token（固定，不随项目规模增长）
 * 节省: 防止跑偏浪费的 token 远超此开销
 */

import { getDB } from '../storage/db.js';

export type GoalStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';

export interface ProjectGoal {
  id: string;
  projectId: string;
  title: string;
  status: GoalStatus;
  acceptanceCriteria?: string;
  parentId?: string;        // 父目标（支持嵌套）
  order: number;            // 排序
  createdAt: number;
  doneAt?: number;
}

export class GoalTracker {
  /** 目标开始时的回调（由 index.ts 注册，触发 AI 自动执行） */
  static onGoalStarted: ((goal: ProjectGoal) => void) | null = null;
  /** 项目全部完成的回调（由 goals-outcomes.ts 注册，自动生成评分卡） */
  static onProjectCompleted: ((projectId: string) => void) | null = null;

  /**
   * 创建目标
   */
  static create(projectId: string, title: string, acceptanceCriteria?: string, parentId?: string): ProjectGoal {
    const db = getDB();
    const id = 'goal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    const maxOrder = GoalTracker.list(projectId).length;
    
    db.run(
      `INSERT INTO project_goals (id, project_id, title, status, acceptance_criteria, parent_id, "order", created_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [id, projectId, title, acceptanceCriteria || null, parentId || null, maxOrder, Date.now()]
    );
    
    return {
      id, projectId, title, status: 'pending',
      acceptanceCriteria, parentId, order: maxOrder, createdAt: Date.now(),
    };
  }

  /**
   * 标记完成
   */
  static markDone(id: string): boolean {
    const db = getDB();
    const goal = GoalTracker.get(id);
    if (!goal) return false;
    db.run(`UPDATE project_goals SET status = 'done', done_at = ? WHERE id = ?`, [Date.now(), id]);
    
    // 检查是否全部完成 → 触发 outcome
    const all = GoalTracker.list(goal.projectId);
    const done = all.filter(g => g.status === 'done').length;
    if (done === all.length && all.length > 0) {
      console.log(`[GoalTracker] 🎉 项目 ${goal.projectId} 全部完成 (${done}/${all.length})`);
    }
    return true;
  }

  /**
   * 标记进行中
   */
  static markInProgress(id: string): boolean {
    const db = getDB();
    const goal = GoalTracker.get(id);
    if (!goal) return false;
    // 先将该项目其他进行中的目标恢复为 pending
    db.run(`UPDATE project_goals SET status = 'pending' WHERE project_id = ? AND status = 'in_progress'`, [goal.projectId]);
    db.run(`UPDATE project_goals SET status = 'in_progress' WHERE id = ?`, [id]);
    // 触发 onGoalStarted 回调（AI 自动执行）
    try {
      const updated = GoalTracker.get(id);
      if (updated && GoalTracker.onGoalStarted) GoalTracker.onGoalStarted(updated);
    } catch (e: any) { console.error('[GoalTracker] onGoalStarted 回调异常:', e?.message || e); }
    return true;
  }

  /**
   * 恢复目标为待开始
   */
  static markPending(id: string): boolean {
    const db = getDB();
    const goal = GoalTracker.get(id);
    if (!goal) return false;
    db.run(`UPDATE project_goals SET status = 'pending', done_at = NULL WHERE id = ?`, [id]);
    return true;
  }

  /**
   * 取消目标
   */
  static cancel(id: string): boolean {
    const db = getDB();
    db.run(`UPDATE project_goals SET status = 'cancelled' WHERE id = ?`, [id]);
    return true;
  }

  /**
   * 更新目标字段（title / acceptanceCriteria / status 等）
   */
  static update(id: string, fields: Partial<Pick<ProjectGoal, 'title' | 'acceptanceCriteria' | 'status'>>): boolean {
    const db = getDB();
    const goal = GoalTracker.get(id);
    if (!goal) return false;
    const sets: string[] = [];
    const vals: any[] = [];
    if (fields.title !== undefined) { sets.push('title = ?'); vals.push(fields.title); }
    if (fields.acceptanceCriteria !== undefined) { sets.push('acceptance_criteria = ?'); vals.push(fields.acceptanceCriteria); }
    if (fields.status !== undefined) {
      sets.push('status = ?'); vals.push(fields.status);
      if (fields.status === 'done') sets.push('done_at = ?'), vals.push(Date.now());
      else sets.push('done_at = NULL');
    }
    if (sets.length === 0) return true;
    vals.push(id);
    db.run(`UPDATE project_goals SET ${sets.join(', ')} WHERE id = ?`, vals);
    return true;
  }

  /**
   * 彻底删除目标（含以该目标为父目标的子目标）
   */
  static remove(id: string): boolean {
    const db = getDB();
    db.run(`DELETE FROM project_goals WHERE id = ? OR parent_id = ?`, [id, id]);
    return true;
  }

  /**
   * 获取单个目标
   */
  static get(id: string): ProjectGoal | null {
    const db = getDB();
    const stmt = db.prepare('SELECT * FROM project_goals WHERE id = ?');
    stmt.bind([id]);
    if (stmt.step()) {
      const row = stmt.getAsObject() as any;
      stmt.free();
      return GoalTracker._fromRow(row);
    }
    stmt.free();
    return null;
  }

  /**
   * 列出项目的所有目标（按 order 排序）
   */
  static list(projectId: string): ProjectGoal[] {
    const db = getDB();
    const stmt = db.prepare('SELECT * FROM project_goals WHERE project_id = ? ORDER BY "order" ASC');
    stmt.bind([projectId]);
    const goals: ProjectGoal[] = [];
    while (stmt.step()) goals.push(GoalTracker._fromRow(stmt.getAsObject() as any));
    stmt.free();
    return goals;
  }

  /**
   * 获取进度摘要（注入 system prompt 用）
   */
  static getProgressSummary(projectId: string): string {
    const goals = GoalTracker.list(projectId);
    if (goals.length === 0) return '';
    
    const doneCount = goals.filter(g => g.status === 'done').length;
    const emoji: Record<GoalStatus, string> = { pending: '⏳', in_progress: '🔄', done: '✅', cancelled: '❌' };
    
    const lines: string[] = [
      `\n## 项目目标进度 (${doneCount}/${goals.length})`,
    ];
    
    for (const g of goals) {
      const marker = emoji[g.status] || '⏳';
      const criteria = g.acceptanceCriteria ? ` — ${g.acceptanceCriteria}` : '';
      const indent = g.parentId ? '  ' : '';
      lines.push(`${indent}${marker} ${g.order + 1}. ${g.title}${criteria}`);
    }
    
    lines.push('');
    return lines.join('\n');
  }

  /**
   * 获取当前进行中的目标
   */
  static getCurrent(projectId: string): ProjectGoal | null {
    const goals = GoalTracker.list(projectId);
    return goals.find(g => g.status === 'in_progress') || goals.find(g => g.status === 'pending') || null;
  }

  /**
   * 删除项目的所有目标
   */
  static clear(projectId: string): void {
    const db = getDB();
    db.run('DELETE FROM project_goals WHERE project_id = ?', [projectId]);
  }

  /**
   * 是否有进行中的目标
   */
  static isActive(projectId: string): boolean {
    const goals = GoalTracker.list(projectId);
    return goals.some(g => g.status !== 'done' && g.status !== 'cancelled');
  }

  private static _fromRow(row: any): ProjectGoal {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      status: row.status as GoalStatus,
      acceptanceCriteria: row.acceptance_criteria || undefined,
      parentId: row.parent_id || undefined,
      order: row.order || 0,
      createdAt: row.created_at || 0,
      doneAt: row.done_at || undefined,
    };
  }
}

/**
 * 初始化 goal tracker 所需的数据库表
 * 在 index.ts 启动时调用
 */
export function initGoalTrackerTable(): void {
  const db = getDB();
  db.run(`
    CREATE TABLE IF NOT EXISTS project_goals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      acceptance_criteria TEXT,
      parent_id TEXT,
      "order" INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      done_at INTEGER
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_goals_project ON project_goals(project_id)');

  // —— v2.0.13: 迁移：给 project_goals 补 GoalExecutor 闭环执行状态列（老库无此列导致 resumeAll 报 no such column）——
  try {
    const goalCols = db.exec(`PRAGMA table_info(project_goals)`)[0]?.values?.map((r: any) => r[1]) || [];
    const addIf = (col: string, def: string) => {
      if (!goalCols.includes(col)) {
        db.run(`ALTER TABLE project_goals ADD COLUMN ${col} ${def}`);
        console.log(`[GoalTracker] v2.0.13 migration: added ${col} to project_goals`);
      }
    };
    addIf('exec_status', 'TEXT');
    addIf('exec_round', 'INTEGER DEFAULT 0');
    addIf('exec_progress', 'INTEGER DEFAULT 0');
    addIf('exec_log', 'TEXT');
  } catch (e: any) {
    console.warn('[GoalTracker] v2.0.13 migration warning:', e.message);
  }

  console.log('[GoalTracker] 数据库表已初始化');
}
