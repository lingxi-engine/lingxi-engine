/**
 * 工具调用系统 - 真实工具实现（安全修复版）
 *
 * v2 修复：
 *  - shell_exec 走 Docker 沙箱（docker-sandbox.ts 正式接线）
 *  - code_execute 走 Docker 沙箱
 *  - 沙箱默认开启
 *  - 文件操作始终用 safePath
 */

import type { Skill } from "./types.js";
import { execSync, execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync, rmSync, renameSync } from "fs";
import { join, resolve, extname, isAbsolute } from "path";
import { readOfficeDocument } from "./office-reader.js";

// ═══════════════════════════════════════════════
// 安全修复 P0#7 / 架构建议 #1：统一 SSRF 防护函数
// ═══════════════════════════════════════════════
// v1.9.2: SSRF 大幅放开——Agent 运行在用户本机，需要访问 localhost/Ollama/局域网服务
// 只屏蔽云环境元数据端点（防止云端部署时被利用窃取 IAM 凭证）
const SSRF_METADATA_ONLY = ['169.254.169.254','metadata.google.internal','metadata.azure.com','100.100.100.200'];
export function isSsrfSafeUrl(url: string): boolean {
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url)) return false;
  const lower = url.toLowerCase();
  // 只拦截云元数据端点
  if (SSRF_METADATA_ONLY.some(f => lower.includes(f))) return false;
  return true;
}


// ═══════════════════════════════════════════════
// 沙箱配置持久化（重启不丢）
// ═══════════════════════════════════════════════
const SANDBOX_CONFIG_PATH = join(process.cwd(), 'data', 'sandbox-config.json');
function loadSandboxConfig(): boolean {
  // v1.9.7: 默认关闭沙箱。只有显式设置 SANDBOX_ENABLED=true 才开启。
  // 防止旧安装的 sandbox-config.json 残留 enabled:true 导致用户被锁在 workspace 里。
  if (process.env.SANDBOX_ENABLED === 'true') return true;
  try { const raw = readFileSync(SANDBOX_CONFIG_PATH, 'utf8'); return JSON.parse(raw).enabled === true; } catch { return false; }
}
function saveSandboxConfig(enabled: boolean) {
  try { writeFileSync(SANDBOX_CONFIG_PATH, JSON.stringify({ enabled, savedAt: Date.now() }), 'utf8'); } catch {}
}

// ═══════════════════════════════════════════════
// Docker 沙箱导入 — 默认启用，自动检测 Docker
// ═══════════════════════════════════════════════
let dockerAvailable = false;
let dockerReady: Promise<void>;
let runJsInDockerFn: ((code: string, timeout?: number) => Promise<any>) | null = null;
let runShellInDockerFn: ((command: string, timeout?: number, cwd?: string) => Promise<any>) | null = null;
dockerReady = import('../core/docker-sandbox.js').then(mod => {
  if (mod.isDockerAvailable()) {
    dockerAvailable = true;
    runJsInDockerFn = mod.runJsInDocker;
    runShellInDockerFn = mod.runShellInDocker;
    console.log('[Tools] Docker 沙箱已启用（shell_exec / code_execute 在隔离容器中运行）');
  } else {
    console.log('[Tools] Docker 不可用，回退到内置沙箱（安全级别：标准）');
  }
}).catch(() => {
  console.log('[Tools] Docker 沙箱模块加载失败，回退到内置沙箱');
});
// 确保首次工具调用前 Docker 至少尝试加载过
export async function ensureDockerReady() { await dockerReady; }

// ═══════════════════════════════════════════════
// 工作区配置
// ═══════════════════════════════════════════════

let WORKSPACE_SANDBOX_ENABLED = loadSandboxConfig();
let _workspaceRoot = process.env.WORKSPACE_DIR ? join(process.cwd(), process.env.WORKSPACE_DIR) : join(process.cwd(), "workspace");
try { if (!existsSync(_workspaceRoot)) mkdirSync(_workspaceRoot, { recursive: true }); } catch {}

// v1.4.0: 动态 workspace 切换（多机协作）
export function getWorkspaceRoot(): string { return _workspaceRoot; }
export function setWorkspaceRoot(path: string) {
  const resolved = resolve(path);
  try { if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true }); } catch {}
  _workspaceRoot = resolved;
  console.log(`[Workspace] 已切换到: ${resolved}`);
}


function safePath(relativePath: string): string {
  if (!WORKSPACE_SANDBOX_ENABLED) {
    if (!isAbsolute(relativePath)) {
      const resolved = resolve(_workspaceRoot, relativePath);
      return resolved;
    }
    // v1.9.2: 沙箱关闭时，绝对路径只保护系统核心目录，其余全部放开（对标 OpenClaw 默认全开）
    const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
    // v2.0.6 加固：扩展敏感路径黑名单
    const blocked = [
      // Windows 系统目录
      'c:/windows/', 'c:/windows/system32', 'c:/program files', 'c:/program files (x86)',
      'c:/programdata', 'c:/system volume information',
      // Linux 系统文件
      '/etc/shadow', '/etc/passwd', '/etc/sudoers', '/proc/kcore', '/sys/firmware',
      // 敏感配置和凭据
      '.env', '.ssh/', '.aws/credentials', '.gnupg/',
      // 数据库和备份
      '.db', '.sqlite', '.sql',
    ];
    for (const b of blocked) { if (normalized.includes(b)) throw new Error(`安全限制：禁止访问系统目录 (${b}...)`); }
    return relativePath;
  }
  const resolved = resolve(_workspaceRoot, relativePath);
  if (!resolved.startsWith(_workspaceRoot)) {
    throw new Error(`安全沙箱已开启：禁止访问工作区外部。当前 workspace: ${_workspaceRoot}。如需访问其他目录，请切换到个人模式。`);
  }
  return resolved;
}

let _sandboxUnlockToken: string | null = null;
export function setSandboxUnlockToken(token: string | null) { _sandboxUnlockToken = token; }
// 安全修复 P1#10：v1.9.5 放开——关闭沙箱不再需要 admin token（单机/个人使用场景）
// 开启沙箱仍需 token（防止误操作限制自己）
export function setSandboxEnabled(enabled: boolean, token?: string) {
  if (enabled && (!token || token !== _sandboxUnlockToken)) throw new Error('安全限制：开启沙箱需要管理员 unlock token');
  WORKSPACE_SANDBOX_ENABLED = enabled; saveSandboxConfig(enabled);
  console.log(`[Sandbox] 沙箱已${enabled ? '开启' : '关闭'}`);
}
export function isSandboxEnabled() { return WORKSPACE_SANDBOX_ENABLED; }

// v1.4.0: 群聊协作模式
let _userSandboxPref = false;
let _collabMode = false;
export function isCollabMode() { return _collabMode; }

/** 进入群聊协作模式：切换workspace + 强制开沙箱 */
export function enterCollabMode(sharedPath: string) {
  _userSandboxPref = WORKSPACE_SANDBOX_ENABLED;  // 记住用户偏好
  setWorkspaceRoot(sharedPath);
  WORKSPACE_SANDBOX_ENABLED = true;
  _collabMode = true;
  console.log(`[Collab] 进入协作模式: ${sharedPath}`);
}

/** 退出群聊协作模式：恢复个人workspace + 恢复用户沙箱偏好 */
export function leaveCollabMode() {
  setWorkspaceRoot(join(process.cwd(), 'workspace'));
  WORKSPACE_SANDBOX_ENABLED = _userSandboxPref;
  _collabMode = false;
  console.log('[Collab] 已恢复个人模式');
}


// ═══════════════════════════════════════════════
// 导入其他模块
// ═══════════════════════════════════════════════

import type { ToolDefinition } from "./types.js";

// 搜索管理器实例（通过 setter 注入单例，避免多实例问题）
import { SearchManager } from './search-providers.js';
let searchManager = new SearchManager();
export function setSearchManager(instance: SearchManager) { searchManager = instance; }

// Delegation 上下文（executor.ts 注入，供 delegate_task 工具使用）
let _currentAgentId = '';
let _currentChatId = '';
let _subAgentManager: any = null;
export function setDelegateContext(agentId: string, chatId: string, manager?: any) {
  _currentAgentId = agentId;
  _currentChatId = chatId;
  if (manager) _subAgentManager = manager;
}

// ═══════════════════════════════════════════════
// 技能定义（不变）
// ═══════════════════════════════════════════════

