// ── v2.0.13: 启动时固化版本号到全局（health 接口展示用，PM2 直启无 npm_package_version）──
(globalThis as any).__LINGXI_VERSION__ = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('./package.json');
    return pkg.version || 'dev';
  } catch { return 'dev'; }
})();
/**
 * Project Hub - 主入口
 */
// 必须最先加载 .env：ESM 中 import 会被提升，若在模块体中调用 dotenvConfig()，
// 则 hub.ts 等模块加载时读取的 process.env.* 全为空。用副作用导入置于首位可修复。
import 'dotenv/config';
// P1-B: LAN_SECRET 安全默认 —— 缺失时自动生成并持久化到 .env（局域网传输层 HMAC 签名）
(() => {
  try {
    if (!process.env.LAN_SECRET) {
      const envPath = path.join(process.cwd(), '.env');
      let envText = '';
      if (existsSync(envPath)) envText = readFileSync(envPath, 'utf8');
      if (!/^LAN_SECRET\s*=/m.test(envText)) {
        const secret = randomBytes(32).toString('hex');
        process.env.LAN_SECRET = secret;
        try {
          appendFileSync(envPath, '\n# Auto-generated on first boot (P1-B: 局域网传输层 HMAC 签名密钥)\nLAN_SECRET=' + secret + '\n', 'utf8');
          console.log('[LAN] LAN_SECRET 未配置，已自动生成并写入 .env（局域网通信 HMAC 签名已启用）');
        } catch (e) {
          console.log('[LAN] LAN_SECRET 未配置，已生成进程内密钥（.env 写入失败，重启后密钥会变化）');
        }
      }
    }
  } catch (e) { /* 绝不阻断启动 */ }
})();
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { randomBytes } from 'crypto';
import * as path from 'path';
import { join } from 'path';
import multer from 'multer';
import { initDB, getDB, closeDB, DB, startAutoSave, saveToDisk, initNumericIdSeq, cleanupExpiredTokens, createInviteCode, listInviteCodes, updateAgent, getChatMode, setChatMode, CHAT_MODES, nextNumericId, getUserCredits, addCredits, spendCredits, getCreditHistory, getWallet, addWalletBalance, spendWalletBalance, listWalletTx, ensureWallet, _walletTx, createHire, fireHire, listHiresByBuyer, listHiresBySeller, getHire, createChat, addParticipant, removeParticipant, getAgentByUserId, deleteFriendshipByPair } from './src/storage/db.js';
import { initGoalTrackerTable, GoalTracker } from './src/core/goal-tracker.js';
import type { ProjectGoal } from './src/core/goal-tracker.js';

import * as auth from './src/auth/index.js';
import { registerAuthRoutes } from './src/routes/auth-main.js';
import { registerFriendsChatsRoutes } from './src/routes/friends-chats.js';
import { registerWorkflowsRoutes } from './src/routes/workflows.js';
import { registerWalletRoutes } from './src/routes/wallet.js';
import { registerMarketRoutes } from './src/routes/market.js';
import { registerAgentsRoutes } from './src/routes/agents.js';
import { registerSubAgentRoutes } from './src/routes/subagents.js';
import { registerCustomProviderRoutes } from './src/routes/custom-providers.js';
import { registerLanRoutes } from './src/routes/lan.js';
import { adminAuth } from './src/middleware/admin-auth.js';
import { jwtAuth, isTrustedLocalSource } from './src/middleware/jwt-auth.js';
import { apiRateLimit, authRateLimit } from './src/middleware/rate-limit.js';
import { MessageRouter } from './src/core/router.js';
import { AIHub } from './src/ai/hub.js';
import { AgentManager } from './src/agents/manager.js';
import { handleWSMessage, wsSubscriptions, processUserMessage } from './src/core/ws-handler.js';
import { getInstanceId, type PeerMessage } from './src/core/instance-mesh.js';
import { ToolRegistry } from './src/tools/registry.js';
import { BUILTIN_TOOLS, BUILTIN_SKILLS, setSearchManager, setSubAgentManager } from './src/tools/builtin.js';
import { SearchManager } from './src/tools/search-providers.js';
import { UsageTracker } from './src/core/usage-tracker.js';
import { MCPManager } from './src/mcp/adapter.js';
import { ProviderRegistry } from './src/ai/provider-registry.js';
import { BrowserManager } from './src/tools/browser.js';
import { PluginManager } from './src/plugins/plugin-manager.js';
import { CronScheduler, createCronJob, type JobPayload } from './src/core/cron-scheduler.js';
import { logger } from './src/core/logger.js';
import { errorHandler, notFoundHandler } from './src/http/error.js';
import { registerV17Routes } from './src/routes-v1.7.js';
import { SessionManager } from './src/core/session-manager.js';
import { SubAgentManager } from './src/core/subagent-manager.js';
import { TelegramAdapter, type TelegramConfig } from './src/channels/telegram.js';
import { ApprovalManager } from './src/core/approval.js';
import { HookManager, type HookEvent } from './src/core/hooks.js';
import { InboxManager, type InboxItem, type InboxType } from './src/core/inbox.js';
import { ChannelManager } from './src/channels/manager.js';
import { SkillManager } from './src/skills/skill-manager.js';
import { TTSManager } from './src/voice/tts.js';
import { STTManager } from './src/voice/stt.js';
import { CustomProviderManager, INFERENCE_BACKENDS } from './src/ai/custom-providers.js';
import { DebugPanel } from './src/dev/debug-panel.js';
import { VisionManager } from './src/ai/vision.js';
import { PushNotificationManager } from './src/core/push.js';
import { OutcomeTracker } from './src/core/outcome-tracker.js';
import { createGoalOutcomeRoutes } from './src/routes/goals-outcomes.js';
import { createProfileRoutes } from './src/routes/profile.js';
import { createMiscRoutes, setupMesh, createMeshRoutes } from './src/routes/misc.js';
import { createSkillsRoutes } from './src/routes/skills.js';
import { createRagRoutes } from './src/routes/rag.js';
import { createChannelRoutes, startChannelAdapter } from './src/routes/channel.js';
import { createUploadRoutes } from './src/routes/upload.js';
import { createEvaluationRoutes } from './src/routes/evaluation.js';
import { createAgiRoutes } from './src/routes/agi.js';
// CLI 通过 bin 入口直接运行，不需要导入
// import { startCLI } from './src/cli/chat.js';

// ═══ 全局异常兜底 ═══
// 任何未捕获异常都会先记录日志再崩溃，防止生产环境静默宕机
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  // 不退出进程，unhandledRejection 在 Node 默认也是 warn 不 crash
});
process.on('uncaughtException', async (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message, '\n', err.stack);
  try { await closeDB(); } catch (_) {}
  process.exit(1);
});

interface User {
  id: string;
  email?: string;
  username?: string;
  displayName: string;
  agentId?: string;
  createdAt: number;
}

interface VerificationCode {
  email: string;
  code: string;
  username?: string;
  expiresAt: number;
}

const verificationCodes = new Map<string, VerificationCode>();
// P0-4 修复: 验证码尝试次数限制（防暴力枚举）
const verificationAttempts = new Map<string, { count: number; firstAttempt: number }>();
const MAX_CODE_ATTEMPTS = 10;  // 5分钟内最多尝试10次
const ATTEMPT_WINDOW = 5 * 60 * 1000;


// ── v1.7 RBAC 角色控制（使用 src/server/rbac.ts 修复版）──
import { rbac, getParticipantRole, type Role } from './src/server/rbac.js';

async function main() {
  // ═══ 启动检测 ═══
  const nodeVer = process.versions.node.split('.').map(Number);
  if (nodeVer[0] < 18) { console.error('[FATAL] Node.js >= 18 要求，当前:', process.version); process.exit(1); }
  
  // v1.9.9: 自动生成缺失的安全配置——零配置即可启动
  const { randomBytes } = await import('crypto');
  const { appendFileSync } = await import('fs');
  let envPatched = false;
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    appendFileSync(join(process.cwd(), '.env'), `\n# Auto-generated on first boot\nJWT_SECRET=${process.env.JWT_SECRET}\n`);
    console.log('[Config] 自动生成 JWT_SECRET（已写入 .env）');
    envPatched = true;
  }
  if (!process.env.ADMIN_TOKEN) {
    process.env.ADMIN_TOKEN = randomBytes(16).toString('hex');
    appendFileSync(join(process.cwd(), '.env'), `ADMIN_TOKEN=${process.env.ADMIN_TOKEN}\n`);
    console.log('[Config] 自动生成 ADMIN_TOKEN（已写入 .env）');
    envPatched = true;
  }
  if (envPatched) console.log('[Config] 首次启动已自动生成安全密钥，无需手动配置即可使用');

  // 配置校验（生产环境必须）  
  const criticalEnvs = ['JWT_SECRET'];
  if (!process.env.DEV_MODE) criticalEnvs.push('DEEPSEEK_API_KEY');
  const missing = criticalEnvs.filter(k => !process.env[k]);
  // 2026-09-02 安全修复：MESH_TOKEN 弱/默认值检测 —— 生产模式（DEV_MODE=false）拒绝启动，开发模式仅警告
  const MESH_TOKEN_WEAK = ['change-me-to-a-strong-secret', 'changeme', 'change-me'];
  const _meshToken = process.env.MESH_TOKEN || '';
  const meshEnabled = !!process.env.MESH_PLATFORM_URL;
  const meshWeak = MESH_TOKEN_WEAK.includes(_meshToken) || (meshEnabled && !_meshToken);
  if (meshWeak) {
    const msg = 'MESH_TOKEN 为默认弱值' + (meshEnabled ? '（且已配置 MESH_PLATFORM_URL）' : '');
    if (process.env.DEV_MODE === 'false') {
      console.error('[FATAL] ' + msg + '，生产环境（DEV_MODE=false）拒绝启动，请设置强随机 MESH_TOKEN');
      process.exit(1);
    }
    console.warn('[Config] ' + msg + '（开发模式仅警告）');
  }
  if (missing.length) {
    console.warn('[Config] 缺少配置项:', missing.join(', '), '- 服务可能无法正常运行');
  }
  logger.attachToConsole();        // 所有 console 输出同步写入日志文件
  logger.rotate();                 // 清理7天前的旧日志
  // P1-3: 每小时执行一次日志轮转，避免长期运行时旧日志堆积
  setInterval(() => { try { logger.rotate(); } catch {} }, 3600_000);
  logger.info('Boot', `Node ${process.version}, PID ${process.pid}`);

  // ═══ 单机多实例：命令行参数 ═══
  // 用法: node index.ts --port 3457 --data-dir data2 --auto-port
  //   --port NNNN      指定服务端口（覆盖 PORT）
  //   --data-dir NAME  数据目录（DB/上传/日志隔离，覆盖 DATA_DIR）
  //   --name NAME      --data-dir 的别名
  //   --auto-port      端口被占用时自动 +1 重试（多实例共存）
  const argv = process.argv.slice(2);
  const cliArg = (name: string): string | undefined => {
    const idx = argv.indexOf('--' + name);
    if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
    const eq = argv.find(a => a.startsWith('--' + name + '='));
    return eq ? eq.split('=').slice(1).join('=') : undefined;
  };
  const cliPort = cliArg('port');
  if (cliPort) process.env.PORT = cliPort;
  const cliDataDir = cliArg('data-dir') || cliArg('name');
  if (cliDataDir) process.env.DATA_DIR = cliDataDir;
  const autoPort = argv.includes('--auto-port') || process.env.AUTO_PORT === 'true';

  const dataDir = process.env.DATA_DIR ? join(process.cwd(), process.env.DATA_DIR) : join(process.cwd(), 'data');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'main.db');
  await initDB(dbPath);
  startAutoSave(5000);  // 每5秒自动保存到磁盘
  initNumericIdSeq();    // V7: 初始化数字 ID 自增起点
  cleanupExpiredTokens(); // V7: 清理过期验证 token
  // 迁移：给缺少 numeric_id 的旧用户补分配
  try {
    const raw = getDB();
    const s = raw.prepare('SELECT id FROM users WHERE numeric_id IS NULL');
    const orphans: string[] = [];
    while (s.step()) orphans.push(s.get()[0]);
    s.free();
    for (const uid of orphans) {
      const ms = raw.prepare('SELECT MAX(numeric_id) as m FROM users WHERE numeric_id IS NOT NULL');
      ms.step(); const max = ms.getAsObject().m || 9999; ms.free();
      const nid = max + 1;
      raw.run('UPDATE users SET numeric_id = ?, display_name = CASE WHEN display_name = "访客" OR display_name IS NULL THEN ? ELSE display_name END, status = CASE WHEN status = "offline" OR status IS NULL THEN "online" ELSE status END WHERE id = ?', [nid, '用户' + nid, uid]);
      console.log('[DB] 迁移: 用户', uid, '-> numeric_id', nid);
    }
    if (orphans.length > 0) { saveToDisk(); console.log('[DB] 迁移完成，补分配', orphans.length, '个用户'); }
  } catch (e: any) { console.warn('[DB] 迁移失败:', e.message); }
  initGoalTrackerTable();   // v1.7.1: 项目目标追踪表
  const db = new DB();  // DB 类封装

  // ── 平台统一用户系统：启动时从平台获取 admin 用户信息 ──
  const PLATFORM_API_URL = process.env.PLATFORM_API_URL || '';
  const PLATFORM_ADMIN_TOKEN = process.env.PLATFORM_ADMIN_TOKEN || '';
  let platformAdminUser: any = null;
  if (PLATFORM_API_URL && PLATFORM_ADMIN_TOKEN) {
    try {
      const resp = await fetch(`${PLATFORM_API_URL}/api/admin/users?token=${PLATFORM_ADMIN_TOKEN}`);
      const data = await resp.json() as any;
      if (data.ok && data.users && data.users.length > 0) {
        // 找 role='admin' 的用户，否则取第一个
        platformAdminUser = data.users.find((u: any) => u.role === 'admin') || data.users[0];
        console.log('[Platform] admin 用户:', platformAdminUser.username, 'ID:', platformAdminUser.id, '积分:', platformAdminUser.points);
        // 在 main.db 中创建/更新对应的本地用户记录（用于聊天/消息外键引用）
        const localId = String(platformAdminUser.id);
        const existing = db.getUser(localId);
        if (!existing) {
          db.createUser(localId, platformAdminUser.username || '管理员');
          const raw2 = getDB();
          raw2.run('UPDATE users SET numeric_id = ?, status = "online", last_active_at = ? WHERE id = ?', [platformAdminUser.id, Date.now(), localId]);
          saveToDisk();
          console.log('[DB] 创建平台 admin 用户映射, id =', localId, 'numeric_id =', platformAdminUser.id);
        } else {
          const raw2 = getDB();
          raw2.run('UPDATE users SET status = "online", last_active_at = ?, display_name = ? WHERE id = ?', [Date.now(), platformAdminUser.username || '管理员', localId]);
        }
      }
    } catch (e: any) {
      console.warn('[Platform] 无法连接平台 API，回退到本地 admin-auto 模式:', e.message);
    }
  }
  // P1-7: 缓存到全局，供 jwt-auth 中间件使用（deprecated: 后续应迁移到 app.locals）
  (globalThis as any).__platformAdminUser = platformAdminUser;
  (globalThis as any).__platformApiUrl = PLATFORM_API_URL;
  (globalThis as any).__platformAdminToken = PLATFORM_ADMIN_TOKEN;

  // 如果平台不可达，回退到旧的 admin-auto 逻辑
  if (!platformAdminUser) {
    try {
      const adminUser = db.getUser('admin');
      if (!adminUser) {
        const raw2 = getDB();
        const ms2 = raw2.prepare('SELECT MAX(numeric_id) as m FROM users WHERE numeric_id IS NOT NULL');
        ms2.step(); const maxNid = (ms2.getAsObject().m || 9999) as number; ms2.free();
        const adminNid = maxNid + 1;
        db.createUser('admin', '管理员');
        raw2.run('UPDATE users SET numeric_id = ?, status = "online", last_active_at = ? WHERE id = ?', [adminNid, Date.now(), 'admin']);
        console.log('[DB] 创建 admin-auto 用户(本地回退), numeric_id =', adminNid);
        saveToDisk();
      } else {
        const raw2 = getDB();
        raw2.run('UPDATE users SET status = "online", last_active_at = ? WHERE id = ?', [Date.now(), 'admin']);
      }
    } catch (e: any) { console.warn('[DB] admin 用户初始化警告:', e.message); }
  }
  const aiHub = new AIHub();
  (globalThis as any).__aiHub = aiHub;
  (globalThis as any).__aiHub_providers = [];
