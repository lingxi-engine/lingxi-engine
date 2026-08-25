/**
 * 审批流 - Approval Manager
 * 危险操作需用户批准后才执行
 *
 * v2 (2026-08-25 改造)：
 *  1. 默认超时改为 10 秒（原 5 分钟）
 *  2. 超时行为从「自动拒绝」改为「自动通过」（无人操作默认放行，留痕可审计）
 *  3. 新增事件回调 onRequest/onDecide，用于前端实时弹窗
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

/** 解析环境变量布尔值：1/true/yes/on 视为开启 */
function envBool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

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

export type ApprovalListener = (req: ApprovalRequest) => void;

export class ApprovalManager {
  private pending: Map<string, ApprovalRequest> = new Map();
  private history: ApprovalRequest[] = [];
  private timeoutMs: number;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private resolvers: Map<string, (req: ApprovalRequest) => void> = new Map();

  private autoApprove: boolean;
  /** 超时自动通过（默认 true）：10 秒不操作 → 自动批准 */
  private autoApproveOnTimeout: boolean;

  private onRequestListeners: ApprovalListener[] = [];
  private onDecideListeners: ApprovalListener[] = [];

  constructor(
    timeoutMs = parseInt(process.env.APPROVAL_TIMEOUT || '10000', 10), // 默认 10 秒
    autoApprove?: boolean,
    autoApproveOnTimeout?: boolean
  ) {
    this.timeoutMs = timeoutMs;
    // 自动批准模式：APPROVAL_AUTO_APPROVE=1/true/yes/on 时开启，所有审批请求立即放行（历史留痕可审计）
    this.autoApprove = autoApprove ?? envBool(process.env.APPROVAL_AUTO_APPROVE);
    if (this.autoApprove) console.log('[Approval] 自动批准模式已开启 (APPROVAL_AUTO_APPROVE) —— 审批请求将自动通过');

    // 超时自动通过：默认开启；环境变量 APPROVAL_AUTO_APPROVE_ON_TIMEOUT=0/false/no/off 可关闭（关闭后超时=自动拒绝）
    if (autoApproveOnTimeout !== undefined) {
      this.autoApproveOnTimeout = autoApproveOnTimeout;
    } else if (process.env.APPROVAL_AUTO_APPROVE_ON_TIMEOUT !== undefined) {
      this.autoApproveOnTimeout = envBool(process.env.APPROVAL_AUTO_APPROVE_ON_TIMEOUT);
    } else {
      this.autoApproveOnTimeout = true;
    }
    console.log(`[Approval] 审批管理器 v2: timeout=${this.timeoutMs}ms, 超时自动通过=${this.autoApproveOnTimeout}`);
  }

  /** 注册「新审批请求」事件（前端弹窗用） */
  onRequest(listener: ApprovalListener): void {
    this.onRequestListeners.push(listener);
  }

  /** 注册「审批已决定」事件（前端关闭弹窗用） */
  onDecide(listener: ApprovalListener): void {
    this.onDecideListeners.push(listener);
  }

  private emitRequest(req: ApprovalRequest) {
    for (const l of this.onRequestListeners) { try { l(req); } catch (_e) {} }
  }

  private emitDecide(req: ApprovalRequest) {
    for (const l of this.onDecideListeners) { try { l(req); } catch (_e) {} }
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

    // 自动批准模式：立即放行（decidedBy='auto' 留痕，可审计）
    if (this.autoApprove) {
      this.approve(id, 'auto');
      return req;
    }

    // 超时处理：默认自动通过，可配置为自动拒绝
    const timer = setTimeout(() => {
      if (this.autoApproveOnTimeout) {
        this.approve(id, 'auto-timeout');
      } else {
        this.expire(id);
      }
    }, this.timeoutMs);
    this.timers.set(id, timer);

    console.log(`[Approval] 新请求 ${id}: ${req.action} (risk=${risk}, timeout=${this.timeoutMs}ms)`);
    // 通知前端弹窗
    this.emitRequest(req);
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
    console.log(`[Approval] 批准 ${id}${by ? ' (' + by + ')' : ''}`);
    this.emitDecide(req);
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
    this.emitDecide(req);
    return true;
  }

  /**
   * 超时（自动拒绝路径，保留向后兼容）
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
    this.emitDecide(req);
  }

  /**
   * 等待审批结果（Promise 版）
   */
  waitForApproval(id: string): Promise<ApprovalRequest> {
    return new Promise((resolve) => {
      // 优先查 pending；若请求已被 approve/reject/expire（含自动批准、HTTP 接口先批），从 history 取，避免竞态误判 rejected
      const req = this.pending.get(id) || this.history.find(h => h.id === id);
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
   * 注意：write_file/code_execute/shell_exec 是 AI 执行任务的常用工具，
   * 如果列为需审批，在无人值守的目标任务中会因超时无人批准而中断。
   * 仅保留真正高危的操作需审批。
   */
  needsApproval(tool: string, args: Record<string, any>): boolean {
    // shell_exec 仅在执行破坏性命令时需审批
    if (tool === 'shell_exec' && args.command) {
      const cmd = String(args.command).toLowerCase();
      const dangerousPatterns = ['rm -rf', 'mkfs', 'shutdown', 'reboot', 'dd if=', 'chmod 777', 'format ', 'del /f'];
      if (dangerousPatterns.some(p => cmd.includes(p))) return true;
    }

    // 写系统关键目录需审批
    if (tool === 'write_file' && args.path) {
      const sysPaths = ['/etc', '/usr/bin', 'C:\\\\Windows\\\\System32', 'C:\\\\Program Files'];
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