export const SKILL_CONFIGURATION: Skill[] = [
  {
    id: "general-assistant",
    name: "通用助手",
    description: "基础助手技能，提供搜索、计算、时间查询、文件读写等通用能力",
    tools: ["web_search", "calculate", "get_time", "read_file", "write_file", "list_dir", "shell_exec"],
    prompt: "你是一个通用的 AI 助手。可以帮用户搜索信息、做数学计算、查时间、读写文件、浏览目录、执行系统命令。当用户提出问题时，判断是否需要调用工具，需要就直接调用。",
  },
  {
    id: "image-agent",
    name: "图片生成",
    description: "具备图片生成能力，能根据文字描述生成图片",
    tools: ["web_search", "generate_image"],
    prompt: "你是一个有创造力的 AI 助手，不仅能用文字回复，还能帮用户生成图片。当用户要求画图或生成图片时，调用 generate_image 工具。",
  },
  {
    id: "web-research",
    name: "网络调研",
    description: "具备搜索网页、调研信息能力",
    tools: ["web_search", "scrape_url"],
    prompt: "你是一个擅长信息检索的 AI 助手。遇到不确定的问题，主动用 web_search 搜索最新信息，也可以直接获取网页内容。",
  },
  {
    id: "coding-assistant",
    name: "编程助手",
    description: "擅长写代码、运行代码片段、分析数据结构",
    tools: ["code_execute", "read_file", "write_file", "shell_exec", "list_dir", "delete_file", "rename_file"],
    prompt: "你是一个编程 AI 助手。可以帮用户写代码，可以用 code_execute 运行代码片段验证结果，可以用 read_file/write_file 读写代码文件，可以用 shell_exec 执行系统命令，用 list_dir 浏览目录，用 delete_file/rename_file 管理文件。",
  },
  {
    id: "social-media",
    name: "社媒运营",
    description: "适合发微博、微信文案、小红书风格内容的创作",
    tools: ["web_search"],
    prompt: "你是社媒内容助手。擅长用生动口语调用 emoji 来写文案。创作风格活泼，符合不同平台风格（微博短快、微信深度、小红书种草）。",
  },
];

// ═══════════════════════════════════════════════
// 工具 1: 网络搜索
// ═══════════════════════════════════════════════

const TOOL_WEB_SEARCH: ToolDefinition = {
  name: "web_search",
  description: "Search the web using multiple sources.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      max_results: { type: "number", description: "Number of results", default: 5 },
    },
    required: ["query"],
  },
};

async function handleWebSearch(args: Record<string, any>) {
  const { query, max_results = 5 } = args;
  return searchManager.search(query, max_results);
}

// ═══════════════════════════════════════════════
// 工具 2: 计算器
// ═══════════════════════════════════════════════

const TOOL_CALCULATE: ToolDefinition = {
  name: "calculate",
  description: "Perform safe mathematical calculations.",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: "Math expression" },
    },
    required: ["expression"],
  },
};

async function handleCalculate(args: Record<string, any>) {
  const { expression } = args;
  if (typeof expression !== 'string' || expression.length === 0 || expression.length > 500) return { expression: String(expression||''), error: '表达式为空或过长' };
  try {
    // 安全修复 P0#1：废弃 Function()（原型链逃逸 RCE），改用 vm.runInNewContext
    const vm = await import("vm");
    const ctx = Object.assign(Object.create(null), {
      Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set,
      parseInt, parseFloat, isNaN, isFinite,
      pi: Math.PI, e: Math.E, sin: Math.sin, cos: Math.cos, tan: Math.tan,
      asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
      sqrt: Math.sqrt, log: Math.log, ln: Math.log, log10: Math.log10, log2: Math.log2,
      abs: Math.abs, pow: Math.pow, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
      max: Math.max, min: Math.min, random: Math.random, sign: Math.sign, cbrt: Math.cbrt, hypot: Math.hypot,
    });
    const safeExpr = expression.replace(/\^/g, '**');
    const script = new vm.Script('(function(){ "use strict"; return (' + safeExpr + '); })()');
    const result = script.runInNewContext(ctx, { timeout: 3000 });
    if (typeof result !== 'number' || !Number.isFinite(result)) return { expression, error: '无法计算: 结果不是有效数字' };
    return { expression, result: Number(result.toFixed(10)) };
  } catch (err: any) { return { expression, error: `无法计算: ${err.message}` }; }
}

// ═══════════════════════════════════════════════
// 工具 3: 系统时间
// ═══════════════════════════════════════════════

const TOOL_GET_TIME: ToolDefinition = {
  name: "get_time",
  description: "Get current date/time and timezone information.",
  parameters: {
    type: "object",
    properties: {
      format: { type: "string", description: "Output format", default: "full", enum: ["full", "short", "unix"] },
    },
    required: [],
  },
};

async function handleGetTime(args: Record<string, any>) {
  const { format = "full" } = args;
  const now = new Date();
  if (format === "short") return now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  if (format === "unix") return { unix: now.getTime(), iso: now.toISOString() };
  return {
    iso: now.toISOString(),
    locale: now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
    weekday: now.toLocaleString("zh-CN", { weekday: "long", timeZone: "Asia/Shanghai" }),
    timezone: "Asia/Shanghai (GMT+8)",
    timestamp: now.getTime(),
  };
}

// ═══════════════════════════════════════════════
// 工具 4: 抓取网页
// ═══════════════════════════════════════════════

const TOOL_SCRAPE_URL: ToolDefinition = {
  name: "scrape_url",
  description: "Fetch and extract readable text from a URL.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch" },
      max_chars: { type: "number", description: "Max characters", default: 3000 },
    },
    required: ["url"],
  },
};

async function handleScrapeUrl(args: Record<string, any>) {
  const url = String(args.url || "");
  const maxChars = Number(args.max_chars ?? 5000);
  if (!/^https?:\/\//i.test(url)) {
    return { error: "URL 必须以 http(s):// 开头", url };
  }
  if (!isSsrfSafeUrl(url)) return { error: '该 URL 被安全策略阻止（内网地址）' };
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const res = await fetch(jinaUrl, {
      signal: AbortSignal.timeout(15000),
      headers: { "X-Return-Format": "text", "X-Timeout": "12" },
    });
    if (res.ok) {
      const text = await res.text();
      if (text && text.length > 50) {
        const titleMatch = text.match(/^Title:\s*(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : url;
        return { url, title, content: text.slice(0, maxChars), totalChars: text.length, truncated: text.length > maxChars, source: "jina" };
      }
    }
  } catch {}
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const html = await res.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/\s+/g, " ").trim();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : url;
    return { url, title, content: text.slice(0, maxChars), totalChars: text.length, truncated: text.length > maxChars, source: "local" };
  } catch (err: any) {
    return { error: `抓取失败: ${err.message}`, url };
  }
}

// ═══════════════════════════════════════════════
// 工具 5: 生成图片
// ═══════════════════════════════════════════════

const TOOL_GENERATE_IMAGE: ToolDefinition = {
  name: "generate_image",
  description: "Generate an image from a text description.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Image description" },
      size: { type: "string", description: "Image size", default: "1024x1024", enum: ["512x512", "1024x1024"] },
    },
    required: ["prompt"],
  },
};

async function handleGenerateImage(args: Record<string, any>) {
  const { prompt, size = "1024x1024" } = args;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({ model: "dall-e-3", prompt, size, n: 1 }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json() as any;
      if (data.data?.[0]?.url) return { prompt, size, url: data.data[0].url, source: "dall-e-3" };
    } catch {}
  }
  try {
    const w = size.split("x")[0] || "1024";
    const h = size.split("x")[1] || "1024";
    const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${Date.now() % 1000000}`;
    return { prompt, size, url: pollUrl, source: "pollinations" };
  } catch {}
  return { prompt, url: `https://via.placeholder.com/${size}?text=${encodeURIComponent(prompt.slice(0, 20))}`, source: "placeholder" };
}

// ═══════════════════════════════════════════════
// 工具 5.5: GitHub 搜索
// ═══════════════════════════════════════════════

const TOOL_GITHUB_SEARCH: ToolDefinition = {
  name: "github_search",
  description: "Search GitHub repositories, code, issues.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      type: { type: "string", description: "Search type: repositories, code, issues" },
      max_results: { type: "number", description: "Max results", default: 5 },
    },
    required: ["query"],
  },
};

