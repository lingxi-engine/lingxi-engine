/**
 * 灵犀引擎统一日志系统 v1.5.0
 *
 * 功能：
 * - 分级日志：debug / info / warn / error
 * - 双通道输出：控制台 + 文件（data/logs/）
 * - 按天自动切分
 * - 关键操作审计标记
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, readFileSync, renameSync } from 'fs';
import * as fs from 'fs';
import { join } from 'path';
import { stdout as _stdout, stderr as _stderr } from 'process';

// ─── 配置 ───

const LOG_DIR = join(process.cwd(), process.env.DATA_DIR || 'data', 'logs');
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const MAX_LOG_AGE_DAYS = 3; // 瘦身: 3 天（原 7 天）
const MAX_LOG_SIZE_MB = 8; // EPIPE防护+瘦身: 原 100MB，配合下面的频率限制
const MAX_LOG_SIZE_BYTES = MAX_LOG_SIZE_MB * 1024 * 1024;
type LogLevel = keyof typeof LOG_LEVELS;

let minLevel: LogLevel = 'info';
let fileLogging = true;
let _consoleHijacked = false;

// P1-1: 异步写入缓冲区
let _logBuffer: string[] = [];
let _currentLogSize = 0;

function flushBuffer() {
  if (_logBuffer.length === 0) return;
  const lines = _logBuffer.join('\n') + '\n';
  _logBuffer = [];
  try {
    const file = getLogFile();
    try { _currentLogSize = statSync(file).size; } catch { _currentLogSize = 0; }
    if (_currentLogSize > MAX_LOG_SIZE_BYTES) {
      try {
        const oldFile = file.replace('.log', '.old.log');
        try { unlinkSync(oldFile); } catch {}
        try { renameSync(file, oldFile); } catch {}
      } catch {}
    }
    appendFileSync(file, lines, 'utf8');
    _currentLogSize += Buffer.byteLength(lines, 'utf8');
  } catch { /* 写文件失败不中断 */ }
}

setInterval(() => { flushBuffer(); }, 1000);
process.on('beforeExit', () => { flushBuffer(); });

// 保存原始 console 引用，防止 attachToConsole 后无限递归
const _origConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

// 初始化日志目录
try { if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// ─── 格式化 ───

function fmtTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function getLogFile(): string {
  const d = new Date();
  const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return join(LOG_DIR, `lingxi-${ds}.log`);
}

// P0-2: 敏感字段脱敏
const SENSITIVE_KEYS = /(?:password|passwd|token|secret|apiKey|api_key|adminToken|admin_token|verifyCode|verify_code|resetToken|reset_token|credential)/gi;
function redactMessage(msg: string): string {
  return msg.replace(SENSITIVE_KEYS, (match) => match + '=***');
}

// ─── 核心 ───

function write(level: LogLevel, module: string, message: string, audit?: string) {
  if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) return;

  const time = fmtTime();
  const auditTag = audit ? ` [${audit}]` : '';
  const line = `[${time}] [${level.toUpperCase()}] [${module}]${auditTag} ${message}`;

  // 控制台 — 始终用原始 console，避免 attachToConsole 后无限递归
  // EPIPE防护: 控制台管道可能已断开，任何写入异常都必须吞掉，否则会反向触发 uncaughtException
  try {
    if (level === 'error') _origConsole.error(line);
    else if (level === 'warn') _origConsole.warn(line);
    else _origConsole.log(line);
  } catch { /* 管道已断，静默 */ }

  // P0-2: 敏感字段脱敏
  const safeLine = redactMessage(line);

  // 文件 — P1-1: 异步缓冲写入
  if (fileLogging) {
    _logBuffer.push(safeLine);
  }
}

// ─── 公开 API ───

export const logger = {
  /** 设置最低日志级别 */
  setLevel(level: LogLevel) { minLevel = level; },

  /** 启用/禁用文件日志 */
  setFileLogging(on: boolean) { fileLogging = on; },

  /** 获取日志目录 */
  getLogDir() { return LOG_DIR; },

  debug(module: string, msg: string) { write('debug', module, msg); },
  info(module: string, msg: string) { write('info', module, msg); },
  warn(module: string, msg: string) { write('warn', module, msg); },
  error(module: string, msg: string) { write('error', module, msg); },

  /** 审计日志 — 记录关键操作 */
  audit(module: string, action: string, detail: string) {
    write('info', module, `${action}: ${detail}`, 'AUDIT');
  },

  /** 获取今日日志文件内容 */
  getTodayLog(): string {
    try {
      return readFileSync(getLogFile(), 'utf8');
    } catch {
      return '(暂无日志)';
    }
  },

  /** 清理超过 MAX_LOG_AGE_DAYS 天的旧日志 */
  rotate(): number {
    let deleted = 0;
    try {
      const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 86400_000;
      for (const f of readdirSync(LOG_DIR)) {
        if (!f.startsWith('lingxi-') || !f.endsWith('.log')) continue;
        const full = join(LOG_DIR, f);
        try { if (statSync(full).mtimeMs < cutoff) { unlinkSync(full); deleted++; } } catch { /* skip locked files */ }
      }
    } catch { /* ignore */ }
    if (deleted > 0) console.log(`[Logger] 清理了 ${deleted} 个过期日志`);
    return deleted;
  },

  /** 自动接管 console.log/warn/error，所有输出同时走 logger */
  attachToConsole() {
    if (_consoleHijacked) return;
    _consoleHijacked = true;
    const _log = console.log, _warn = console.warn, _error = console.error;
    // EPIPE防护: 可重入锁——日志写入过程中产生的 console 输出直接放行，不再进 logger，
    // 否则"写日志 → 触发 console → 再写日志"会无限自噬
    let _inHijack = false;
    const safeWrite = (fn: (...a: any[]) => void, level: LogLevel, args: any[]) => {
      if (_inHijack) { try { fn(...args); } catch { /* 管道断 */ } return; }
      _inHijack = true;
      try { fn(...args); } catch { /* EPIPE: 管道已断，吞掉，绝不外抛 */ }
      try { write(level, 'console', args.map(String).join(' ')); } catch { /* 落盘失败不中断 */ }
      _inHijack = false;
    };
    console.log = (...args: any[]) => safeWrite(_log, 'info', args);
    console.warn = (...args: any[]) => safeWrite(_warn, 'warn', args);
    console.error = (...args: any[]) => safeWrite(_error, 'error', args);
  },
};
