/**
 * 灵犀引擎 - 移动端入口
 * 
 * 精简版引擎，适用于 nodejs-mobile (Android/iOS) 环境：
 * - 移除 Puppeteer/浏览器工具（移动端不可用）
 * - 移除 LAN 发现（移动端用远程连接）
 * - 移除 IM 渠道（Telegram/Discord/Slack 等）
 * - 默认 AI Provider 为云端 API（DeepSeek/Qwen/OpenAI 兼容）
 * - 数据目录由原生层通过 LINGXI_DATA_DIR 环境变量传入
 * - 监听地址固定 127.0.0.1:3456（安全，不暴露到网络）
 */
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';

import { initDB, getDB, closeDB, DB, startAutoSave, saveToDisk, initNumericIdSeq, cleanupExpiredTokens, getChatMode, setChatMode, CHAT_MODES } from '../src/storage/db.js';
import { initGoalTrackerTable } from '../src/core/goal-tracker.js';
import * as auth from '../src/auth/index.js';
import { jwtAuth } from '../src/middleware/jwt-auth.js';
import { apiRateLimit, authRateLimit } from '../src/middleware/rate-limit.js';
import { MessageRouter } from '../src/core/router.js';
import { AIHub } from '../src/ai/hub.js';
import { AgentManager } from '../src/agents/manager.js';
import { handleWSMessage, wsSubscriptions } from '../src/core/ws-handler.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { BUILTIN_TOOLS, BUILTIN_SKILLS, setSearchManager } from '../src/tools/builtin.js';
import { SearchManager } from '../src/tools/search-providers.js';
import { UsageTracker } from '../src/core/usage-tracker.js'; // singleton instance
import { ProviderRegistry } from '../src/ai/provider-registry.js';
import { CronScheduler } from '../src/core/cron-scheduler.js';
import { logger } from '../src/core/logger.js';
import { SessionManager } from '../src/core/session-manager.js';
import { SubAgentManager } from '../src/core/subagent-manager.js';
import { ApprovalManager } from '../src/core/approval.js';
import { HookManager } from '../src/core/hooks.js';
import { InboxManager } from '../src/core/inbox.js';
import { SkillManager } from '../src/skills/skill-manager.js';
import { CustomProviderManager, INFERENCE_BACKENDS } from '../src/ai/custom-providers.js';
import { VisionManager } from '../src/ai/vision.js';
import { localChat, isLocalModelAvailable, getLocalModelInfo } from './local-llm.js';

// ═══ 移动端环境配置 ═══
// 原生层通过环境变量传入数据目录，默认为当前目录下的 data
const DATA_DIR = process.env.LINGXI_DATA_DIR || join(process.cwd(), 'data');
const PORT = parseInt(process.env.LINGXI_PORT || '3456', 10);
const HOST = '127.0.0.1'; // 安全：仅本地回环，不暴露到网络

// ═══ 全局异常兜底 ═══
process.on('unhandledRejection', (reason, promise) => {
  console.error('[Mobile][FATAL] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Mobile][FATAL] Uncaught Exception:', err.stack || err.message);
  try { closeDB(); } catch (_) {}
  process.exit(1);
});