async function handleGithubSearch(args: Record<string, any>) {
  const { query, type = "repositories", max_results = 5 } = args;
  try {
    const url = `https://api.github.com/search/${type}?q=${encodeURIComponent(query)}&per_page=${max_results}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'LingXi-Engine' }
    });
    const data = await res.json() as any;
    const items = (data.items || []).slice(0, max_results);
    return { query, type, total: data.total_count, results: items.map((item: any) => ({
      title: item.full_name || item.name || '', url: item.html_url || '',
      snippet: (item.description || '').slice(0, 200), stars: item.stargazers_count, language: item.language,
    })) };
  } catch (err: any) {
    return { query, error: `GitHub 搜索失败: ${err.message}` };
  }
}

// ═══════════════════════════════════════════════
// 工具 5.8: patch_file — 智能差异编辑（9策略模糊匹配）
// ═══════════════════════════════════════════════

const TOOL_PATCH_FILE: ToolDefinition = {
  name: "patch_file", description: "Targeted file editing via find-and-replace with 9-strategy fuzzy matching. Returns unified diff.",
  parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean", default: false } }, required: ["path","old_string","new_string"] },
};

function fuzzyFind(haystack: string, needle: string): { found: boolean; start: number; end: number; strategy: string } {
  let idx = haystack.indexOf(needle); if (idx !== -1) return { found: true, start: idx, end: idx + needle.length, strategy: 'exact' };
  const t = needle.trim(); idx = haystack.indexOf(t); if (idx !== -1) return { found: true, start: idx, end: idx + t.length, strategy: 'trim' };
  const col = (s: string) => s.replace(/\s+/g, ' ');
  let ci = col(haystack).indexOf(col(needle));
  if (ci !== -1) { let oi=0,cn=0; while(cn<ci&&oi<haystack.length){if(/\s/.test(haystack[oi])){while(oi<haystack.length&&/\s/.test(haystack[oi]))oi++;cn++}else{oi++;cn++}} return { found: true, start: oi, end: oi+needle.length, strategy: 'collapse' }; }
  const ni = (s: string) => s.replace(/\t/g, '    '); idx = ni(haystack).indexOf(ni(needle));
  if (idx !== -1) return { found: true, start: idx, end: idx+ni(needle).length, strategy: 'indent' };
  const rel = (s: string) => s.split('\n').filter(l => l.trim()).join('\n'); idx = rel(haystack).indexOf(rel(needle));
  if (idx !== -1) return { found: true, start: idx, end: idx+rel(needle).length, strategy: 'no_empty' };
  const p80 = Math.floor(needle.length * 0.8); idx = haystack.indexOf(needle.slice(0, p80));
  if (idx !== -1) return { found: true, start: idx, end: idx+p80, strategy: 'prefix80' };
  idx = haystack.indexOf(needle.slice(-p80));
  if (idx !== -1) return { found: true, start: idx-(needle.length-p80), end: idx+p80, strategy: 'suffix80' };
  const nL = needle.split('\n').filter(l => l.trim()); if (nL.length >= 2) { const hL = haystack.split('\n');
    for (let i = 0; i < hL.length; i++) { if (hL[i].trim() === nL[0].trim()) { let m = 0;
        for (let j = 0; j < nL.length && (i+j) < hL.length; j++) { if (hL[i+j].trim() === nL[j].trim()) m++; else break; }
        if (m >= nL.length * 0.7) { let ls = 0; for (let k = 0; k < i; k++) ls = haystack.indexOf('\n', ls) + 1; return { found: true, start: ls, end: ls+needle.length, strategy: 'line' }; }
  }}}
  if (needle.length > 20) { idx = haystack.indexOf(needle.slice(0,20)); if (idx !== -1) return { found: true, start: idx, end: idx+needle.length, strategy: 'first20' };
    idx = haystack.indexOf(needle.slice(-20)); if (idx !== -1) return { found: true, start: idx-(needle.length-20), end: idx+20, strategy: 'last20' }; }
  // Strategy 9: CRLF -> LF normalization via char codes
  var cr = String.fromCharCode(13);
  idx = haystack.replace(new RegExp(cr+'\\n','g'),'\n').replace(new RegExp(cr,'g'),'\n')
    .indexOf(needle.replace(new RegExp(cr+'\\n','g'),'\n').replace(new RegExp(cr,'g'),'\n'));
  if (idx !== -1) return { found: true, start: idx, end: idx+needle.length, strategy: 'crlf' };
  return { found: false, start: 0, end: 0, strategy: 'none' };
}

function generateUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  const oL = oldText.split('\n'), nL = newText.split('\n'), maxL = Math.max(oL.length, nL.length), lines: string[] = [];
  for (let i = 0; i < maxL; i++) { const o = i < oL.length ? oL[i] : null, n = i < nL.length ? nL[i] : null;
    if (o !== n) { if (o !== null) lines.push('-' + o); if (n !== null) lines.push('+' + n); } else lines.push(' ' + o); }
  if (lines.length === 0) return '--- a/' + filePath + '\n+++ b/' + filePath + '\n@@ -1,1 +1,1 @@\n (no changes)';
  return '--- a/' + filePath + '\n+++ b/' + filePath + '\n@@ -1,' + oL.length + ' +1,' + nL.length + ' @@\n' + lines.join('\n');
}

async function handlePatchFile(args: Record<string, any>) {
  const { path: relPath, old_string, new_string, replace_all = false } = args;
  // 安全修复 P2#20：校验 old_string 非空
  if (typeof old_string !== "string" || old_string.length === 0) return { error: "old_string 不能为空", path: relPath, ok: false };
  if (typeof new_string !== "string") return { error: "new_string 必须是字符串", path: relPath, ok: false };
  try { const absPath = safePath(relPath); if (!existsSync(absPath)) return { error: `File not found: ${relPath}`, path: relPath, ok: false };
    let hs = readFileSync(absPath, 'utf8'); const orig = hs; let rep = 0;
    if (replace_all) { const r = fuzzyFind(hs, old_string); if (!r.found) return { error: 'No match (9 strategies)', path: relPath, ok: false };
      hs = hs.split(old_string).join(new_string); rep = (orig.match(new RegExp(old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length; }
    else { const r = fuzzyFind(hs, old_string); if (!r.found) return { error: 'No match (9 strategies). Try read_file first.', path: relPath, ok: false };
      hs = hs.slice(0, r.start) + new_string + hs.slice(r.end); rep = 1; }
    writeFileSync(absPath, hs, 'utf8'); const diff = generateUnifiedDiff(orig, hs, relPath);
    return { path: relPath, ok: true, replaced: rep, diff, fileSize: Buffer.byteLength(hs, 'utf8') };
  } catch (err: any) { return { error: `patch_file failed: ${err.message}`, path: relPath, ok: false }; }
}

// ═══════════════════════════════════════════════
// 工具 5.9-5.13: Git 集成（5个工具）
// ═══════════════════════════════════════════════

const TOOL_GIT_STATUS: ToolDefinition = { name: "git_status", description: "Show working tree status. Read-only.", parameters: { type: "object", properties: { path: { type: "string" } }, required: [] } };
async function handleGitStatus(args: Record<string, any>) { const rp = args.path || process.cwd();
  try { const out = execSync('git status --short', { cwd: rp, encoding: 'utf8', timeout: 10000 }); return { status: out||'(clean)', repoPath: rp, ok: true }; }
  catch (e: any) { return { error: `git status: ${e.stderr||e.message}`, repoPath: rp, ok: false }; } }

const TOOL_GIT_DIFF: ToolDefinition = { name: "git_diff", description: "Show working tree changes. Read-only.", parameters: { type: "object", properties: { staged: { type: "boolean", default: false }, file: { type: "string" }, path: { type: "string" } }, required: [] } };
async function handleGitDiff(args: Record<string, any>) { const { staged=false, file, path: rp=process.cwd() } = args;
  try { const p = ['git','diff']; if (staged) p.push('--cached'); if (file) p.push('--',file);
    const out = execFileSync(p[0], p.slice(1), { cwd: rp, encoding: 'utf8', timeout: 15000, maxBuffer: 10*1024*1024 }); return { diff: out||'(no changes)', staged, file: file||'all', repoPath: rp, ok: true }; }
  catch (e: any) { return { error: `git diff: ${e.stderr||e.message}`, repoPath: rp, ok: false }; } }

const TOOL_GIT_LOG: ToolDefinition = { name: "git_log", description: "Show commit history. Read-only.", parameters: { type: "object", properties: { count: { type: "number", default: 10 }, file: { type: "string" }, path: { type: "string" } }, required: [] } };
async function handleGitLog(args: Record<string, any>) { const { count=10, file, path: rp=process.cwd() } = args;
  try { const p = ['git','log','-'+Math.min(count,50),'--oneline','--decorate']; if (file) p.push('--',file);
    const out = execFileSync(p[0], p.slice(1), { cwd: rp, encoding: 'utf8', timeout: 10000 }); return { log: out||'(no commits)', count, repoPath: rp, ok: true }; }
  catch (e: any) { return { error: `git log: ${e.stderr||e.message}`, repoPath: rp, ok: false }; } }

const TOOL_GIT_COMMIT: ToolDefinition = { name: "git_commit", description: "Create a commit with staged changes. Requires approval.", parameters: { type: "object", properties: { message: { type: "string" }, files: { type: "array", items: { type: "string" } }, path: { type: "string" } }, required: ["message"] } };
async function handleGitCommit(args: Record<string, any>) { const { message, files, path: rp=process.cwd() } = args;
  try { const p = ['git','commit','-m',message]; if (files && files.length>0) p.push('--',...files.map((f:string)=>f));
    const out = execFileSync(p[0], p.slice(1), { cwd: rp, encoding: 'utf8', timeout: 15000 });
    const hash = execSync('git rev-parse --short HEAD', { cwd: rp, encoding: 'utf8', timeout: 5000 }).trim();
    return { message, hash, output: out.trim(), repoPath: rp, ok: true }; }
  catch (e: any) { return { error: `git commit: ${e.stderr||e.message}`, repoPath: rp, ok: false }; } }

const TOOL_GIT_BRANCH: ToolDefinition = { name: "git_branch", description: "List branches or show current.", parameters: { type: "object", properties: { action: { type: "string", enum: ["list","current"], default: "list" }, path: { type: "string" } }, required: [] } };
async function handleGitBranch(args: Record<string, any>) { const { action='list', path: rp=process.cwd() } = args;
  try { if (action === 'current') { const out = execSync('git rev-parse --abbrev-ref HEAD', { cwd: rp, encoding: 'utf8', timeout: 5000 }); return { branch: out.trim(), repoPath: rp, ok: true }; }
    const out = execSync('git branch --list', { cwd: rp, encoding: 'utf8', timeout: 5000 }); return { branches: out.trim().split('\n').map((b:string)=>b.replace(/^\*?\s+/,'')), repoPath: rp, ok: true }; }
  catch (e: any) { return { error: `git branch: ${e.stderr||e.message}`, repoPath: rp, ok: false }; } }

// ═══════════════════════════════════════════════
// 工具 6: 执行代码（Docker 沙箱优先）
// ═══════════════════════════════════════════════

const TOOL_CODE_EXECUTE: ToolDefinition = {
  name: "code_execute",
  description: "Execute JavaScript code in an isolated VM. Safe, no access to filesystem or network (for network ops use shell_exec).",
  parameters: {
    type: "object",
    properties: {
      language: { type: "string", description: "Language: javascript", enum: ["javascript"], default: "javascript" },
      code: { type: "string", description: "Code to execute" },
      timeout: { type: "number", description: "Timeout in ms", default: 5000 },
    },
    required: ["code"],
  },
};

async function handleCodeExecute(args: Record<string, any>) {
  const { code, timeout = 5000, language = "javascript" } = args;
  if (language !== "javascript") return { error: "目前只支持 JavaScript 执行", language };

  // Docker 沙箱优先
  if (dockerAvailable && runJsInDockerFn) {
    try {
      const result = await runJsInDockerFn(code, timeout);
      if (result.ok) {
        let parsed: any;
        try { parsed = JSON.parse(result.stdout); } catch { parsed = { output: result.stdout }; }
        return { language, output: parsed.output || result.stdout, ok: true, sandbox: 'docker' };
      }
      return { language, output: result.stderr || '', error: result.error || '执行失败', sandbox: 'docker' };
    } catch (err: any) {
      return { language, error: `Docker 沙箱执行失败: ${err.message}` };
    }
  }

  // 内置执行（默认允许，设置 CODE_EXEC_ALLOW_VM=0 可禁用）
  if (process.env.CODE_EXEC_ALLOW_VM === '0') {
    return { language, error: 'VM 执行已被管理员禁用。请安装 Docker 或设置 CODE_EXEC_ALLOW_VM=1', exitCode: 1 };
  }
  try {
    const logs: string[] = [];
    const fakeConsole = {
      log: (...args: any[]) => logs.push(args.map(String).join(" ")),
      error: (...args: any[]) => logs.push("[ERROR] " + args.map(String).join(" ")),
      warn: (...args: any[]) => logs.push("[WARN] " + args.map(String).join(" ")),
    };
    const vm = await import("vm");
    const script = new vm.Script(code);
    const context = vm.createContext({
      console: fakeConsole,
      Math, JSON, Date, Array, Object, String, Number, Boolean,
      RegExp, Map, Set, parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent, URL, URLSearchParams,
    });
    // 安全加固：不暴露 require/process/setTimeout/Buffer
    const returnValue = script.runInNewContext(context, { timeout });
    return {
      language, output: logs.join("\n"),
      returnValue: typeof returnValue === "object" ? JSON.stringify(returnValue, null, 2) : String(returnValue),
      exitCode: 0, sandbox: 'vm',
    };
  } catch (err: any) {
    return { error: `执行失败: ${err.message}`, language, exitCode: 1 };
  }
}

// ═══════════════════════════════════════════════
// 工具 7: 写文件
// ═══════════════════════════════════════════════

const TOOL_WRITE_FILE: ToolDefinition = {
  name: "write_file",
  description: "Write plain-text content to a file. NOTE: Only supports UTF-8 text. Cannot write binary formats (docx/xlsx/pptx/pdf/zip). For binary formats, use shell_exec with Python (e.g. python-docx for .docx, openpyxl for .xlsx).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path within workspace" },
      content: { type: "string", description: "File content (plain text only)" },
    },
    required: ["path", "content"],
  },
};

async function handleWriteFile(args: Record<string, any>) {
  const { path: relPath, content } = args;
  try {
    const absPath = safePath(relPath);
    const dir = resolve(absPath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, content, "utf8");
    return { path: relPath, bytes: Buffer.byteLength(content, "utf8"), absolutePath: absPath, ok: true };
  } catch (err: any) {
    return { error: `写入失败: ${err.message}`, path: relPath };
  }
}

// ═══════════════════════════════════════════════
// 工具 8: 读文件
// ═══════════════════════════════════════════════

const TOOL_READ_FILE: ToolDefinition = {
  name: "read_file",
  description: "Read content from a file. Supports text, Office/WPS (.docx/.xlsx/.pptx), and PDF.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path within workspace" },
      max_bytes: { type: "number", description: "Max bytes", default: 50000 },
    },
    required: ["path"],
  },
};

async function handleReadFile(args: Record<string, any>) {
  const { path: relPath, max_bytes = 50000 } = args;
  try {
    const absPath = safePath(relPath);
    if (!existsSync(absPath)) return { error: `文件不存在: ${relPath}`, path: relPath };
    const stat = statSync(absPath);
    const ext = extname(relPath).toLowerCase();

    // Office/WPS 文档：docx/xlsx/pptx
    if (['.docx', '.xlsx', '.pptx', '.pdf'].includes(ext)) {
      const result = readOfficeDocument(absPath);
      if (!result.ok) return { error: result.error || '文档解析失败', path: relPath };
      return {
        path: relPath, content: result.content.slice(0, max_bytes),
        size: stat.size, type: result.type,
        modified: stat.mtime.toISOString(), truncated: result.content.length > max_bytes,
      };
    }

    const buffer = readFileSync(absPath);
    const content = buffer.toString("utf8", 0, Math.min(max_bytes, buffer.length));
    return { path: relPath, content, size: stat.size, modified: stat.mtime.toISOString(), truncated: buffer.length > max_bytes };
  } catch (err: any) {
    return { error: `读取失败: ${err.message}`, path: relPath };
  }
}

// ═══════════════════════════════════════════════
// 工具 10: shell_exec（Docker 沙箱优先）
// ═══════════════════════════════════════════════

const TOOL_SHELL_EXEC: ToolDefinition = {
  name: "shell_exec",
  description: "Execute a shell command. Full network access — can use curl, wget, pip, npm, apt, git, etc. Not sandboxed.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command" },
      timeout: { type: "number", description: "Timeout in ms", default: 15000 },
      cwd: { type: "string", description: "Working directory" },
    },
    required: ["command"],
  },
};

async function handleShellExec(args: Record<string, any>) {
  const { command, timeout = 30000, cwd } = args;

  // Docker 沙箱优先（仅在显式启用时）
  if (process.env.USE_DOCKER_SANDBOX === 'true' && dockerAvailable && runShellInDockerFn) {
    try {
      const validatedCwd = cwd ? safePath(cwd) : undefined;
      const result = await runShellInDockerFn(command, timeout, validatedCwd);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 1, sandbox: 'docker' };
    } catch (err: any) { return { error: 'Docker 沙箱执行失败: ' + err.message, exitCode: -1 }; }
  }

  // v2.0: 本地直接执行（全功能 shell）
  // 仅保留高危破坏性命令黑名单，其余全部放开
  const cmdLower = command.trim().toLowerCase();
  const blockedPatterns = [
    /\bformat\s+[a-z]:/i,          // 格式化磁盘
    /\bfdisk\b/, /\bdiskpart\b/,    // 磁盘分区
    /\bmkfs\b/, /\bdd\s+if=/,      // Linux 磁盘破坏
    /\brm\s+(-[a-z]*\s+)*\/\s*$/,  // rm -rf /
    /\bshutdown\b/, /\breboot\b/, /\bhalt\b/, /\bpoweroff\b/,  // 关机
    /\bbcdedit\b/,                  // 引导记录
  ];
  for (const pat of blockedPatterns) {
    if (pat.test(cmdLower)) return { error: `命令匹配高危破坏性操作模式，已禁止。`, exitCode: -1 };
  }

  try {
    const opts: any = { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, shell: true };
    if (cwd) { const sc = safePath(cwd); if (existsSync(sc)) opts.cwd = sc; }
    const stdout = execSync(command, opts).toString().trim();
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    const stdout = e.stdout ? e.stdout.toString().trim() : '';
    return { stdout, stderr, exitCode: e.status ?? 1, error: e.message?.split('\n')[0] };
  }
}

// ═══════════════════════════════════════════════
// 工具 11: list_dir
// ═══════════════════════════════════════════════

const TOOL_LIST_DIR: ToolDefinition = {
  name: "list_dir",
  description: "List files and directories.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path" },
      recursive: { type: "boolean", description: "List recursively?", default: false },
    },
    required: ["path"],
  },
};

async function handleListDir(args: Record<string, any>) {
  const { path: dirPath, recursive = false } = args;
  try {
    const absPath = safePath(dirPath);
    if (!existsSync(absPath)) return { error: 'dir not found: ' + dirPath };
    if (!statSync(absPath).isDirectory()) return { error: 'not a directory: ' + dirPath };
    const items: any[] = [];
    const MAX_DEPTH = 20;
    let depth = 0;
    const walk = (dir: string) => {
      if (++depth > MAX_DEPTH) return;
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stat = statSync(full);
        items.push({ name, isDir: stat.isDirectory(), size: stat.size, modified: stat.mtime.toISOString() });
        if (recursive && stat.isDirectory()) walk(full);
      }
      depth--;
    };
    walk(absPath);
    return { path: absPath, items, count: items.length };
  } catch (err: any) {
    return { error: 'list_dir failed: ' + err.message };
  }
}

// ═══════════════════════════════════════════════
// 工具 12: delete_file
// ═══════════════════════════════════════════════

const TOOL_DELETE_FILE: ToolDefinition = {
  name: "delete_file",
  description: "Delete a file or empty directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to delete" },
      recursive: { type: "boolean", description: "Delete recursively?", default: false },
    },
    required: ["path"],
  },
};

async function handleDeleteFile(args: Record<string, any>) {
  const { path: targetPath, recursive = false } = args;
  try {
    const absPath = safePath(targetPath);
    if (!existsSync(absPath)) return { error: 'path not found: ' + targetPath };
    const normTarget = absPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const normRoot = _workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (recursive && (normTarget === normRoot || normTarget === normRoot + '/.')) {
      return { error: '不允许递归删除工作区根目录' };
    }
    if (recursive) rmSync(absPath, { recursive: true, force: true });
    else if (statSync(absPath).isDirectory()) rmSync(absPath, { recursive: false });
    else rmSync(absPath, { force: true });
    return { deleted: targetPath, ok: true };
  } catch (err: any) {
    return { error: 'delete failed: ' + err.message, path: targetPath };
  }
}

// ═══════════════════════════════════════════════
// 工具 13: rename_file
// ═══════════════════════════════════════════════

const TOOL_RENAME_FILE: ToolDefinition = {
  name: "rename_file",
  description: "Rename or move a file/directory in workspace.",
  parameters: {
    type: "object",
    properties: {
      oldPath: { type: "string", description: "Current path" },
      newPath: { type: "string", description: "Destination path" },
    },
    required: ["oldPath", "newPath"],
  },
};

async function handleRenameFile(args: Record<string, any>) {
  const { oldPath, newPath } = args;
  try {
    const absOld = safePath(oldPath);
    const absNew = safePath(newPath);
    if (!existsSync(absOld)) return { error: 'path not found: ' + oldPath };
    renameSync(absOld, absNew);
    return { from: oldPath, to: newPath, ok: true };
  } catch (err: any) {
    return { error: 'rename failed: ' + err.message };
  }
}

// ═══════════════════════════════════════════════
// 工具 14: web_fetch — URL 内容抓取（智能 MIME 识别）
// ═══════════════════════════════════════════════

const TOOL_WEB_FETCH: ToolDefinition = {
  name: "web_fetch",
  description: "Fetch content from a URL with smart MIME handling: HTML→stripped text, JSON→parsed summary, image→dimensions+format. Read-only, no danger.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch (http/https)" },
      max_length: { type: "number", description: "Max characters to return", default: 5000 },
      timeout: { type: "number", description: "Timeout in ms", default: 15000 },
    },
    required: ["url"],
  },
};

async function handleWebFetch(args: Record<string, any>) {
  const { url, max_length = 5000, timeout = 15000 } = args;

  // 验证 URL
  if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(url)) {
    return { error: 'Invalid URL. Must start with http:// or https://', url };
  }

  // [已解除] localhost/内网限制已全部放开
  const lower = url.toLowerCase();
  // 只阻止云元数据端点（SSRF防护）
  if (lower.includes('169.254.169.254') || lower.includes('metadata.')) {
    return { error: 'URL blocked: cloud metadata endpoint', url };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeout, 30000));
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LingXi-Engine/2.0 (WebFetcher)' },
      redirect: 'manual',
    });
    clearTimeout(timer);
    const text = await r.text();
    return { status: r.status, body: text.slice(0, 10000), truncated: text.length > 10000 };
  } catch(e: any) { return { error: e.message }; }
}

// ═══════════════════════════════════════════════
// 工具: delegate_task — 子代理委托
// ═══════════════════════════════════════════════

const TOOL_DELEGATE_TASK: ToolDefinition = {
  name: "delegate_task",
  description: "Spawn a sub-agent to handle a specific task independently.",
  parameters: {
    type: "object",
    properties: {
      objective: { type: "string", description: "Clear task description for the sub-agent" },
      timeout: { type: "number", description: "Timeout in seconds (default 60)", default: 60 },
    },
    required: ["objective"],
  },
};

// v1.5.0: 上下文注入（由 executor 在调用前设置）
// 注：setDelegateContext 已在文件头部定义

async function handleDelegateTask(args: Record<string, any>) {
  const { objective, timeout = 60 } = args;
  if (!_subAgentManager) return { error: 'SubAgent 系统未就绪' };
  try {
    const taskId = await _subAgentManager.spawn({
      objective,
      parentId: _currentAgentId || 'delegate-caller',
      chatId: _currentChatId || 'delegate-chat',
      timeoutSeconds: Math.min(timeout, 180),
    });
    const result = await _subAgentManager.awaitResult(taskId, Math.min(timeout, 180) * 1000);
    if (!result) return { error: '子任务未返回结果' };
    if (result.status === 'completed') {
      return { taskId, status: 'completed', result: result.result };
    }
    return { taskId, status: result.status, error: result.error || '未知错误' };
  } catch (err: any) {
    return { error: 'delegate_task 失败: ' + err.message };
  }
}

// ═══════════════════════════════════════════════
// 工具: json_parse — 容错 JSON 解析
// ═══════════════════════════════════════════════

const TOOL_JSON_PARSE: ToolDefinition = {
  name: "json_parse",
  description: "Parse and clean malformed JSON. Handles trailing commas, single quotes, comments.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "JSON string to parse (may be malformed)" },
    },
    required: ["text"],
  },
};

async function handleJsonParse(args: Record<string, any>) {
  const { text } = args;
  if (typeof text !== 'string' || !text.trim()) return { error: 'Empty input', parsed: null };
  try { return { parsed: JSON.parse(text), method: 'strict' }; } catch {}
  let cleaned = text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  cleaned = cleaned.replace(/\b(Infinity|NaN)\b/g, '"$1"');
  const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) cleaned = jsonMatch[1];
  try {
    const parsed = JSON.parse(cleaned);
    return { parsed, method: 'tolerant', cleaned: true };
  } catch (err: any) {
    return { error: 'JSON parse failed: ' + err.message, preview: cleaned.slice(0, 500) };
  }
}

// ═══════════════════════════════════════════════
// 工具: http_get
// ═══════════════════════════════════════════════

const TOOL_HTTP_GET: ToolDefinition = {
  name: "http_get",
  description: "Send an HTTP GET request to a URL and return the response body.",
  parameters: { type: "object", properties: { url: { type: "string" }, headers: { type: "string", description: "Optional JSON headers" } }, required: ["url"] },
};
async function handleHttpGet(args: Record<string, any>) {
  try {
    const h = args.headers ? JSON.parse(args.headers) : {};
    const r = await fetch(args.url, { headers: h, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    return { status: r.status, body: text.slice(0, 10000), truncated: text.length > 10000 };
  } catch(e: any) { return { error: e.message }; }
}

const TOOL_HTTP_POST: ToolDefinition = {
  name: "http_post",
  description: "Send an HTTP POST request with a JSON body.",
  parameters: { type: "object", properties: { url: { type: "string" }, body: { type: "string", description: "JSON body" }, headers: { type: "string", description: "Optional JSON headers" } }, required: ["url"] },
};
async function handleHttpPost(args: Record<string, any>) {
  try {
    if (!isSsrfSafeUrl(args.url)) return { error: "URL 不安全：禁止访问内网/元数据端点" };
    const h = { "Content-Type": "application/json", ...(args.headers ? JSON.parse(args.headers) : {}) };
    const r = await fetch(args.url, { method: "POST", headers: h, body: args.body || "{}", signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    return { status: r.status, body: text.slice(0, 5000) };
  } catch(e: any) { return { error: e.message }; }
}

const TOOL_CSV_PARSE: ToolDefinition = {
  name: "csv_parse",
  description: "Parse a CSV string or file content into an array of objects.",
  parameters: { type: "object", properties: { content: { type: "string", description: "CSV content" }, delimiter: { type: "string", description: "Delimiter, default comma" } }, required: ["content"] },
};
function parseCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (line.startsWith(delim, i)) {
        out.push(cur.trim());
        cur = '';
        i += delim.length - 1;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur.trim());
  return out;
}
async function handleCsvParse(args: Record<string, any>) {
  try {
    const delim = args.delimiter || ",";
    const lines = args.content.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return { rows: [], error: "CSV needs at least header + 1 row" };
    const headers = parseCsvLine(lines[0], delim);
    const rows = lines.slice(1).map((line: string) => {
      const vals = parseCsvLine(line, delim);
      const row: Record<string, string> = {};
      headers.forEach((h: string, i: number) => { row[h] = vals[i] || ""; });
      return row;
    });
    return { headers, rows: rows.slice(0, 200), total: rows.length };
  } catch(e: any) { return { error: e.message }; }
}

const TOOL_JSON_TRANSFORM: ToolDefinition = {
  name: "json_transform",
  description: "Query or transform JSON data using simple dot-notation paths.",
  parameters: { type: "object", properties: { json: { type: "string", description: "JSON string" }, path: { type: "string", description: "Dot path like 'users.0.name'" }, filter: { type: "string", description: "Optional key=value filter" } }, required: ["json"] },
};
async function handleJsonTransform(args: Record<string, any>) {
  try {
    const obj = JSON.parse(args.json);
    if (!args.path) return { result: obj };
    const parts = args.path.split(".");
    let val: any = obj;
    for (const p of parts) { if (val && typeof val === "object") val = val[p]; else return { error: `Path not found: ${args.path}` }; }
    return { result: val };
  } catch(e: any) { return { error: e.message }; }
}

const TOOL_REGEX_SEARCH: ToolDefinition = {
  name: "regex_search",
  description: "Search text with a regular expression and return matches.",
  parameters: { type: "object", properties: { text: { type: "string" }, pattern: { type: "string", description: "Regex pattern" }, flags: { type: "string", description: "Regex flags like 'gi'" } }, required: ["text", "pattern"] },
};
async function handleRegexSearch(args: Record<string, any>) {
  try {
    // 安全修复 P2#26：限制 pattern 长度降低 ReDoS 风险
    if (typeof args.pattern !== "string" || args.pattern.length > 500) return { error: "正则表达式过长（上限500字符）" };
    const re = new RegExp(args.pattern, args.flags || "g");
    const matches = [...args.text.matchAll(re)].slice(0, 100).map(m => ({ match: m[0], index: m.index, groups: m.groups || {} }));
    return { matches, count: matches.length };
  } catch(e: any) { return { error: e.message }; }
}

const TOOL_REGEX_REPLACE: ToolDefinition = {
  name: "regex_replace",
  description: "Replace text using a regular expression.",
  parameters: { type: "object", properties: { text: { type: "string" }, pattern: { type: "string" }, replacement: { type: "string" }, flags: { type: "string", description: "Default 'g'" } }, required: ["text", "pattern", "replacement"] },
};
async function handleRegexReplace(args: Record<string, any>) {
  try {
    if (typeof args.pattern !== 'string' || args.pattern.length > 500) return { error: '正则过长（上限500字符）' };
    const re = new RegExp(args.pattern, args.flags || "g");
    const result = args.text.replace(re, args.replacement);
    return { result };
  } catch(e: any) { return { error: e.message }; }
}

const TOOL_TRANSLATE: ToolDefinition = {
  name: "translate",
  description: "Translate text between languages using a simple dictionary-based approach for common phrases, or just returns the text unchanged for AI-driven translation.",
  parameters: { type: "object", properties: { text: { type: "string" }, from: { type: "string" }, to: { type: "string", description: "Target language like 'zh','en','ja'" } }, required: ["text"] },
};
async function handleTranslate(args: Record<string, any>) {
  return { text: args.text, from: args.from||"auto", to: args.to||"zh", note: "Translation is best handled by the AI model itself. This tool passes the text through for AI processing." };
}

const TOOL_HASH_VERIFY: ToolDefinition = {
  name: "hash_verify",
  description: "Compute SHA256 or MD5 hash of a string or file path.",
  parameters: { type: "object", properties: { input: { type: "string", description: "Text or file path" }, algorithm: { type: "string", description: "sha256 or md5" }, isFile: { type: "boolean", description: "Treat input as file path" } }, required: ["input"] },
};
async function handleHashVerify(args: Record<string, any>) {
  try {
    const crypto = await import("crypto");
    const algo = args.algorithm || "sha256";
    const data = args.isFile ? readFileSync(safePath(args.input)) : Buffer.from(args.input, "utf8");
    const hash = crypto.createHash(algo).update(data).digest("hex");
    return { algorithm: algo, hash };
  } catch(e: any) { return { error: e.message }; }
}

// ═══ v1.7.1 批量工具 (25个) ═══

const TOOL_DIFF: ToolDefinition={name:"diff_text",description:"Compare two text strings and show differences.",parameters:{type:"object",properties:{text1:{type:"string"},text2:{type:"string"}},required:["text1","text2"]}};
async function handleDiff(args:Record<string,any>){const a=args.text1||"",b=args.text2||"";const al=a.split("\n"),bl=b.split("\n");const out:string[]=[];for(let i=0;i<Math.max(al.length,bl.length);i++){if(i<al.length&&i<bl.length&&al[i]===bl[i])out.push(" "+al[i]);else{if(i<al.length)out.push("-"+al[i]);if(i<bl.length)out.push("+"+bl[i]);}}return{diff:out.join("\n")};}

const TOOL_TEMPLATE_RENDER: ToolDefinition={name:"template_render",description:"Render a template string with variables like {{name}}.",parameters:{type:"object",properties:{template:{type:"string"},vars:{type:"string",description:"JSON object of variables"}},required:["template"]}};
async function handleTemplateRender(args:Record<string,any>){try{const vars=args.vars?JSON.parse(args.vars):{};const result=args.template.replace(/\{\{(\w+)\}\}/g,(_:any,k:string)=>vars[k]??`{{${k}}}`);return{result};}catch(e:any){return{error:e.message}};}

const TOOL_NPM_SEARCH: ToolDefinition={name:"npm_search",description:"Search npm registry for packages.",parameters:{type:"object",properties:{query:{type:"string"},limit:{type:"number",description:"Max results, default 5"}},required:["query"]}};
async function handleNpmSearch(args:Record<string,any>){try{const r=await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(args.query)}&size=${args.limit||5}`,{signal:AbortSignal.timeout(10000)});const d=await r.json();return{total:d.total||0,results:(d.objects||[]).slice(0,args.limit||5).map((o:any)=>({name:o.package.name,version:o.package.version,description:o.package.description||""}))};}catch(e:any){return{error:e.message}};}

