/**
 * MCP (Model Context Protocol) 适配器
 * 让灵犀引擎能连接 MCP 服务器，动态扩展工具
 * 
 * MCP 协议规范：https://spec.modelcontextprotocol.io/
 * 核心概念：
 *   - MCP Server 暴露 tools / resources / prompts
 *   - MCP Client 连接 Server，发现并调用工具
 *   - 通信方式：stdio / SSE / WebSocket
 */

export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPToolCallResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface MCPServerConfig {
  id: string;                    // 服务器标识
  name: string;                  // 显示名
  command: string;               // 启动命令，如 "npx @anthropic/mcp-server-filesystem"
  args?: string[];               // 命令参数
  env?: Record<string, string>;  // 环境变量
  type: 'stdio' | 'sse';        // 通信方式
  url?: string;                  // SSE 模式的 URL
  enabled?: boolean;             // 是否启用（默认 true）
}

interface MCPMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * MCP Client - 连接一个 MCP Server
 * 当前实现 stdio 模式（最常用）
 */
export class MCPClient {
  private process: any = null;
  private msgId = 0;
  private pendingRequests = new Map<number | string, { resolve: (value: any) => void; reject: (err: Error) => void }>();
  private buffer = '';
  private tools: MCPToolSchema[] = [];
  private config: MCPServerConfig;
  private initialized = false;

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  /** 启动 MCP Server 并初始化 */
  async start(): Promise<void> {
    if (this.config.type === 'sse') {
      // SSE 模式：通过 HTTP 连接（暂不实现，留给 P3）
      console.warn(`[MCP] Server ${this.config.id} 使用 SSE 模式（暂不支持），已跳过`);
      return;
    }

    // stdio 模式：启动子进程
    const { spawn } = await import('child_process');
    const env = { ...process.env, ...this.config.env };
    
    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: false, // 安全修复 P1#14：去掉 shell:true 防止命令注入
    });

    if (!this.process.stdin || !this.process.stdout) {
      console.error(`[MCP] Server ${this.config.id} 启动失败：无法获取 stdin/stdout`);
      return;
    }

    // 读取 stdout
    this.process.stdout.on('data', (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      console.log(`[MCP:${this.config.id}] stderr:`, data.toString().trim());
    });

    this.process.on('error', (err: Error) => {
      console.error(`[MCP:${this.config.id}] 进程错误:`, err.message);
    });

    this.process.on('exit', (code: number) => {
      console.log(`[MCP:${this.config.id}] 进程退出: code=${code}`);
    });

    // MCP 握手：initialize
    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lingxi-engine', version: '1.0.0' },
    });

    console.log(`[MCP:${this.config.id}] 初始化成功:`, initResult?.serverInfo?.name || 'unknown');

    // 发送 initialized 通知
    this.sendNotification('notifications/initialized', {});

    // 获取工具列表
    await this.refreshTools();
    this.initialized = true;
  }

  /** 关闭连接 */
  async close(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.initialized = false;
    this.tools = [];
  }

  /** 刷新工具列表 */
  async refreshTools(): Promise<MCPToolSchema[]> {
    const result = await this.sendRequest('tools/list', {});
    this.tools = result?.tools || [];
    console.log(`[MCP:${this.config.id}] 发现 ${this.tools.length} 个工具: ${this.tools.map(t => t.name).join(', ')}`);
    return this.tools;
  }

  /** 调用工具 */
  async callTool(name: string, args: Record<string, any>): Promise<MCPToolCallResult> {
    const result = await this.sendRequest('tools/call', { name, arguments: args });
    return result as MCPToolCallResult;
  }

  /** 获取工具列表 */
  getTools(): MCPToolSchema[] {
    return this.tools;
  }

  /** 是否已初始化 */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ── 内部通信 ──

  private sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId;
      const msg: MCPMessage = { jsonrpc: '2.0', id, method, params };

      // 30 秒超时
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP 请求超时: ${method}`));
        }
      }, 30000);

      // 包装 resolve/reject 以清除 timer
      const wrappedResolve = (v: any) => { clearTimeout(timer); resolve(v); };
      const wrappedReject = (e: Error) => { clearTimeout(timer); reject(e); };

      // 一次性 set，避免重复覆盖
      this.pendingRequests.set(id, { resolve: wrappedResolve, reject: wrappedReject });

      const data = JSON.stringify(msg) + '\n';
      this.process.stdin?.write(data);
    });
  }

  private sendNotification(method: string, params: any): void {
    const msg: MCPMessage = { jsonrpc: '2.0', method, params };
    const data = JSON.stringify(msg) + '\n';
    this.process.stdin?.write(data);
  }

  private processBuffer(): void {
    // 按 \n 分割消息
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // 保留最后一段（可能不完整）

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line.trim()) as MCPMessage;
        
        if (msg.id && this.pendingRequests.has(msg.id)) {
          const { resolve, reject } = this.pendingRequests.get(msg.id)!;
          this.pendingRequests.delete(msg.id);
          
          if (msg.error) {
            reject(new Error(msg.error.message));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

/**
 * MCP 管理器 - 管理多个 MCP Server 连接
 * 并将其工具桥接到灵犀引擎的 ToolRegistry
 */
export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private toolToServer = new Map<string, string>(); // toolName -> serverId

  /**
   * 添加并启动 MCP Server
   */
  async addServer(config: MCPServerConfig): Promise<MCPClient> {
    if (this.clients.has(config.id)) {
      await this.removeServer(config.id);
    }
    const client = new MCPClient(config);
    await client.start();
    this.clients.set(config.id, client);

    // 记录工具到 server 的映射
    for (const tool of client.getTools()) {
      this.toolToServer.set(tool.name, config.id);
    }

    return client;
  }

  /**
   * 移除 MCP Server
   */
  async removeServer(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (client) {
      await client.close();
      this.clients.delete(serverId);
      // 清理工具映射
      for (const [toolName, sid] of this.toolToServer.entries()) {
        if (sid === serverId) this.toolToServer.delete(toolName);
      }
    }
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(toolName: string, args: Record<string, any>): Promise<any> {
    const serverId = this.toolToServer.get(toolName);
    if (!serverId) throw new Error(`MCP 工具 "${toolName}" 未注册`);

    const client = this.clients.get(serverId);
    if (!client) throw new Error(`MCP Server "${serverId}" 未连接`);

    const result = await client.callTool(toolName, args);
    
    // 提取文本内容
    if (result.content && Array.isArray(result.content)) {
      return result.content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
    }
    return result;
  }

  /**
   * 获取所有 MCP 工具列表
   */
  listAllTools(): { serverId: string; serverName: string; tools: MCPToolSchema[] }[] {
    const result: { serverId: string; serverName: string; tools: MCPToolSchema[] }[] = [];
    for (const [id, client] of this.clients) {
      result.push({ serverId: id, serverName: id, tools: client.getTools() });
    }
    return result;
  }

  /**
   * 获取所有可用的 MCP ToolDefinition（适配到灵犀引擎格式）
   */
  getAllToolDefinitions(): Array<{
    name: string;
    description: string;
    parameters: { type: string; properties: Record<string, any>; required: string[] };
    mcpServerId: string;
  }> {
    const tools: any[] = [];
    for (const [serverId, client] of this.clients) {
      for (const t of client.getTools()) {
        tools.push({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
          mcpServerId: serverId,
        });
      }
    }
    return tools;
  }

  /**
   * 列出已连接的服务器
   */
  listServers(): { id: string; toolCount: number; initialized: boolean }[] {
    const result: { id: string; toolCount: number; initialized: boolean }[] = [];
    for (const [id, client] of this.clients) {
      result.push({ id, toolCount: client.getTools().length, initialized: client.isInitialized() });
    }
    return result;
  }

  /** 是否有某个工具 */
  hasTool(toolName: string): boolean {
    return this.toolToServer.has(toolName);
  }

  /** 关闭所有连接 */
  async closeAll(): Promise<void> {
    for (const [, client] of this.clients) {
      await client.close();
    }
    this.clients.clear();
    this.toolToServer.clear();
  }
}
