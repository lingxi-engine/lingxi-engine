/**
 * 审批流 - Approval Manager
 * 危险操作需用户批准后才执行
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

export interface ApprovalRequest {
  id: string;
  agentId: string;
  action: string;          // 操作描述：如 "write_file /etc/passwd"
  tool: string;            // 工具名
  args: Record<string, any>; // 工具参数
  risk: 'low' | 'medium' | 'high';
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  reason?: string;
  timeoutMs: number;
}

export class ApprovalManager {
  private pending: Map<string, ApprovalRequest> = new Map();
  private history: ApprovalRequest[] = [];
  private timeoutMs: number;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private resolvers: Map<string, (req: ApprovalRequest) => void> = new Map();

  constructor(timeoutMs = parseInt(process.env.APPROVAL_TIMEOUT || '300000', 10)) { // 默认 5 分钟，可通过环境变量配置
    this.timeoutMs = timeoutMs;
  }

  /**
   * 创建审批请求
   */
  request(agentId: string, tool: string, args: Record<string, any>, action?: string, risk: 'low' | 'medium' | 'high' = 'medium'): ApprovalRequest {
    const id = `apr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const req: ApprovalRequest = {
      id,
      agentId,
      action: action || `${tool}(${Object.keys(args).join(', ')})`,
      tool,
      args,
      risk,
      status: 'pending',
      createdAt: Date.now(),
      timeoutMs: this.timeoutMs,
    };
    this.pending.set(id, req);

    // 超时自动拒绝
    const timer = setTimeout(() => {
      this.expire(id);
    }, this.timeoutMs);
    this.timers.set(id, timer);

    console.log(`[Approval] 新请求 ${id}: ${req.action} (risk=${risk})`);
    return req;
  }

  /**
   * 批准
   */
  approve(id: string, by?: string): boolean {
    const req = this.pending.get(id);
    if (!req || req.status !== 'pending') return false;
    req.status = 'approved';
    req.decidedAt = Date.now();
    req.decidedBy = by;
    this.history.push(req);
    this.pending.delete(id);
    this.clearTimer(id);
    const resolver = this.resolvers.get(id);
    if (resolver) { this.resolvers.delete(id); resolver(req); }
    const waitTimer = this.timers.get(id + '-wait'); if (waitTimer) clearTimeout(waitTimer);
    console.log(`[Approval] 批准 ${id}`);
    return true;
  }

  /**
   * 拒绝
   */
  reject(id: string, by?: string, reason?: string): boolean {
    const req = this.pending.get(id);
    if (!req || req.status !== 'pending') return false;
    req.status = 'rejected';
    req.decidedAt = Date.now();
    req.decidedBy = by;
    req.reason = reason;
    this.history.push(req);
    this.pending.delete(id);
    this.clearTimer(id);
    const resolver2 = this.resolvers.get(id);
    if (resolver2) { this.resolvers.delete(id); resolver2(req); }
    const waitTimer2 = this.timers.get(id + '-wait'); if (waitTimer2) clearTimeout(waitTimer2);
    console.log(`[Approval] 拒绝 ${id}: ${reason || ''}`);
    return true;
  }

  /**
   * 超时
   */
  private expire(id: string) {
    const req = this.pending.get(id);
    if (!req) return;
    // 竞态保护：如果已被 approve/reject，不再覆盖
    if (req.status !== 'pending') return;
    req.status = 'timeout';
    req.decidedAt = Date.now();
    this.history.push(req);
    this.pending.delete(id);
    this.clearTimer(id);
    const resolver3 = this.resolvers.get(id);
    if (resolver3) { this.resolvers.delete(id); resolver3(req); }
    const waitTimer3 = this.timers.get(id + '-wait'); if (waitTimer3) clearTimeout(waitTimer3);
    console.log(`[Approval] 超时 ${id}`);
  }

  /**
   * 等待审批结果（Promise 版）
   */
  waitForApproval(id: string): Promise<ApprovalRequest> {
    return new Promise((resolve) => {
      const req = this.pending.get(id);
      if (!req) {
        resolve({ id, status: 'rejected', decidedAt: Date.now(), createdAt: Date.now(), userId: '', tool: '', args: {} } as unknown as ApprovalRequest);
        return;
      }
      if (req.status !== 'pending') {
        resolve(req);
        return;
      }

      // 回调通知：approve/reject/expire 时直接 resolve
      this.resolvers.set(id, resolve);

      // 超时兜底
      const timeout = setTimeout(() => {
        this.resolvers.delete(id);
        const r = this.pending.get(id) || this.history.find(h => h.id === id);
        resolve(r || { ...req, status: 'timeout' });
      }, this.timeoutMs + 1000);
      this.timers.set(id + '-wait', timeout);
    });
  }

  /**
   * 获取待审批列表
   */
  getPending(): ApprovalRequest[] {
    return Array.from(this.pending.values());
  }

  /**
   * 获取历史
   */
  getHistory(limit = 50): ApprovalRequest[] {
    return this.history.slice(-limit);
  }

  /**
   * 判断操作是否需要审批
   */
  needsApproval(tool: string, args: Record<string, any>): boolean {
    const dangerousTools = ['write_file', 'code_execute', 'browser_navigate', 'shell_exec', 'delete_file', 'rename_file'];
    if (dangerousTools.includes(tool)) return true;

    // shell_exec 危险命令检测
    if (tool === 'shell_exec' && args.command) {
      const cmd = String(args.command);
      const dangerousCmds = ['git clone', 'git push', 'npm install -g', 'pip install', 'rm -rf', 'rmdir /s',
        'sudo ', 'chmod 777', 'chown ', 'mkfs', 'dd if=', 'format ', 'shutdown', 'reboot',
        'docker rm', 'docker rmi', 'kubectl delete', 'wget ', 'curl.*|.*sh', '> /dev/'];
      if (dangerousCmds.some(c => cmd.toLowerCase().includes(c))) return true;
    }
    
    // 写系统目录需审批
    if (tool === 'write_file' && args.path) {
      const sysPaths = ['/etc', '/usr', '/bin', 'C:\\Windows', 'C:\\Program'];
      if (sysPaths.some(p => String(args.path).startsWith(p))) return true;
    }
    
    return false;
  }

  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }
}