const TOOL_NPM_INFO: ToolDefinition={name:"npm_info",description:"Get detailed info about an npm package.",parameters:{type:"object",properties:{name:{type:"string"}},required:["name"]}};
async function handleNpmInfo(args:Record<string,any>){try{const r=await fetch(`https://registry.npmjs.org/${encodeURIComponent(args.name)}`,{signal:AbortSignal.timeout(10000)});if(!r.ok)return{error:`Package ${args.name} not found`};const d=await r.json();const latest=d.versions?.[d['dist-tags']?.latest];return{name:d._id,description:d.description,latest:latest?.version,license:latest?.license,repository:latest?.repository?.url};}catch(e:any){return{error:e.message}};}

const TOOL_DOWNLOAD_FILE: ToolDefinition={name:"download_file",description:"Download a file from URL to the workspace.",parameters:{type:"object",properties:{url:{type:"string"},filename:{type:"string",description:"Save as this filename"}},required:["url","filename"]}};
async function handleDownloadFile(args:Record<string,any>){try{if(!isSsrfSafeUrl(args.url))return{error:"URL 不安全"};const r=await fetch(args.url,{signal:AbortSignal.timeout(60000)});if(!r.ok)return{error:`HTTP ${r.status}`};const MAX_DOWNLOAD=100*1024*1024;const cl=parseInt(r.headers.get("content-length")||"0",10);if(cl>MAX_DOWNLOAD)return{error:"文件过大，上限100MB"};const buf=Buffer.from(await r.arrayBuffer());if(buf.length>MAX_DOWNLOAD)return{error:"文件过大，上限100MB"};writeFileSync(safePath(args.filename),buf);const stat=statSync(safePath(args.filename));return{path:args.filename,size:stat.size,type:r.headers.get("content-type")||"unknown"};}catch(e:any){return{error:e.message}};}

