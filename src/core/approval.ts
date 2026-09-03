/**
 * 审批流 - Approval Manager
 * 危险操作需用户批准后才执行
 *
 * v2.0 架构升级：支持强制完成（force_complete）免审批通道
 *  - 长任务强制完成模式下，无人值守的审批请求会因超时无人批准而中断
 *  - 新增 bypassApproval()：目标任务强制完成模式下直接放行（历史留痕可审计）
 *  - 仅保留真正高危的破坏性操作强制审批
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

export class ApprovalManager {
  private pending: Map<string, ApprovalRequest> = new Map();
  private history: ApprovalRequest[] = [];
  private timeoutMs: number;
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private resolvers: Map<string, (req: ApprovalRequest) => void> = new Map();

  private autoApprove: boolean;
  /** 超时策略：approve=无操作自动通过（留痕 decidedBy='timeout_auto'）；reject=超时拒绝 */
  private timeoutAction: 'approve' | 'reject';
  /** v2.0: 强制完成模式（免审批通道）——目标任务无人值守时开启 */
  private forceComplete: boolean;

  constructor(timeoutMs = parseInt(process.env.APPROVAL_TIMEOUT || '300000', 10), autoApprove?: boolean, timeoutAction?: 'approve' | 'reject') { // 默认 5 分钟，可通过环境变量配置
    this.timeoutMs = timeoutMs;
    // 自动批准模式：APPROVAL_AUTO_APPROVE=1/true/yes/on 时开启，所有审批请求立即放行（历史留痕可审计）
    this.autoApprove = autoApprove ?? envBool(process.env.APPROVAL_AUTO_APPROVE);
    // 超时策略：默认无操作自动通过
    this.timeoutAction = timeoutAction ?? 'approve';
    // v2.0: 强制完成免审批通道：FORCE_COMPLETE=1/true/yes/on 时开启
    this.forceComplete = envBool(process.env.FORCE_COMPLETE);
    if (this.autoApprove) console.log('[Approval] 自动批准模式已开启 (APPROVAL_AUTO_APPROVE) —— 审批请求将自动通过');
    if (this.forceComplete) console.log('[Approval] 强制完成免审批通道已开启 (FORCE_COMPLETE) —— 目标任务审批请求自动放行');
  }

  /** v2.0: 动态开启/关闭强制完成免审批通道 */
  setForceComplete(on: boolean): void {
    this.forceComplete = on;
    if (on) console.log('[Approval] 强制完成免审批通道已开启');
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

    // v2.0: 强制完成免审批通道：目标任务无人值守时自动放行（decidedBy='force_complete' 留痕）
    if (this.forceComplete) {
      this.approve(id, 'force_complete');
      return req;
    }

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
    // 超时策略：approve = 无操作自动放行（留痕可审计）
    if (this.timeoutAction === 'approve') {
      console.log(`[Approval] 超时自动通过 ${id} (${Math.round(this.timeoutMs / 1000)}s 无操作)`);
      this.approve(id, 'timeout_auto');
      return;
    }
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
   * v2.0: 强制完成模式下，仅真正高危的破坏性操作需要审批，其余放行
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
      const sysPaths = process.platform === 'win32'
        ? ['C:\\Windows', 'C:\\Windows\\System32', 'C:\\Program Files', 'C:\\Program Files (x86)']
        : ['/etc', '/usr', '/bin', '/sbin', '/boot', '/sys', '/proc'];
      if (sysPaths.some(p => String(args.path).startsWith(p))) return true;
    }

    // v2.0: 强制完成模式下，非高危操作直接放行（无人值守不中断）
    if (this.forceComplete) {
      return false;
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
