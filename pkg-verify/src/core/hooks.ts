/**
 * 生命周期事件 - Hook Manager
 * 在关键事件触发时执行绑定的回调
 */

import { existsSync, writeFileSync, readFileSync } from 'fs';
import { exec, execFile } from 'child_process';

export type HookEvent =
  | 'messageReceived'
  | 'preToolUse'
  | 'postToolUse'
  | 'agentReply'
  | 'cronExecuted'
  | 'sessionStart'
  | 'sessionEnd';

export interface Hook {
  id: string;
  event: HookEvent;
  name: string;
  priority: number;        // 数字越大越先执行
  enabled: boolean;
  filter?: Record<string, any>; // 条件过滤
  action: string;          // 要执行的命令或脚本路径
  createdAt: number;
  lastTriggered?: number;
  triggerCount: number;
}

export interface HookContext {
  event: HookEvent;
  agentId?: string;
  userId?: string;
  chatId?: string;
  tool?: string;
  args?: Record<string, any>;
  result?: any;
  message?: string;
  timestamp: number;
}

export class HookManager {
  private hooks: Map<string, Hook> = new Map();
  private stateFile: string;

  constructor(dataDir: string) {
    this.stateFile = `${dataDir}/hooks.json`;
    this.load();
  }

  /**
   * 注册 Hook
   */
  register(event: HookEvent, name: string, action: string, priority = 0, filter?: Record<string, any>): Hook {
    const id = `hook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const hook: Hook = {
      id,
      event,
      name,
      priority,
      enabled: true,
      filter,
      action,
      createdAt: Date.now(),
      triggerCount: 0,
    };
    this.hooks.set(id, hook);
    this.save();
    console.log(`[Hooks] 注册 ${id}: ${name} → ${event}`);
    return hook;
  }

  /**
   * 触发事件
   */
  async trigger(event: HookEvent, ctx: HookContext): Promise<string[]> {
    const hooks = Array.from(this.hooks.values())
      .filter(h => h.enabled && h.event === event)
      .sort((a, b) => b.priority - a.priority);

    const results: string[] = [];
    for (const hook of hooks) {
      // 条件过滤
      if (hook.filter && !this.matchFilter(hook.filter, ctx)) continue;

      try {
        const result = await this.executeHook(hook, ctx);
        hook.lastTriggered = Date.now();
        hook.triggerCount++;
        results.push(result);
      } catch (err: any) {
        console.error(`[Hooks] 执行 ${hook.id} 失败:`, err.message);
        results.push(`error: ${err.message}`);
      }
    }
    this.save();
    return results;
  }

  /**
   * 执行 Hook
   */
  private async executeHook(hook: Hook, ctx: HookContext): Promise<string> {
    // 替换 action 中的变量
    const cmd = hook.action
      .replace(/\{event\}/g, ctx.event)
      .replace(/\{agentId\}/g, ctx.agentId || '')
      .replace(/\{userId\}/g, ctx.userId || '')
      .replace(/\{chatId\}/g, ctx.chatId || '')
      .replace(/\{tool\}/g, ctx.tool || '')
      .replace(/\{message\}/g, (ctx.message || '').replace(/"/g, '\\"'))
      .replace(/\{timestamp\}/g, String(ctx.timestamp));

    // 安全执行：用 execFile 数组参数，避免命令注入
    const parts = cmd.split(/\s+/);
    const cmdName = parts[0];
    const baseArgs = parts.slice(1);

    return new Promise((resolve, reject) => {
      execFile(cmdName, baseArgs, { timeout: 10000 }, (err: any, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve(stdout.trim() || stderr.trim());
      });
    });
  }

  /**
   * 条件匹配
   */
  private matchFilter(filter: Record<string, any>, ctx: HookContext): boolean {
    for (const [key, value] of Object.entries(filter)) {
      const ctxValue = (ctx as any)[key];
      if (ctxValue !== value) {
        // 字符串包含匹配
        if (typeof ctxValue === 'string' && typeof value === 'string') {
          if (!ctxValue.includes(value)) return false;
        } else {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * 列出所有 Hook
   */
  list(): Hook[] {
    return Array.from(this.hooks.values());
  }

  /**
   * 获取指定事件的 Hook
   */
  getByEvent(event: HookEvent): Hook[] {
    return this.list().filter(h => h.event === event && h.enabled);
  }

  /**
   * 删除 Hook
   */
  remove(id: string): boolean {
    const ok = this.hooks.delete(id);
    if (ok) this.save();
    return ok;
  }

  /**
   * 启用/禁用
   */
  setEnabled(id: string, enabled: boolean) {
    const h = this.hooks.get(id);
    if (h) {
      h.enabled = enabled;
      this.save();
    }
  }

  /**
   * 保存
   */
  private save() {
    try {
      const data = Array.from(this.hooks.values());
      writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch (err: any) {
      console.error('[Hooks] 保存失败:', err.message);
    }
  }

  /**
   * 加载
   */
  private load() {
    try {
      if (!existsSync(this.stateFile)) return;
      const data = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      for (const h of data) {
        this.hooks.set(h.id, h);
      }
    } catch {
      // ignore
    }
  }
}