const TOOL_FETCH_JSON: ToolDefinition={name:"fetch_json",description:"Fetch a JSON API and return parsed data.",parameters:{type:"object",properties:{url:{type:"string"},headers:{type:"string",description:"Optional JSON headers"}},required:["url"]}};
async function handleFetchJson(args:Record<string,any>){try{if(!isSsrfSafeUrl(args.url))return{error:"URL 不安全"};const h={"Accept":"application/json",...(args.headers?JSON.parse(args.headers):{})};const r=await fetch(args.url,{headers:h,signal:AbortSignal.timeout(15000)});const data=await r.json();return{status:r.status,data};}catch(e:any){return{error:e.message}};}

const TOOL_PING_CHECK: ToolDefinition={name:"ping_check",description:"Check if a host is reachable via HTTP.",parameters:{type:"object",properties:{host:{type:"string"}},required:["host"]}};
async function handlePingCheck(args:Record<string,any>){try{const fullUrl=args.host.startsWith("http")?args.host:`https://${args.host}`;if(!isSsrfSafeUrl(fullUrl))return{reachable:false,error:"URL 不安全"};const start=Date.now();const r=await fetch(fullUrl,{signal:AbortSignal.timeout(8000),redirect:"follow"});return{reachable:true,status:r.status,latency:Date.now()-start};}catch(e:any){return{reachable:false,error:e.message}};}

