/**
 * Signal 渠道适配器
 * 需要本地运行 signal-cli
 */

import { MessageRouter } from '../core/router.js';
import { AgentManager } from '../agents/manager.js';
import { DB } from '../storage/db.js';
import { execFile } from 'child_process';

export interface SignalConfig {
  phoneNumber: string;
  signalCliPath?: string;
  defaultUserId?: string;
  defaultChatId?: string;
  enabled: boolean;
}

export class SignalAdapter {
  private config: SignalConfig;
  private router: MessageRouter;
  private manager: AgentManager;
  private db: DB;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(config: SignalConfig, router: MessageRouter, manager: AgentManager, db: DB) {
    this.config = config;
    this.router = router;
    this.manager = manager;
    this.db = db;
  }

  async start(): Promise<boolean> {
    if (!this.config.phoneNumber) {
      console.error('[Signal] 缺少 phoneNumber');
      return false;
    }
    
    // 检查 signal-cli 是否可用
    const cliPath = this.config.signalCliPath || 'signal-cli';
    try {
      await this.execCmd(`${cliPath} --version`);
      console.log('[Signal] signal-cli 可用');
    } catch (err: any) {
      console.error('[Signal] signal-cli 不可用，请安装: https://github.com/AsamK/signal-cli');
      return false;
    }
    
    this.running = true;
    
    // 轮询接收消息（signal-cli 的 JSON RPC 模式更高效，但需要守护进程）
    // 这里用简单的轮询模式
    this.startPolling();
    console.log('[Signal] 已启动（轮询模式）');
    return true;
  }

  private startPolling() {
    const cliPath = this.config.signalCliPath || 'signal-cli';
    // 每 10 秒检查一次新消息
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        const output = await this.execCmd(
          `${cliPath} -u ${this.config.phoneNumber} receive -t 5 --json`
        );
        if (output.trim()) {
          // 解析 JSON 消息
          const lines = output.trim().split('\n');
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              if (msg.envelope?.dataMessage?.message) {
                await this.handleMessage(
                  msg.envelope.source,
                  msg.envelope.dataMessage.message
                );
              }
            } catch (e: any) { if (e.message !== 'no messages') console.warn('[Signal] 消息处理异常:', e.message); }
          }
        }
      } catch (err: any) {
        // 每 1 分钟告警一次（10s 轮询 = 6 次/分钟）
        (this as any)._signalErrCount = ((this as any)._signalErrCount || 0) + 1;
        if ((this as any)._signalErrCount % 6 === 1) {
          console.warn('[Signal] 轮询失败:', (err as any).message?.slice(0, 80));
        }
      }
    }, 10000);
  }

  private async handleMessage(from: string, text: string) {
    if (!text) return;
    console.log(`[Signal] 消息 from ${from}: ${text}`);
    
    const userId = this.config.defaultUserId || 'user-signal';
    const chatId = this.config.defaultChatId || 'chat-signal';
    
    const agent = this.db.getAgentByUserId(userId);
    if (!agent) return;
    
    try {
      const reply = await this.router.generateReply(chatId, agent.agent_id || agent.id, 'signal-' + Date.now());
      if (reply) {
        await this.sendReply(from, reply);
      }
    } catch (err: any) {
      console.error('[Signal] 回复失败:', err.message);
    }
  }

  private async sendReply(to: string, text: string) {
    const cliPath = this.config.signalCliPath || 'signal-cli';
    try {
      // 安全执行：用 execFile 数组参数，避免命令注入
      const safeText = text.slice(0, 2000);
      await this.execFileCmd(cliPath, ['-u', this.config.phoneNumber, 'send', '-m', safeText, to]);
    } catch (err: any) {
      console.error('[Signal] 发送失败:', err.message);
    }
  }

  private execFileCmd(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  private execCmd(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // v2 安全修复：拒绝复合命令/管道/重定向
      if (/[;&|`$()<>]/.test(cmd)) {
        return reject(new Error('命令包含不安全字符'));
      }
      const parts = cmd.split(/\s+/).filter(Boolean);
      const bin = parts[0];
      const args = parts.slice(1);
      execFile(bin, args, { timeout: 30000, shell: false }, (err: any, stdout: any, stderr: any) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  stop() {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    console.log('[Signal] 已停止');
  }
}