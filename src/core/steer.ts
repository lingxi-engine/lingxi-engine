
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export interface SteerCommand {
  type: 'redirect' | 'supplement' | 'priority' | 'cancel';
  message: string;
  timestamp: number;
  priority?: number;
}

export interface SteerState {
  taskId: string;
  active: boolean;
  commands: SteerCommand[];
  lastUpdated: number;
}

export class SteerManager {
  private states: Map<string, SteerState> = new Map();

  send(taskId: string, type: SteerCommand['type'], message: string): boolean {
    let state = this.states.get(taskId);
    if (!state) {
      state = { taskId, active: true, commands: [], lastUpdated: Date.now() };
      this.states.set(taskId, state);
    }
    const cmd: SteerCommand = { type, message, timestamp: Date.now(), priority: 1 };
    state.commands.push(cmd);
    state.lastUpdated = Date.now();
    return true;
  }

  poll(taskId: string): SteerCommand | null {
    const state = this.states.get(taskId);
    if (!state || state.commands.length === 0) return null;
    state.commands.sort((a, b) => (b.priority || 1) - (a.priority || 1));
    const cmd = state.commands.shift()!;
    state.lastUpdated = Date.now();
    return cmd;
  }

  getPending(taskId: string): SteerCommand[] {
    const state = this.states.get(taskId);
    return state ? state.commands : [];
  }

  clear(taskId: string): boolean {
    const state = this.states.get(taskId);
    if (!state) return false;
    state.commands.splice(0);
    return true;
  }

  remove(taskId: string): boolean {
    return this.states.delete(taskId);
  }

  toPrompt(taskId: string): string {
    const cmds = this.getPending(taskId);
    if (cmds.length === 0) return '';
    return cmds.map(function(c) {
      var prefix = '[steer]';
      if (c.type === 'redirect') prefix = '[steer-redirect]';
      else if (c.type === 'supplement') prefix = '[steer-supplement]';
      else if (c.type === 'cancel') prefix = '[steer-cancel]';
      return prefix + ' ' + c.message;
    }).join('\n');
  }
}
