/**
 * Docker 沙箱执行器
 * 当服务器安装 Docker 并启用 USE_DOCKER_SANDBOX=true 时，
 * shell_exec / code_execute 会在隔离容器中运行，防止影响主机。
 */
import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';

// Docker 可用性检测 — 默认启用，检测失败则降级
function detectDocker(): boolean {
  try {
    execSync('docker info', { timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

let _dockerDetected: boolean | null = null;
function dockerReallyAvailable(): boolean {
  if (_dockerDetected === null) {
    _dockerDetected = detectDocker();
    if (_dockerDetected) {
      console.log('[Docker] Docker 已检测到，沙箱默认启用');
    } else {
      console.log('[Docker] Docker 未检测到，将降级到内置沙箱');
    }
  }
  return _dockerDetected;
}

// v2.0: 仅在显式设置 USE_DOCKER_SANDBOX=true 时才启用 Docker 沙箱
// 防止自动检测到 Docker 就把用户命令关进隔离容器（看不到宿主机文件）
const USE_DOCKER = process.env.USE_DOCKER_SANDBOX === 'true';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'node:20-alpine';
// 安全修复 P0#4：校验 SANDBOX_IMAGE 只允许安全的镜像名格式，防止命令注入
const _imgValid = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,127}$/.test(SANDBOX_IMAGE);
if (!_imgValid) console.error('[Docker] SANDBOX_IMAGE 值不安全，已回退到默认镜像');
const SAFE_SANDBOX_IMAGE = _imgValid ? SANDBOX_IMAGE : 'node:20-alpine';
const SANDBOX_TIMEOUT = parseInt(process.env.SANDBOX_TIMEOUT || '10000');
const SANDBOX_MEMORY = process.env.SANDBOX_MEMORY || '128m';
const SANDBOX_CPUS = process.env.SANDBOX_CPUS || '0.5';

// 降级标志（复用缓存探测，避免重复执行 docker info）
export const DOCKER_FALLBACK = USE_DOCKER && !dockerReallyAvailable();

// 多语言镜像映射
const LANGUAGE_IMAGES: Record<string, string> = {
  javascript: 'node:20-alpine',
  typescript: 'node:20-alpine',
  python: 'python:3.12-alpine',
  go: 'golang:1.23-alpine',
  shell: 'node:20-alpine', // alpine 自带 sh
};

export interface DockerRunOptions {
  command: string[]; // 容器内执行的命令（数组形式）
  image?: string; // 覆盖默认镜像
  cwd?: string;
  timeout?: number;
  network?: boolean; // 默认 false（--network none）
  binds?: string[]; // 额外挂载，格式 ["host:container"]
  input?: string; // stdin 输入
}

export interface DockerRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export function isDockerAvailable(): boolean {
  return USE_DOCKER && dockerReallyAvailable();
}

async function execDocker(args: string[], options: { timeout: number; input?: string }): Promise<DockerRunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeout + 2000, // 多给 2s 让 docker 自己清理
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, options.timeout);

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    if (options.input && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, exitCode: null, error: `docker 启动失败: ${err.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed && code === null) {
        resolve({ ok: false, stdout, stderr, exitCode: null, error: `执行超时（>${options.timeout}ms）` });
      } else {
        resolve({ ok: code === 0, stdout, stderr, exitCode: code ?? null });
      }
    });
  });
}

/**
 * 在 Docker 容器中执行命令
 */
export async function runInDocker(options: DockerRunOptions): Promise<DockerRunResult> {
  const {
    command,
    image,
    cwd,
    timeout = SANDBOX_TIMEOUT,
    network = false,   // 默认禁网，调用方需要联网时显式开启
    binds = [],
    input,
  } = options;

  const useImage = image || SAFE_SANDBOX_IMAGE;

  const args: string[] = [
    'run', '--rm',
    '--network', network ? 'bridge' : 'none',
    '--memory', SANDBOX_MEMORY,
    '--memory-swap', SANDBOX_MEMORY,
    '--cpus', SANDBOX_CPUS,
    '--pids-limit', '64',
    '--read-only',
    '--tmpfs', '/tmp:noexec,nosuid,size=50m',
    '-w', cwd || '/sandbox',
  ];

  // 默认不挂载任何宿主机目录（除了用户显式 binds）
  for (const b of binds) {
    // Windows 路径含冒号（C:\），不能用 split(':')
    // 格式: hostPath:containerPath[:ro] — 从右往左找
    const parts = b.split(':');
    let host, container, mode;
    if (parts.length >= 3) {
      // Windows: C:\path:container:ro → 重新组合
      if (parts[0].length <= 2 && /^[a-zA-Z]$/.test(parts[0])) {
        // 盘符开头
        mode = parts.length >= 4 ? parts[parts.length - 1] : parts[parts.length - 1];
        container = parts[parts.length - 2];
        host = parts.slice(0, parts.length - 2).join(':');
      } else {
        // Linux: /path:container:ro
        mode = parts[parts.length - 1];
        container = parts[parts.length - 2];
        host = parts.slice(0, parts.length - 2).join(':');
      }
    } else {
      host = parts[0];
      container = parts[1];
      mode = 'ro';
    }
    args.push('-v', `${resolve(host)}:${container}:${mode}`);
  }

  args.push(useImage, ...command);

  return execDocker(args, { timeout, input });
}

const HOST_SANDBOX_DIR = join(process.cwd(), 'data', 'docker-sandbox');

/**
 * 执行一段 JS 代码：写入临时文件 -> Docker 中 node 运行 -> 清理
 */
export async function runJsInDocker(code: string, timeout = 10000): Promise<DockerRunResult> {
  if (!existsSync(HOST_SANDBOX_DIR)) mkdirSync(HOST_SANDBOX_DIR, { recursive: true });
  const fileName = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.js`;
  const hostPath = join(HOST_SANDBOX_DIR, fileName);
  const containerPath = `/sandbox/${fileName}`;

  // 包裹用户代码，捕获 console 输出并返回
  // 安全修复 P0#5：废弃 Function+with（原型链逃逸 RCE），改用 vm.runInNewContext + Object.create(null)
  const wrapped = `
const vm = require('vm');
const logs = [];
const fakeConsole = {
  log: (...a) => logs.push(a.map(String).join(' ')),
  error: (...a) => logs.push('[ERROR] ' + a.map(String).join(' ')),
  warn: (...a) => logs.push('[WARN] ' + a.map(String).join(' ')),
};
const context = Object.assign(Object.create(null), {
  console: fakeConsole,
  Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
});
const code = ${JSON.stringify(code)};
let returnValue;
try {
  const script = new vm.Script('(function(){ "use strict";\\n' + code + '\\n})()');
  returnValue = script.runInNewContext(context, { timeout: 10000 });
} catch (e) {
  fakeConsole.error(e.message);
}
process.stdout.write(JSON.stringify({ output: logs.join('\\n'), returnValue: typeof returnValue === 'object' ? JSON.stringify(returnValue) : String(returnValue || '') }));
`;

  writeFileSync(hostPath, wrapped, 'utf8');

  try {
    return await runInDocker({
      command: ['node', containerPath],
      binds: [`${hostPath}:${containerPath}:ro`],
      timeout,
      cwd: '/sandbox',
    });
  } finally {
    try { rmSync(hostPath); } catch {}
    // 清理可能残留的容器
    try { execSync('docker rm -f $(docker ps -aq --filter "ancestor=' + SAFE_SANDBOX_IMAGE + '") 2>/dev/null', { timeout: 5000, stdio: 'pipe' }); } catch {}
  }
}

/**
 * 执行 shell 命令：Docker 中 /bin/sh -c，自动挂载工作目录
 */
export async function runShellInDocker(command: string, timeout = 10000, cwd?: string): Promise<DockerRunResult> {
  const workspaceDir = process.env.WORKSPACE_DIR ? resolve(process.cwd(), process.env.WORKSPACE_DIR) : join(process.cwd(), 'workspace');
  const binds: string[] = [];
  // 自动挂载工作目录，让容器内可以访问项目文件
  if (existsSync(workspaceDir)) {
    binds.push(`${workspaceDir}:/sandbox:rw`);
  }
  return runInDocker({
    command: ['/bin/sh', '-c', command],
    timeout,
    cwd: cwd || '/sandbox',
    binds,
  });
}

/**
 * 执行 Python 代码
 */
export async function runPythonInDocker(code: string, timeout = 15000): Promise<DockerRunResult> {
  if (!existsSync(HOST_SANDBOX_DIR)) mkdirSync(HOST_SANDBOX_DIR, { recursive: true });
  const fileName = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.py`;
  const hostPath = join(HOST_SANDBOX_DIR, fileName);
  const containerPath = `/sandbox/${fileName}`;
  writeFileSync(hostPath, code, 'utf8');
  try {
    return await runInDocker({
      command: ['python3', containerPath],
      image: 'python:3.12-alpine',
      binds: [`${hostPath}:${containerPath}:ro`],
      timeout,
      cwd: '/sandbox',
    });
  } finally {
    try { rmSync(hostPath); } catch {}
  }
}

/**
 * 执行 Go 代码
 */
export async function runGoInDocker(code: string, timeout = 30000): Promise<DockerRunResult> {
  if (!existsSync(HOST_SANDBOX_DIR)) mkdirSync(HOST_SANDBOX_DIR, { recursive: true });
  const dirName = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const hostDir = join(HOST_SANDBOX_DIR, dirName);
  mkdirSync(hostDir, { recursive: true });
  const hostPath = join(hostDir, 'main.go');
  writeFileSync(hostPath, code, 'utf8');
  try {
    return await runInDocker({
      command: ['go', 'run', '/sandbox/main.go'],
      image: 'golang:1.23-alpine',
      binds: [`${hostDir}:/sandbox:ro`],
      timeout,
      cwd: '/sandbox',
    });
  } finally {
    try { rmSync(hostDir, { recursive: true }); } catch {}
  }
}

/**
 * 通用多语言代码执行
 */
export async function runCodeInDocker(language: string, code: string, timeout?: number): Promise<DockerRunResult> {
  switch (language.toLowerCase()) {
    case 'javascript':
    case 'typescript':
    case 'js':
    case 'ts':
      return runJsInDocker(code, timeout || 10000);
    case 'python':
    case 'py':
      return runPythonInDocker(code, timeout || 15000);
    case 'go':
    case 'golang':
      return runGoInDocker(code, timeout || 30000);
    default:
      return { ok: false, stdout: '', stderr: '', exitCode: null, error: `不支持的语言: ${language}` };
  }
}