const TOOL_DNS_LOOKUP: ToolDefinition={name:"dns_lookup",description:"Resolve a domain name to IP addresses.",parameters:{type:"object",properties:{hostname:{type:"string"}},required:["hostname"]}};
async function handleDnsLookup(args:Record<string,any>){try{const dns=await import("dns");const {promisify}=await import("util");const lookup=promisify(dns.lookup);const addr=await lookup(args.hostname);return{address:addr.address,family:addr.family};}catch(e:any){return{error:e.message}};}

const TOOL_PORT_CHECK: ToolDefinition={name:"port_check",description:"Check if a local port is in use.",parameters:{type:"object",properties:{port:{type:"number"}},required:["port"]}};
async function handlePortCheck(args:Record<string,any>){const port=parseInt(args.port);if(isNaN(port)||port<1||port>65535)return{inUse:false,error:"端口必须是1-65535整数"};try{const {execFileSync}=await import("child_process");const out=execFileSync("sh",["-c",`netstat -ano 2>/dev/null | grep ":${port} " | head -5`],{encoding:"utf8",timeout:5000});return{inUse:out.length>0,listeners:out.trim().split("\n").filter(Boolean).map((l:string)=>l.trim().split(/\s+/)[4]||"?").filter(Boolean)};}catch{return{inUse:false,listeners:[]}};}

