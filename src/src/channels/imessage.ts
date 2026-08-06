/**
 * iMessage 渠道适配器
 * 仅 macOS，通过 AppleScript 发送消息
 * 接收消息需要使用 macOS 的 Messages app + AppleScript 监控
 */

import { MessageRouter } from '../core/router.js';
import { AgentManager } from '../agents/manager.js';
import { DB } from '../storage/db.js';
import { exec, execFile } from 'child_process';

export interface IMessageConfig {
  appleScript: string;      // AppleScript 脚本路径
  defaultUserId?: string;
  defaultChatId?: string;
  enabled: boolean;
}

export class IMessageAdapter {
  private config: IMessageConfig;
  private router: MessageRouter;
  private manager: AgentManager;
  private db: DB;
  private running = false;

  constructor(config: IMessageConfig, router: MessageRouter, manager: AgentManager, db: DB) {
    this.config = config;
    this.router = router;
    this.manager = manager;
    this.db = db;
  }

  async start(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      console.error('[iMessage] 仅支持 macOS');
      return false;
    }
    
    if (!this.config.appleScript) {
      console.error('[iMessage] 缺少 appleScript 路径');
      return false;
    }
    
    this.running = true;
    console.log('[iMessage] 已启动（仅发送，接收需要额外配置）');
    return true;
  }

  /**
   * 发送 iMessage
   */
  async send(to: string, text: string): Promise<boolean> {
    try {
      // 安全执行：用 execFile 数组参数，避免 AppleScript 注入
      const safeText = text.slice(0, 2000);
      await this.execFileCmd('osascript', [this.config.appleScript, to, safeText]);
      console.log(`[iMessage] 已发送给 ${to}`);
      return true;
    } catch (err: any) {
      console.error('[iMessage] 发送失败:', err.message);
      return false;
    }
  }

  private execCmd(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(cmd, { timeout: 15000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  private execFileCmd(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 15000 }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  stop() {
    this.running = false;
    console.log('[iMessage] 已停止');
  }
}