async function main() {
  console.log('[Mobile] 灵犀引擎移动端启动中...');
  console.log('[Mobile] Node:', process.version, '| Platform:', process.platform, '| Arch:', process.arch);

  // ── 安全配置自动生成（2026-09-02 修复：持久化到 DATA_DIR，重启后旧 token 不失效）──
  const secretsFile = join(DATA_DIR, '.mobile-secrets.json');
  // 2026-09-02 安全修复：生产模式（DEV_MODE=false）必须外部提供稳定密钥，缺失即拒绝启动；
  // 开发模式自动生成并持久化到 DATA_DIR（.mobile-secrets.json，0600），重启复用，不打印到日志。
  if (process.env.DEV_MODE === 'false' && (!process.env.JWT_SECRET || !process.env.ADMIN_TOKEN)) {
    console.error('[Mobile][FATAL] 生产环境（DEV_MODE=false）必须显式设置 JWT_SECRET / ADMIN_TOKEN 环境变量，拒绝启动');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET || !process.env.ADMIN_TOKEN) {
    try {
      if (existsSync(secretsFile)) {
        const saved = JSON.parse(readFileSync(secretsFile, 'utf8'));
        process.env.JWT_SECRET = process.env.JWT_SECRET || saved.JWT_SECRET;
        process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || saved.ADMIN_TOKEN;
      }
    } catch { /* 文件损坏则重新生成 */ }
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = randomBytes(32).toString('hex');
      console.log('[Mobile] 自动生成 JWT_SECRET（已持久化）');
    }
    if (!process.env.ADMIN_TOKEN) {
      process.env.ADMIN_TOKEN = randomBytes(16).toString('hex');
      console.log('[Mobile] 自动生成 ADMIN_TOKEN（已持久化）');
    }
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(secretsFile, JSON.stringify({ JWT_SECRET: process.env.JWT_SECRET, ADMIN_TOKEN: process.env.ADMIN_TOKEN }), { mode: 0o600 });
    } catch (e: any) { console.warn('[Mobile] 秘钥持久化失败:', e.message); }
  }

  // ── 数据目录初始化 ──
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = join(DATA_DIR, 'main.db');
  await initDB(dbPath);
  startAutoSave(5000);
  initNumericIdSeq();
  cleanupExpiredTokens();
  initGoalTrackerTable();

  const db = new DB();
  const aiHub = new AIHub();
  (globalThis as any).__aiHub = aiHub;
  (globalThis as any).__aiHub_providers = [];

  const searchManagerInstance = new SearchManager();
  setSearchManager(searchManagerInstance);

  const manager = new AgentManager(db, aiHub);
  const router = new MessageRouter(db, manager, aiHub);

  // ── 工具系统（排除浏览器工具）──
  const toolRegistry = new ToolRegistry();
  const MOBILE_EXCLUDED_TOOLS = ['browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_extract'];
  for (const { tool, handler } of BUILTIN_TOOLS) {
    if (MOBILE_EXCLUDED_TOOLS.includes(tool.name)) continue;
    toolRegistry.registerTool(tool, handler);
  }
  for (const skill of BUILTIN_SKILLS) {
    toolRegistry.registerSkill(skill);
  }
  router.setToolRegistry(toolRegistry);
  console.log('[Mobile][Tools] 注册', toolRegistry.listTools().length, '个工具,', toolRegistry.listSkills().length, '个技能');

  // ── AI 客户端 ──
  const defaultModelForReflection = aiHub.getDefaultModel();
  const defaultClientResult = aiHub.getClient(defaultModelForReflection);
  if (defaultClientResult) {
    router.setAIClient(defaultClientResult.client, defaultClientResult.resolvedModel);
  }
  router.rebuildSearchIndex();

  // ── 模型同步（移动端仅同步云端，跳过 Ollama）──
  await aiHub.syncNvidiaModels();
  // 移动端不尝试连接 Ollama（本地没有）
  const defaultModel = aiHub.getDefaultModel();
  console.log('[Mobile][AI] 默认模型:', defaultModel);

  // ── Provider 注册表 ──
  const providerRegistry = new ProviderRegistry();
  providerRegistry.registerFromEnv();
  providerRegistry.restore();
  console.log('[Mobile][Providers]', providerRegistry.list().length, '个 Provider');

  // ── 定时任务 ──
  const inboxManager = new InboxManager(DATA_DIR, getDB());
  const approvalManager = new ApprovalManager(300000);
  const hookManager = new HookManager(DATA_DIR);

  const cronScheduler = new CronScheduler(async (job) => {
    console.log(`[Mobile][Cron] 执行: ${job.name}`);
    try {
      if (job.payload.kind === 'agentMessage' && job.payload.agentId && job.payload.chatId) {
        const reply = await router.generateReply(job.payload.chatId, job.payload.agentId, 'cron-' + job.id);
        if (reply) inboxManager.add('cron', `定时任务: ${job.name}`, reply, job.payload.agentId);
      } else if (job.payload.kind === 'systemEvent') {
        inboxManager.add('cron', `系统事件: ${job.name}`, job.payload.text || '');
      }
      await hookManager.trigger('cronExecuted', { event: 'cronExecuted', timestamp: Date.now(), message: job.name });
    } catch (err: any) { console.error(`[Mobile][Cron] 错误:`, err.message); }
  }, DATA_DIR);
  cronScheduler.start();

  // ── 会话/子代理/技能 ──
  const sessionManager = new SessionManager(DATA_DIR);
  sessionManager.startAutoSave(10000);

  const subAgentManager = new SubAgentManager(
    defaultClientResult?.client,
    defaultClientResult?.resolvedModel || defaultModel
  );

  const skillsDir = join(process.cwd(), 'skills');
  const skillManager = new SkillManager(skillsDir, DATA_DIR);
  skillManager.scanLocal();

  const customProviderManager = new CustomProviderManager();
  const visionManager = new VisionManager(aiHub);
  // UsageTracker is a singleton instance, no need to construct

  console.log('[Mobile][Skills]', skillManager.list().length, '个技能');
  console.log('[Mobile][Vision]', visionManager.getStatus());

  // ── Express App ──
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));

  // 安全响应头
  app.use((_req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  // CORS: 移动端允许所有本地来源
  app.use((_req: any, res: any, next: any) => {
    const origin = _req.headers.origin || '';
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin.startsWith('capacitor://') || origin.startsWith('ionic://');
    if (isLocal) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    }
    if (_req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // 静态文件（Web 前端）
  const webDir = process.env.LINGXI_WEB_DIR || join(process.cwd(), 'web');
  if (existsSync(webDir)) {
    app.use(express.static(webDir));
  }

  // ── 鉴权 ──
  app.use('/api', jwtAuth({ required: false }));
  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;
  app.use('/api/auth', authRateLimit);
  app.use('/api', apiRateLimit);

  // ── 移动端状态 API ──
  app.get('/api/mobile/status', (_req, res) => {
    res.json({
      ok: true,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      dataDir: DATA_DIR,
      localModel: {
        available: isLocalModelAvailable(),
        info: getLocalModelInfo(),
      },
      engine: {
        models: aiHub.listModels().length,
        agents: db.listAgents().length,
        tools: toolRegistry.listTools().length,
        skills: skillManager.list().length,
      },
    });
  });

  // ── 本地模型 API ──
  app.post('/api/mobile/local-chat', async (req, res) => {
    try {
      const { messages } = req.body || {};
      if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: '需要 messages 数组' });
      if (!isLocalModelAvailable()) return res.status(503).json({ error: '本地模型不可用' });
      const reply = await localChat(messages);
      res.json({ ok: true, reply });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 认证 API（2026-09-02 安全修复：接入共享 V7 认证，密码 bcrypt 校验）──
  app.post('/api/auth/register', async (req, res) => {
    try {
      const { email, password, display_name } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: '需要 email 和 password' });
      // 复用共享认证：bcrypt 哈希入库 + 邮箱验证 token（旧实现不存密码、无凭据直接发 token）
      const result = auth.register({
        email,
        password,
        displayName: display_name || email.split('@')[0],
        agentBinding: 'skip',
      });
      const token = auth.signAccessToken({
        sub: String(result.user.id),
        numeric_id: Number(result.user.numeric_id) || 0,
        sid: 'mobile-' + Date.now(),
      });
      // 兼容新老前端：同时返回 token / accessToken / user
      res.json({
        ok: true,
        userId: result.user.id,
        token,
        accessToken: token,
        user: { id: result.user.id, displayName: result.user.display_name, email: result.user.email },
        verificationToken: result.verificationToken,
      });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: '需要 email 和 password' });
      // 复用共享认证：用户名或邮箱 + bcrypt 密码比对，验证通过才签发 token
      const result = await auth.loginWithUsernameOrEmail(email, password);
      res.json({
        ok: true,
        userId: result.user.id,
        token: result.accessToken,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        user: {
          id: result.user.id,
          displayName: result.user.displayName,
          email: result.user.email,
          numericId: result.user.numericId,
          emailVerified: result.user.emailVerified,
        },
      });
    } catch (err: any) { res.status(401).json({ error: err.message }); }
  });

  app.get('/api/auth/me', (req: any, res) => {
    res.setHeader('X-Lingxi-Mobile', 'mobile-auth-fix-20260902');
    // 2026-09-02 安全修复：不再无条件返回 owner。
    // 已登录 → 返回 DB 真实档案 + JWT 中的真实角色；未登录 → 匿名 local-user（本地回环 UI 展示用）
    const uid = req.user?.sub || req.user?.id;
    if (uid) {
      const user = db.getUser(String(uid));
      const roles = req.user?.roles || ['user'];
      return res.json({ ok: true, user: {
        id: String(uid),
        displayName: user?.display_name || '移动端用户',
        email: user?.email || '',
        roles,
        role: roles[0],
      } });
    }
    res.json({ ok: true, user: { id: 'user-mobile-admin', displayName: '移动端用户', roles: ['local-user'], role: 'local-user' } });
  });

  // ── 核心 API 路由（复用主引擎逻辑的精简版）──
  // 聊天
  app.get('/api/chats', requireAuth, (req: any, res) => {
    const chats = db.listChats();
    res.json({ ok: true, chats });
  });

  app.post('/api/chats', requireAuth, (req: any, res) => {
    const { type, name } = req.body || {};
    const chatId = 'chat-' + Date.now();
    db.createChat(chatId, type || 'private');
    const userId = req.user?.id || 'user-mobile-admin';
    db.addParticipant('p-' + chatId + '-user', chatId, userId, undefined, 'owner');
    res.json({ ok: true, chatId });
  });

  app.get('/api/chats/:id/messages', requireAuth, (req, res) => {
    const msgs = db.listMessages(req.params.id as string, 100);
    res.json({ ok: true, messages: msgs });
  });

  app.get('/api/chats/:id/mode', requireAuth, (req, res) => {
    const mode = getChatMode(req.params.id as string);
    res.json({ ok: true, mode, modes: [...CHAT_MODES] });
  });

  app.post('/api/chats/:id/mode', requireAuth, (req, res) => {
    const { mode } = req.body || {};
    if (!setChatMode(req.params.id as string, mode)) {
      return res.status(400).json({ error: '无效模式' });
    }
    res.json({ ok: true, mode });
  });

  // Agent
  app.get('/api/agents', requireAuth, (_req, res) => {
    const agents = db.listAgents();
    res.json({ ok: true, agents });
  });

  // 模型
  app.get('/api/models', requireAuth, (_req, res) => {
    const models = aiHub.listModels();
    res.json({ ok: true, models, default: aiHub.getDefaultModel() });
  });

  // 工具
  app.get('/api/tools', requireAuth, (_req, res) => {
    res.json({ ok: true, tools: toolRegistry.listTools(), skills: toolRegistry.listSkills() });
  });

  // Provider
  app.get('/api/providers', requireAuth, (_req, res) => {
    res.json({ ok: true, providers: providerRegistry.list() });
  });

  // 收件箱
  app.get('/api/inbox', requireAuth, (_req, res) => {
    res.json({ ok: true, items: inboxManager.list(), unread: inboxManager.unreadCount() });
  });

  // 技能
  app.get('/api/skills', requireAuth, (_req, res) => {
    res.json({ ok: true, skills: skillManager.list() });
  });

  // 定时任务
  app.get('/api/cron', requireAuth, (_req, res) => {
    res.json({ ok: true, jobs: cronScheduler.listJobs() });
  });

  // 会话
  app.get('/api/sessions', requireAuth, (_req, res) => {
    res.json({ ok: true, sessions: sessionManager.listAll() });
  });

  // ── WebSocket ──
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Map<string, Set<WebSocket>>();

  function broadcast(event: any) {
    const payload = JSON.stringify(event);
    const eventChatId = event.chatId;
    for (const [, set] of clients) {
      for (const ws of set) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (eventChatId) {
          const subs = wsSubscriptions.get(ws);
          if (!subs || !subs.has(eventChatId)) continue;
        }
        ws.send(payload);
      }
    }
  }

  wss.on('connection', (ws, req) => {
    const urlStr = req.url || '';
    const queryIndex = urlStr.indexOf('?');
    const params = queryIndex >= 0 ? new URLSearchParams(urlStr.slice(queryIndex + 1)) : new URLSearchParams();

    const token = params.get('token');
    let clientId: string | null = null;
    if (token) {
      try {
        const payload = auth.verifyAccessToken(token);
        if (payload) clientId = payload.sub;
      } catch { /* fallback */ }
    }
    if (!clientId) {
      // 2026-09-02 安全修复：匿名回退仅限本机回环连接（引擎只监听 127.0.0.1），
      // 非本机来源的匿名连接一律拒绝；本机匿名保持原身份逻辑以兼容现有 App
      const remote = req.socket?.remoteAddress || '';
      const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
      if (!isLoopback) {
        console.warn('[Mobile][WS] 拒绝非本机匿名连接:', remote);
        ws.close(1008, 'unauthorized');
        return;
      }
      clientId = params.get('id') || 'user-mobile-admin';
      console.log('[Mobile][WS] 本机连接:', clientId);
    }

    if (!clients.has(clientId)) clients.set(clientId, new Set());
    clients.get(clientId)!.add(ws);
    broadcast({ type: 'user.online', userId: clientId });

    // 自动创建用户设置
    ensureMobileUserSetup(clientId, db, manager, toolRegistry);

    ws.on('message', (raw) => {
      try {
        handleWSMessage(raw, clientId, router, broadcast, ws);
      } catch (err: any) {
        console.error('[Mobile][WS] 消息处理异常:', err?.message);
        try { ws.send(JSON.stringify({ type: 'error', message: err?.message })); } catch {}
      }
    });

    ws.on('close', () => {
      const set = clients.get(clientId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clients.delete(clientId!);
      }
      broadcast({ type: 'user.offline', userId: clientId });
    });

    ws.on('error', () => {});
  });

  // ── 启动服务器 ──
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('=== 灵犀引擎 Mobile 已就绪 ===');
    console.log(` HTTP: http://${HOST}:${PORT}`);
    console.log(` WS: ws://${HOST}:${PORT}/ws`);
    console.log(` 数据: ${DATA_DIR}`);
    console.log(` 模型: ${aiHub.listModels().length} | Agent: ${db.listAgents().length} | 工具: ${toolRegistry.listTools().length}`);
    console.log(` 本地模型: ${isLocalModelAvailable() ? '可用' : '不可用（使用云端 API）'}`);
    console.log('==============================');
    console.log('');
    // 通知原生层引擎已就绪
    if (process.send) {
      process.send({ type: 'engine-ready', port: PORT, host: HOST });
    }
  });

  // ── 优雅退出 ──
  const shutdown = async (signal: string) => {
    console.log(`[Mobile] 收到 ${signal}，正在关闭...`);
    cronScheduler.stop();
    sessionManager.close();
    try { saveToDisk(); } catch {}
    try { closeDB(); } catch {}
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// 移动端用户自动设置
function ensureMobileUserSetup(clientId: string, db: any, manager: any, toolRegistry?: any) {
  try {
    const existing = db.getUser(clientId);
    if (existing) {
      const chats = db.listChats();
      const userChats = chats.filter((c: any) => {
        const ps = db.getChatParticipants(c.id);
        return ps.some((p: any) => p.user_id === clientId);
      });
      if (userChats.length > 0) return;
    } else {
      db.createUser(clientId, '移动端用户');
    }
    // 创建默认 Agent + 聊天
    const agent = manager.register(clientId, 'AI助手', '你是一个友好实用的AI助手。', 'semi');
    const chatId = 'chat-' + clientId;
    db.createChat(chatId, 'private');
    db.addParticipant('p-' + clientId + '-user', chatId, clientId, undefined, 'owner');
    db.addParticipant('p-' + clientId + '-agent', chatId, undefined, agent.id, 'agent');
    if (toolRegistry) toolRegistry.bindSkills(agent.id, ['general-assistant']);
    console.log('[Mobile] 用户就绪:', clientId);
  } catch (err: any) {
    console.error('[Mobile] 用户设置失败:', err.message);
  }
}

main().catch((err) => {
  console.error('[Mobile] 启动失败:', err);
  process.exit(1);
});