const TOOL_ENV_LIST: ToolDefinition={name:"env_list",description:"List environment variables (values masked for safety).",parameters:{type:"object",properties:{filter:{type:"string",description:"Filter by variable name"}}}};
async function handleEnvList(args:Record<string,any>){const filter=(args.filter||"").toUpperCase();const vars=Object.keys(process.env).filter(k=>!filter||k.toUpperCase().includes(filter)).filter(k=>!["KEY","TOKEN","SECRET","PASSWORD","PASS"].some(s=>k.toUpperCase().includes(s))).slice(0,50);const result:Record<string,string>={};vars.forEach(k=>{result[k]=process.env[k]?process.env[k]!.substring(0,4)+"***":""});return{count:vars.length,vars:result};}

const TOOL_ENV_GET: ToolDefinition={name:"env_get",description:"Read the full value of a non-sensitive environment variable. Blocked for vars containing KEY/TOKEN/SECRET/PASSWORD.",parameters:{type:"object",properties:{name:{type:"string",description:"Environment variable name"}},required:["name"]}};
async function handleEnvGet(args:Record<string,any>){const name=args.name||"";const upper=name.toUpperCase();if(["KEY","TOKEN","SECRET","PASSWORD","PASS"].some(s=>upper.includes(s))){return{error:`安全限制：变量 "${name}" 包含敏感关键字，不允许读取`};}const val=process.env[name];if(val===undefined){return{error:`变量 "${name}" 不存在`,found:false};}return{name,value:val,found:true};}

const TOOL_CRON_PREVIEW: ToolDefinition={name:"cron_preview",description:"Preview the next 5 execution times for a cron expression.",parameters:{type:"object",properties:{expression:{type:"string",description:"Cron expression like '0 9 * * *'"}},required:["expression"]}};
async function handleCronPreview(args:Record<string,any>){try{const parts=args.expression.split(/\s+/);if(parts.length<5)return{error:"Invalid cron expression"};const now=new Date();const times=[];for(let i=0;i<5;i++){const t=new Date(now.getTime()+(i+1)*3600000);times.push(t.toISOString().replace("T"," ").substring(0,19));}return{expression:args.expression,nextRuns:times,note:"Actual scheduling requires a full cron parser. These are approximate."};}catch(e:any){return{error:e.message}};}

const TOOL_WEBHOOK: ToolDefinition={name:"webhook",description:"Send a webhook POST to a URL with JSON payload.",parameters:{type:"object",properties:{url:{type:"string"},payload:{type:"string",description:"JSON payload"}},required:["url"]}};
async function handleWebhook(args:Record<string,any>){try{if(!isSsrfSafeUrl(args.url))return{error:"URL 不安全"};const r=await fetch(args.url,{method:"POST",headers:{"Content-Type":"application/json"},body:args.payload||"{}",signal:AbortSignal.timeout(10000)});return{status:r.status,ok:r.ok};}catch(e:any){return{error:e.message}};}

const TOOL_SUMMARIZE: ToolDefinition={name:"summarize",description:"Create a concise summary of text by extracting first sentences.",parameters:{type:"object",properties:{text:{type:"string"},sentences:{type:"number",description:"Number of sentences, default 3"}},required:["text"]}};
async function handleSummarize(args:Record<string,any>){const text=args.text||"";const limit=args.sentences||3;const sentences=text.split(/[.!?。！？]+/).filter((s:string)=>s.trim().length>10);return{summary:sentences.slice(0,limit).join(". ")+".",originalLength:text.length,summarized:true};}

const TOOL_CLASSIFY_TEXT: ToolDefinition={name:"classify_text",description:"Classify text into categories using keyword matching.",parameters:{type:"object",properties:{text:{type:"string"},categories:{type:"string",description:"Comma-separated categories"}},required:["text"]}};
async function handleClassifyText(args:Record<string,any>){const text=(args.text||"").toLowerCase();const cats=(args.categories||"技术,商业,娱乐,教育,新闻,其他").split(",");const scores:Record<string,number>={};cats.forEach((c:string)=>scores[c.trim()]=0);if(text.includes("代码")||text.includes("编程")||text.includes("api"))scores["技术"]=(scores["技术"]||0)+3;if(text.includes("市场")||text.includes("销售")||text.includes("投资"))scores["商业"]=(scores["商业"]||0)+3;if(text.includes("电影")||text.includes("音乐")||text.includes("游戏"))scores["娱乐"]=(scores["娱乐"]||0)+3;const best=Object.entries(scores).sort((a,b)=>b[1]-a[1])[0];return{category:best?best[0]:"其他",scores};}

const TOOL_EXCEL_WRITE: ToolDefinition={name:"excel_write",description:"Create a simple CSV file (Excel-compatible) from data.",parameters:{type:"object",properties:{filename:{type:"string"},headers:{type:"string",description:"Comma-separated headers"},rows:{type:"string",description:"JSON array of row arrays"}},required:["filename","headers","rows"]}};
async function handleExcelWrite(args:Record<string,any>){try{const headers=args.headers.split(",").map((s:string)=>s.trim());const rows=JSON.parse(args.rows||"[]");const csv=[headers.join(","),...rows.map((r:any[])=>r.join(","))].join("\n");writeFileSync(safePath(args.filename),csv);return{path:args.filename,size:csv.length,rows:rows.length};}catch(e:any){return{error:e.message}};}

const TOOL_PROCESS_LIST: ToolDefinition={name:"process_list",description:"List running processes (filtered).",parameters:{type:"object",properties:{filter:{type:"string",description:"Filter by process name"}}}};
async function handleProcessList(args:Record<string,any>){try{const {execSync}=await import("child_process");const filter=args.filter||"";const cmd=process.platform==="win32"?`tasklist /FO CSV /NH`: `ps aux`;const out=execSync(cmd,{encoding:"utf8",timeout:5000});const lines=out.trim().split("\n").slice(0,30);return{processes:lines.filter(l=>!filter||l.toLowerCase().includes(filter.toLowerCase())),count:lines.length};}catch(e:any){return{error:e.message}};}

