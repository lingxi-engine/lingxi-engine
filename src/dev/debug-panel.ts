/**
 * 开发者模式 - Debug Panel
 * 请求/响应查看、工具调用日志、WS 消息监控
 */

export interface DebugLogEntry {
  id: string;
  type: 'request' | 'response' | 'ws' | 'tool' | 'error' | 'info';
  timestamp: number;
  method?: string;
  url?: string;
  status?: number;
  duration?: number;
  request?: any;
  response?: any;
  message?: string;
}

export class DebugPanel {
  private logs: DebugLogEntry[] = [];
  private maxLogs = 500;
  private enabled = false;
  private wsLogEnabled = false;

  /**
   * 启用/禁用调试模式
   */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.logs = [];
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 启用/禁用 WS 日志
   */
  setWSLog(enabled: boolean) {
    this.wsLogEnabled = enabled;
  }

  isWSLogEnabled(): boolean {
    return this.wsLogEnabled;
  }

  /**
   * 记录 HTTP 请求
   */
  logRequest(method: string, url: string, body?: any) {
    if (!this.enabled) return;
    this.add({
      type: 'request',
      method,
      url,
      request: body,
    });
  }

  /**
   * 记录 HTTP 响应
   */
  logResponse(method: string, url: string, status: number, duration: number, response?: any) {
    if (!this.enabled) return;
    this.add({
      type: 'response',
      method,
      url,
      status,
      duration,
      response: response ? this.truncate(response) : undefined,
    });
  }

  /**
   * 记录 WS 消息
   */
  logWS(direction: 'in' | 'out', data: any) {
    if (!this.enabled || !this.wsLogEnabled) return;
    this.add({
      type: 'ws',
      message: `${direction}: ${JSON.stringify(data).slice(0, 200)}`,
    });
  }

  /**
   * 记录工具调用
   */
  logTool(tool: string, args: any, result: any, duration: number) {
    if (!this.enabled) return;
    this.add({
      type: 'tool',
      message: `${tool} (${duration}ms)`,
      request: this.truncate(args),
      response: this.truncate(result),
    });
  }

  /**
   * 记录错误
   */
  logError(message: string, error?: any) {
    this.add({
      type: 'error',
      message,
      response: error ? this.truncate(error) : undefined,
    });
  }

  /**
   * 记录信息
   */
  logInfo(message: string) {
    if (!this.enabled) return;
    this.add({ type: 'info', message });
  }

  /**
   * 添加日志
   */
  private add(entry: Partial<DebugLogEntry>) {
    const log: DebugLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      ...entry,
    } as DebugLogEntry;
    
    this.logs.push(log);
    if (this.logs.length > this.maxLogs) this.logs.shift();
  }

  /**
   * 截断大对象
   */
  private truncate(obj: any, maxLen = 500): any {
    const str = JSON.stringify(obj);
    if (str.length <= maxLen) return obj;
    return str.slice(0, maxLen) + '...';
  }

  /**
   * 获取日志列表
   */
  getLogs(limit = 100, type?: string): DebugLogEntry[] {
    let logs = this.logs.slice(-limit);
    if (type) logs = logs.filter(l => l.type === type);
    return logs;
  }

  /**
   * 清空日志
   */
  clear() {
    this.logs = [];
  }

  /**
   * 获取统计
   */
  getStats() {
    const stats: Record<string, number> = {};
    for (const log of this.logs) {
      stats[log.type] = (stats[log.type] || 0) + 1;
    }
    return {
      total: this.logs.length,
      byType: stats,
      enabled: this.enabled,
      wsLog: this.wsLogEnabled,
    };
  }
}