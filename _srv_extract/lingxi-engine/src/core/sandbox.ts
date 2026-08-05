/**
 * Agent 工作区隔离 - Sandbox Manager
 * 每个 Agent 有独立的工作目录+运行环境
 * 文件操作、工具调用在沙箱内进行，互不影响
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, copyFileSync, realpathSync } from 'fs';
import { join, resolve } from 'path';

export interface Sandbox {
  agentId: string;
  workDir: string;
  tools: string[];
  allowedPaths: string[];
  deniedPaths: string[];
  maxFileSize: number;
  memoryLimit: number;
}

export class SandboxManager {
  private sandboxes: Map<string, Sandbox> = new Map();
  private baseDir: string;

  constructor(dataDir: string) {
    this.baseDir = join(dataDir, 'sandboxes');
    if (!existsSync(this.baseDir)) mkdirSync(this.baseDir, { recursive: true });
  }

  create(agentId: string): Sandbox {
    const workDir = join(this.baseDir, agentId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });

    const sb: Sandbox = {
      agentId,
      workDir,
      tools: ['read_file', 'write_file', 'list_dir', 'exec_command'],
      allowedPaths: [workDir],
      deniedPaths: [
        '/etc', '/usr', '/bin', '/opt', '/root', '/var', '/sys', '/proc',
        // Windows 系统目录
        'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
        'C:\\ProgramData', 'C:\\System Volume Information',
        'C:\\Users\\Administrator\\AppData',
        'C:\\Users\\Default',
      ],
      maxFileSize: 1024 * 1024,
      memoryLimit: 256,
    };
    this.sandboxes.set(agentId, sb);
    return sb;
  }

  get(agentId: string): Sandbox | undefined {
    return this.sandboxes.get(agentId);
  }

  getOrCreate(agentId: string): Sandbox {
    return this.get(agentId) || this.create(agentId);
  }

  delete(agentId: string): boolean {
    const sb = this.sandboxes.get(agentId);
    if (!sb) return false;
    this.sandboxes.delete(agentId);
    return true;
  }

  validatePath(agentId: string, targetPath: string): { ok: boolean; resolvedPath?: string; error?: string } {
    const sb = this.sandboxes.get(agentId);
    if (!sb) return { ok: false, error: '沙箱不存在' };

    // 第一步：resolve 规范化（消除 .. 和 .）
    let resolved = resolve(targetPath);

    // 第二步：解析符号链接防止绕过（v2.0.6 加固：realpath 失败时做额外安全检查）
    let realpathOk = false;
    try {
      resolved = realpathSync(resolved);
      realpathOk = true;
    } catch {
      // 文件尚不存在时 realpath 会失败，需要手动验证路径不逃逸
    }

    const workDir = resolve(sb.workDir);
    const workDirLower = workDir.toLowerCase();
    const resolvedLower = resolved.toLowerCase();

    // 如果 realpath 失败（文件不存在），检查规范化路径是否在 workDir 内
    if (!realpathOk) {
      if (!resolvedLower.startsWith(workDirLower)) {
        return { ok: false, error: '路径超出沙箱范围: ' + resolved };
      }
      // 额外检查：不能通过符号链接间接逃逸
      // 逐级检查路径的每一段，确保没有父目录组件
      const rel = resolved.slice(workDir.length).replace(/^[/\\]+/, '');
      if (rel.includes('..')) {
        return { ok: false, error: '路径包含非法组件' };
      }
    }

    // 第三步：显式黑名单检查
    for (const denied of sb.deniedPaths) {
      const deniedLower = denied.toLowerCase();
      if (resolvedLower.startsWith(deniedLower) && !resolvedLower.startsWith(workDirLower)) {
        return { ok: false, error: '禁止访问系统目录: ' + resolved };
      }
    }

    // 第四步：白名单前缀匹配，防止 /sandbox/agent1evil 误匹配 /sandbox/agent1
    const allowed = sb.allowedPaths.some(p => {
      const allowedPath = resolve(p);
      return resolved === allowedPath ||
        resolved.startsWith(allowedPath + '/') ||
        resolved.startsWith(allowedPath + '\\');
    });
    if (!allowed) return { ok: false, error: '路径超出允许范围' };
    return { ok: true, resolvedPath: resolved };
  }

  writeFile(agentId: string, filePath: string, content: string): { ok: boolean; error?: string } {
    const v = this.validatePath(agentId, filePath);
    if (!v.ok) return { ok: false, error: v.error };
    try {
      const dir = resolve(v.resolvedPath!, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(v.resolvedPath!, content, 'utf-8');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  readFile(agentId: string, filePath: string): { ok: boolean; content?: string; error?: string } {
    const v = this.validatePath(agentId, filePath);
    if (!v.ok) return { ok: false, error: v.error };
    try {
      const content = readFileSync(v.resolvedPath!, 'utf-8');
      return { ok: true, content };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  listDir(agentId: string, dirPath?: string): { ok: boolean; files?: string[]; error?: string } {
    const sb = this.sandboxes.get(agentId);
    if (!sb) return { ok: false, error: '沙箱不存在' };
    const target = dirPath ? resolve(dirPath) : sb.workDir;
    const v = this.validatePath(agentId, target);
    if (!v.ok) return { ok: false, error: v.error };
    try {
      const files = readdirSync(v.resolvedPath!);
      return { ok: true, files };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  deleteFile(agentId: string, filePath: string): { ok: boolean; error?: string } {
    const v = this.validatePath(agentId, filePath);
    if (!v.ok) return { ok: false, error: v.error };
    try {
      rmSync(v.resolvedPath!, { force: true });
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  list(): Sandbox[] {
    return Array.from(this.sandboxes.values());
  }

  cleanup(agentId: string): boolean {
    const sb = this.sandboxes.get(agentId);
    if (!sb) return false;
    rmSync(sb.workDir, { recursive: true, force: true });
    this.sandboxes.delete(agentId);
    return true;
  }
}