const TOOL_HTML_TO_MD: ToolDefinition={name:"html_to_markdown",description:"Convert HTML text to plain text by stripping tags.",parameters:{type:"object",properties:{html:{type:"string"}},required:["html"]}};
async function handleHtmlToMd(args:Record<string,any>){const out=(args.html||"").replace(/<br\s*\/?>/gi,"\n").replace(/<\/p>/gi,"\n\n").replace(/<\/h[1-6]>/gi,"\n\n").replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/\n{3,}/g,"\n\n").trim();return{markdown:out};}

const TOOL_SEND_EMAIL: ToolDefinition={name:"send_email",description:"Generate a mailto link for sending email (actual SMTP requires configuration).",parameters:{type:"object",properties:{to:{type:"string"},subject:{type:"string"},body:{type:"string"}},required:["to"]}};
async function handleSendEmail(args:Record<string,any>){const mailto=`mailto:${args.to}?subject=${encodeURIComponent(args.subject||"")}&body=${encodeURIComponent(args.body||"")}`;return{mailto,note:"Use this link in a browser or configure SMTP in .env for actual sending."};}

const TOOL_EMBEDDING: ToolDefinition={name:"embedding",description:"Compute a simple text embedding using character n-gram hashing. For production use, configure an embedding API.",parameters:{type:"object",properties:{text:{type:"string"}},required:["text"]}};
async function handleEmbedding(args:Record<string,any>){const text=(args.text||"").toLowerCase();const vec:number[]=new Array(128).fill(0);for(let i=0;i<text.length-2;i++){const ngram=text.slice(i,i+3);let hash=0;for(let j=0;j<ngram.length;j++)hash=((hash<<5)-hash)+ngram.charCodeAt(j);vec[Math.abs(hash)%128]+=1;}const norm=Math.sqrt(vec.reduce((s,v)=>s+v*v,0))||1;return{embedding:vec.map(v=>v/norm),dimensions:128,note:"Simple hash-based embedding. For production, use an embedding API like OpenAI or local model."};}

const TOOL_IMAGE_ANALYZE: ToolDefinition={name:"image_analyze",description:"Get basic info about an image file (dimensions, format, size). No AI vision included.",parameters:{type:"object",properties:{path:{type:"string",description:"Image file path"}},required:["path"]}};
async function handleImageAnalyze(args:Record<string,any>){try{const buffer=readFileSync(safePath(args.path));const stat=statSync(safePath(args.path));let format="unknown",width=0,height=0;if(buffer[0]===0xFF&&buffer[1]===0xD8)format="JPEG";else if(buffer[0]===0x89&&buffer[1]===0x50)format="PNG";else if(buffer[0]===0x47)format="GIF";else if(buffer[0]===0x52&&buffer[1]===0x49)format="WEBP";if(format==="PNG"){width=buffer.readUInt32BE(16);height=buffer.readUInt32BE(20);}else if(format==="JPEG"){let i=2;while(i<buffer.length){if(buffer[i]===0xFF&&buffer[i+1]>=0xC0&&buffer[i+1]<=0xC3){height=buffer.readUInt16BE(i+5);width=buffer.readUInt16BE(i+7);break;}i+=buffer.readUInt16BE(i+2)+2;}}return{path:args.path,format,width,height,size:stat.size};}catch(e:any){return{error:e.message}};}

const TOOL_MARK_GOAL_DONE: ToolDefinition = {
  name: "mark_goal_done",
  description: "Mark a project goal as complete. Returns updated progress and whether all goals are done.",
  parameters: {
    type: "object",
    properties: {
      goal_id: { type: "string", description: "Goal ID to mark as done" },
    },
    required: ["goal_id"],
  },
};

async function handleMarkGoalDone(args: Record<string, any>) {
  const { goal_id } = args;
  try {
    const { GoalTracker } = await import('../core/goal-tracker.js');
    const goal = GoalTracker.get(goal_id);
    if (!goal) return { error: `目标不存在: ${goal_id}` };
    GoalTracker.markDone(goal_id);
    const all = GoalTracker.list(goal.projectId);
    const done = all.filter(g => g.status === 'done').length;
    const allDone = all.every(g => g.status === 'done' || g.status === 'cancelled');
    return { 
      goal_id, title: goal.title, 
      progress: `${done}/${all.length}`,
      all_done: allDone,
      remaining: all.filter(g => g.status !== 'done' && g.status !== 'cancelled').map(g => g.title),
    };
  } catch (e: any) { return { error: e.message }; }
}

// ═══════════════════════════════════════════════
// 导出
// ═══════════════════════════════════════════════

export const BUILTIN_TOOLS: { tool: ToolDefinition; handler: (args: Record<string, any>) => Promise<any> }[] = [
  { tool: TOOL_WEB_SEARCH, handler: handleWebSearch },
  { tool: TOOL_CALCULATE, handler: handleCalculate },
  { tool: TOOL_GET_TIME, handler: handleGetTime },
  { tool: TOOL_SCRAPE_URL, handler: handleScrapeUrl },
  { tool: TOOL_GENERATE_IMAGE, handler: handleGenerateImage },
  { tool: TOOL_GITHUB_SEARCH, handler: handleGithubSearch },
  { tool: TOOL_PATCH_FILE, handler: handlePatchFile },
  { tool: TOOL_GIT_STATUS, handler: handleGitStatus },
  { tool: TOOL_GIT_DIFF, handler: handleGitDiff },
  { tool: TOOL_GIT_LOG, handler: handleGitLog },
  { tool: TOOL_GIT_COMMIT, handler: handleGitCommit },
  { tool: TOOL_GIT_BRANCH, handler: handleGitBranch },
  { tool: TOOL_WEB_FETCH, handler: handleWebFetch },
  { tool: TOOL_JSON_PARSE, handler: handleJsonParse },
  { tool: TOOL_DELEGATE_TASK, handler: handleDelegateTask },
  { tool: TOOL_MARK_GOAL_DONE, handler: handleMarkGoalDone },
  { tool: TOOL_CODE_EXECUTE, handler: handleCodeExecute },
  { tool: TOOL_WRITE_FILE, handler: handleWriteFile },
  // ═══ v1.7.1 新增工具 ═══
  { tool: TOOL_HTTP_GET, handler: handleHttpGet },
  { tool: TOOL_HTTP_POST, handler: handleHttpPost },
  { tool: TOOL_CSV_PARSE, handler: handleCsvParse },
  { tool: TOOL_JSON_TRANSFORM, handler: handleJsonTransform },
  { tool: TOOL_REGEX_SEARCH, handler: handleRegexSearch },
  { tool: TOOL_REGEX_REPLACE, handler: handleRegexReplace },
  { tool: TOOL_TRANSLATE, handler: handleTranslate },
  { tool: TOOL_HASH_VERIFY, handler: handleHashVerify },
  // 批量工具
  { tool: TOOL_DIFF, handler: handleDiff },
  { tool: TOOL_TEMPLATE_RENDER, handler: handleTemplateRender },
  { tool: TOOL_NPM_SEARCH, handler: handleNpmSearch },
  { tool: TOOL_NPM_INFO, handler: handleNpmInfo },
  { tool: TOOL_DOWNLOAD_FILE, handler: handleDownloadFile },
  { tool: TOOL_FETCH_JSON, handler: handleFetchJson },
  { tool: TOOL_PING_CHECK, handler: handlePingCheck },
  { tool: TOOL_DNS_LOOKUP, handler: handleDnsLookup },
  { tool: TOOL_PORT_CHECK, handler: handlePortCheck },
  { tool: TOOL_ENV_LIST, handler: handleEnvList },
  { tool: TOOL_ENV_GET, handler: handleEnvGet },
  { tool: TOOL_CRON_PREVIEW, handler: handleCronPreview },
  { tool: TOOL_WEBHOOK, handler: handleWebhook },
  { tool: TOOL_SUMMARIZE, handler: handleSummarize },
  { tool: TOOL_CLASSIFY_TEXT, handler: handleClassifyText },
  { tool: TOOL_EXCEL_WRITE, handler: handleExcelWrite },
  { tool: TOOL_PROCESS_LIST, handler: handleProcessList },
  { tool: TOOL_HTML_TO_MD, handler: handleHtmlToMd },
  { tool: TOOL_SEND_EMAIL, handler: handleSendEmail },
  { tool: TOOL_EMBEDDING, handler: handleEmbedding },
  { tool: TOOL_IMAGE_ANALYZE, handler: handleImageAnalyze },
  { tool: TOOL_READ_FILE, handler: handleReadFile },
  { tool: TOOL_SHELL_EXEC, handler: handleShellExec },
  { tool: TOOL_LIST_DIR, handler: handleListDir },
  { tool: TOOL_DELETE_FILE, handler: handleDeleteFile },
  { tool: TOOL_RENAME_FILE, handler: handleRenameFile },
];

export const BUILTIN_SKILLS = SKILL_CONFIGURATION;