const searchManagerInstance = new SearchManager();
// v2 修复：单例注入到 builtin.ts，避免双实例问题
setSearchManager(searchManagerInstance);
  const manager = new AgentManager(db, aiHub);
  const router = new MessageRouter(db, manager, aiHub);

  // ── 初始化工具系统 ──
  const toolRegistry = new ToolRegistry();
  for (const { tool, handler } of BUILTIN_TOOLS) {
    toolRegistry.registerTool(tool, handler);
  }
  for (const skill of BUILTIN_SKILLS) {
    toolRegistry.registerSkill(skill);
  }
  router.setToolRegistry(toolRegistry);
  console.log('[Tools] 注册', toolRegistry.listTools().length, '个工具,', toolRegistry.listSkills().length, '个技能');

  // ── 注入 AI 客户端给记忆反思 ──
  const defaultModelForReflection = aiHub.getDefaultModel();
  const defaultClientResult = aiHub.getClient(defaultModelForReflection);
  if (defaultClientResult) {
    router.setAIClient(defaultClientResult.client, defaultClientResult.resolvedModel);
  }

  // ── 重建记忆搜索索引 ──
  router.rebuildSearchIndex();

  // ── 动态拉取模型列表 ──
  await aiHub.syncNvidiaModels();
  await aiHub.syncOllamaModels();
  const defaultModel = aiHub.getDefaultModel();
  console.log('[AI Hub] 默认模型:', defaultModel);

  // ── 评分卡追踪器（需 AI 客户端）──
  const outcomeTracker = new OutcomeTracker(
    defaultClientResult?.client || { chat: { completions: { create: () => Promise.resolve({ choices: [{ message: { content: '[]' } }] }) } } } as any,
    defaultClientResult?.resolvedModel || defaultModel,
  );

  // ── P2-3: Provider 注册表 ──
  const providerRegistry = new ProviderRegistry();
  providerRegistry.registerFromEnv();
  providerRegistry.restore();  // 恢复用户通过 UI 添加的 Provider
  // ── 启动同步：providers.json → AIHub（修复 .env 未配置但 UI 保存过的 provider 丢失问题）
  const hubIds = new Set((aiHub.listProviders?.() || []).map((h: any) => h.id));
  for (const p of providerRegistry.list()) {
    if (p.enabled !== false && !hubIds.has(p.id)) {
      try {
        aiHub.addProvider({
          id: p.id, type: p.type as any,
          apiKey: p.apiKey || '', baseUrl: p.baseUrl,
          models: p.models, isLocal: p.isLocal,
        });
        console.log(`[ProviderSync] 恢复 → AIHub: ${p.id} (${(p.models || []).length} 模型)`);
      } catch (e) { console.warn(`[ProviderSync] ${p.id} 同步失败:`, (e as Error).message); }
    }
  }
  console.log('[Providers] ', providerRegistry.list().length, '个 Provider,', providerRegistry.listModels().length, '个模型');

  // ── P2-1: MCP 管理器 ──
  const mcpManager = new MCPManager();
  // MCP Server 在运行时通过 API 动态添加

  // ── P2-2: 浏览器自动化 ──
  const browserManager = new BrowserManager();
  const browserAvailable = await browserManager.init(join(dataDir, 'uploads'));
  if (browserAvailable) {
    // 把浏览器工具注册到 ToolRegistry
    const browserToolDefs = BrowserManager.getToolDefinitions();
    const browserHandlers = browserManager.getHandlers();
    for (const toolDef of browserToolDefs) {
      try {
        toolRegistry.registerTool(toolDef, browserHandlers[toolDef.name]);
      } catch { /* 可能已注册 */ }
    }
    console.log('[Browser] ', browserToolDefs.length, '个工具已注册');
  }

  // ── P2-4: 插件管理器 ──
  const pluginManager = new PluginManager([
    join(process.cwd(), 'plugins'),
  ]);
  const pluginResult = await pluginManager.loadAll();
  // 把插件工具注册到 ToolRegistry
  const pluginTools = pluginManager.getAllToolDefinitions();
  for (const toolDef of pluginTools) {
    const handler = (args: Record<string, any>) => pluginManager.callTool(toolDef.name, args);
    try {
      toolRegistry.registerTool(toolDef, handler);
    } catch { /* skip duplicate */ }
  }

  // ── P1-1: Cortex 定时任务 ──
  const cronScheduler = new CronScheduler(async (job) => {
    console.log(`[Cron] 执行任务: ${job.name} (${job.id})`);
    try {
      if (job.payload.kind === 'agentMessage' && job.payload.agentId && job.payload.chatId) {
        const reply = await router.generateReply(job.payload.chatId, job.payload.agentId, 'cron-' + job.id);
        if (reply) {
          console.log(`[Cron] Agent 回复: ${reply.slice(0, 80)}`);
          inboxManager.add('cron', `定时任务: ${job.name}`, reply, job.payload.agentId);
        }
      } else if (job.payload.kind === 'systemEvent') {
        console.log(`[Cron] 系统事件: ${job.payload.text}`);
        inboxManager.add('cron', `系统事件: ${job.name}`, job.payload.text || '');
      } else if (job.payload.kind === 'toolCall' && job.payload.toolName) {
        // 安全：无人值守的定时任务禁止执行需人工审批的危险工具（write_file/code_execute/shell_exec 等）
        if (approvalManager.needsApproval(job.payload.toolName, job.payload.toolArgs || {})) {
          console.warn(`[Cron] 拒绝执行需审批工具: ${job.payload.toolName} (任务 ${job.name})`);
          inboxManager.add('cron', `定时任务被拒绝: ${job.name}`, `工具 ${job.payload.toolName} 需要人工审批，不允许在定时任务中执行`);
        } else {
          const result = await toolRegistry.execute({ id: 'cron-exec', name: job.payload.toolName, arguments: job.payload.toolArgs || {} });
          const content = result.success ? JSON.stringify(result.result || '').slice(0, 500) : `Error: ${result.error}`;
          console.log(`[Cron] 工具 ${job.payload.toolName}:`, result.success ? 'ok' : result.error);
          inboxManager.add('cron', `工具执行: ${job.payload.toolName}`, content);
        }
      } else if (job.payload.kind === 'standingOrder' && job.payload.prompt) {
        const targetChat = job.payload.chatId || 'chat-default';
        console.log(`[Cron] Standing Order: ${job.name} → ${targetChat}`);
        const agents = db.listAgents();
        if (agents.length > 0) {
          const reply = await router.generateReply(targetChat, agents[0].id || agents[0].agent_id, 'so-' + job.id);
          if (reply) {
            broadcast({ type: 'message.new', chatId: targetChat, from: 'agent:' + (agents[0].id || agents[0].agent_id), senderType: 'agent', content: reply, timestamp: Date.now() });
            inboxManager.add('cron', `Standing Order: ${job.name}`, reply);
          }
        }
      }
      await hookManager.trigger('cronExecuted', { event: 'cronExecuted', timestamp: Date.now(), message: job.name });
    } catch (err: any) { console.error(`[Cron] 任务执行错误:`, err.message); }
  }, dataDir);
  cronScheduler.start();

  // ── P1-2: 会话管理器 ──
  const sessionManager = new SessionManager(dataDir);
  sessionManager.startAutoSave(10000);

  // ── P1-3: 子代理管理器 ──
  const subAgentManager = new SubAgentManager(
    defaultClientResult?.client,
    defaultClientResult?.resolvedModel || defaultModel
  );
  subAgentManager.setResultHandler((task: any) => {
    console.log(`[SubAgent] ${task.id} 完成: status=${task.status}, result=${(task.result || '').slice(0, 80)}`);
    try {
      broadcast({ type: 'subagent.result', chatId: task.chatId || task.parentChatId, task });
    } catch (e) { /* ignore */ }
  });
  // v1.5.0: 将 SubAgentManager 注入到 builtin 工具系统，使 delegate_task 可用
  setSubAgentManager(subAgentManager);
  console.log('[SubAgent] 已注入工具系统，delegate_task 可用');

  // v2.0: 注册 Agent 间消息处理器 — Agent 收到其他 Agent 的消息时，用 generateOneShot 生成回复
  // 对标 CrewAI delegation + AutoGen GroupChat
  function registerAgentMessageHandlerForAgent(agentId: string) {
    try {
      const agent = manager.get(agentId);
      if (!agent) return;
      subAgentManager.registerAgentMessageHandler(agentId, async (msg: any) => {
        const fromAgent = manager.get(msg.fromAgentId);
        const fromName = fromAgent?.displayName || msg.fromAgentId;
        const prompt = `你收到了来自另一个 Agent（${fromName}）的协助请求消息。请根据你的角色和能力，给出有帮助的回复。\n\n来自 ${fromName} 的消息：\n${msg.content}\n\n你的回复：`;
        const reply = await router.generateOneShot(agentId, prompt, {
          temperature: 0.5,
          timeoutMs: 120000,
          systemPrompt: `你是 ${agent.displayName || agentId}。另一个 Agent 向你请求协助，请根据你的专长给出简洁有用的回复。`,
        });
        return reply || '(无回复)';
      });
      console.log(`[SubAgent] Agent ${agentId} 消息处理器已注册`);
    } catch (e: any) {
      console.error(`[SubAgent] 注册 Agent ${agentId} 消息处理器失败:`, e.message);
    }
  }

  // 为所有现有 Agent 注册消息处理器
  try {
    const allAgents = manager.list();
    for (const agent of allAgents) {
      const agentId = agent.id;
      if (agentId) registerAgentMessageHandlerForAgent(agentId);
    }
    console.log(`[SubAgent] 已为 ${allAgents.length} 个现有 Agent 注册消息处理器`);
  } catch (e: any) {
    console.error('[SubAgent] 批量注册 Agent 消息处理器失败:', e.message);
  }

  // 导出供后续创建 Agent 时调用
  (globalThis as any).__registerAgentMessageHandler = registerAgentMessageHandlerForAgent;

  // ── V5 P1: 审批管理器 ──
  const approvalManager = new ApprovalManager(300000);
  console.log('[Approval] 审批管理器已初始化 (timeout=5min)');
  // 注入到 toolRegistry，使危险工具调用走审批流
  toolRegistry.setApprovalManager(approvalManager);

  // ── V5 P1: Hook 管理器 ──
  const hookManager = new HookManager(dataDir);
  console.log('[Hooks] Hook 管理器已初始化, 已加载', hookManager.list().length, '个 Hook');

  // ── V5 P1: 收件箱管理器 ──
  const inboxManager = new InboxManager(dataDir, getDB());
  console.log('[Inbox] 收件箱已初始化, 未读', inboxManager.unreadCount(), '条');

  // ── V5 P4: 技能管理器 ──
  const skillsDir = join(process.cwd(), 'skills');
  const skillManager = new SkillManager(skillsDir, dataDir);
  skillManager.scanLocal();
  console.log('[Skills] 技能管理器已初始化, 已安装', skillManager.list().length, '个技能');

  // ── V5 P5: 渠道管理器 ──
  const channelManager = new ChannelManager(dataDir);
  channelManager.load();
  console.log('[Channels] 渠道管理器已初始化, 已配置', channelManager.list().length, '个渠道');

  // ── V5 P3: 语音模块 ──
  const ttsManager = new TTSManager();
  const sttManager = new STTManager();
  console.log('[Voice] TTS:', ttsManager.getStatus(), '| STT:', sttManager.getStatus());

  // ── V5 P6: 自定义 Provider 管理器 ──
  const customProviderManager = new CustomProviderManager();
  console.log('[CustomProviders] 管理器已初始化, 支持', INFERENCE_BACKENDS.length, '种推理后端');

  // ── V5 P7: 调试面板 ──
  const debugPanel = new DebugPanel();
  console.log('[Debug] 调试面板已初始化 (默认关闭)');

  // ── V5 P3: Vision 图片理解 ──
  const visionManager = new VisionManager(aiHub);
  console.log('[Vision] 图片理解:', visionManager.getStatus());

  // ── V5 P2: 推送通知 ──
  const pushManager = new PushNotificationManager(dataDir);
  console.log('[Push] 推送通知:', pushManager.getStatus());

  // ── P1-4: Telegram 渠道（可选） ──
  let telegramAdapter: TelegramAdapter | null = null;
  if (process.env.TELEGRAM_BOT_TOKEN) {
    const tgConfig: TelegramConfig = {
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      enabled: true,
      allowedChats: process.env.TELEGRAM_ALLOWED_CHATS?.split(','),
      requireMention: process.env.TELEGRAM_REQUIRE_MENTION !== 'false',
      defaultUserId: process.env.TELEGRAM_DEFAULT_USER || 'user-shen',
      defaultChatId: process.env.TELEGRAM_DEFAULT_CHAT || 'chat-telegram',
    };
    telegramAdapter = new TelegramAdapter(tgConfig, router, manager, db);
    const tgOk = await telegramAdapter.start();
    if (!tgOk) telegramAdapter = null;
  }

  const app = express();
  app.set('trust proxy', 1); // v5-P0-C: 反代部署时 req.ip 取 X-Forwarded-For 真实客户端
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  // v2 安全修复：阻止备份/敏感文件被 download（必须放在 express.static 前面）
  app.use((req: any, res: any, next: any) => {
    if (/\.bak\.|\.bak-|^\/\.(env|git)|\.sql$|\.db$|\.log$/i.test(req.path)) {
      return res.status(403).send('Forbidden');
    }
    next();
  });
  // v2.0.4: 安全响应头
  app.use((_req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  // CORS: 允许本机 + 可通过 CORS_ORIGIN 配置额外允许的域名（逗号分隔）
  app.use((_req: any, res: any, next: any) => {
    const origin = _req.headers.origin || '';
    const allowedExtra = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const isAllowed = allowedExtra.some(d => origin === d || origin.endsWith('.' + d));
    if (isLocal || isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    }
    if (_req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
  app.use(express.static(join(process.cwd(), 'web')));
  let port = parseInt(process.env.PORT || '3456', 10);
  // 单机多实例：--auto-port 时端口被占用自动顺延，避免 EADDRINUSE 崩溃
  port = await resolveAvailablePort(port, autoPort);

  // ── v2.0.7: 健康检查端点（置于鉴权/限流之前，供探针与部署脚本使用）──
  // 同时保留旧响应字段 status/agents/time，兼容前端状态栏与冒烟测试
  app.get('/api/health', (_req, res) => {
    try {
      let dbOk = false;
      try { dbOk = !!db && typeof (db as any).getUser === 'function'; } catch { dbOk = false; }
      res.json({
        ok: true,
        status: 'ok',
        version: (process.env.npm_package_version) || (globalThis as any).__LINGXI_VERSION__ || 'dev',
        agents: manager.list().length,
        time: Date.now(),
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage().rss,
        wsConnections: clients.size,
        db: dbOk,
        timestamp: Date.now(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 全局鉴权兜底：所有 /api 路由至少走一次 JWT 检查 ──
  app.use('/api', jwtAuth({ required: false }));
  // ── 危险操作鉴权：破坏性/配置类/工具执行类路由必须登录（挂在具体路由上） ──
  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;
// v2.3.1: 市场浏览类接口使用可选鉴权（公网可浏览，登录用户可发布/雇佣）
const optAuth = jwtAuth({ required: false }) as unknown as import('express').RequestHandler;
  // ── 认证接口限流 ──
  app.use('/api/auth', authRateLimit);
  // ── v2.0.4: 通用 API 限流（30次/分钟）──
  app.use('/api', apiRateLimit);

  // ── 认证/用户路由：已迁移至 src/routes/auth-main.ts（巨石拆分批次1，原样抽取+依赖注入） ──
  registerAuthRoutes(app, { db, manager, defaultModel, requireAuth, broadcast });

  // ─── Agent 路由：已迁移至 src/routes/agents.ts（巨石拆分批次6，原三段孤岛 L603-624/L762-781/L996-1022）───
  registerAgentsRoutes(app, { db, manager, router, toolRegistry, requireAuth });
  registerSubAgentRoutes(app, { subAgentManager, broadcast, requireAuth });

  // ── 好友/聊天路由：已迁移至 src/routes/friends-chats.ts（巨石拆分批次2，原样抽取+依赖注入） ──
  registerFriendsChatsRoutes(app, { db, requireAuth, broadcast });


  // ── 工作流/协作缓存路由：已迁移至 src/routes/workflows.ts（巨石拆分批次3，原样抽取+依赖注入） ──
  registerWorkflowsRoutes(app, { requireAuth });


  // ── 文件上传 ──
  const uploadsDir = join(dataDir, 'uploads');
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      // 安全：只保留安全扩展名，其余一律改为 .bin（防止 html/svg 存储型 XSS）
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = /\.(png|jpe?g|gif|webp|bmp|mp3|wav|ogg|m4a|mp4|webm|pdf|txt|md|csv|json)$/i.test(ext) ? ext : '.bin';
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + safeExt);
    }
  });
  const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

  app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const url = '/uploads/' + req.file.filename;
      res.json({ ok: true, url, originalName: req.file.originalname, size: req.file.size });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Serve static uploads（禁止执行脚本，仅允许安全类型）
  app.use('/uploads', (req: any, res: any, next: any) => {
    // 阻止 HTML/JS 等可执行内容被浏览器渲染
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment');
    next();
  }, express.static(uploadsDir, { index: false }));

  // ── 头像静态文件服务 ──
  const avatarsDir = join(dataDir, 'avatars');
  if (!existsSync(avatarsDir)) mkdirSync(avatarsDir, { recursive: true });
  app.use('/avatars', (req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  }, express.static(avatarsDir, { index: false }));
  // ── 视频静态文件服务（ComfyUI 生成结果）──
  const videosDir = join(dataDir, 'videos');
  if (!existsSync(videosDir)) mkdirSync(videosDir, { recursive: true });
  app.use('/videos', (req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  }, express.static(videosDir, { index: false }));


  // ── 系统 API ──
  // ── 版本号：构建时间戳（如 v2026.7.5-9.33） ──
  const now = new Date();
  const Y = now.getFullYear();
  const M = now.getMonth() + 1;
  const D = now.getDate();
  const HH = now.getHours();
  const mm = now.getMinutes();
  const APP_VERSION = `v${Y}.${M}.${D}-${HH}.${mm}`;

  // v2.0.7: health 端点已前移至鉴权之前（启动段），此处旧注册移除

  app.get('/api/version', (_req, res) => {
    res.json({ version: APP_VERSION });
  });

  app.get('/api/search/providers', requireAuth, (_req, res) => {
    try {
      res.json({ ok: true, providers: searchManagerInstance.listProviders() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/usage', requireAuth, (_req, res) => {
    try {
      res.json({ ok: true, stats: UsageTracker.getStats(), recent: UsageTracker.getRecentRecords(50) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/usage/reset', adminAuth, (_req, res) => {
    try {
      UsageTracker.reset();
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 模型路由配置持久化：写回 .env（read-modify-write，保留原内容与注释）
  function persistEnvVar(key: string, value: string): void {
    try {
      const envPath = path.join(process.cwd(), '.env');
      let text = '';
      if (existsSync(envPath)) text = readFileSync(envPath, 'utf8');
      const re = new RegExp('^(' + key + '\\s*=).*$', 'm');
      if (re.test(text)) {
        text = text.replace(re, '$1' + value);
      } else {
        text += (text.endsWith('\n') || text === '' ? '' : '\n') + key + '=' + value + '\n';
      }
      writeFileSync(envPath, text, 'utf8');
    } catch (e: any) {
      console.warn('[Config] 写入 .env 失败:', e.message);
    }
  }

  // ── 模型路由配置 ──
  app.get('/api/model-route', requireAuth, (_req, res) => {
    res.json({
      ok: true,
      toolModel: process.env.TOOL_MODEL || '',
      replyModel: process.env.REPLY_MODEL || '',
      defaultModel: process.env.DEFAULT_MODEL || '',
      enabled: process.env.ROUTE_ENABLED !== 'false' ? 'true' : 'false',
    });
  });

  app.put('/api/model-route', requireAuth, (req, res) => {
    try {
      const { toolModel, replyModel, enabled } = req.body;
      if (toolModel !== undefined) { process.env.TOOL_MODEL = toolModel; persistEnvVar('TOOL_MODEL', toolModel); }
      if (replyModel !== undefined) { process.env.REPLY_MODEL = replyModel; persistEnvVar('REPLY_MODEL', replyModel); }
      if (enabled !== undefined) { process.env.ROUTE_ENABLED = String(enabled); persistEnvVar('ROUTE_ENABLED', String(enabled)); }
      res.json({ ok: true, toolModel: process.env.TOOL_MODEL, replyModel: process.env.REPLY_MODEL, enabled: process.env.ROUTE_ENABLED !== 'false' ? 'true' : 'false' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/chats', requireAuth, (req, res) => {
    try {
      const userId = req.query.userId as string;
      // ⭐ v2.1.2 修复 F5 会话消失：admin-auto 本地免登录模式下，participant 表中
      //    旧会话可能没有 user_id 记录（P1-4 403 拦截导致的遗留数据），按 userId
      //    过滤会返回空列表。本地模式兜底返回全部会话，避免 F5 后左侧栏空白。
      const jwtSid = String((req as any).user?.sid || '');
      const isLocalAuto = (jwtSid === 'admin-auto' || jwtSid === 'admin-token');
      if (userId && !isLocalAuto) {
        const allChats = db.listChats();
        const userChats = allChats.filter((c: any) => {
          const participants = db.getChatParticipants(c.id);
          return participants.some((p: any) => p.user_id === userId);
        });
        res.json({ ok: true, chats: userChats });
      } else {
        // 本地免登录模式或未传 userId：返回全部列表（个人单机使用兜底）
        const allChats = db.listChats();
        if (userId && isLocalAuto) {
          // 本地模式：先尝试按 userId 过滤，有结果就用过滤的，没有就返回全部
          const userChats = allChats.filter((c: any) => {
            const participants = db.getChatParticipants(c.id);
            return participants.some((p: any) => p.user_id === userId);
          });
          res.json({ ok: true, chats: userChats.length ? userChats : allChats });
        } else {
          res.json({ ok: true, chats: allChats });
        }
      }
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/models', requireAuth, (_req, res) => {
    try { res.json({ ok: true, models: aiHub.listModels() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/chats/:id/messages', requireAuth, (req, res) => {
    try {
      // P1-2 修复: 校验调用者是否为该会话参与者
      const chatId = req.params.id as string;
      const jwtUser = (req as any).user;
      const uid = String(jwtUser?.sub || jwtUser?.numeric_id || '');
      const participants = db.getChatParticipants(chatId) || [];
      const isParticipant = participants.some((p: any) => String(p.user_id) === uid || String(p.agent_id) === uid);
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      if (!isParticipant && !isAdmin) return res.status(403).json({ error: '无权访问此会话消息' });
      res.json({ ok: true, messages: db.listMessages(chatId) });
    }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 消息搜索 API ──
  app.get('/api/search/messages', requireAuth, (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'q 参数必填' });
      const chatId = req.query.chatId ? String(req.query.chatId) : undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit)) : 50;
      // P1-2 修复: 若指定 chatId，校验调用者是否为该会话参与者
      const jwtUser = (req as any).user;
      const uid = String(jwtUser?.sub || jwtUser?.numeric_id || '');
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      if (chatId && !isAdmin) {
        const participants = db.getChatParticipants(chatId) || [];
        const isParticipant = participants.some((p: any) => String(p.user_id) === uid || String(p.agent_id) === uid);
        if (!isParticipant) return res.status(403).json({ error: '无权搜索此会话消息' });
      }
      const results = (db as any).searchMessages(q, { chatId, limit });
      res.json({ ok: true, query: q, count: results.length, results });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 数据导出 / 备份 API ──
  app.get('/api/export/backup', requireAuth, (req, res) => {
    // P1-2 修复: 全量备份仅管理员可用
    const roles = (req as any).user?.roles || [];
    if (!roles.includes('admin')) return res.status(403).json({ error: '仅管理员可导出全量备份' });
    try {
      const data = (db as any).exportBackup();
      const filename = `lingxi-backup-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(JSON.stringify(data, null, 2));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 记忆搜索 API（P1-1: 需鉴权 + 强制 agentId/chatId 过滤，防止跨 agent 越权访问）──
  app.get('/api/memory/search', requireAuth, (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const topK = parseInt(req.query.topK as string) || 5;
      const agentId = (req.query.agentId as string) || '';
      const chatId = (req.query.chatId as string) || '';
      if (!q) return res.status(400).json({ error: 'q 参数必填' });
      if (!agentId && !chatId) return res.status(400).json({ error: 'agentId 或 chatId 至少提供一个' });
      const hits = router.searchMemory(q, topK, { agentId: agentId || undefined, chatId: chatId || undefined });
      res.json({ ok: true, query: q, hits });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });



  // ── 工具列表 API ──
  app.get('/api/tools', requireAuth, (_req, res) => {
    try { res.json({ ok: true, tools: toolRegistry.listTools(), skills: toolRegistry.listSkills() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── AI 员工市场 + 雇佣系统 API ──
  // ── AI 员工市场 + 雇佣系统路由（批次5: 迁移至 src/routes/market.ts） ──
  registerMarketRoutes(app, { optAuth, requireAuth });
  registerWalletRoutes(app, { optAuth, requireAuth });
  registerCustomProviderRoutes(app, { INFERENCE_BACKENDS, customProviderManager, requireAuth });
  registerLanRoutes(app, { db, manager, router, broadcast, requireAuth, port, dataDir });

  // ── P2-3: Provider 管理 API ──
  // 模型管理前端调用的别名（/api/ai/* → /api/providers/*）
  app.get('/api/ai/config', requireAuth, (_req, res) => {
    try {
      const seen = new Set<string>();
      const providers: any[] = [];
      for (const hp of (aiHub.listProviders?.() || []) as any[]) {
        seen.add(hp.id);
        providers.push(hp);
      }
      for (const p of providerRegistry.list() as any[]) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          providers.push({ id: p.id, type: p.type, name: p.name, baseUrl: p.baseUrl, models: p.models, isLocal: p.isLocal, enabled: p.enabled, hasKey: !!(p.apiKey && p.apiKey.length > 8 && !p.apiKey.startsWith('your-')) });
        }
      }
      res.json({ ok: true, defaultModel: process.env.DEFAULT_MODEL || 'deepseek-chat', providers });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/ai/config', requireAuth, (req, res) => {
    try {
      const { defaultModel, providers } = req.body || {};
      if (defaultModel) {
        process.env.DEFAULT_MODEL = defaultModel;
        aiHub.setDefaultModel(defaultModel);
        console.log('[Providers] 默认模型已切换为:', defaultModel);
      }
      if (providers && Array.isArray(providers)) {
        for (const p of providers) {
          const existing = providerRegistry.list().find((x: any) => x.id === p.id);
          if (existing) {
            providerRegistry.unregister(existing.id);
          }
          providerRegistry.register({
            id: p.id, name: p.name || p.id, type: p.type || 'openai',
            apiKey: p.apiKey, baseUrl: p.baseUrl,
            models: p.models || [], isLocal: p.isLocal || false,
            enabled: p.enabled !== false,
          });
          try {
            aiHub.addProvider({
              id: p.id, type: p.type || 'openai',
              apiKey: p.apiKey, baseUrl: p.baseUrl,
              models: p.models || [], isLocal: p.isLocal || false,
            });
          } catch(e) { /* 同步失败不影响 */ }
          const existingIdx = (globalThis as any).__aiHub_providers.findIndex((x: any) => x.id === p.id);
          if (existingIdx >= 0) (globalThis as any).__aiHub_providers[existingIdx] = p;
          else (globalThis as any).__aiHub_providers.push(p);
        }
      }
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/ai/providers/:id', requireAuth, (req, res) => {
    try {
      providerRegistry.unregister(String(req.params.id));
      aiHub.removeProvider(String(req.params.id));
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/providers', requireAuth, (_req, res) => {
    try {
      const seen = new Set<string>();
      const providers: any[] = [];
      const allModels: any[] = [];
      
      // 1. AIHub 优先（启动时从 .env 加载的，URL 正确）
      for (const hp of (aiHub.listProviders?.() || []) as any[]) {
        seen.add(hp.id);
        providers.push(hp);
        for (const m of hp.models || []) {
          allModels.push({ id: m, provider: hp.id, isLocal: hp.isLocal });
        }
      }
      
      // 2. ProviderRegistry 补充（用户通过设置 UI 添加的）
      for (const p of providerRegistry.list() as any[]) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          providers.push({ id: p.id, type: p.type, name: p.name, baseUrl: p.baseUrl, models: p.models, isLocal: p.isLocal, enabled: p.enabled, hasKey: !!(p.apiKey && p.apiKey.length > 8 && !p.apiKey.startsWith('your-')) });
          for (const m of p.models || []) {
            if (!allModels.some(x => x.id === m)) {
              allModels.push({ id: m, provider: p.id, isLocal: p.isLocal });
            }
          }
        }
      }
      
      res.json({ ok: true, providers, models: allModels, defaultModel: process.env.DEFAULT_MODEL || aiHub.getDefaultModel() || '' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 多AI交互：不依赖群聊/Agent，直接选模型+模式进行多模型对话 ──
  app.post('/api/multi-ai', requireAuth, async (req, res) => {
    try {
      const { mode, models, message, history } = req.body || {};
      if (!message || !Array.isArray(models) || models.length === 0) {
        return res.status(400).json({ error: 'message 和 models 必填' });
      }
      if (models.length > 6) { return res.status(400).json({ error: '最多选择6个模型' }); }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const send = (event: string, data: any) => { res.write(`event: ${event}\n`); res.write(`data: ${JSON.stringify(data)}\n\n`); };
      const buildMessages = (_m: string, sys: string, extra: any[] = []) => {
        const msgs: any[] = [{ role: 'system', content: sys }];
        for (const h of (history || []).slice(-10)) msgs.push({ role: h.role || 'user', content: h.content });
        for (const h of extra) msgs.push({ role: h.role || 'user', content: h.content });
        msgs.push({ role: 'user', content: message });
        return msgs;
      };
      const callModel = async (modelId: string, sys: string, extra: any[] = []): Promise<string> => {
        const cr = aiHub.getClient(modelId);
        if (!cr) throw new Error('找不到模型: ' + modelId);
        const msgs = buildMessages(modelId, sys, extra);
        let full = '';
        // 获取通用助手的工具列表
        const tools = toolRegistry ? toolRegistry.listToolsForSkills(['general-assistant']).map((t: any) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.parameters.properties || {}, required: t.parameters.required || [] } }
        })) : undefined;
        try {
          const stream = await cr.client.chat.completions.create({ model: cr.resolvedModel, messages: msgs, stream: true, temperature: 0.7, tools: tools as any });
          for await (const chunk of stream as any) {
            const d = chunk.choices?.[0]?.delta?.content;
            if (d) { full += d; send('chunk', { model: modelId, text: d }); }
            // 处理工具调用
            const toolCalls = chunk.choices?.[0]?.delta?.tool_calls;
            if (toolCalls && toolRegistry) {
              for (const tc of toolCalls) {
                if (tc.function?.name && tc.function?.arguments) {
                  try {
                    const args = JSON.parse(tc.function.arguments || '{}');
                    const result = await toolRegistry.execute({ id: tc.id || 'multi-ai-tool', name: tc.function.name, arguments: args });
                    send('tool', { model: modelId, tool: tc.function.name, result: JSON.stringify(result).slice(0, 200) });
                    msgs.push({ role: 'assistant', tool_calls: [tc] });
                    msgs.push({ role: 'tool', tool_call_id: tc.id || 'multi-ai-tool', content: JSON.stringify(result).slice(0, 4000) });
                  } catch(e: any) { send('tool', { model: modelId, tool: tc.function.name, error: e.message }); }
                }
              }
            }
          }
        } catch (e: any) {
          const resp = await cr.client.chat.completions.create({ model: cr.resolvedModel, messages: msgs, temperature: 0.7, tools: tools as any });
          full = resp.choices?.[0]?.message?.content || '';
          // 非流式也处理工具调用
          const respToolCalls = resp.choices?.[0]?.message?.tool_calls;
          if (respToolCalls && toolRegistry) {
            for (const tc of respToolCalls) {
              try {
                const args = JSON.parse(tc.function.arguments || '{}');
                const result = await toolRegistry.execute({ id: tc.id || 'multi-ai-tool', name: tc.function.name, arguments: args });
                send('tool', { model: modelId, tool: tc.function.name, result: JSON.stringify(result).slice(0, 200) });
                msgs.push({ role: 'assistant', tool_calls: [tc] });
                msgs.push({ role: 'tool', tool_call_id: tc.id || 'multi-ai-tool', content: JSON.stringify(result).slice(0, 4000) });
              } catch(e2: any) { send('tool', { model: modelId, tool: tc.function.name, error: e2.message }); }
            }
            // 如果有工具调用，再请求一次让模型基于工具结果回复
            if (respToolCalls.length > 0) {
              const resp2 = await cr.client.chat.completions.create({ model: cr.resolvedModel, messages: msgs, temperature: 0.7 });
              full = resp2.choices?.[0]?.message?.content || full;
              send('chunk', { model: modelId, text: full });
            }
          }
          if (!full) { full = resp.choices?.[0]?.message?.content || ''; send('chunk', { model: modelId, text: full }); }
        }
        send('done', { model: modelId, full });
        return full;
      };
      const mt = mode || 'free';
      if (mt === 'free' || mt === 'brainstorm') {
        const p = mt === 'brainstorm' ? '你是一个创意顾问。请针对用户的问题提出你的独特想法和建议，要具体、有创意。' : '你是一个有用的AI助手。请回答用户的问题。';
        await Promise.all(models.map(m => callModel(m, p).catch(e => { send('error', { model: m, error: e.message }); return ''; })));
      } else if (mt === 'debate') {
        const replies: any[] = [];
        for (let i = 0; i < models.length; i++) {
          const pos = i === 0 ? '正方（支持）' : i === 1 ? '反方（反对）' : `第${i+1}方观点`;
          const dh = replies.map((r, j) => ({ role: 'assistant', content: `[${models[j]} 的发言]: ${r}` }));
          send('start', { model: models[i], position: pos });
          replies.push(await callModel(models[i], `你正在参加一场辩论。你的立场是${pos}。请针对用户的议题发表你的观点和论据。${dh.length > 0 ? '以下是其他参与者的发言，请回应他们的观点：' : ''}`, dh).catch(e => { send('error', { model: models[i], error: e.message }); return ''; }));
        }
      } else if (mt === 'roundtable') {
        const replies: any[] = [];
        for (let i = 0; i < models.length; i++) {
          const rh = replies.map((r, j) => ({ role: 'assistant', content: `[${models[j]} 的发言]: ${r}` }));
          send('start', { model: models[i], round: i + 1 });
          replies.push(await callModel(models[i], `你正在参加一个圆桌讨论。请就用户提出的话题分享你的专业见解。${rh.length > 0 ? '请参考其他参与者的发言并补充你的观点：' : ''}`, rh).catch(e => { send('error', { model: models[i], error: e.message }); return ''; }));
        }
      } else if (mt === 'chain') {
        let acc = '';
        for (let i = 0; i < models.length; i++) {
          const ch = i > 0 ? [{ role: 'assistant', content: `[上一个模型(${models[i-1]})的分析]: ${acc}` }] : [];
          send('start', { model: models[i], step: i + 1 });
          acc = await callModel(models[i], i === 0 ? '你是一个分析专家。请分析用户的问题并给出你的初步判断。' : '你是一个续写专家。上一个模型已经给出了分析，请在此基础上深入分析并给出你的结论。', ch).catch(e => { send('error', { model: models[i], error: e.message }); return ''; });
        }
      } else if (mt === 'vote') {
        const props: any[] = [];
        for (let i = 0; i < models.length; i++) {
          send('start', { model: models[i], phase: 'proposal' });
          props.push({ model: models[i], content: await callModel(models[i], '你是一个决策顾问。请针对用户的问题给出你的方案和建议。').catch(e => { send('error', { model: models[i], error: e.message }); return ''; }) });
        }
        for (let i = 0; i < models.length; i++) {
          const pt = props.map(p => `[${p.model}的方案]: ${p.content.slice(0, 500)}...`).join('\n\n');
          send('start', { model: models[i], phase: 'vote' });
          await callModel(models[i], `你是一个评委。以下是多个方案，请评价并投票选出最佳方案，说明理由。\n\n${pt}`).catch(e => { send('error', { model: models[i], error: e.message }); });
        }
      } else { return res.status(400).json({ error: '不支持的模式: ' + mt }); }
      send('complete', { mode: mt, models });
      res.end();
    } catch (err: any) {
      console.error('[MultiAI] error:', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else { res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`); res.end(); }
    }
  });

  app.post('/api/providers', requireAuth, (req, res) => {
    try {
      // 补全 id 和 baseUrl（前端可能没传）
      const DEFAULT_BASE_URLS: Record<string, string> = {
        deepseek: 'https://api.deepseek.com/v1',
        openai: 'https://api.openai.com/v1',
        anthropic: 'https://api.anthropic.com/v1',
        google: 'https://generativelanguage.googleapis.com/v1beta/openai',
        minimax: 'https://api.minimax.io/v1',
        moonshot: 'https://api.moonshot.cn/v1',
        zhipu: 'https://open.bigmodel.cn/api/paas/v4',
        qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        stepfun: 'https://api.stepfun.com/v1',
        siliconflow: 'https://api.siliconflow.cn/v1',
        groq: 'https://api.groq.com/openai/v1',
        openrouter: 'https://openrouter.ai/api/v1',
        nvidia: 'https://integrate.api.nvidia.com/v1',
        ollama: 'http://localhost:11434/v1',
        'llama-cpp': 'http://localhost:8080/v1',
        vllm: 'http://localhost:8000/v1',
        'lm-studio': 'http://localhost:1234/v1',
        tgi: 'http://localhost:8080/v1',
        'text-gen-webui': 'http://localhost:5000/v1',
        baidu: 'https://qianfan.baidubce.com/v2',
        yi: 'https://api.lingyiwanwu.com/v1',
        baichuan: 'https://api.baichuan-ai.com/v1',
        iflytek: 'https://spark-api-open.xf-yun.com/v1',
        volcengine: 'https://ark.cn-beijing.volces.com/api/v3',
        tencent: 'https://api.hunyuan.cloud.tencent.com/v1',
        mistral: 'https://api.mistral.ai/v1',
        together: 'https://api.together.xyz/v1',
        fireworks: 'https://api.fireworks.ai/inference/v1',
        perplexity: 'https://api.perplexity.ai',
        xai: 'https://api.x.ai/v1',
      };
      const body = {
        ...req.body,
        id: req.body.id || req.body.type + '-' + Date.now().toString(36),
        baseUrl: req.body.baseUrl || DEFAULT_BASE_URLS[req.body.type] || '',
      };

      // v1.9.6: 只按 ID 精确匹配同 provider，不再按 type 误杀（避免 local-ollama 覆盖 ollama-cloud）
      const existing = providerRegistry.list().find((p: any) => p.id === body.id);
      if (existing) {
        providerRegistry.unregister(existing.id);
        aiHub.removeProvider(existing.id);  // ← 同步删除 AIHub 旧 provider
      }
      providerRegistry.register(body);
      // 同步到 AI Hub
      try {
        aiHub.addProvider({
          id: body.id, type: body.type || 'custom',
          apiKey: body.apiKey || "", baseUrl: body.baseUrl,
          models: body.models || [], isLocal: body.isLocal || false,
        });
      } catch(e) { console.warn('[Providers] AIHub 同步失败:', (e as Error).message); /* 同步失败不影响注册 */ }
      // 自动切换所有 Agent 到新 Provider 的第一个模型
      if (req.body.models && req.body.models.length > 0) {
        try {
          const newModel = req.body.models[0];
          const agents = db.listAgents();
          for (const agent of agents) {
            manager.update(agent.id || agent.agent_id, { model: newModel });
          }
          console.log(`[Providers] ${agents.length} 个 Agent 已切换到模型: ${newModel}`);
        } catch(e) { /* 切换失败不影响 */ }
      }
      res.json({ ok: true, id: req.body.id });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/providers/:id', requireAuth, (req, res) => {
    try {
      providerRegistry.unregister(String(req.params.id));
      aiHub.removeProvider(String(req.params.id));
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // PUT: 更新 Provider（主要用于前端修改 API Key）
  app.put('/api/providers/:id', requireAuth, (req, res) => {
    try {
      const id = String(req.params.id);
      const existing = providerRegistry.get(id);
      if (!existing) return res.status(404).json({ error: 'Provider 不存在' });
      const { apiKey, name, baseUrl, models } = req.body || {};
      // 构造更新后的配置
      const updated = {
        id: existing.id,
        type: existing.type,
        name: name || existing.name,
        apiKey: apiKey !== undefined ? apiKey : existing.apiKey,
        baseUrl: baseUrl || existing.baseUrl,
        models: models || existing.models,
        isLocal: existing.isLocal,
        enabled: existing.enabled,
      };
      // 先删后加（replace 语义）
      providerRegistry.unregister(id);
      aiHub.removeProvider(id);
      providerRegistry.register(updated);
      try {
        aiHub.addProvider({
          id: updated.id, type: updated.type as any,
          apiKey: updated.apiKey || '', baseUrl: updated.baseUrl,
          models: updated.models, isLocal: updated.isLocal,
        } as any);
      } catch(e) { console.warn('[Providers] AIHub 同步失败:', (e as Error).message); }
      console.log(`[Providers] 已更新: ${id}`);
      res.json({ ok: true, id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // PUT: set default model
  app.put('/api/providers/default', requireAuth, (req, res) => {
    try {
      const { model } = req.body;
      if (!model) return res.status(400).json({ error: 'model 必填' });
      process.env.DEFAULT_MODEL = model;
      aiHub.setDefaultModel(model);
      console.log('[Providers] 默认模型已切换为:', model);
      res.json({ ok: true, defaultModel: model });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // DELETE: 移除 Provider 下的单个模型
  app.delete('/api/providers/:id/models/:model', requireAuth, (req, res) => {
    try {
      const providerId = String(req.params.id);
      const modelName = String(req.params.model);
      const ok = providerRegistry.removeModel(providerId, modelName);
      if (!ok) return res.status(404).json({ error: '模型不存在' });
      // 同步 AIHub
      try { aiHub.removeProvider(providerId); const p = providerRegistry.get(providerId); if (p) aiHub.addProvider({ id: p.id, type: p.type as any, apiKey: p.apiKey || '', baseUrl: p.baseUrl, models: p.models, isLocal: p.isLocal } as any); } catch(_e) {}
      console.log(`[Providers] 已移除模型: ${providerId}/${modelName}`);
      res.json({ ok: true, removed: modelName });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── P2-1: MCP 管理 API ──
  app.get('/api/mcp/servers', requireAuth, (_req, res) => {
    try { res.json({ ok: true, servers: mcpManager.listServers(), tools: mcpManager.getAllToolDefinitions() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/mcp/servers', requireAuth, async (req, res) => {
    try {
      const config = req.body;
      const client = await mcpManager.addServer(config);
      // 把 MCP 工具桥接到 ToolRegistry
      for (const tool of client.getTools()) {
        const bridgedDef: any = {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        };
        try {
          toolRegistry.registerTool(bridgedDef, (args: any) => mcpManager.callTool(tool.name, args));
        } catch { /* skip duplicate */ }
      }
      res.json({ ok: true, serverId: config.id, toolCount: client.getTools().length });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/mcp/servers/:id', requireAuth, async (req, res) => {
    try {
      await mcpManager.removeServer(String(req.params.id));
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── P2-4: 插件管理 API ──
  app.get('/api/plugins', requireAuth, (_req, res) => {
    try { res.json({ ok: true, plugins: pluginManager.listPlugins() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/plugins/:id/enable', requireAuth, (req, res) => {
    try { pluginManager.setEnabled(String(req.params.id), true); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/plugins/:id/disable', requireAuth, (req, res) => {
    try { pluginManager.setEnabled(String(req.params.id), false); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/plugins/reload', requireAuth, async (_req, res) => {
    try {
      const result = await pluginManager.loadAll();
      res.json({ ok: true, ...result });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── P2-2: 浏览器状态 API ──
  app.get('/api/browser/status', requireAuth, (_req, res) => {
    try { res.json({ ok: true, available: browserManager.isAvailable() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ────────────────────────────────────────
  // P1 REST API
  // ────────────────────────────────────────

  // ── P1-1: Cron 定时任务 API ──
  app.get('/api/cron', requireAuth, (_req, res) => {
    try { res.json({ ok: true, jobs: cronScheduler.listJobs() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // v1.7 Standing Orders — 常驻定时任务，结果自动发到聊天
  app.post('/api/standing-orders', requireAuth, (req, res) => {
    try {
      const { name, cron, prompt, chatId, timezone } = req.body || {};
      if (!name || !cron || !prompt) return res.status(400).json({ error: 'name/cron/prompt 必填' });
      const jobId = 'so-' + Date.now().toString(36);
      cronScheduler.addJob({
        id: jobId,
        name: 'SO: ' + name,
        enabled: true,
        schedule: { kind: 'cron', expr: cron, tz: timezone || 'Asia/Shanghai' },
        payload: { kind: 'standingOrder', prompt, chatId: chatId || '', text: prompt },
        runCount: 0,
        createdAt: Date.now(),
      });
      res.json({ ok: true, id: jobId });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/standing-orders', requireAuth, (_req, res) => {
    try {
      const jobs = cronScheduler.listJobs().filter((j: any) => j.id?.startsWith('so-'));
      res.json({ ok: true, jobs });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/standing-orders/:id', requireAuth, (req, res) => {
    try { cronScheduler.removeJob(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/cron', requireAuth, (req, res) => {
    try {
      const { name, schedule, payload, enabled } = req.body;
      if (!name || !schedule || !payload) return res.status(400).json({ error: 'name/schedule/payload 必填' });
      const job = createCronJob({ name, schedule, payload, enabled: enabled ?? true });
      cronScheduler.addJob(job);
      res.json({ ok: true, job });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/cron/:id', requireAuth, (req, res) => {
    try {
      const ok = cronScheduler.removeJob(String(req.params.id));
      res.json({ ok });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/cron/:id/run', requireAuth, async (req, res) => {
    try {
      const ok = await cronScheduler.runNow(String(req.params.id));
      res.json({ ok });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.patch('/api/cron/:id', requireAuth, (req, res) => {
    try {
      const { enabled } = req.body;
      if (enabled !== undefined) cronScheduler.setEnabled(String(req.params.id), enabled);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── v1.8.4: 目标系统 (GoalTracker) ──
  // project 参数缺省为 'default'（单项目场景），支持 ?project= 查询多项目
  app.get('/api/goals', requireAuth, (_req, res) => {
    try {
      const project = String(_req.query.project || 'default');
      const goals = GoalTracker.list(project);
      const done = goals.filter(g => g.status === 'done').length;
      res.json({ ok: true, project, goals, progress: { total: goals.length, done } });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/goals/summary', requireAuth, (_req, res) => {
    try {
      const project = String(_req.query.project || 'default');
      res.json({ ok: true, summary: GoalTracker.getProgressSummary(project) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/goals', requireAuth, (req, res) => {
    try {
      const { title, acceptanceCriteria, parentId, project } = req.body || {};
      if (!title || !String(title).trim()) return res.status(400).json({ error: 'title 必填' });
      const goal = GoalTracker.create(String(project || 'default'), String(title).trim(), acceptanceCriteria, parentId);
      res.json({ ok: true, goal });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.patch('/api/goals/:id', requireAuth, (req, res) => {
    try {
      const id = String(req.params.id);
      const { status } = req.body || {};
      const goal = GoalTracker.get(id);
      if (!goal) return res.status(404).json({ error: '目标不存在' });
      if (status === 'done') GoalTracker.markDone(id);
      else if (status === 'in_progress') GoalTracker.markInProgress(id);
      else if (status === 'cancelled') GoalTracker.cancel(id);
      else if (status === 'pending') { getDB().run(`UPDATE project_goals SET status = 'pending', done_at = NULL WHERE id = ?`, [id]); }
      else return res.status(400).json({ error: 'status 必须是 pending/in_progress/done/cancelled' });
      res.json({ ok: true, goal: GoalTracker.get(id) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/goals/:id', requireAuth, (req, res) => {
    try {
      const id = String(req.params.id);
      if (!GoalTracker.get(id)) return res.status(404).json({ error: '目标不存在' });
      GoalTracker.remove(id);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 模块化路由挂载（目标追踪/评分卡、个人资料、杂项）──
  // v2.0.9: 仅对子路由实际路径执行 requireAuth，避免 app.use('/api', requireAuth, ...) 对所有 /api 请求先鉴权，
  // 导致无效 token 拦截到免鉴权路由（如 /api/lan/search）
  const authIfMatch = (pattern: RegExp) => (req: any, res: any, next: any) =>
    pattern.test(req.path) ? requireAuth(req, res, next) : next();
  app.use('/api', authIfMatch(/^\/(goals|outcomes)(\/|$)/), createGoalOutcomeRoutes({ outcomeTracker, db, broadcast, router } as any));
  app.use('/api', authIfMatch(/^\/evaluations(\/|$)/), createEvaluationRoutes({ router, db } as any));  // AGI: 评测体系

  // ── AGI 能力（辩论/思考树/世界模型/人格）──
  app.use('/api', authIfMatch(/^\/agi(\/|$)/), createAgiRoutes({ router, manager } as any));

  // ── 个人资料 API（GET/PUT /api/profile、头像上传）──
  app.use('/api', authIfMatch(/^\/profile(\/|$)/), createProfileRoutes({ db, dataDir } as any));

  // ── 杂项 API（时间/标签/联邦通信/Mesh/工作区模式）──
  app.use('/api', createMiscRoutes({ db, manager, router, broadcast, dataDir } as any));

  // ── 上传管理 API ──
  app.use('/api', authIfMatch(/^\/upload(\/|$)/), createUploadRoutes({ db, dataDir } as any));

  // ── GoalTracker.onGoalStarted: 任务监控/AI自动执行 ──
  GoalTracker.onGoalStarted = (goal: ProjectGoal) => {
    // 从 projectId 提取 chatId（格式: project-<chatId> 或 default）
    let chatId: string | null = goal.projectId.startsWith('project-') ? goal.projectId.slice(8) : null;
    if (!chatId) {
      // projectId 为 'default' 时，回退到最近活跃会话
      try {
        const chats = db.listChats();
        if (chats && chats.length > 0) {
          chatId = chats[0].id;
          console.log(`[GoalTracker] 目标 "${goal.title}" projectId=${goal.projectId}，回退到最近会话 ${chatId}`);
        }
      } catch (e: any) { /* ignore */ }
    }
    if (!chatId) {
      console.log(`[GoalTracker] 目标 "${goal.title}" 已开始，但未绑定会话 (projectId=${goal.projectId})`);
      return;
    }
    const msgId = 'goal-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    // 自主执行指令：AI 必须持续工作直到验收标准全部满足
    const taskPrompt = goal.acceptanceCriteria
      ? `请开始执行目标任务：「${goal.title}」\n\n验收标准：${goal.acceptanceCriteria}\n\n要求：\n1. 将目标拆解为子步骤，逐步执行\n2. 每个子步骤都需要实际完成（调用工具、生成结果），不只是写计划\n3. 全部验收标准满足后再总结报告\n4. 如果一次性无法完成，告知进度并继续\n5. 不要停下来问用户问题，不要等待确认，自主判断并执行\n6. 一旦开始就必须持续工作直到目标完全达成，中途不可暂停\n7. 遇到困难时换一种方式继续，不要放弃不要停`
      : `请开始执行目标任务：「${goal.title}」\n\n要求：\n1. 拆解为子步骤，逐步执行\n2. 每个子步骤实际完成\n3. 不要停下来问用户问题，自主判断并执行\n4. 一旦开始就必须持续工作直到全部完成，中途不可暂停\n5. 全部完成后总结`;
    const content = taskPrompt;
    try {
      db.addMessage({ id: msgId, chatId, senderType: 'user', senderId: 'goal-tracker', content, type: 'text', timestamp: Date.now() });
      broadcast({ type: 'message.new', chatId, from: 'goal-tracker', senderId: 'goal-tracker', senderType: 'user', content, timestamp: Date.now() });
      // 触发 AI 执行目标 — 这里传递 taskGoal 让 router 知道这是目标任务
      try { processUserMessage(chatId, 'goal-tracker', content, undefined, router, broadcast); } catch (e: any) {
        console.error(`[GoalTracker] 触发AI执行失败:`, e?.message || e);
      }
      console.log(`[GoalTracker] 已向 ${chatId} 注入目标 "${goal.title}"`);
    } catch (e: any) {
      console.error(`[GoalTracker] 注入目标消息失败:`, e?.message || e);
    }
  };

  // ── P1-2: 会话管理 API ──
  app.get('/api/sessions', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      const sessions = userId ? sessionManager.listByUser(userId) : sessionManager.listAll();
      res.json({ ok: true, sessions, activeId: sessionManager.getActive()?.id || null });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/sessions', requireAuth, (req, res) => {
    try {
      const { id, label, chatId, userId, agentIds } = req.body;
      if (!id || !chatId || !userId) return res.status(400).json({ error: 'id/chatId/userId 必填' });
      const session = sessionManager.create({ id, label: label || id, chatId, userId, agentIds: agentIds || [] });
      res.json({ ok: true, session });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.patch('/api/sessions/:id', requireAuth, (req, res) => {
    try {
      const session = sessionManager.update(String(req.params.id), req.body);
      if (!session) return res.status(404).json({ error: '会话不存在' });
      res.json({ ok: true, session });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/sessions/:id', requireAuth, (req, res) => {
    try {
      const ok = sessionManager.delete(String(req.params.id));
      res.json({ ok });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/sessions/:id/activate', requireAuth, (req, res) => {
    try {
      sessionManager.setActive(String(req.params.id));
      res.json({ ok: true, activeId: String(req.params.id) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── P1-4: Telegram 状态 API ──
  app.get('/api/telegram/status', requireAuth, (_req, res) => {
    try {
      res.json({ ok: true, connected: !!telegramAdapter, token: process.env.TELEGRAM_BOT_TOKEN ? '***configured' : 'not set' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ────────────────────────────────────────
  // V5 新增 API
  // ────────────────────────────────────────

  // ── V5 P1: 收件箱 API ──
  app.get('/api/inbox', requireAuth, (req, res) => {
    try {
      const unreadOnly = req.query.unread === 'true';
      const limit = parseInt(req.query.limit as string) || 50;
      res.json({ ok: true, items: inboxManager.list(limit, unreadOnly), unread: inboxManager.unreadCount() });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/inbox/:id', requireAuth, (req, res) => {
    try {
      const item = inboxManager.get(String(req.params.id));
      if (!item) return res.status(404).json({ error: '不存在' });
      const fullContent = inboxManager.getFullContent(String(req.params.id));
      res.json({ ok: true, item, fullContent });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/inbox/:id/read', requireAuth, (req, res) => {
    try { inboxManager.markRead(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/inbox/:id', requireAuth, (req, res) => {
    try { inboxManager.delete(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V5 P1: 审批 API ──
  app.get('/api/approval/pending', requireAuth, (req, res) => {
    // P1 修复: 审批列表仅管理员可查看
    const roles = (req as any).user?.roles || [];
    if (!roles.includes('admin')) return res.status(403).json({ error: '仅管理员可查看审批列表' });
    try { res.json({ ok: true, pending: approvalManager.getPending() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/approval/:id', requireAuth, (req, res) => {
    // P1 修复: 审批操作仅管理员可执行
    const roles = (req as any).user?.roles || [];
    if (!roles.includes('admin')) return res.status(403).json({ error: '仅管理员可执行审批操作' });
    try {
      const { action, by } = req.body;
      if (action === 'approve') approvalManager.approve(String(req.params.id), by);
      else if (action === 'reject') approvalManager.reject(String(req.params.id), by, req.body.reason);
      else return res.status(400).json({ error: 'action 只能是 approve 或 reject' });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/approval/history', requireAuth, (req, res) => {
    // P1 修复: 审批历史仅管理员可查看
    const roles = (req as any).user?.roles || [];
    if (!roles.includes('admin')) return res.status(403).json({ error: '仅管理员可查看审批历史' });
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      res.json({ ok: true, history: approvalManager.getHistory(limit) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V5 P1: Hook API ──
  app.get('/api/hooks', requireAuth, (_req, res) => {
    try { res.json({ ok: true, hooks: hookManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/hooks', requireAuth, (req, res) => {
    try {
      const { event, name, action, priority, filter } = req.body;
      if (!event || !name || !action) return res.status(400).json({ error: 'event/name/action 必填' });
      const hook = hookManager.register(event, name, action, priority || 0, filter);
      res.json({ ok: true, hook });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/hooks/:id', requireAuth, (req, res) => {
    try { hookManager.remove(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/hooks/:id/enable', requireAuth, (req, res) => {
    try { hookManager.setEnabled(String(req.params.id), req.body.enabled ?? true); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V5 P4: 技能 API ── 批次13a: 8条路由移交 src/routes/skills.ts
  app.use('/api', createSkillsRoutes({ skillManager } as any));
  app.use('/api', createRagRoutes({ router } as any)); // REST 6条(模块版自带requireAuth, 含移植的scan-workspace)
  // ── V5 P5: 渠道管理 API ── 批次13c: 11条路由移交 src/routes/channel.ts (4条管理带requireAuth, 7条webhook公网免锁)
  const channelCtx = { channelManager, router, manager, db, get telegramAdapter() { return telegramAdapter; } } as any;
  app.use('/api', createChannelRoutes(channelCtx));
  // 启动已配置的渠道 (模块版 startChannelAdapter, telegram分支带全局实例防重复检查)
  for (const ch of channelManager.getEnabledChannels()) {
    await startChannelAdapter(ch, channelCtx);
  }

  // ── V5 P7: 开发者模式 API ──
  // (已有上面的路由)

  // ── V5 P3: Vision 图片理解 API ──
  app.get('/api/vision/status', requireAuth, (_req, res) => {
    try { res.json({ ok: true, ...visionManager.getStatus() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/vision/analyze', requireAuth, async (req, res) => {
    try {
      const { image, mimeType, question } = req.body;
      if (!image) return res.status(400).json({ error: 'image 必填' });
      const result = await visionManager.analyze(image, mimeType || 'image/jpeg', question);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json({ ok: true, description: result.description });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V5 P2: 推送通知 API ──
  app.get('/api/push/status', requireAuth, (_req, res) => {
    try { res.json({ ok: true, ...pushManager.getStatus() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/push/vapid-key', requireAuth, (_req, res) => {
    try {
      const key = pushManager.getVapidPublicKey();
      if (!key) return res.json({ ok: true, available: false });
      res.json({ ok: true, available: true, vapidPublicKey: key });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/push/subscribe', requireAuth, (req, res) => {
    try {
      const { userId, endpoint, keys, platform } = req.body;
      if (!userId || !endpoint || !platform) return res.status(400).json({ error: 'userId/endpoint/platform 必填' });
      const sub = pushManager.subscribe(userId, { endpoint, keys, platform });
      res.json({ ok: true, id: sub.id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/push/:id', requireAuth, (req, res) => {
    try { pushManager.unsubscribe(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/push/send', requireAuth, async (req, res) => {
    try {
      const { userId, title, body, data } = req.body;
      if (!userId || !title) return res.status(400).json({ error: 'userId/title 必填' });
      const sent = await pushManager.sendToUser(userId, title, body, data);
      res.json({ ok: true, sent });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V5 P7: 开发者模式 API ──
  app.get('/api/dev/status', adminAuth, (_req, res) => {
    try { res.json({ ok: true, ...debugPanel.getStats() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V5 运行设置：超时 / 日志级别 / 调试开关（管理员可改，重启后仍从 env 读取）──
  app.get('/api/settings', requireAuth, (req, res) => {
    try {
      res.json({
        ok: true,
        settings: {
          orchestratorTimeoutSeconds: parseInt(process.env.ORCHESTRATOR_TIMEOUT_SECONDS || '120', 10),
          taskTimeoutSeconds: parseInt(process.env.TASK_TIMEOUT_SECONDS || '120', 10),
          chatTimeoutSeconds: parseInt(process.env.CHAT_TIMEOUT_SECONDS || '120', 10),
          logLevel: process.env.LOG_LEVEL || 'info',
          fileLogging: process.env.FILE_LOGGING !== 'false',
          devMode: process.env.DEV_MODE === 'true',
        }
      });
    } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/settings', requireAuth, (req, res) => {
    try {
      const body = req.body || {};
      // 超时设置：范围 10 秒 – 24 小时，保存时同步写入 .env 持久化（重启不丢失）
      if (typeof body.orchestratorTimeoutSeconds === 'number' && body.orchestratorTimeoutSeconds >= 10 && body.orchestratorTimeoutSeconds <= 86400) {
        process.env.ORCHESTRATOR_TIMEOUT_SECONDS = String(body.orchestratorTimeoutSeconds);
        persistEnvVar('ORCHESTRATOR_TIMEOUT_SECONDS', String(body.orchestratorTimeoutSeconds));
      }
      if (typeof body.taskTimeoutSeconds === 'number' && body.taskTimeoutSeconds >= 10 && body.taskTimeoutSeconds <= 86400) {
        process.env.TASK_TIMEOUT_SECONDS = String(body.taskTimeoutSeconds);
        persistEnvVar('TASK_TIMEOUT_SECONDS', String(body.taskTimeoutSeconds));
      }
      if (typeof body.chatTimeoutSeconds === 'number' && body.chatTimeoutSeconds >= 10 && body.chatTimeoutSeconds <= 86400) {
        process.env.CHAT_TIMEOUT_SECONDS = String(body.chatTimeoutSeconds);
        persistEnvVar('CHAT_TIMEOUT_SECONDS', String(body.chatTimeoutSeconds));
      }
      if (['debug','info','warn','error'].includes(body.logLevel)) {
        process.env.LOG_LEVEL = body.logLevel;
        logger.setLevel(body.logLevel);
      }
      if (typeof body.fileLogging === 'boolean') {
        process.env.FILE_LOGGING = String(body.fileLogging);
        logger.setFileLogging(body.fileLogging);
      }
      res.json({ ok: true, settings: {
        orchestratorTimeoutSeconds: parseInt(process.env.ORCHESTRATOR_TIMEOUT_SECONDS || '120', 10),
        taskTimeoutSeconds: parseInt(process.env.TASK_TIMEOUT_SECONDS || '120', 10),
        chatTimeoutSeconds: parseInt(process.env.CHAT_TIMEOUT_SECONDS || '120', 10),
        logLevel: process.env.LOG_LEVEL || 'info',
        fileLogging: process.env.FILE_LOGGING !== 'false',
      }});
    } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });

  app.post('/api/dev/enable', adminAuth, (req, res) => {
    try {
      debugPanel.setEnabled(req.body.enabled ?? true);
      debugPanel.setWSLog(req.body.wsLog ?? false);
      res.json({ ok: true, ...debugPanel.getStats() });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/dev/logs', adminAuth, (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const type = req.query.type as string;
      res.json({ ok: true, logs: debugPanel.getLogs(limit, type) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/dev/clear', adminAuth, (_req, res) => {
    try { debugPanel.clear(); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 管理面板"日志"卡片：读取磁盘上的真实运行日志（logger 按天切分的文件）
  // 安全：仅管理员可读，且对含 token/验证码/重置链接的行脱敏
  app.get('/api/logs', requireAuth, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 200, 2000);
      const content = logger.getTodayLog();
      const lines = content.split('\n').filter(Boolean).map((l: string) =>
        /token|验证码|重置|verify-email|reset-password/i.test(l)
          ? l.replace(/(token[:\s]*|验证码[:\s]*|链接[:\s]*)[^\s,，]+/gi, '$1***')
          : l
      );
      const logObjs = lines.map((l: string) => {
          const m = l.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(?:\[([^\]]+)\])?\s*(.*)$/);
          if (m) return { timestamp: m[1], level: (m[2]||'INFO').toLowerCase(), message: (m[3]?'['+m[3]+'] ':'')+(m[4]||l) };
          return { timestamp: '', level: 'info', message: l };
        });
        res.json({ ok: true, total: logObjs.length, logs: logObjs.slice(-limit), lines: lines.slice(-limit) });
    } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── V5 P3: 语音 API ──
  app.get('/api/voice/status', requireAuth, (_req, res) => {
    try {
      res.json({ ok: true, tts: ttsManager.getStatus(), stt: sttManager.getStatus() });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/voice/tts', requireAuth, async (req, res) => {
    try {
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: 'text 必填' });
      const result = await ttsManager.synthesize(text);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json({ ok: true, audio: result.audioBase64, mimeType: result.mimeType, duration: result.duration });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/voice/stt', requireAuth, async (req, res) => {
    try {
      const { audio, mimeType } = req.body;
      if (!audio) return res.status(400).json({ error: 'audio 必填' });
      const result = await sttManager.transcribe(audio, mimeType || 'audio/mpeg');
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.json({ ok: true, text: result.text, language: result.language });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  // ────────────────────────────────────────
  // WebSocket
  // ────────────────────────────────────────
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  // V10: WS 连接管理 — 用户 → 连接集合
  const clients = new Map<string, Set<WebSocket>>();

  // V10 安全修复：按 chatId 过滤广播，只推送给订阅了该聊天的客户端
  function broadcast(event: any) {
    const payload = JSON.stringify(event);
    const eventChatId = event.chatId;
    for (const [, set] of clients) {
      for (const ws of set) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        // 如果有 chatId，只发给订阅该 chat 的连接；无 chatId 的事件（online/offline）全局广播
        if (eventChatId) {
          const subs = wsSubscriptions.get(ws);
          if (!subs || !subs.has(eventChatId)) continue;
        }
        try { ws.send(payload); } catch (_e) { /* 连接已断开，跳过 */ }
      }
    }
  }

  wss.on('connection', (ws, req) => {
    const urlStr = req.url || '';
    const queryIndex = urlStr.indexOf('?');
    const params = queryIndex >= 0 ? new URLSearchParams(urlStr.slice(queryIndex + 1)) : new URLSearchParams();
    
    // V10 安全检查：验证 JWT token，拒绝未认证连接
    const token = params.get('token') || req.headers['sec-websocket-protocol'];
    let clientId: string | null = null;
    if (token) {
      try {
        const payload = auth.verifyAccessToken(token);
        if (payload) {
          clientId = payload.sub; // user-10003
        }
      } catch { /* token 无效，继续 fallback */ }
    }
    if (!clientId) {
      const devAnonId = params.get('id');
      const adminToken = process.env.ADMIN_TOKEN;
      // v2.0.7: 免登录连接仅限本地/内网来源（与 jwt-auth 中间件一致），公网必须携带 token
      const localOnly = isTrustedLocalSource(req as any);
      // v1.9.9: ADMIN_TOKEN 模式——配了 ADMIN_TOKEN 就允许免登录连接
      if (adminToken && devAnonId && localOnly) {
        clientId = devAnonId;
        console.log('[WS] ADMIN_TOKEN 模式免登录连接:', clientId);
      } else if (devAnonId && localOnly) {
        // v2.0.5: 个人本地引擎兜底——无 token 时始终允许连接（与 jwt-auth 中间件一致）
        clientId = devAnonId;
        console.log('[WS] 本地引擎免登录连接:', clientId);
      } else {
        console.warn('[WS] 拒绝未认证连接 - 缺少客户端 ID 或来源不受信任');
        ws.close(4001, '认证失败：请提供有效的 JWT token');
        return;
      }
    }
    console.log('[WS] connect:', clientId, token ? '(认证)' : '(开发模式匿名)');
    if (!clients.has(clientId)) clients.set(clientId, new Set());
    clients.get(clientId)!.add(ws);
    broadcast({ type: 'user.online', userId: clientId, message: clientId + ' 上线了' });
    // 自动为访客创建用户 + 聊天 + Agent（如果还没有）
    ensureUserSetup(clientId, db, manager, toolRegistry);
    ws.on('message', (raw) => {
      // 安全：任何畸形帧都不允许击穿到 uncaughtException（会导致整进程退出）
      try {
        handleWSMessage(raw, clientId, router, broadcast, ws);
      } catch (err: any) {
        console.error('[WS] 消息处理异常(已隔离):', clientId, err?.message);
        try { ws.send(JSON.stringify({ type: 'error', message: '消息格式错误: ' + (err?.message || err) })); } catch { /* ignore */ }
      }
    });
    ws.on('close', () => {
      const set = clients.get(clientId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clients.delete(clientId);
      }
      console.log('[WS] close:', clientId);
      broadcast({ type: 'user.offline', userId: clientId });
      try { getDB().run('UPDATE users SET status = ? WHERE id = ?', ['offline', clientId]); } catch {}
    });
    ws.on('error', (err) => {
      console.error('[WS] error:', clientId, err.message);
    });
  });

  setupDemoData(db, manager, toolRegistry);
  registerV17Routes(app, { aiHub });

  // ────────────────────────────────────────
  // 实例网格 (Instance Mesh) — 局域网/跨机多灵犀协作
  // ────────────────────────────────────────
  setupMesh({ db, manager, router, broadcast, dataDir } as any, port); // 批次12: mesh引擎+REST已移交 src/routes/misc.ts
  app.use('/api', createMeshRoutes({ db, manager, router, broadcast, dataDir } as any)); // REST 4条(模块版自带requireAuth)






  app.post('/api/ratings', requireAuth, (req, res) => {
    try {
      const { messageId, userId, rating, comment } = req.body || {};
      if (!messageId || !userId || !rating) return res.status(400).json({ error: 'messageId/userId/rating 必填' });
      if (rating < 1 || rating > 5) return res.status(400).json({ error: '评分 1-5' });
      const id = 'rating-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const stmt = getDB().prepare('INSERT INTO message_ratings (id, message_id, user_id, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      stmt.bind([id, messageId, userId, rating, comment || null, Date.now()]);
      stmt.step(); stmt.free();
      res.json({ ok: true, id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/ratings', requireAuth, (req, res) => {
    try {
      const userId = req.query.userId as string;
      const stmt = getDB().prepare('SELECT * FROM message_ratings WHERE user_id = ? ORDER BY created_at DESC LIMIT 50');
      stmt.bind([userId]);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json({ ok: true, ratings: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });







  // ── 系统升级 API（git pull + pm2 重启）──
  app.post('/api/update', requireAuth, async (req, res) => {
    try {
      const jwtUser = (req as any).user;
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      if (!isAdmin) return res.status(403).json({ error: '仅管理员可执行升级' });
      if (!existsSync(join(process.cwd(), '.git'))) {
        return res.json({ ok: false, error: '当前部署不是 git 仓库，无法自动升级' });
      }
      const { execSync } = await import('child_process');
      const out = execSync('git pull --ff-only', { cwd: process.cwd(), timeout: 120000, encoding: 'utf8' });
      console.log('[Update] git pull 完成:', String(out).slice(0, 500));
      res.json({ ok: true, output: String(out).slice(0, 1000) });
      // 延迟 1.5s 触发 pm2 重启，确保响应先返回
      setTimeout(async () => {
        try {
          const { exec } = await import('child_process');
          exec('npx pm2 restart lingxi', { cwd: process.cwd() });
        } catch (e: any) { console.error('[Update] pm2 重启失败:', e?.message || e); }
      }, 1500);
    } catch (err: any) {
      res.status(500).json({ error: '升级失败: ' + (err?.message || err) });
    }
  });


  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[FATAL] 端口 ${port} 在启动时被占用。请用 --port 指定其他端口，或加 --auto-port 自动顺延。`);
      process.exit(1);
    }
    throw err;
  });

  // P1-6: 请求 ID 中间件 — 为每个请求分配唯一 ID，便于链路追踪
  app.use((req: any, _res: any, next: any) => {
    req.requestId = 'req_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    next();
  });

  // P1-4: 挂载 404 fallback + 全局错误 handler
  app.use(notFoundHandler);
  app.use(errorHandler({
    logger: (err: unknown, ctx: any) => {
      logger.error('Express', 'Unhandled error: ' + ((err as Error)?.message || String(err)) + ' | ctx=' + JSON.stringify(ctx));
    },
  }));

  
// ── v2.0.13: Express 全局错误处理中间件（畸形 JSON 等返回 400 而非 500 Unhandled）──
app.use((err: any, _req: any, res: any, _next: any) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    console.warn('[Express] 拒绝畸形请求体:', err.message?.slice(0, 120));
    res.status(400).json({ error: '请求体格式错误（JSON 无效）' });
    return;
  }
  console.error('[Express] Unhandled error:', err?.message || err, '| ctx=', _req?.path ? { path: _req.path, method: _req.method } : '');
  res.status(500).json({ error: '服务器内部错误' });
});
server.listen(port, '0.0.0.0', () => {
    console.log('');
    console.log('=== 灵犀引擎 V5 已就绪 ===');
    console.log(' HTTP: http://localhost:' + port);
    console.log(' WS: ws://localhost:' + port + '/ws');
    console.log(' 数据目录: ' + dataDir + (getInstanceId() ? ' | 实例: ' + getInstanceId() : ''));
    console.log(' Demo: user-shen | user-wang');
    console.log('');
    console.log(' [V4] AI: ' + aiHub.listModels().length + ' 模型 | Cron: ' + cronScheduler.listJobs().length + ' | Sessions | SubAgent | Telegram:' + (telegramAdapter ? '✅' : '❌'));
    console.log(' [V4] Providers: ' + providerRegistry.list().length + ' | MCP: ' + mcpManager.listServers().length + ' | Browser: ' + (browserAvailable ? '✅' : '❌') + ' | Plugins: ' + pluginManager.size);
    console.log(' [V5] Approval: ' + approvalManager.getPending().length + ' 待审批 | Hooks: ' + hookManager.list().length + ' | Inbox: ' + inboxManager.unreadCount() + ' 未读');
    console.log(' [V5] Skills: ' + skillManager.list().length + ' 已安装 | Channels: ' + channelManager.list().length + ' 已配置');
    console.log('');
    console.log(' API: /api/inbox | /api/approval | /api/hooks | /api/skills | /api/channels | /api/cron | /api/sessions | /api/subagents | /api/providers | /api/mcp');
    console.log('========================');
    console.log('');
  });

  // ═══ 优雅退出（统一 SIGINT/SIGTERM，防止 PM2 重启丢上下文）═══
  let _shuttingDown = false;
  const gracefulExit = async (sig: string) => {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`\n[Shutdown] 收到 ${sig}，开始优雅退出...`);
    try { cronScheduler.stop(); } catch(_e) {}
    try { sessionManager.close(); console.log('[Shutdown] 会话已保存'); } catch(_e) {}
    try { telegramAdapter?.stop(); } catch(_e) {}
    try { await channelManager.closeAll(); } catch(_e) {}
    try { await browserManager.close(); } catch(_e) {}
    try { await mcpManager.closeAll(); } catch(_e) {}
    try { await saveToDisk(); console.log('[Shutdown] 数据库已保存'); } catch (e: any) { console.error('[Shutdown] DB保存失败:', e.message); }
    try { await closeDB(dbPath); console.log('[Shutdown] 数据库已关闭'); } catch(_e) {}
    try { server.close(); } catch(_e) {}
    console.log('[Shutdown] 退出完成');
    process.exit(0);
  };
  process.on('SIGINT', () => gracefulExit('SIGINT'));
  process.on('SIGTERM', () => gracefulExit('SIGTERM'));
}

/**
 * 探测端口是否可用；autoPort 为 true 时被占用则自动 +1 顺延（最多 20 次）。
 * 用于单机多实例共存，避免 EADDRINUSE 直接崩溃。
 */
async function resolveAvailablePort(startPort: number, autoPort: boolean): Promise<number> {
  const { createServer } = await import('net');
  const probe = (p: number) => new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(p, '0.0.0.0');
  });

  let p = startPort;
  for (let i = 0; i < (autoPort ? 20 : 1); i++) {
    if (await probe(p)) {
      if (p !== startPort) console.log(`[Port] ${startPort} 被占用，自动改用 ${p}`);
      return p;
    }
    if (!autoPort) break;
    p++;
  }
  console.error(`[FATAL] 端口 ${startPort} 已被占用。`);
  console.error(`  - 换端口: node index.ts --port ${startPort + 1}`);
  console.error(`  - 或自动顺延: node index.ts --auto-port`);
  console.error(`  - 多实例还需隔离数据: --data-dir data2`);
  process.exit(1);
}

function setupDemoData(db: any, manager: any, toolRegistry?: any) {
  // 重启后重新绑定技能（ToolRegistry 是内存的，重启后空了）
  if (toolRegistry) {
    const agents = db.listAgents();
    for (const agent of agents) {
      toolRegistry.bindSkills(agent.id || agent.agent_id, ['general-assistant']);
    }
    if (agents.length > 0) console.log('[Tools] ' + agents.length + ' 个 Agent 已重新绑定通用助手技能');
  }
}

// 访客连接时自动创建专属用户 + 聊天 + Agent
function ensureUserSetup(clientId: string, db: any, manager: any, toolRegistry?: any) {
  try {
    const existing = db.getUser(clientId);
    if (existing) {
      // 用户已存在：更新状态为在线 + 补 numeric_id
      try {
        const raw = getDB();
        if (!existing.numeric_id) {
          const ms = raw.prepare('SELECT MAX(numeric_id) as m FROM users WHERE numeric_id IS NOT NULL'); ms.step(); const max = ms.getAsObject().m || 9999; ms.free();
          raw.run('UPDATE users SET numeric_id = ?, display_name = CASE WHEN display_name = "访客" OR display_name IS NULL THEN ? ELSE display_name END WHERE id = ?', [max + 1, '用户' + (max + 1), clientId]);
        }
        raw.run('UPDATE users SET status = ?, last_active_at = ? WHERE id = ?', ['online', Date.now(), clientId]);
      } catch {}
      const chats = db.listChats();
      const userChats = chats.filter((c: any) => {
        const ps = db.getChatParticipants(c.id);
        return ps.some((p: any) => p.user_id === clientId);
      });
      if (userChats.length > 0) return;
      // 用户存在但没有聊天，创建一个
      const agent = manager.register(clientId, 'AI助手', '你是一个友好实用的AI助手，可帮用户查信息、回答问题、搜索资料。文件操作在安全沙箱内进行。shell_exec仅在沙箱开启且命令在白名单内时才可用。', 'semi');
      const chatId = 'chat-' + clientId;
      db.createChat(chatId, 'private');
      db.addParticipant('p-' + clientId + '-user', chatId, clientId, undefined, 'owner');
      db.addParticipant('p-' + clientId + '-agent', chatId, undefined, agent.id, 'agent');
      if (toolRegistry) toolRegistry.bindSkills(agent.id, ['general-assistant']);
      console.log('[Auto] 为已有用户创建聊天:', clientId);
      return;
    }
    // 全新用户
    const raw = getDB();
    const ms = raw.prepare('SELECT MAX(numeric_id) as m FROM users WHERE numeric_id IS NOT NULL'); ms.step(); const maxId = ms.getAsObject().m || 9999; ms.free();
    const nextId = maxId + 1;
    db.createUser(clientId, '用户' + nextId);
    raw.run('UPDATE users SET numeric_id = ?, status = ?, display_name = ? WHERE id = ?', [nextId, 'online', '用户' + nextId, clientId]);
    const agent = manager.register(clientId, 'AI助手', '你是一个友好实用的AI助手，可帮用户查信息、回答问题、搜索资料。文件操作在安全沙箱内进行。shell_exec仅在沙箱开启且命令在白名单内时才可用。', 'semi');
    const chatId = 'chat-' + clientId;
    db.createChat(chatId, 'private');
    db.addParticipant('p-' + clientId + '-user', chatId, clientId, undefined, 'owner');
    db.addParticipant('p-' + clientId + '-agent', chatId, undefined, agent.id, 'agent');
    if (toolRegistry) toolRegistry.bindSkills(agent.id, ['general-assistant']);
    console.log('[Auto] 新用户就绪:', clientId, '数字ID:', nextId);
  } catch (err: any) {
    console.error('[Auto] 用户设置失败:', clientId, err.message || err);
  }
}

main().catch((err: any) => {
  console.error('启动失败:', err);
  process.exit(1);
});


