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
import { randomInt, timingSafeEqual, randomBytes } from 'crypto';
import * as path from 'path';
import { join } from 'path';
import multer from 'multer';
import { initDB, getDB, closeDB, DB, startAutoSave, saveToDisk, initNumericIdSeq, cleanupExpiredTokens, createInviteCode, listInviteCodes, updateAgent, getChatMode, setChatMode, CHAT_MODES, nextNumericId, getUserCredits, addCredits, spendCredits, getCreditHistory, createHire, fireHire, listHiresByBuyer, listHiresBySeller, getHire, createChat, addParticipant, removeParticipant, getAgentByUserId, deleteFriendshipByPair, syncAgentToPrivateChats } from './src/storage/db.js';
import { initGoalTrackerTable, GoalTracker } from './src/core/goal-tracker.js';
import type { ProjectGoal } from './src/core/goal-tracker.js';

import * as auth from './src/auth/index.js';
import { adminAuth } from './src/middleware/admin-auth.js';
import { jwtAuth, isTrustedLocalSource } from './src/middleware/jwt-auth.js';
import { apiRateLimit, authRateLimit } from './src/middleware/rate-limit.js';
import { MessageRouter } from './src/core/router.js';
import { AIHub } from './src/ai/hub.js';
import { AgentManager } from './src/agents/manager.js';
import { handleWSMessage, wsSubscriptions, processUserMessage } from './src/core/ws-handler.js';
import { startInstanceMesh, setPeerMessageHandler, setPeerTaskHandler, sendPeerMessage, getMeshInfo, getInstanceId, type PeerMessage } from './src/core/instance-mesh.js';
import { startLanDiscovery, stopLanDiscovery, getLanPeers, getLanSelfInfo, getLanInstanceId, getLanIp, type LanUser } from './src/net/lan-discovery.js';
import { verifyLanRequest } from './src/net/lan-transport.js';
import { LanSocialHub, LAN_SOCIAL_CHANNEL } from './src/net/lan-social.js';
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
import { DiscordAdapter, type DiscordConfig } from './src/channels/discord.js';
import { SlackAdapter, type SlackConfig } from './src/channels/slack.js';
import { WeChatAdapter, type WeChatConfig } from './src/channels/wechat.js';
import { FeishuAdapter, type FeishuConfig } from './src/channels/feishu.js';
import { QQBotAdapter, type QQBotConfig } from './src/channels/qqbot.js';
import { WhatsAppAdapter, type WhatsAppConfig } from './src/channels/whatsapp.js';
import { SignalAdapter, type SignalConfig } from './src/channels/signal.js';
import { IMessageAdapter, type IMessageConfig } from './src/channels/imessage.js';
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
import { createMiscRoutes } from './src/routes/misc.js';
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
        console.log(`[ProviderSync] 恢复 → AIHub: ${p.id} (${p.models.length} 模型)`);
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
        version: (process.env.npm_package_version) || '2.0.12',
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
  // ── 认证接口限流 ──
  app.use('/api/auth', authRateLimit);
  // ── v2.0.4: 通用 API 限流（30次/分钟）──
  app.use('/api', apiRateLimit);

  // ════════════════════════════════════════════════
  // ── V7 认证路由（持久身份：邮箱+密码+数字ID+JWT） ──
  // ════════════════════════════════════════════════

  // ── V7: 注册（邮箱 + 密码 + 数字 ID） ──
  app.post('/api/auth/register', authRateLimit, async (req, res) => {
    try {
      const { email, password, display_name, invite_code, agent_binding } = req.body;
      const result = auth.register({
        email, password, displayName: display_name, inviteCode: invite_code,
        agentBinding: agent_binding || 'skip',
      });
      // 注册成功后自动登录并签发 token，前端无需再次登录
      let tokens: any = {};
      try { tokens = await auth.loginWithEmail(email, password); } catch (_e) {}
      // 如果选了 auto_default，自动创建灵犀引擎
      if (agent_binding === 'auto_default' && result.user) {
        try {
          const agent = manager.register(result.user.id, display_name + '的灵犀引擎', display_name + ' 的 AI 助手', 'semi');
          if (defaultModel) {
            try { manager.update(agent.id, { model: defaultModel, modelSource: 'local' }); } catch(_e) {}
          }
          res.json({ ok: true, user: result.user, agent, ...tokens });
        } catch (ae: any) {
          res.json({ ok: true, user: result.user, agentError: ae.message, ...tokens });
        }
      } else {
        res.json({ ok: true, user: result.user, ...tokens });
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 邮箱验证 ──
  app.get('/api/auth/verify-email', (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.status(400).json({ error: '缺少 token' });
      const result = auth.verifyEmail(token);
      res.json({ ok: true, message: '邮箱验证成功', userId: result.userId, email: result.email });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 登录（邮箱 + 密码） ──
  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
      const result = await auth.loginWithEmail(email, password);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  });

  // ── V7: 登录（数字 ID + 密码） ──
  app.post('/api/auth/login-by-id', (req, res) => {
    try {
      const { numeric_id, password } = req.body;
      if (!numeric_id || !password) return res.status(400).json({ error: '数字ID和密码必填' });
      const result = auth.loginWithNumericId(Number(numeric_id), password);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  });

  // ── V7: 忘记密码（防枚举，总是 200） ──
  app.post('/api/auth/forgot-password', (req, res) => {
    try {
      const { email } = req.body;
      if (!email || !email.includes('@')) return res.status(400).json({ error: '请输入有效的邮箱' });
      auth.forgotPassword(email);
      res.json({ ok: true, message: '如果该邮箱已注册，重置链接已发送' });
    } catch (err: any) {
      res.json({ ok: true, message: '如果该邮箱已注册，重置链接已发送' });
    }
  });

  // ── V7: 重置密码 ──
  app.post('/api/auth/reset-password', (req, res) => {
    try {
      const { token, new_password } = req.body;
      auth.resetPassword(token, new_password);
      res.json({ ok: true, message: '密码已重置，请重新登录' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 刷新 token ──
  app.post('/api/auth/refresh', (req, res) => {
    try {
      const { refresh_token } = req.body;
      if (!refresh_token) return res.status(400).json({ error: '缺少 refresh_token' });
      const result = auth.refreshAccessToken(refresh_token);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(401).json({ error: err.message });
    }
  });

  // ── V7: 注销 ──
  app.post('/api/auth/logout', jwtAuth({ required: true }), (req, res) => {
    try {
      const sid = (req as any).user?.sid;
      const uid = (req as any).user?.sub;
      if (sid) auth.logout(sid);
      // 登出时设置用户状态为 offline
      if (uid) {
        try { getDB().run('UPDATE users SET status = ?, last_active_at = ? WHERE id = ?', ['offline', Date.now(), uid]); } catch {}
        try { broadcast({ type: 'user.offline', userId: uid }); } catch {}
      }
      res.json({ ok: true, message: '已注销' });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── V7: 当前用户信息（需 JWT） ──
  app.get('/api/auth/me', jwtAuth({ required: true }), (req, res) => {
    const user = { ...(req as any).user };
    const platformApiUrl = (globalThis as any).__platformApiUrl || '';
    const platformAdminToken = (globalThis as any).__platformAdminToken || '';

    // 情况 1: 平台 admin-auto 模式（未登录，使用平台 admin 身份）
    if (user.sid === 'platform-admin') {
      const pa = (globalThis as any).__platformAdminUser;
      if (pa) {
        user.id = String(pa.id);
        user.display_name = pa.username;
        user.username = pa.username;
        user.numeric_id = pa.id;
        user.email = pa.email || '';
        user.points = pa.points;
        user.status = pa.status || 'active';
        user.role = pa.role || 'admin';
      }
      return res.json({ ok: true, user });
    }

    // 情况 2: 平台 JWT（用户通过平台登录，payload 含 id/username/role）
    if (user.id && !user.sub) {
      // 这是平台签发的 JWT，补全字段
      user.sub = String(user.id);
      user.numeric_id = Number(user.id);
      user.sid = user.sid || 'platform';
      user.roles = user.roles || [user.role || 'user'];
      // 从平台 API 获取最新用户信息
      if (platformApiUrl) {
        (async () => {
          try {
            const resp = await fetch(`${platformApiUrl}/api/user/${user.id}`);
            const d = await resp.json() as any;
            if (d.ok && d.user) {
              user.username = d.user.username;
              user.display_name = d.user.username;
              user.email = d.user.email || '';
              // 补充积分等信息
              if (platformAdminToken) {
                try {
                  const ar = await fetch(`${platformApiUrl}/api/admin/users/${user.id}?token=${platformAdminToken}`);
                  const ad = await ar.json() as any;
                  if (ad.ok && ad.user) {
                    user.points = ad.user.points;
                    user.status = ad.user.status;
                  }
                } catch(_e) {}
              }
            }
          } catch(_e) {}
          // 确保 main.db 中有对应的本地记录（用于聊天引用）
          try {
            const localId = String(user.id);
            const existing = db.getUser(localId);
            if (!existing && user.username) {
              db.createUser(localId, user.username);
              const raw2 = getDB();
              raw2.run('UPDATE users SET numeric_id = ?, status = ? WHERE id = ?', [Number(user.id), 'online', localId]);
              saveToDisk();
            } else if (existing && user.username && existing.display_name !== user.username) {
              // 修复: 同步云平台最新 display_name 到本地数据库，避免刷新后回退为"用户+nid"
              const raw2 = getDB();
              raw2.run('UPDATE users SET display_name = ?, status = ? WHERE id = ?', [user.username, 'online', localId]);
              saveToDisk();
            }
          } catch(_e) {}
          // 注册到 Mesh 平台（让其他实例能找到此用户）
          try {
            const meshUrl = process.env.MESH_PLATFORM_URL || '';
            const meshTok = process.env.MESH_TOKEN || '';
            if (meshUrl && meshTok && user.numeric_id) {
              fetch(meshUrl.replace(/\/$/, '') + '/api/users/register', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + meshTok, 'Content-Type': 'application/json' },
                body: JSON.stringify({ instanceId: getInstanceId(), numericId: Number(user.numeric_id), displayName: user.username || user.display_name || '', email: user.email || '', userId: String(user.id) }),
              }).catch(() => {});
            }
          } catch(_e) {}
          res.json({ ok: true, user });
        })();
      } else {
        res.json({ ok: true, user });
      }
      return;
    }

    // 情况 3: 引擎本地 JWT（admin-auto 回退模式或本地注册用户）
    try {
      const dbUser = db.getUser(user.sub || user.id || '');
      if (dbUser) {
        user.id = dbUser.id;
        user.display_name = dbUser.display_name;
        user.numeric_id = dbUser.numeric_id;
        user.email = dbUser.email;
        user.username = dbUser.username;
        user.status = dbUser.status;
        user.avatar_url = dbUser.avatar_url || '';
        user.bio = dbUser.bio || '';
        user.email_verified = !!dbUser.email_verified;
      }
    } catch(_e) {}
    // 兜底: 从 sub 取 id
    if (!user.id && user.sub) user.id = String(user.sub);
    res.json({ ok: true, user });
  });

  // ── V7: Admin 管理接口 ──
  app.use('/api/admin/*', adminAuth);
  app.post('/api/admin/invite-codes', (req, res) => {
    try {
      const { code, max_uses, expires_at } = req.body;
      if (!code) return res.status(400).json({ error: '缺少 code' });
      createInviteCode(code, 'admin', max_uses || 1, expires_at ? Number(expires_at) : undefined);
      res.json({ ok: true, code });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });
  app.get('/api/admin/invite-codes', (_req, res) => {
    res.json({ ok: true, codes: listInviteCodes() });
  });

  // ── 旧版兼容：验证码发送（保留 demo 模式） ──
  app.post('/api/auth/send-code', (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }
    const code = String(randomInt(100000, 1000000));
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const username = req.body.username;
    verificationCodes.set(email, { email, code, username, expiresAt });
    console.log('[Auth] 验证码已生成:', email, '(已脱敏)');
    res.json({ ok: true, message: '验证码已生成', expiresIn: 300 });
  });

  // ── 旧版兼容：验证码注册（保留 demo 模式） ──
  app.post('/api/auth/register-with-email', (req, res) => {
    try {
      const { email, code, username } = req.body;
      if (!email || !code) return res.status(400).json({ error: '邮箱和验证码必填' });
      const stored = verificationCodes.get(email);
      if (!stored) return res.status(400).json({ error: '请先获取验证码' });
      if (Date.now() > stored.expiresAt) {
        verificationCodes.delete(email);
        return res.status(400).json({ error: '验证码已过期，请重新获取' });
      }
      // P0-4 修复: 验证码尝试次数检查
      const attempts = verificationAttempts.get(email);
      if (attempts && Date.now() - attempts.firstAttempt < ATTEMPT_WINDOW) {
        if (attempts.count >= MAX_CODE_ATTEMPTS) {
          return res.status(429).json({ error: '验证码尝试次数过多，请稍后再试' });
        }
        attempts.count++;
      } else {
        verificationAttempts.set(email, { count: 1, firstAttempt: Date.now() });
      }
      if (stored.code !== code) return res.status(400).json({ error: '验证码错误' });
      // 验证成功，清除尝试计数
      verificationAttempts.delete(email);
      verificationCodes.delete(email);
      const localPart = email.split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const numericId = nextNumericId(); const userId = String(numericId);
      const displayName = username || stored.username || localPart;
      const user: User = db.createUser(userId, displayName);
      const agent = manager.register(userId, displayName + '的AI', displayName + ' 的 AI 助手', 'semi');
      if (defaultModel) {
        try { manager.update(agent.id, { model: defaultModel, modelSource: 'local' }); } catch(_e) {}
      }
      res.json({ ok: true, user, agent });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── 旧版用户名注册（兼容） ──
  // P0-3 修复: 添加 requireAuth，防止无鉴权无限创建用户
  app.post('/api/users/register', requireAuth, (req, res) => {
    const { displayName, username } = req.body;
    const name = username || displayName;
    if (!name) return res.status(400).json({ error: '用户名不能为空' });
    const numericId = nextNumericId(); const id = String(numericId);
    const user: User = db.createUser(id, name);
    res.json({ ok: true, user });
  });

  app.post('/api/agents/register', requireAuth, (req, res) => {
    try {
      const { userId, displayName, personality, autonomy } = req.body;
      if (!userId || !displayName) return res.status(400).json({ error: 'userId 和 displayName 必填' });
      // P0-5 修复: 越权防护 — 校验 userId 是否为 JWT 持有者
      const jwtUser = (req as any).user;
      const jwtUserId = jwtUser?.sub || jwtUser?.id || '';
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      if (jwtUserId && jwtUserId !== userId && jwtNumericId !== userId) {
        return res.status(403).json({ error: '无权为他人创建 agent' });
      }
      const agent = manager.register(userId, displayName, personality || '你是一个友好的 AI 助手', autonomy || 'semi');
      // 新 agent 补到已有私聊
      try {
        const synced = syncAgentToPrivateChats(userId);
        if (synced > 0) console.log('[Friends] agent synced to', synced, 'private chats');
      } catch(_e) {}
      res.json({ ok: true, agent });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── 好友系统 ──
  app.get('/api/users', requireAuth, (req, res) => {
    try {
      const keyword = (req.query.q as string) || '';
      // P1-1: require query param to prevent user enumeration
      if (!keyword || keyword.trim().length < 2) {
        return res.status(400).json({ error: '请提供至少2个字符的搜索关键词' });
      }
      const users = db.searchUsers(keyword, 50);
      res.json({ ok: true, users: users.map((u: any) => ({ id: u.id, numericId: u.numeric_id, displayName: u.display_name })) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 按 numeric_id 精确查找用户 ──
  app.get('/api/users/by-id', requireAuth, (req, res) => {
    try {
      const numericId = parseInt(req.query.numericId as string);
      if (isNaN(numericId)) return res.status(400).json({ error: '无效的 numericId' });
      const raw = getDB();
      const s = raw.prepare('SELECT id, numeric_id, display_name, email, status FROM users WHERE numeric_id = ?');
      s.bind([numericId]);
      let user = null;
      if (s.step()) { user = s.getAsObject(); }
      s.free();
      if (!user) return res.status(404).json({ error: '用户不存在' });
      res.json({ ok: true, user: { id: user.id, numericId: user.numeric_id, displayName: user.display_name, email: user.email, status: user.status } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/friends/request', requireAuth, (req, res) => {
    try {
      const { fromUserId, toUserId, message } = req.body;
      if (!fromUserId || !toUserId) return res.status(400).json({ error: 'fromUserId 和 toUserId 必填' });
      if (fromUserId === toUserId) return res.status(400).json({ error: '不能添加自己为好友' });
      // P0-4: verify sender is JWT holder
      const jwtUser = (req as any).user;
      const jwtUserId = jwtUser?.sub || jwtUser?.id || '';
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      if (jwtUserId && jwtUserId !== fromUserId && jwtNumericId !== fromUserId) {
        return res.status(403).json({ error: '无权替他人发送好友请求' });
      }
      const result = db.sendFriendRequest(fromUserId, toUserId, message || '');
      if (result.error) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/friends/respond', requireAuth, (req, res) => {
    try {
      const { requestId, action } = req.body;
      if (!requestId || !action) return res.status(400).json({ error: 'requestId 和 action 必填' });
      if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action 只能是 accept 或 reject' });
      // P0-5: verify current user is the receiver (v5-P1-A: fail-closed)
      const jwtUser5 = (req as any).user;
      const jwtUserId5 = jwtUser5?.sub || jwtUser5?.id || '';
      const jwtNumericId5 = String(jwtUser5?.numeric_id || '');
      const sid5 = String(jwtUser5?.sid || '');
      const isBootstrap5 = sid5 === 'admin-auto' || sid5 === 'platform-admin' || sid5 === 'admin-token' || jwtUserId5 === 'admin';
      if (jwtUserId5 && !isBootstrap5) {
        try {
          const raw5 = getDB();
          const stmt5 = raw5.prepare('SELECT to_user_id FROM friendships WHERE id = ?');
          stmt5.bind([requestId]);
          let toId5 = '';
          if (stmt5.step()) { const r5 = stmt5.getAsObject() as any; toId5 = r5.to_user_id; }
          stmt5.free();
          if (!toId5) return res.status(403).json({ error: '好友请求不存在或无权处理' });
          if (toId5 !== jwtUserId5 && toId5 !== jwtNumericId5) {
            return res.status(403).json({ error: '无权处理他人的好友请求' });
          }
        } catch(_e5) {
          return res.status(403).json({ error: '无法验证好友请求归属' });
        }
      }
      const result = db.respondFriendRequest(requestId, action);
      if (result.error) return res.status(400).json(result);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/friends/requests', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      // P1-2: verify userId is JWT holder
      const jwtUser2 = (req as any).user;
      const jwtUserId2 = jwtUser2?.sub || jwtUser2?.id || '';
      const jwtNumericId2 = String(jwtUser2?.numeric_id || '');
      const sid2 = String(jwtUser2?.sid || '');
      // v2.1.3: admin-auto/admin-token 本地免登录模式下 sub='admin' 是虚拟身份，跳过一致性检查
      const isLocalAuto2 = (sid2 === 'admin-auto' || sid2 === 'admin-token');
      if (jwtUserId2 && !isLocalAuto2 && jwtUserId2 !== userId && jwtNumericId2 !== userId) {
        return res.status(403).json({ error: '无权查看他人的好友请求' });
      }
      res.json({ ok: true, ...db.getFriendRequests(userId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/friends/list', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      // P1-2: verify userId is JWT holder
      const jwtUser3 = (req as any).user;
      const jwtUserId3 = jwtUser3?.sub || jwtUser3?.id || '';
      const jwtNumericId3 = String(jwtUser3?.numeric_id || '');
      const sid3 = String(jwtUser3?.sid || '');
      // v2.1.3: admin-auto/admin-token 本地免登录模式下 sub='admin' 是虚拟身份，跳过一致性检查
      const isLocalAuto3 = (sid3 === 'admin-auto' || sid3 === 'admin-token');
      if (jwtUserId3 && !isLocalAuto3 && jwtUserId3 !== userId && jwtNumericId3 !== userId) {
        return res.status(403).json({ error: '无权查看他人的好友列表' });
      }
      res.json({ ok: true, friends: db.listFriends(userId) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 删除好友 ──
  app.delete('/api/friends/:id', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      const friendId = String(req.params.id || '');
      if (!userId || !friendId) return res.status(400).json({ error: 'userId 和 friendId 必填' });
      // P0-1 修复: 越权防护 — 校验 userId 是否为 JWT 持有者
      const jwtUser = (req as any).user;
      const jwtUserId = jwtUser?.sub || jwtUser?.id || '';
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      if (jwtUserId && jwtUserId !== userId && jwtNumericId !== userId) {
        return res.status(403).json({ error: '无权操作他人好友关系' });
      }
      // 使用 DB 封装函数，自动处理 chatId 排序一致性
      deleteFriendshipByPair(userId, friendId);
      res.json({ ok: true, message: '好友已删除' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── 聊天 & 参与者 API ──
  app.post('/api/chats', requireAuth, (req, res) => {
    try {
      const { id, type } = req.body;
      if (!id) return res.status(400).json({ error: 'id 必填' });
      const chat = db.createChat(id, type || 'private');
      res.json({ ok: true, chat });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) return res.json({ ok: true, exists: true });
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/participants', requireAuth, (req, res) => {
    try {
      const { id, chatId, userId, agentId, role } = req.body;
      if (!id || !chatId) return res.status(400).json({ error: 'id 和 chatId 必填' });
      // P1-4 修复: 身份伪造防护 — userId 必须为 JWT 持有者
      // ⭐ v2.1.2 修复 F5 会话消失：admin-auto（本地免登录）模式下 sub='admin' 是虚拟身份，
      //    与前端的 clientId（u-xxx）永远不匹配 → participant 写入被 403 拒绝 → 会话列表空白。
      //    本地免登录（sid='admin-auto'）时跳过一致性检查，允许写入。
      const jwtUser = (req as any).user;
      const jwtSid = String(jwtUser?.sid || '');
      const jwtSub = String(jwtUser?.sub || '');
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      const isLocalAuto = (jwtSid === 'admin-auto' || jwtSid === 'admin-token');
      if (userId && !isLocalAuto) {
        const reqUid = String(userId);
        if (jwtSub && reqUid !== jwtSub && reqUid !== jwtNumericId) {
          return res.status(403).json({ error: '无权以他人身份加入群聊' });
        }
      }
      // 角色白名单: 只允许 member/owner
      const allowedRoles = ['member', 'owner'];
      const finalRole = allowedRoles.includes(role) ? role : 'member';
      db.addParticipant(id, chatId, userId, agentId, finalRole);
      res.json({ ok: true });
    } catch (err: any) {
      if (err.message?.includes('UNIQUE')) return res.json({ ok: true, exists: true });
      res.status(500).json({ error: err.message });
    }
  });



  // ── 跨平台好友聊天：通过 Mesh 发送消息给好友实例 ──
  app.post('/api/chats/:id/send-friend', requireAuth, async (req, res) => {
    try {
      const chatId = req.params.id as string;
      const content = req.body?.content;
      const fromUserId = req.body?.fromUserId || req.user?.numeric_id || (req.user as any)?.id;
      // P0-2 修复: 身份伪造防护 — 校验 fromUserId 是否为 JWT 持有者
      if (req.body?.fromUserId) {
        const jwtUser = (req as any).user;
        const jwtUserId = String(jwtUser?.sub || jwtUser?.id || '');
        const jwtNumericId = String(jwtUser?.numeric_id || '');
        const reqFromId = String(req.body.fromUserId);
        if (jwtUserId && jwtUserId !== reqFromId && jwtNumericId !== reqFromId) {
          return res.status(403).json({ error: '无权以他人身份发送消息' });
        }
      }
      // Fix 3: 去掉 chat-platform- 前缀限制，支持所有好友私聊
      if (!content) return res.status(400).json({ error: 'content 必填' });

      // P1-3: verify current user is chat participant
      const jwtUser4 = (req as any).user;
      const jwtUserId4 = String(jwtUser4?.sub || jwtUser4?.id || '');
      const jwtNumericId4 = String(jwtUser4?.numeric_id || '');
      const parts = db.getChatParticipants(chatId);
      if (jwtUserId4 && parts.length > 0) {
        const isMember = parts.some((p: any) => String(p.user_id) === jwtUserId4 || String(p.user_id) === jwtNumericId4);
        if (!isMember) {
          return res.status(403).json({ error: '无权向此聊天发送消息' });
        }
      }
      const friendParticipant = parts.find((p: any) => String(p.user_id) !== String(fromUserId));
      if (!friendParticipant) return res.status(400).json({ error: '无法确定好友' });

      const friendUserId = String(friendParticipant.user_id);
      const friendNumericId = Number(friendUserId);

      // 本地用户（同一实例内好友）：直接落库 + 广播，无需走 Mesh
      if (!friendNumericId || isNaN(friendNumericId)) {
        const localFriend = db.listUsers().find((u: any) => u.id === friendUserId);
        if (!localFriend) return res.status(404).json({ error: '好友用户不存在（ID: ' + friendUserId + '）' });
        const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        db.addMessage({ id: msgId, chatId, senderType: 'user', senderId: String(fromUserId), content, type: 'text', timestamp: Date.now() });
        broadcast({ type: 'message.new', chatId, from: String(fromUserId), senderId: String(fromUserId), senderType: 'user', content, timestamp: Date.now() });
        return res.json({ ok: true, local: true });
      }

      // 跨实例好友：走 Mesh 中继
      const _meshUrl = process.env.MESH_PLATFORM_URL || process.env.PLATFORM_URL || '';
      const _meshTok = process.env.MESH_TOKEN || process.env.PLATFORM_TOKEN || '';
      if (!_meshUrl || !_meshTok) return res.status(500).json({ error: 'Mesh 未配置' });

      const r = await fetch(_meshUrl.replace(/\/$/, '') + '/api/users/find?numericId=' + friendNumericId, {
        headers: { 'Authorization': 'Bearer ' + _meshTok },
      });
      const d = await r.json() as any;
      if (!d.found) return res.status(404).json({ error: '好友不在线或未注册到 Mesh' });

      const ok = sendPeerMessage({
        type: 'peer.message',
        fromInstance: getInstanceId(),
        toInstance: d.instanceId,
        chatId,
        content,
        fromUserId: String(fromUserId),
        toUserId: friendNumericId,
        timestamp: Date.now(),
      } as any);

      if (!ok) return res.status(500).json({ error: 'Mesh 未连接或目标不在线' });

      // 本地也落库
      const msgId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      db.addMessage({ id: msgId, chatId, senderType: 'user', senderId: String(fromUserId), content, type: 'text', timestamp: Date.now() });

      // 广播给前端（发送方也能实时看到消息）
      broadcast({ type: 'message.new', chatId, from: String(fromUserId), senderId: String(fromUserId), senderType: 'user', content, timestamp: Date.now() });

      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/chats/:id/participants', requireAuth, (req, res) => {
    try {
      const participants = db.getChatParticipants(req.params.id as string);
      res.json({ ok: true, participants });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/participants', requireAuth, (req, res) => {
    try {
      const { id, chatId, agentId } = req.body || {};
      if ((!id && !agentId) || !chatId) return res.status(400).json({ error: 'id 和 chatId 必填' });
      db.removeParticipant(chatId, id || '', agentId);
      // 如果群聊没参与者了，清理协作模式缓存
      const remaining = db.getChatParticipants(chatId);
      if (!remaining || remaining.length === 0) {
        (globalThis as any).__chatModes?.delete(chatId);
        (globalThis as any).__roundRobinIdx?.delete(chatId);
      }
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 删除整个会话（含消息+参与者） ──
  app.delete('/api/chats/:id', requireAuth, (req, res) => {
    try {
      const chatId = req.params.id;
      const d = getDB();
      d.run('DELETE FROM messages WHERE chat_id = ?', [chatId]);
      d.run('DELETE FROM participants WHERE chat_id = ?', [chatId]);
      d.run('DELETE FROM chats WHERE id = ?', [chatId]);
      d.run('DELETE FROM chat_memories WHERE chat_id = ?', [chatId]);
      d.run('DELETE FROM entities WHERE chat_id = ?', [chatId]);
      (globalThis as any).__chatModes?.delete(chatId);
      (globalThis as any).__roundRobinIdx?.delete(chatId);
      res.json({ ok: true, deleted: chatId });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  // ── 工作流编排 API ──
  app.get('/api/workflows', requireAuth, (req, res) => {
    try {
      const stmt = getDB().prepare('SELECT id, name, created_at, updated_at FROM workflows ORDER BY updated_at DESC');
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json({ ok: true, workflows: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/workflows/:id', requireAuth, (req, res) => {
    try {
      const stmt = getDB().prepare('SELECT * FROM workflows WHERE id = ?');
      stmt.bind([req.params.id]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '工作流不存在' });
      res.json({ ok: true, workflow: { ...row, data: JSON.parse(row.data) } });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/workflows', requireAuth, (req, res) => {
    try {
      const { id, name, data } = req.body || {};
      if (!id || !name || !data) return res.status(400).json({ error: 'id/name/data 必填' });
      const now = Date.now();
      const stmt = getDB().prepare('INSERT OR REPLACE INTO workflows (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
      stmt.bind([id, name, JSON.stringify(data), now, now]);
      stmt.step(); stmt.free();
      res.json({ ok: true, id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/workflows/:id', requireAuth, (req, res) => {
    try {
      const { name, data } = req.body || {};
      const now = Date.now();
      if (name) {
        const stmt = getDB().prepare('UPDATE workflows SET name = ?, data = ?, updated_at = ? WHERE id = ?');
        stmt.bind([name, data ? JSON.stringify(data) : null, now, req.params.id]);
        stmt.step(); stmt.free();
      }
      if (data) {
        const stmt = getDB().prepare('UPDATE workflows SET data = ?, updated_at = ? WHERE id = ?');
        stmt.bind([JSON.stringify(data), now, req.params.id]);
        stmt.step(); stmt.free();
      }
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/workflows/:id', requireAuth, (req, res) => {
    try {
      const stmt = getDB().prepare('DELETE FROM workflows WHERE id = ?');
      stmt.bind([req.params.id]);
      stmt.step(); stmt.free();
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 清理协作模式缓存
  app.delete('/api/collab-cache/:chatId', requireAuth, (req, res) => {
    (globalThis as any).__chatModes?.delete(req.params.chatId);
    (globalThis as any).__roundRobinIdx?.delete(req.params.chatId);
    res.json({ ok: true });
  });


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


  // ── 聊天成员管理 ──
  app.get('/api/chats/:id/available-members', requireAuth, (req, res) => {
    try {
      const userId = req.query.userId as string;
      const chatId = req.params.id as string;
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const friends = db.listFriends(userId);
      const friendAgents = friends.map((f: any) => {
        const agent = db.getAgentByUserId(f.friendId);
        return agent ? { id: agent.id, displayName: agent.display_name || agent.displayName, type: 'agent' } : null;
      }).filter(Boolean);
      const myAgent = db.getAgentByUserId(userId);
      const myAI = myAgent ? [{ id: myAgent.id, displayName: myAgent.display_name || myAgent.displayName, type: 'my-ai' }] : [];
      const all = [...friends.map((f: any) => ({ id: f.friendId, displayName: f.friendName, type: 'friend' })), ...friendAgents, ...myAI];
      const existing = db.getChatParticipants(chatId);
      const existingIds = new Set(existing.map((p: any) => p.user_id || p.agent_id));
      const available = all.filter((m: any) => !existingIds.has(m.id));
      res.json({ ok: true, members: available });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

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

  app.get('/api/agents/:id/memory', requireAuth, (req, res) => {
    try {
      const agent = db.getAgent(String(req.params.id));
      if (!agent) return res.status(404).json({ error: 'Agent not found' });
      res.json({ ok: true, memory: agent.memory_summary || '', personality: agent.personality || '' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/agents/:id/memory', requireAuth, (req, res) => {
    try {
      const { personality, memory } = req.body || {};
      db.updateAgent(String(req.params.id), { personality: personality || undefined, memory_summary: memory || undefined });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/agents', requireAuth, (_req, res) => {
    try { res.json({ ok: true, agents: manager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
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

  // ── RAG 知识库初始化 ──
  router.initRAG();

  // ── RAG 知识库 API ──
  // 上传/添加文档
  app.post('/api/rag/documents', requireAuth, async (req, res) => {
    try {
      const { title, source, mimeType, content, metadata } = req.body;
      if (!title || !content) return res.status(400).json({ error: 'title 和 content 必填' });
      const doc = {
        id: 'rag-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        title,
        source: source || title,
        mimeType: mimeType || 'text/plain',
        content,
        createdAt: Date.now(),
        metadata: metadata || {},
      };
      const chunkCount = await router.addRagDocument(doc);
      res.json({ ok: true, docId: doc.id, chunkCount });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 列出文档
  app.get('/api/rag/documents', requireAuth, (req, res) => {
    try {
      const docs = router.listRagDocuments();
      res.json({ ok: true, count: docs.length, documents: docs });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 删除文档
  app.delete('/api/rag/documents/:id', requireAuth, (req, res) => {
    try {
      const removed = router.removeRagDocument(String(req.params.id));
      if (!removed) return res.status(404).json({ error: '文档不存在' });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 知识库（无 LLM 生成，纯检索）
  app.get('/api/rag/search', requireAuth, async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const topK = parseInt(req.query.topK as string) || 5;
      if (!q) return res.status(400).json({ error: 'q 参数必填' });
      const hits = await router.searchRag(q, topK);
      res.json({ ok: true, query: q, hits });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 用知识库生成问答（RAG 生成）
  app.post('/api/rag/generate', requireAuth, async (req, res) => {
    try {
      const { query, topK, systemPrompt } = req.body;
      if (!query) return res.status(400).json({ error: 'query 必填' });
      const result = await router.ragGenerate(query, { topK, systemPrompt });
      res.json({ ok: true, ...result });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  // 扫描工作区文档并自动导入知识库
  app.post('/api/rag/scan-workspace', requireAuth, async (req, res) => {
    try {
      const wsRoot = (globalThis as any).__workspaceRoot || process.cwd();
      const SUPPORTED_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log']);
      const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'storage', 'uploads', 'dist', 'build', 'coverage', '.next', '.nuxt', 'avatars']);
      const existing = new Set((router.listRagDocuments() || []).map((d: any) => d.title));
      const files: string[] = [];
      const walk = (dir: string) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          if (ent.name.startsWith('.')) continue;
          const full = join(dir, ent.name);
          if (ent.isDirectory()) {
            if (!SKIP_DIRS.has(ent.name)) walk(full);
          } else if (ent.isFile()) {
            const ext = path.extname(ent.name).toLowerCase();
            if (SUPPORTED_EXT.has(ext)) files.push(full);
          }
        }
      };
      walk(wsRoot);
      let imported = 0, skipped = 0;
      for (const full of files) {
        try {
          const name = full.split(/[\\/]/).pop() || full;
          if (existing.has(name)) { skipped++; continue; }
          const stat = statSync(full);
          if (stat.size > 2 * 1024 * 1024) { skipped++; continue; }
          const content = readFileSync(full, 'utf8');
          if (!content.trim()) { skipped++; continue; }
          const ext = path.extname(name).toLowerCase();
          const doc = {
            id: 'rag-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
            title: name,
            source: full,
            mimeType: (ext === '.md' || ext === '.markdown') ? 'text/markdown' : 'text/plain',
            content,
            createdAt: Date.now(),
            metadata: { path: full },
          };
          await router.addRagDocument(doc);
          imported++;
          existing.add(name);
        } catch { skipped++; }
      }
      res.json({ ok: true, imported, skipped });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  // ── Agent 更新 API ──
  app.patch('/api/agents/:id', requireAuth, (req, res) => {
    try {
      const updates = req.body;
      const agent = manager.update(String(req.params.id), updates);
      res.json({ ok: true, agent });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── Agent 绑定技能 API ──
  app.post('/api/agents/:id/skills', requireAuth, (req, res) => {
    try {
      const { skillIds } = req.body;
      if (!Array.isArray(skillIds)) return res.status(400).json({ error: 'skillIds 必须是数组' });
      toolRegistry.bindSkills(String(req.params.id), skillIds);
      res.json({ ok: true, agentId: String(req.params.id), skills: skillIds });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  // 鈹€鈹€ 璁板繂鍙嶆€?API 鈹€鈹€锛堝墠绔?reflectMemory() 璋冪敤锛?
  app.post('/api/agents/:id/reflect', requireAuth, async (req, res) => {
    try {
      const agentId = String(req.params.id);
      const chatId = (req.body && req.body.chatId) ? String(req.body.chatId) : undefined;
      const result = await router.reflectAgent(agentId, chatId);
      res.json(result);
    } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });


  // ── 工具列表 API ──
  app.get('/api/tools', requireAuth, (_req, res) => {
    try { res.json({ ok: true, tools: toolRegistry.listTools(), skills: toolRegistry.listSkills() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── AI 员工市场 + 雇佣系统 API ──
  app.get('/api/market/list', requireAuth, (_req, res) => {
    try {
      const stmt = getDB().prepare('SELECT * FROM agent_market WHERE status = ? ORDER BY rating DESC, hire_count DESC');
      stmt.bind(['active']);
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json({ ok: true, listings: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/market/publish', requireAuth, (req, res) => {
    try {
      const { agentId, publisherId, title, description, category, price, tags, duration, durationUnit } = req.body || {};
      if (!agentId || !publisherId || !title) return res.status(400).json({ error: 'agentId/publisherId/title 必填' });
      // v2.0.12 B1/B2: 价格校验（最低10积分避免抽成取整后卖方到账0，上限100000）
      const priceNum = Math.floor(Number(price) || 0);
      if (priceNum < 10) return res.status(400).json({ error: '发布价格最低 10 积分' });
      if (priceNum > 100000) return res.status(400).json({ error: '价格不能超过 100000 积分' });
      // v2.0.12: 自定义时长（0=永久买断）
      const durNum = Math.max(0, Math.floor(Number(duration) || 0));
      const unitOk = ['minute', 'hour', 'day'].includes(durationUnit) ? durationUnit : 'hour';
      const unit = durNum > 0 ? unitOk : 'permanent';
      const d = getDB();
      const id = 'ml-' + Date.now().toString(36);
      d.run('INSERT INTO agent_market (id,agent_id,publisher_id,title,description,category,price,tags,created_at,duration,duration_unit) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [id, agentId, publisherId, title, description||'', category||'通用', priceNum, JSON.stringify(tags||[]), Date.now(), durNum, unit]);
      res.json({ ok: true, id });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 雇佣AI员工：扣积分 → 创建工作群 → 双方agent入群 → 记录雇佣关系 */
  app.post('/api/market/hire', requireAuth, (req, res) => {
    try {
      const { listingId, buyerId } = req.body || {};
      if (!listingId || !buyerId) return res.status(400).json({ error: 'listingId/buyerId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT * FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const listing = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!listing) return res.status(404).json({ error: '商品不存在' });
      // v2.0.12 B3: 禁止自雇 + 检查上架状态
      if (listing.status !== 'active') return res.status(400).json({ error: '该商品已下架或不可雇佣' });
      if (String(listing.publisher_id) === String(buyerId)) return res.status(400).json({ error: '不能雇佣自己发布的员工' });
      // 1. 扣买方积分
      const price = listing.price || 10;
      const spendResult = !spendCredits ? {ok:false, error:'no fn'} : spendCredits(buyerId, price);
      if (typeof spendResult === 'object' && !spendResult.ok) return res.status(400).json({ error: spendResult.error, balance: (spendResult as { balance?: number }).balance });
      
      // 2. 给卖方加分（90%，10%平台税）
      const sellerPayout = Math.floor(price * 0.9);
      if (typeof addCredits === 'function') addCredits(listing.publisher_id, sellerPayout);
      
      // 3. 创建工作群组 chat
      const chatId = 'chat-hire-' + Date.now().toString(36);
      if (typeof createChat === 'function') createChat(chatId, 'group');
      
      // 4. 双方agent入群
      const buyerAgent = typeof getAgentByUserId === 'function' ? getAgentByUserId(buyerId) : null;
      const sellerAgent = typeof getAgentByUserId === 'function' ? getAgentByUserId(listing.publisher_id) : null;
      const boughtAgent = listing.agent_id ? d.getAgent(listing.agent_id) : null;
      
      const buyerAgentId = buyerAgent?.id || '';
      const usedAgentId = listing.agent_id || boughtAgent?.id || sellerAgent?.id || '';
      
      if (typeof addParticipant === 'function') {
        addParticipant('hp-' + Date.now().toString(36) + '-1', chatId, buyerId, undefined, 'member');
        addParticipant('hp-' + Date.now().toString(36) + '-2', chatId, undefined, buyerAgentId, 'agent');
        addParticipant('hp-' + Date.now().toString(36) + '-3', chatId, listing.publisher_id, undefined, 'member');
        addParticipant('hp-' + Date.now().toString(36) + '-4', chatId, undefined, usedAgentId, 'agent');
      }
      
      // 5. v2.0.12: 计算到期时间（发布者自定义时长，0=永久买断）
      const durMs: Record<string, number> = { minute: 60000, hour: 3600000, day: 86400000 };
      const dur = Number(listing.duration) || 0;
      const expiresAt = dur > 0 ? Date.now() + dur * (durMs[String(listing.duration_unit)] || 3600000) : 0;

      // 6. 记录雇佣关系
      const hireId = 'hire-' + Date.now().toString(36);
      if (typeof createHire === 'function') {
        createHire({
          id: hireId, listingId, buyerId,
          sellerId: listing.publisher_id,
          agentId: usedAgentId,
          title: listing.title || "AI雇佣",
          chatId, price, expiresAt,
        });
      }

      // 7. 记订单（关联hireId）+ 增hire计数
      const orderId = 'mo-' + Date.now().toString(36);
      d.run('INSERT INTO market_orders (id,listing_id,buyer_id,hire_id,created_at) VALUES (?,?,?,?,?)', [orderId, listingId, buyerId, hireId, Date.now()]);
      d.run('UPDATE agent_market SET hire_count = hire_count + 1 WHERE id = ?', [listingId]);
      
      // 8. 发欢迎消息
      const welcomeMsg = {
        id: 'msg-' + Date.now().toString(36),
        chatId, senderType: 'user',
        senderId: buyerId,
        content: '🎉 雇佣成功！欢迎AI员工加入团队。你可以在这个工作群中分配任务。',
        type: 'text', timestamp: Date.now(),
      };
      d.addMessage(welcomeMsg);
      
      res.json({ ok: true, orderId, hireId, chatId, expiresAt, balance: typeof spendResult === 'object' ? ((spendResult as { balance?: number }).balance || 0) : 0 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 查看积分余额 */
  app.get('/api/credits/balance', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const balance = typeof getUserCredits === 'function' ? getUserCredits(userId) : { credits: 1000, totalEarned: 0, totalSpent: 0 };
      res.json({ ok: true, ...balance });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 积分变动历史 */
  app.get('/api/credits/history', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const history = typeof getCreditHistory === 'function' ? getCreditHistory(userId, 50) : [];
      res.json({ ok: true, history });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 管理员加积分 */
  app.post('/api/credits/grant', adminAuth, (req, res) => {
    try {
      const { userId, amount } = req.body || {};
      if (!userId || !amount) return res.status(400).json({ error: 'userId/amount 必填' });
      const newBal = typeof addCredits === 'function' ? addCredits(userId, Math.abs(amount)) : 0;
      res.json({ ok: true, balance: newBal });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 雇佣到期惰性检查——超过 expires_at 则标记 expired 并把被雇 agent 移出工作群（保留聊天记录） */
  function checkHireExpired(hire: any): boolean {
    if (!hire || hire.status !== 'active') return false;
    const exp = Number(hire.expires_at) || 0;
    if (exp <= 0 || Date.now() < exp) return false;
    getDB().run("UPDATE hires SET status = 'expired', fired_at = ? WHERE id = ?", [Date.now(), hire.id]);
    if (hire.chat_id && hire.agent_id && typeof removeParticipant === 'function') {
      removeParticipant(hire.chat_id, '', hire.agent_id);
    }
    return true;
  }
  /** 查看员工的雇佣关系 */
  app.get('/api/employees', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const asBuyer = typeof listHiresByBuyer === 'function' ? listHiresByBuyer(userId) : [];
      const asSeller = typeof listHiresBySeller === 'function' ? listHiresBySeller(userId) : [];
      // 补充listing信息（并先做到期检查）+ 关联订单（供评价）
      const enrich = (hires: any[]) => hires.map((h0: any) => {
        const h = checkHireExpired(h0) && typeof getHire === 'function' ? (getHire(h0.id) || h0) : h0;
        const lst = getDB().prepare('SELECT * FROM agent_market WHERE id = ?');
        lst.bind([h.listing_id]);
        const listing = lst.step() ? lst.getAsObject() : null;
        lst.free();
        const ordStmt = getDB().prepare('SELECT id, rating FROM market_orders WHERE hire_id = ?');
        ordStmt.bind([h.id]);
        const order = ordStmt.step() ? ordStmt.getAsObject() : null;
        ordStmt.free();
        return { ...h, listing, orderId: order?.id || null, rated: !!(order && Number(order.rating) > 0) };
      });
      res.json({ ok: true, asBuyer: enrich(asBuyer), asSeller: enrich(asSeller) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 解雇员工 */
  app.post('/api/employees/fire', requireAuth, (req, res) => {
    try {
      const { hireId } = req.body || {};
      if (!hireId) return res.status(400).json({ error: 'hireId 必填' });
      const ok = typeof fireHire === 'function' ? fireHire(hireId) : false;
      if (!ok) return res.status(404).json({ error: '未找到该雇佣关系或已解雇' });
      // 清理工作群参与者（保留聊天记录）—— v2.0.12: 移除被雇 agent（原 buyer_agent_id/seller_agent_id 字段不存在导致从未生效）
      const hire = typeof getHire === 'function' ? getHire(hireId) : null;
      if (hire && hire.chat_id && hire.agent_id && typeof removeParticipant === 'function') {
        removeParticipant(hire.chat_id, '', hire.agent_id);
      }
      res.json({ ok: true, message: '已解雇' });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** 我的市场发布 */
  app.get('/api/market/my-listings', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const rows = getDB().queryObjects('SELECT * FROM agent_market WHERE publisher_id = ? ORDER BY created_at DESC', [userId]);
      res.json({ ok: true, listings: rows });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 下架商品 */
  app.post('/api/market/unpublish', requireAuth, (req, res) => {
    try {
      const { listingId, userId } = req.body || {};
      if (!listingId || !userId) return res.status(400).json({ error: 'listingId/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT publisher_id FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '商品不存在' });
      if (row.publisher_id !== userId) return res.status(403).json({ error: '只能下架自己的商品' });
      d.run("UPDATE agent_market SET status = 'paused' WHERE id = ?", [listingId]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 重新上架 */
  app.post('/api/market/republish', requireAuth, (req, res) => {
    try {
      const { listingId, userId } = req.body || {};
      if (!listingId || !userId) return res.status(400).json({ error: 'listingId/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT publisher_id FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '商品不存在' });
      if (row.publisher_id !== userId) return res.status(403).json({ error: '只能上架自己的商品' });
      d.run("UPDATE agent_market SET status = 'active' WHERE id = ?", [listingId]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 编辑商品 */
  app.put('/api/market/:id', requireAuth, (req, res) => {
    try {
      const { userId, title, description, category, price, tags, duration, durationUnit } = req.body || {};
      const listingId = req.params.id;
      if (!listingId || !userId) return res.status(400).json({ error: 'listingId/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT publisher_id FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '商品不存在' });
      if (row.publisher_id !== userId) return res.status(403).json({ error: '只能编辑自己的商品' });
      const sets: string[] = [];
      const vals: any[] = [];
      if (title !== undefined) { sets.push('title = ?'); vals.push(title); }
      if (description !== undefined) { sets.push('description = ?'); vals.push(description); }
      if (category !== undefined) { sets.push('category = ?'); vals.push(category); }
      if (price !== undefined) {
        const p = Math.floor(Number(price) || 0);
        if (p < 10) return res.status(400).json({ error: '发布价格最低 10 积分' });
        if (p > 100000) return res.status(400).json({ error: '价格不能超过 100000 积分' });
        sets.push('price = ?'); vals.push(p);
      }
      if (tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(tags)); }
      if (duration !== undefined) { sets.push('duration = ?'); vals.push(Math.max(0, Math.floor(Number(duration) || 0))); }
      if (durationUnit !== undefined && ['minute', 'hour', 'day', 'permanent'].includes(durationUnit)) { sets.push('duration_unit = ?'); vals.push(durationUnit); }
      if (sets.length === 0) return res.json({ ok: true, message: '无需更新' });
      vals.push(listingId);
      d.run(`UPDATE agent_market SET ${sets.join(', ')} WHERE id = ?`, vals);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 删除商品 */
  app.delete('/api/market/:id', requireAuth, (req, res) => {
    try {
      const userId = req.body?.userId || req.query.userId;
      const listingId = req.params.id;
      if (!listingId || !userId) return res.status(400).json({ error: 'listingId/userId 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT publisher_id FROM agent_market WHERE id = ?');
      stmt.bind([listingId]);
      const row = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!row) return res.status(404).json({ error: '商品不存在' });
      if (row.publisher_id !== userId) return res.status(403).json({ error: '只能删除自己的商品' });
      d.run('DELETE FROM agent_market WHERE id = ?', [listingId]);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 评价雇佣 + rating 回写 listing */
  app.post('/api/market/rate', requireAuth, (req, res) => {
    try {
      const { orderId, rating, review, userId } = req.body || {};
      const r = Math.floor(Number(rating) || 0);
      if (!orderId || !userId || r < 1 || r > 5) return res.status(400).json({ error: 'orderId/userId/rating(1-5) 必填' });
      const d = getDB();
      const stmt = d.prepare('SELECT * FROM market_orders WHERE id = ?');
      stmt.bind([orderId]);
      const order = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      if (!order) return res.status(404).json({ error: '订单不存在' });
      if (order.buyer_id !== userId) return res.status(403).json({ error: '只能评价自己的订单' });
      d.run('UPDATE market_orders SET rating = ?, review = ?, completed_at = ?, status = ? WHERE id = ?',
        [r, review || '', Date.now(), 'completed', orderId]);
      // rating 回写：listing 评分 = 该商品所有订单评分的平均值
      const avgStmt = d.prepare('SELECT AVG(rating) AS avg_r FROM market_orders WHERE listing_id = ? AND rating IS NOT NULL AND rating > 0');
      avgStmt.bind([order.listing_id]);
      if (avgStmt.step()) {
        const avgRow: any = avgStmt.getAsObject();
        d.run('UPDATE agent_market SET rating = ? WHERE id = ?', [Math.round((Number(avgRow.avg_r) || 0) * 10) / 10, order.listing_id]);
      }
      avgStmt.free();
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  /** v2.0.12: 我的订单 */
  app.get('/api/market/my-orders', requireAuth, (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      if (!userId) return res.status(400).json({ error: 'userId 必填' });
      const rows: any[] = getDB().queryObjects('SELECT * FROM market_orders WHERE buyer_id = ? ORDER BY created_at DESC', [userId]);
      const orders = rows.map((o: any) => {
        const lst = getDB().prepare('SELECT title, category FROM agent_market WHERE id = ?');
        lst.bind([o.listing_id]);
        const listing = lst.step() ? lst.getAsObject() : null;
        lst.free();
        return { ...o, listing };
      });
      res.json({ ok: true, orders });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

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

  // ── P1-3: 子代理 API ──
  app.get('/api/subagents', requireAuth, (req, res) => {
    try {
      const parentId = (req.query.parentId as string) || '';
      res.json({ ok: true, tasks: subAgentManager.list(parentId || undefined) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/subagents/spawn', requireAuth, async (req, res) => {
    try {
      const { objective, parentId, chatId, model, timeoutSeconds } = req.body;
      if (!objective || !parentId) return res.status(400).json({ error: 'objective/parentId 必填' });
      const taskId = await subAgentManager.spawn({
        objective,
        parentId,
        chatId: chatId || 'chat-default',
        model,
        timeoutSeconds,
      });
      res.json({ ok: true, taskId });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/subagents/:id/steer', requireAuth, (req, res) => {
    try {
      const ok = subAgentManager.steer(String(req.params.id), req.body.message);
      res.json({ ok });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/subagents/:id', requireAuth, (req, res) => {
    try {
      const ok = subAgentManager.kill(String(req.params.id));
      res.json({ ok });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  // ── v2.1: 多智能体协作 API ──
  app.post('/api/subagents/collab', requireAuth, async (req, res) => {
    try {
      const { mode, question, models, rounds, parentId, chatId, maxSpeakSeconds } = req.body;
      if (!mode || !question) return res.status(400).json({ error: 'mode/question 必填' });
      const validModes = ['voting', 'debate', 'roundtable', 'pipeline', 'review', 'orchestrator'];
      if (!validModes.includes(mode)) return res.status(400).json({ error: 'mode 必须是 ' + validModes.join('/') });
      const sessionId = await subAgentManager.collab({
        mode, question, models,
        rounds: typeof rounds === 'number' && rounds > 0 ? rounds : undefined,
        parentId: parentId || 'api-caller',
        chatId: chatId || 'chat-default',
        maxSpeakSeconds,
        onEvent: (evt: any) => {
          try {
            broadcast({
              type: 'collab.' + evt.type, chatId: evt.chatId, sessionId: evt.sessionId,
              mode: evt.mode, status: evt.status, round: evt.round, model: evt.model,
              transcript: evt.transcript, conclusion: evt.conclusion, error: evt.error,
            });
          } catch { /* ignore */ }
        },
      });
      res.json({ ok: true, sessionId });
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/subagents/collab', requireAuth, (req, res) => {
    try { res.json({ ok: true, sessions: subAgentManager.listCollabs(50) }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/subagents/collab/:id', requireAuth, (req, res) => {
    try {
      const s = subAgentManager.getCollab(String(req.params.id));
      if (!s) return res.status(404).json({ error: '协作会话不存在' });
      res.json({ ok: true, session: s });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/subagents/collab/:id/cancel', requireAuth, (req, res) => {
    try { res.json({ ok: subAgentManager.killCollab(String(req.params.id)) }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
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

  // ── V5 P4: 技能 API ──
  app.get('/api/skills', requireAuth, (_req, res) => {
    try { res.json({ ok: true, skills: skillManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/skills/scan', requireAuth, (_req, res) => {
    try { res.json({ ok: true, skills: skillManager.scanLocal() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/skills/:id/enable', requireAuth, (req, res) => {
    try { skillManager.setEnabled(String(req.params.id), true); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/skills/:id/disable', requireAuth, (req, res) => {
    try { skillManager.setEnabled(String(req.params.id), false); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/skills/:id', requireAuth, (req, res) => {
    try { skillManager.uninstall(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/skills/create', requireAuth, (req, res) => {
    try {
      const { id, name, description, content } = req.body;
      if (!id || !name || !content) return res.status(400).json({ error: 'id/name/content 必填' });
      skillManager.createSkill(id, name, description || '', content);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/skills/market', requireAuth, async (_req, res) => {
    try {
      const items = await skillManager.browseMarket();
      res.json({ ok: true, items });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/skills/install', requireAuth, async (req, res) => {
    try {
      const { name } = req.body;
      if (!name) return res.status(400).json({ error: 'name 必填' });
      const ok = await skillManager.installFromMarket(name);
      res.json({ ok });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V5 P6: 自定义 Provider API ──
  app.get('/api/custom-providers/backends', requireAuth, (_req, res) => {
    try { res.json({ ok: true, backends: INFERENCE_BACKENDS }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/custom-providers', requireAuth, (_req, res) => {
    try { res.json({ ok: true, providers: customProviderManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/custom-providers', requireAuth, (req, res) => {
    try {
      const { id, name, baseURL, apiKey, models, autoDetect } = req.body;
      if (!id || !baseURL) return res.status(400).json({ error: 'id/baseURL 必填' });
      customProviderManager.add({ id, name: name || id, baseURL, apiKey, models, autoDetect });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/custom-providers/:id', requireAuth, (req, res) => {
    try { customProviderManager.remove(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/custom-providers/test', requireAuth, async (req, res) => {
    try {
      const { baseURL, apiKey, models } = req.body;
      const result = await customProviderManager.testConnection({ id: 'test', name: 'test', baseURL, apiKey, models });
      res.json({ ok: result.ok, models: result.models, error: result.error });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/custom-providers/:id/detect', requireAuth, async (req, res) => {
    try {
      const p = customProviderManager.get(String(req.params.id));
      if (!p) return res.status(404).json({ error: '不存在' });
      const models = await customProviderManager.detectModels(p.baseURL, p.apiKey);
      res.json({ ok: true, models });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

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

  // ── V5 P5: 渠道管理 API ──
  app.get('/api/channels', requireAuth, (_req, res) => {
    try { res.json({ ok: true, definitions: channelManager.getDefinitions(), channels: channelManager.list() }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/channels', requireAuth, (req, res) => {
    try {
      const { id, type, config } = req.body;
      if (!id || !type) return res.status(400).json({ error: 'id/type 必填' });
      const channel = channelManager.configure(id, type, config || {});
      res.json({ ok: true, channel });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/channels/:id/enable', requireAuth, async (req, res) => {
    try { channelManager.setEnabled(String(req.params.id), req.body.enabled ?? true); const ch = channelManager.get(String(req.params.id)); if (ch && ch.enabled) await startChannelAdapter(ch); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/channels/:id', requireAuth, (req, res) => {
    try { channelManager.remove(String(req.params.id)); res.json({ ok: true }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V5 P5: 渠道 Webhook 路由 ──
  // Slack Events API
  app.post('/api/channels/slack/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find(c => c.type === 'slack');
      if (!ch) return res.status(404).json({ error: 'Slack 渠道未配置' });
      const adapter = channelManager.getAdapter(ch.id) as SlackAdapter;
      if (!adapter) return res.status(500).json({ error: 'adapter not started' });
      // v2 修复：验证签名
      if ((adapter as any).verifySignature) {
        const sig = req.headers['x-slack-signature'] as string;
        const ts = req.headers['x-slack-request-timestamp'] as string;
        const body = JSON.stringify(req.body);
        if (!(adapter as any).verifySignature(sig, ts, body)) {
          return res.status(403).json({ error: '签名验证失败' });
        }
      }
      const result = await adapter.handleEvent(req.body);
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 微信公众号/企业微信
  app.get('/api/channels/wechat/webhook', (req, res) => {
    try {
      const ch = channelManager.list().find(c => c.type === 'wechat');
      if (!ch) return res.status(404).send('Not configured');
      const adapter = channelManager.getAdapter(ch.id) as WeChatAdapter;
      if (!adapter) return res.status(500).send('Adapter not started');
      const { signature, timestamp, nonce, echostr } = req.query as any;
      if (adapter.verifySignature(signature, timestamp, nonce)) {
        res.send(echostr);
      } else {
        res.status(403).send('Invalid signature');
      }
    } catch (err: any) { res.status(500).send(err.message); }
  });
  app.post('/api/channels/wechat/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find(c => c.type === 'wechat');
      if (!ch) return res.status(404).send('Not configured');
      const adapter = channelManager.getAdapter(ch.id) as WeChatAdapter;
      const result = adapter ? await adapter.handleMessage(req.body) : 'adapter not started';
      res.type('text/xml').send(result);
    } catch (err: any) { res.status(500).send(err.message); }
  });

  // 飞书
  app.post('/api/channels/feishu/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find(c => c.type === 'feishu');
      if (!ch) return res.status(404).json({ error: 'Feishu 渠道未配置' });
      const adapter = channelManager.getAdapter(ch.id) as FeishuAdapter;
      const result = adapter ? await adapter.handleEvent(req.body) : { ok: false, error: 'adapter not started' };
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // QQ Bot
  app.post('/api/channels/qqbot/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find(c => c.type === 'qqbot');
      if (!ch) return res.status(404).json({ error: 'QQBot 渠道未配置' });
      const adapter = channelManager.getAdapter(ch.id) as QQBotAdapter;
      const result = adapter ? await adapter.handleEvent(req.body) : { ok: false, error: 'adapter not started' };
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // WhatsApp
  app.get('/api/channels/whatsapp/webhook', (req, res) => {
    const ch = channelManager.list().find(c => c.type === 'whatsapp');
    if (!ch) return res.status(404).send('Not configured');
    const adapter = channelManager.getAdapter(ch.id) as WhatsAppAdapter;
    if (!adapter) return res.status(500).send('Adapter not started');
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query as any;
    const result = adapter.verifyWebhook(mode, token, challenge);
    if (result !== null) res.send(result);
    else res.status(403).send('Invalid token');
  });
  app.post('/api/channels/whatsapp/webhook', async (req, res) => {
    try {
      const ch = channelManager.list().find(c => c.type === 'whatsapp');
      if (!ch) return res.status(404).json({ error: 'WhatsApp 渠道未配置' });
      const adapter = channelManager.getAdapter(ch.id) as WhatsAppAdapter;
      const result = adapter ? await adapter.handleEvent(req.body) : { ok: false };
      res.json(result);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── V5 P5: 启用渠道时自动启动适配器 ──
  async function startChannelAdapter(ch: any) {
    if (!ch.enabled) return;
    try {
      switch (ch.type) {
        case 'telegram':
          if (!telegramAdapter && ch.config.botToken) {
            const tg = new TelegramAdapter({
              botToken: ch.config.botToken,
              enabled: true,
              requireMention: ch.config.requireMention !== false,
              defaultUserId: ch.config.defaultUserId || 'user-shen',
              defaultChatId: ch.config.defaultChatId || 'chat-telegram',
            }, router, manager, db);
            if (await tg.start()) channelManager.setAdapter(ch.id, tg);
          }
          break;
        case 'discord':
          if (!channelManager.getAdapter(ch.id) && ch.config.botToken) {
            const dc = new DiscordAdapter({
              botToken: ch.config.botToken,
              prefix: ch.config.prefix || '!',
              enabled: true,
              defaultUserId: ch.config.defaultUserId || 'user-discord',
              defaultChatId: ch.config.defaultChatId || 'chat-discord',
            }, router, manager, db);
            if (await dc.start()) channelManager.setAdapter(ch.id, dc);
          }
          break;
        case 'slack':
          if (!channelManager.getAdapter(ch.id) && ch.config.botToken) {
            const sk = new SlackAdapter({
              botToken: ch.config.botToken,
              appToken: ch.config.appToken,
              signingSecret: ch.config.signingSecret,
              enabled: true,
              defaultUserId: ch.config.defaultUserId || 'user-slack',
              defaultChatId: ch.config.defaultChatId || 'chat-slack',
            }, router, manager, db);
            if (await sk.start()) channelManager.setAdapter(ch.id, sk);
          }
          break;
        case 'wechat':
          if (!channelManager.getAdapter(ch.id) && ch.config.appId) {
            const wx = new WeChatAdapter({
              mode: ch.config.mode || 'mp',
              appId: ch.config.appId,
              appSecret: ch.config.appSecret,
              token: ch.config.token,
              encodingAESKey: ch.config.encodingAESKey,
              enabled: true,
              defaultUserId: ch.config.defaultUserId || 'user-wechat',
              defaultChatId: ch.config.defaultChatId || 'chat-wechat',
            }, router, manager, db);
            if (await wx.start()) channelManager.setAdapter(ch.id, wx);
          }
          break;
        case 'feishu':
          if (!channelManager.getAdapter(ch.id) && ch.config.appId) {
            const fs = new FeishuAdapter({
              appId: ch.config.appId,
              appSecret: ch.config.appSecret,
              verificationToken: ch.config.verificationToken,
              encryptKey: ch.config.encryptKey,
              enabled: true,
              defaultUserId: ch.config.defaultUserId || 'user-feishu',
              defaultChatId: ch.config.defaultChatId || 'chat-feishu',
            }, router, manager, db);
            if (await fs.start()) channelManager.setAdapter(ch.id, fs);
          }
          break;
        case 'qqbot':
          if (!channelManager.getAdapter(ch.id) && ch.config.appId) {
            const qq = new QQBotAdapter({
              appId: ch.config.appId,
              appSecret: ch.config.appSecret,
              enabled: true,
              defaultUserId: ch.config.defaultUserId || 'user-qqbot',
              defaultChatId: ch.config.defaultChatId || 'chat-qqbot',
            }, router, manager, db);
            if (await qq.start()) channelManager.setAdapter(ch.id, qq);
          }
          break;
        case 'whatsapp':
          if (!channelManager.getAdapter(ch.id) && ch.config.apiToken) {
            const wa = new WhatsAppAdapter({
              apiToken: ch.config.apiToken,
              phoneNumberId: ch.config.phoneNumberId,
              verifyToken: ch.config.verifyToken,
              enabled: true,
              defaultUserId: ch.config.defaultUserId || 'user-whatsapp',
              defaultChatId: ch.config.defaultChatId || 'chat-whatsapp',
            }, router, manager, db);
            if (await wa.start()) channelManager.setAdapter(ch.id, wa);
          }
          break;
        case 'signal':
          if (!channelManager.getAdapter(ch.id) && ch.config.phoneNumber) {
            const sg = new SignalAdapter({
              phoneNumber: ch.config.phoneNumber,
              signalCliPath: ch.config.signalCliPath,
              enabled: true,
              defaultUserId: ch.config.defaultUserId || 'user-signal',
              defaultChatId: ch.config.defaultChatId || 'chat-signal',
            }, router, manager, db);
            if (await sg.start()) channelManager.setAdapter(ch.id, sg);
          }
          break;
        case 'imessage':
          if (!channelManager.getAdapter(ch.id) && ch.config.appleScript) {
            const im = new IMessageAdapter({
              appleScript: ch.config.appleScript,
              enabled: true,
              defaultUserId: ch.config.defaultUserId || 'user-imessage',
              defaultChatId: ch.config.defaultChatId || 'chat-imessage',
            }, router, manager, db);
            if (await im.start()) channelManager.setAdapter(ch.id, im);
          }
          break;
      }
    } catch (err: any) {
      console.error(`[Channels] 启动 ${ch.type} 失败:`, err.message);
    }
  }

  // 启动已配置的渠道
  for (const ch of channelManager.getEnabledChannels()) {
    await startChannelAdapter(ch);
  }

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
  {
    const meshPlatformUrl = process.env.MESH_PLATFORM_URL || process.env.PLATFORM_URL || '';
    const meshToken = process.env.MESH_TOKEN || process.env.PLATFORM_TOKEN || '';
    let pkgVersion = '0.0.0';
    try { pkgVersion = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version || '0.0.0'; } catch {}

    // 收到 peer 实例转来的消息 → 走与本地用户消息完全相同的六模式编排
    setPeerMessageHandler((msg: PeerMessage) => {
      try {
        if (!msg.content) return;
        // 跨平台好友聊天 peer.message
        if (msg.chatId && String(msg.chatId).startsWith('chat-') && (msg as any).fromUserId !== undefined) {
          const chatId = msg.chatId;
          const fromUserId = String((msg as any).fromUserId);
          const toUserId = String((msg as any).toUserId || '');
          const existing = db.listChats().find((c: any) => c.id === chatId);
          if (!existing) {
            db.createChat(chatId, 'private');
            // 参与者：发送方和当前用户（接收方）
            db.addParticipant('p-' + chatId + '-from', chatId, fromUserId, undefined, 'member');
            db.addParticipant('p-' + chatId + '-to', chatId, toUserId, undefined, 'member');
          }
          db.addMessage({
            id: 'msg-mesh-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            chatId,
            senderType: 'user',
            senderId: fromUserId,
            content: msg.content,
            type: 'text',
            timestamp: Date.now(),
          });
          broadcast({ type: 'message.new', chatId, from: fromUserId, senderId: fromUserId, senderType: 'user', content: msg.content, timestamp: Date.now() });
          console.log(`[Mesh] 好友消息注入聊天 ${chatId}: ${msg.content.slice(0, 40)}`);
          return;
        }
        const chatId = resolveMeshChat(msg.chatId);
        const senderId = 'peer:' + (msg.fromInstance || 'unknown');
        console.log(`[Mesh] peer 消息注入聊天 ${chatId}: ${msg.content.slice(0, 40)}`);
        processUserMessage(chatId, senderId, msg.content, undefined, router, broadcast);
      } catch (err: any) {
        console.error('[Mesh] 处理 peer 消息失败:', err.message);
      }
    });

    // 收到 peer 实例派发的任务 → 让本地 Agent 自主完成，结果经 mesh 回传
    setPeerTaskHandler((msg: PeerMessage) => {
      (async () => {
        try {
          const agents = manager.list();
          const agent = agents.find((a: any) => a.id === msg.fromAgent) || agents[0];
          if (!agent) {
            sendPeerMessage({ type: 'peer.response', fromInstance: getInstanceId(), toInstance: msg.fromInstance, content: '本实例没有可用的 AI Agent', taskId: msg.taskId, timestamp: Date.now() });
            return;
          }
          const chatId = resolveMeshChat(msg.chatId);
          const goal = msg.goal || msg.content || '';
          console.log(`[Mesh] 执行 peer 任务 (agent=${agent.id}): ${goal.slice(0, 40)}`);
          const reply = await router.generateReply(chatId, agent.id, 'mesh-task-' + Date.now(), undefined, undefined, goal);
          sendPeerMessage({ type: 'peer.response', fromInstance: getInstanceId(), toInstance: msg.fromInstance, content: reply, taskId: msg.taskId, timestamp: Date.now() });
        } catch (err: any) {
          console.error('[Mesh] peer 任务执行失败:', err.message);
          sendPeerMessage({ type: 'peer.response', fromInstance: getInstanceId(), toInstance: msg.fromInstance, content: '任务执行失败: ' + err.message, taskId: msg.taskId, timestamp: Date.now() });
        }
      })();
    });

    // 解析/创建一个用于承接 mesh 消息的聊天
    function resolveMeshChat(preferred?: string): string {
      if (preferred) {
        const existing = db.listChats().find((c: any) => c.id === preferred);
        if (existing) return preferred;
      }
      const chats = db.listChats();
      if (chats.length > 0) return chats[0].id;
      // 没有任何聊天 → 建一个
      const chatId = 'mesh-' + Date.now().toString(36);
      db.createChat(chatId, 'group');
      const firstAgent = manager.list()[0];
      if (firstAgent) db.addParticipant('p-mesh-' + firstAgent.id, chatId, undefined, firstAgent.id, 'agent');
      return chatId;
    }

    if (meshPlatformUrl && meshToken) {
      const agentIds = manager.list().map((a: any) => a.id);
      startInstanceMesh(meshPlatformUrl, meshToken, port, agentIds, pkgVersion);
      console.log(`[Mesh] 已启用，平台: ${meshPlatformUrl}`);
      // 自动把本机所有带 numeric_id 的用户注册到平台，供其他实例搜索加好友/聊天
      try {
        const allUsers = db.listUsers() as any[];
        for (const u of allUsers) {
          if (!u.numeric_id) continue;
          fetch(`${meshPlatformUrl.replace(/\/$/, '')}/api/users/register`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${meshToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ instanceId: getInstanceId(), numericId: u.numeric_id, displayName: u.display_name, email: u.email || '', userId: u.id }),
          }).catch(() => {});
        }
        console.log(`[Mesh] 已注册 ${allUsers.filter((u: any) => u.numeric_id).length} 个本地用户到平台`);
      } catch (e: any) { console.warn('[Mesh] 用户注册失败:', e.message); }
    } else {
      console.log('[Mesh] 未配置 MESH_PLATFORM_URL/MESH_TOKEN，实例组网未启用');
    }

    // ── Mesh REST API ──
    app.get('/api/mesh/status', requireAuth, (_req, res) => {
      res.json({ ok: true, ...getMeshInfo() });
    });

    // 在线实例列表（代理平台 /api/instances/list）
    app.get('/api/mesh/peers', requireAuth, async (_req, res) => {
      try {
        if (!meshPlatformUrl || !meshToken) return res.json({ ok: true, instances: [], count: 0, disabled: true });
        const r = await fetch(meshPlatformUrl.replace(/\/$/, '') + '/api/instances/list', {
          headers: { 'Authorization': 'Bearer ' + meshToken },
        });
        const d = await r.json() as any;
        // 排除自己
        const me = getInstanceId();
        const instances = (d.instances || []).filter((i: any) => i.instanceId !== me);
        res.json({ ok: true, instances, count: instances.length });
      } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
    });

    // 向某个 peer 实例发消息（会触发对方本地 AI 处理）
    app.post('/api/mesh/send', requireAuth, (req, res) => {
      const { toInstance, content, chatId } = req.body || {};
      if (!toInstance || !content) return res.status(400).json({ error: '需要 toInstance 和 content' });
      const ok = sendPeerMessage({ type: 'peer.message', fromInstance: getInstanceId(), toInstance, content, chatId, timestamp: Date.now() });
      res.json({ ok });
    });

    // 向某个 peer 实例派发任务（对方 Agent 自主完成后回传）
    app.post('/api/mesh/task', requireAuth, (req, res) => {
      const { toInstance, goal, agentId } = req.body || {};
      if (!toInstance || !goal) return res.status(400).json({ error: '需要 toInstance 和 goal' });
      const taskId = 'task-' + Date.now().toString(36);
      const ok = sendPeerMessage({ type: 'peer.task', fromInstance: getInstanceId(), toInstance, goal, fromAgent: agentId, taskId, timestamp: Date.now() });
      res.json({ ok, taskId });
    });
  }


  // ────────────────────────────────────────
  // 局域网社交 (LAN Social) — 同网段引擎自动发现 + ID 加好友 + 群组双聊天 + 多智能体
  // ────────────────────────────────────────
  // 本机用户列表（含数字 ID 与各自灵犀引擎），供灯塔广播与社交层共用
  function getLocalLanUsers(): LanUser[] {
    const agentByUser = new Map<string, string>();
    for (const a of manager.list() as any[]) {
      const owner = a.userId || a.user_id;
      if (owner && !agentByUser.has(owner)) agentByUser.set(owner, a.id);
    }
    return (db.listUsers() as any[])
      .filter((u) => u.numeric_id)
      .map((u) => ({
        id: u.id,
        numericId: u.numeric_id,
        displayName: u.display_name || u.username || u.id,
        agentId: agentByUser.get(u.id),
      }));
  }

  const lanSocial = new LanSocialHub({ router, manager, broadcast, getLocalUsers: getLocalLanUsers });

  // 启动 UDP 发现（可用 LAN_DISCOVERY=off 关闭）
  if ((process.env.LAN_DISCOVERY || 'on').toLowerCase() !== 'off') {
    startLanDiscovery({
      port,
      version: (() => { try { return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })(),
      dataDir,
      getUsers: getLocalLanUsers,
      discoveryPort: process.env.LAN_DISCOVERY_PORT ? Number(process.env.LAN_DISCOVERY_PORT) : undefined,
    });
  }

  // v5 修复: LAN 写操作身份绑定 — 本地免登录模式信任 body.userId；真实 JWT 强制使用登录身份，防伪造他人身份
  const lanUserId = (req: any, bodyUserId?: string): string | null => {
    const u = (req as any).user;
    if (!u) return null;
    const sid = String(u.sid || '');
    const isBootstrap = sid === 'admin-auto' || sid === 'platform-admin' || sid === 'admin-token' || u.sub === 'admin';
    if (isBootstrap) return bodyUserId || String(u.sub);
    return String(u.sub || u.numeric_id || '');
  };

  // ── 前端用：状态 / 邻居 / 搜索 ──
  app.get('/api/lan/status', requireAuth, (_req, res) => {
    res.json({ ok: true, ...getLanSelfInfo(), socialChannel: LAN_SOCIAL_CHANNEL });
  });

  app.get('/api/lan/peers', requireAuth, (_req, res) => {
    const peers = getLanPeers().map((p) => ({
      instanceId: p.instanceId, lanIp: p.lanIp, port: p.port, version: p.version, lastSeen: p.lastSeen,
      users: p.users.map((u) => ({ numericId: u.numericId, displayName: u.displayName, userId: u.id, agentId: u.agentId })),
    }));
    res.json({ ok: true, peers, count: peers.length });
  });

  app.get('/api/lan/search', requireAuth, (req, res) => {
    const q = (req.query.q as string) || '';
    res.json({ ok: true, results: lanSocial.search(q) });
  });

  // ── 全局用户搜索：按数字 ID 或用户名搜索 ──
  app.get('/api/users/search', requireAuth, async (req, res) => {
    try {
      const q = (req.query.q as string || '').trim();
      if (!q) return res.json({ ok: true, results: [] });
      const platformApiUrl = (globalThis as any).__platformApiUrl || '';
      const platformAdminToken = (globalThis as any).__platformAdminToken || '';
      let platformResults: any[] = [];
      // 优先从平台搜索用户
      if (platformApiUrl && platformAdminToken) {
        try {
          const resp = await fetch(`${platformApiUrl}/api/admin/search?q=${encodeURIComponent(q)}&token=${platformAdminToken}`);
          const d = await resp.json() as any;
          if (d.ok && d.results) {
            platformResults = d.results.map((u: any) => ({
              numericId: u.id,
              displayName: u.username,
              email: u.email || '',
              userId: String(u.id),
              status: u.status || 'active',
              online: (u.status || 'active') !== 'offline' && (u.status || 'active') !== 'inactive',
              source: 'platform',
              points: u.points || 0,
              createdAt: u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '-',
            }));
          }
        } catch (e: any) {
          console.warn('[Platform] 用户搜索失败，回退本地:', e.message);
        }
      }
      // 本地数据库搜索（补充平台未覆盖的本地用户）
      const raw = getDB();
      let localResults: any[] = [];
      const nid = parseInt(q);
      if (!isNaN(nid)) {
        const s1 = raw.prepare('SELECT id, numeric_id, display_name, email, status, created_at FROM users WHERE numeric_id = ?');
        s1.bind([nid]);
        if (s1.step()) { localResults.push(s1.getAsObject()); }
        s1.free();
      }
      const s2 = raw.prepare('SELECT id, numeric_id, display_name, email, status, created_at FROM users WHERE display_name LIKE ? OR id LIKE ? LIMIT 20');
      s2.bind(['%' + q + '%', '%' + q + '%']);
      while (s2.step()) {
        const row = s2.getAsObject();
        if (!localResults.find(r => r.id === row.id)) localResults.push(row);
      }
      s2.free();
      // 局域网邻居中的用户搜索
      let lanResults: any[] = [];
      for (const peer of getLanPeers()) {
        for (const u of peer.users) {
          if (String(u.numericId) === q || (u.displayName || '').includes(q)) {
            lanResults.push({
              numericId: u.numericId,
              displayName: u.displayName,
              userId: u.id,
              lanIp: peer.lanIp,
              port: peer.port,
              source: 'lan',
            });
          }
        }
      }
      // 合并结果，去重（平台优先）
      const platformIds = new Set(platformResults.map((r: any) => String(r.numericId)));
      const localFiltered = localResults
        .filter((r: any) => !platformIds.has(String(r.numeric_id)))
        .map((r: any) => ({
          numericId: r.numeric_id, displayName: r.display_name, email: r.email,
          userId: r.id, status: r.status, online: r.status === 'online', source: 'local',
          createdAt: r.created_at ? new Date(r.created_at).toLocaleString('zh-CN') : '-',
        }));
      const results = [...platformResults, ...localFiltered, ...lanResults];
      res.json({ ok: true, results });
    } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── 前端用：好友 ──
  app.post('/api/lan/friend-request', requireAuth, async (req, res) => {
    try {
      // v2.0.11: 优先使用 body 中的 fromUserId（前端传的是本地用户ID），
      // 仅在 body 没有时才从 JWT 中取。之前优先取 JWT sub 导致 auto-admin
      // 模式下 fromUserId 恒为 'admin'，好友申请记错发送者，接收方看不到申请。
      const { fromUserId: bodyFromUserId, toNumericId, message } = req.body || {};
      const jwtSub = (req as any).user?.sub;
      // 如果 JWT 是 auto-admin 回退模式（sid=admin-auto/admin-token），不用 admin 作为 fromUserId
      const isAutoAdmin = (req as any).user?.sid === 'admin-auto' || (req as any).user?.sid === 'admin-token' || jwtSub === 'admin';
      const fromUserId = bodyFromUserId || (!isAutoAdmin ? jwtSub : '');
      if (!fromUserId || !toNumericId) return res.status(400).json({ error: 'fromUserId 和 toNumericId 必填' });
      const r = await lanSocial.sendFriendRequest(fromUserId, Number(toNumericId), message || '');
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/lan/friend-requests', requireAuth, (req, res) => {
    let userId = (req.query.userId as string) || '';
    // v2.0.10: userId 为空时从 JWT 中获取（platformApi 不带 query param 的场景）
    if (!userId && (req as any).user) {
      userId = String((req as any).user.sub || '');
    }
    res.json({ ok: true, ...lanSocial.friendRequests(userId) });
  });

  app.post('/api/lan/friend-respond', requireAuth, async (req, res) => {
    try {
      const { requestId, action } = req.body || {};
      if (!requestId || !action) return res.status(400).json({ error: 'requestId 和 action 必填' });
      const r = await lanSocial.respondFriendRequest(requestId, action);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/lan/friends', requireAuth, (req, res) => {
    let userId = (req.query.userId as string) || '';
    // v2.0.10: userId 为空时从 JWT 中获取
    if (!userId && (req as any).user) {
      userId = String((req as any).user.sub || '');
    }
    res.json({ ok: true, friends: lanSocial.friends(userId) });
  });

  // ── 前端用：群组 ──
  app.post('/api/lan/group-create', requireAuth, async (req, res) => {
    try {
      const { name, memberNumericIds, chatMode } = req.body || {};
      const ownerUserId = lanUserId(req, req.body?.ownerUserId);
      if (!ownerUserId || !name) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.createGroup(ownerUserId, name, Array.isArray(memberNumericIds) ? memberNumericIds.map(Number) : [], chatMode || 'free');
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.get('/api/lan/groups', requireAuth, (_req, res) => {
    res.json({ ok: true, groups: lanSocial.listGroups() });
  });

  app.get('/api/lan/group', requireAuth, (req, res) => {
    const groupId = (req.query.groupId as string) || '';
    const g = lanSocial.getGroup(groupId);
    if (!g) return res.status(404).json({ error: '群组不存在' });
    res.json({ ok: true, group: g });
  });

  app.post('/api/lan/group-mode', requireAuth, async (req, res) => {
    try {
      const { groupId, mode } = req.body || {};
      const r = await lanSocial.setGroupMode(groupId, mode);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // 群人类聊天发消息
  app.post('/api/lan/group-message', requireAuth, async (req, res) => {
    try {
      const { groupId, content } = req.body || {};
      const senderUserId = lanUserId(req, req.body?.senderUserId);
      if (!senderUserId || !groupId || !content) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.sendHumanMessage(senderUserId, groupId, content);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // 群智能体聊天发话题（触发多智能体编排）
  app.post('/api/lan/group-agent-topic', requireAuth, async (req, res) => {
    try {
      const { groupId, topic } = req.body || {};
      const senderUserId = lanUserId(req, req.body?.senderUserId);
      if (!senderUserId || !groupId || !topic) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.postAgentTopic(senderUserId, groupId, topic);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── 邻居引擎互调接收端（X-LingXi-LAN-Proto 鉴权）──
  // 处理结果若含 error，则返回非 2xx（默认 400），让发送方 sendToPeer 能通过 !resp.ok 感知失败，
  // 而不是把逻辑错误伪装成 HTTP 200。
  const sendPeerResult = (res: any, result: any) => {
    if (result && result.error) res.status(result.status || 400).json(result);
    else res.json(result);
  };
  app.post('/api/lan/peer/friend-request', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleIncomingFriendRequest(req.body));
  });
  app.post('/api/lan/peer/friend-accept', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleFriendAccept(req.body));
  });
  app.post('/api/lan/peer/group-invite', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleGroupInvite(req.body));
  });
  app.post('/api/lan/peer/group-message', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleGroupMessage(req.body));
  });
  app.post('/api/lan/peer/group-mode', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    sendPeerResult(res, lanSocial.handleGroupMode(req.body));
  });
  app.post('/api/lan/peer/agent-invoke', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    try {
      // P0-1: pass request IP for source validation
      (req.body as any)._requestIp = String((req as any).ip || (req as any).socket?.remoteAddress || '').replace(/^::ffff:/, '');
      sendPeerResult(res, await lanSocial.handleAgentInvoke(req.body));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ── 新增：删除好友/群组 API ──
  app.post('/api/lan/remove-friend', requireAuth, async (req, res) => {
    try {
      const { friendId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!userId || !friendId) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.removeFriend!(userId, friendId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/lan/delete-group', requireAuth, async (req, res) => {
    try {
      const { groupId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!userId || !groupId) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.deleteGroup!(userId, groupId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/lan/leave-group', requireAuth, async (req, res) => {
    try {
      const { groupId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!userId || !groupId) return res.status(401).json({ error: '未登录或身份无效' });
      const r = await lanSocial.leaveGroup!(userId, groupId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── 新增 peer 路由：跨实例通知 ──
  app.post('/api/lan/peer/friend-remove', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    const { userId, friendId } = req.body || {};
    if (!userId || !friendId) return res.status(400).json({ error: 'userId/friendId 必填' });
    try {
      const r = await lanSocial.removeFriend!(userId, friendId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/lan/peer/group-deleted', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    const { groupId } = req.body || {};
    if (!groupId) return res.status(400).json({ error: 'groupId 必填' });
    try {
      const r = await lanSocial.deleteGroup!('', groupId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/lan/peer/group-member-left', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    const { groupId, userId } = req.body || {};
    if (!groupId || !userId) return res.status(400).json({ error: 'groupId/userId 必填' });
    try {
      const r = await lanSocial.leaveGroup!(userId, groupId);
      res.json(r);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── 个人中心 + 积分 + 评价 ──
  // ── 方案C：群邀请确认 API ──

  /** 查看待确认的群邀请 */
  app.get('/api/lan/group-invites', requireAuth, (req, res) => {
    try {
      const userId = lanUserId(req, String(req.query.userId || ''));
      if (!userId) return res.status(401).json({ error: '未登录或身份无效' });
      const invites = lanSocial.listPendingInvites(userId);
      res.json({ ok: true, invites });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /** 接受群邀请（A手动确认） */
  app.post('/api/lan/group-invite/accept', requireAuth, async (req, res) => {
    try {
      const { inviteId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!inviteId || !userId) return res.status(401).json({ error: '未登录或身份无效' });
      const result = await lanSocial.acceptGroupInvite(inviteId, userId);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** 拒绝群邀请 */
  app.post('/api/lan/group-invite/reject', requireAuth, (req, res) => {
    try {
      const { inviteId } = req.body || {};
      const userId = lanUserId(req, req.body?.userId);
      if (!inviteId || !userId) return res.status(401).json({ error: '未登录或身份无效' });
      const result = lanSocial.rejectGroupInvite(inviteId, userId);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /** 接收远程接受回调（创建者引擎接收到被邀请者已接受的通知） */
  app.post('/api/lan/peer/group-invite-accepted', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    try {
      const result = lanSocial.handleGroupInviteAccepted(req.body);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  app.get('/api/profile', requireAuth, async (req, res) => {
    try {
      const userId = (req.query.userId as string) || '';
      // P1-2 修复: 查看他人资料需校验关系（本人/好友/同群成员/管理员）
      const jwtUser = (req as any).user;
      const jwtSub = String(jwtUser?.sub || '');
      const jwtNumericId = String(jwtUser?.numeric_id || '');
      const isAdmin = (jwtUser?.roles || []).includes('admin');
      if (userId && !isAdmin) {
        const isSelf = userId === jwtSub || userId === jwtNumericId;
        if (!isSelf) {
          let isFriend = false, isSameChat = false;
          try {
            const friends = db.listFriends ? db.listFriends(jwtSub || jwtNumericId) : [];
            isFriend = friends.some((f: any) => String(f.user_id || f.id) === userId);
          } catch {}
          if (!isFriend) {
            try {
              const chats = db.listChats ? db.listChats() : [];
              for (const c of chats) {
                const parts = db.getChatParticipants(c.id) || [];
                const meIn = parts.some((p: any) => String(p.user_id) === jwtSub || String(p.user_id) === jwtNumericId);
                const targetIn = parts.some((p: any) => String(p.user_id) === userId);
                if (meIn && targetIn) { isSameChat = true; break; }
              }
            } catch {}
          }
          if (!isFriend && !isSameChat) {
            return res.status(403).json({ error: '无权查看此用户资料' });
          }
        }
      }
      const platformApiUrl = (globalThis as any).__platformApiUrl || '';
      const platformAdminToken = (globalThis as any).__platformAdminToken || '';

      // 优先从平台获取用户资料
      if (platformApiUrl && platformAdminToken) {
        try {
          // 先用 admin token 获取用户详情
          const resp = await fetch(`${platformApiUrl}/api/admin/users/${userId.replace(/^\D+/, '')}?token=${platformAdminToken}`);
          const d = await resp.json() as any;
          if (d.ok && d.user) {
            const pu = d.user;
            const usage = UsageTracker.getStats();
            // 获取评价数（引擎本地）
            const ratingStmt = getDB().prepare('SELECT COUNT(*) as count, AVG(rating) as avg FROM message_ratings WHERE user_id = ?');
            ratingStmt.bind([String(pu.id)]);
            const ratingRow = ratingStmt.step() ? ratingStmt.getAsObject() : { count: 0, avg: 0 };
            ratingStmt.free();
            return res.json({
              ok: true,
              profile: {
                id: String(pu.id),
                numeric_id: pu.id,
                display_name: pu.username,
                email: pu.email || '',
                status: pu.status || 'active',
                created_at: pu.created_at,
              },
              credits: pu.points || 0,
              totalEarned: 0,
              totalSpent: 0,
              usage: usage.total,
              ratings: { count: ratingRow.count || 0, avgRating: ratingRow.avg || 0 },
            });
          }
        } catch (e: any) {
          // 平台不可达，回退到本地
        }
      }

      // 回退：本地 main.db 获取用户资料
      let user = db.getUserByEmail(userId) || db.getUser(userId);
      if (!user) {
        return res.status(404).json({ ok: false, error: '用户不存在' });
      }
      const credits = getDB().prepare('SELECT * FROM user_credits WHERE user_id = ?');
      credits.bind([user.id]);
      const creditRow = credits.step() ? credits.getAsObject() : null;
      credits.free();
      const usage = UsageTracker.getStats();
      const ratingStmt = getDB().prepare('SELECT COUNT(*) as count, AVG(rating) as avg FROM message_ratings WHERE user_id = ?');
      ratingStmt.bind([user.id]);
      const ratingRow = ratingStmt.step() ? ratingStmt.getAsObject() : { count: 0, avg: 0 };
      ratingStmt.free();
      res.json({
        ok: true,
        profile: {
          id: user.id,
          numeric_id: user.numeric_id,
          display_name: user.display_name,
          email: user.email,
          status: user.status,
          created_at: user.created_at,
        },
        credits: creditRow?.credits || 1000,
        totalEarned: creditRow?.total_earned || 0,
        totalSpent: creditRow?.total_spent || 0,
        usage: usage.total,
        ratings: { count: ratingRow.count || 0, avgRating: ratingRow.avg || 0 },
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/credits/deduct', requireAuth, (req, res) => {
    try {
      const { userId, amount, reason } = req.body || {};
      const amt = Number(amount);
      if (!userId || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'userId/amount 必填且 amount 必须为正数' });
      const now = Date.now();
      const stmt = getDB().prepare('UPDATE user_credits SET credits = credits - ?, total_spent = total_spent + ?, updated_at = ? WHERE user_id = ? AND credits >= ?');
      stmt.bind([amt, amt, now, userId, amt]);
      stmt.step();
      const changes = getDB().getRowsModified();
      stmt.free();
      if (changes === 0) {
        const checkStmt = getDB().prepare('SELECT credits FROM user_credits WHERE user_id = ?');
        checkStmt.bind([userId]);
        const row = checkStmt.step() ? checkStmt.getAsObject() : null;
        checkStmt.free();
        return res.status(400).json({ error: '积分不足', current: row?.credits || 0 });
      }
      const balStmt = getDB().prepare('SELECT credits FROM user_credits WHERE user_id = ?');
      balStmt.bind([userId]);
      const balRow = balStmt.step() ? balStmt.getAsObject() : null;
      balStmt.free();
      res.json({ ok: true, balance: balRow?.credits || 0 });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/credits/award', requireAuth, (req, res) => {
    // P1-3 修复: 积分发放仅管理员可用
    const roles = (req as any).user?.roles || [];
    if (!roles.includes('admin')) return res.status(403).json({ error: '仅管理员可发放积分' });
    try {
      const { userId, amount, reason } = req.body || {};
      const amt = Number(amount);
      if (!userId || !Number.isFinite(amt) || amt <= 0) return res.status(400).json({ error: 'userId/amount 必填且 amount 必须为正数' });
      const now = Date.now();
      const stmt = getDB().prepare(`INSERT INTO user_credits (user_id, credits, total_earned, total_spent, updated_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(user_id) DO UPDATE SET credits = credits + ?, total_earned = total_earned + ?, updated_at = ?`);
      stmt.bind([userId, 1000 + amt, amt, now, amt, amt, now]);
      stmt.step(); stmt.free();
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

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


  // ── 多实例联邦通信 ──
  // 其他灵犀实例可以注册自己，消息可以跨实例转发
  // ── 联邦通信鉴权 ──
  // 安全：不再提供默认密钥，未配置 FEDERATION_SECRET 时联邦功能整体禁用
  const FEDERATION_SECRET = process.env.FEDERATION_SECRET || '';
  function federationAuth(req: any, res: any, next: any) {
    if (!FEDERATION_SECRET) return res.status(403).json({ error: '联邦通信未启用（请配置 FEDERATION_SECRET）' });
    const secret = String(req.headers['x-federation-secret'] || req.body?.secret || '');
    const a = Buffer.from(secret); const b = Buffer.from(FEDERATION_SECRET);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(403).json({ error: '联邦通信密钥错误' });
    next();
  }

  app.post('/api/federation/register', requireAuth, federationAuth, (req, res) => {
    try {
      const { instanceId, baseUrl, name } = req.body || {};
      if (!instanceId || !baseUrl) return res.status(400).json({ error: 'instanceId/baseUrl 必填' });
      // 记录远程实例
      if (!(globalThis as any).__federationPeers) (globalThis as any).__federationPeers = new Map();
      (globalThis as any).__federationPeers.set(instanceId, { id: instanceId, baseUrl, name: name || instanceId, lastSeen: Date.now() });
      console.log(`[Federation] 实例已注册: ${name} (${baseUrl})`);
      res.json({ ok: true, ourId: process.env.INSTANCE_ID || 'local', ourUrl: 'http://' + req.headers.host });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get('/api/federation/peers', requireAuth, (_req, res) => {
    const peers = (globalThis as any).__federationPeers;
    if (!peers) return res.json({ ok: true, peers: [] });
    res.json({ ok: true, peers: Array.from(peers.values()) });
  });

  // 接收远程实例转发的消息
  app.post('/api/federation/message', requireAuth, federationAuth, async (req, res) => {
    try {
      const { chatId, content, senderId, senderName, fromInstance } = req.body || {};
      if (!chatId || !content) return res.status(400).json({ error: 'chatId/content 必填' });
      // 把远程消息当作用户消息处理
      const result = await router.handleIncoming({
        chatId, senderType: 'user', senderId: senderId || 'remote',
        content: `[${senderName || '远程'}] ${content}`,
      });
      // 广播给本地客户端
      broadcast({ type: 'message.new', chatId, from: senderId || 'remote', senderType: 'user', content: `[${senderName || '远程'}] ${content}`, timestamp: Date.now() });
      // 触发本地 AI 回复
      for (const resp of result.responses) {
        const replyContent = await router.generateReply(chatId, resp.agentId, resp.triggerMessage.id);
        if (replyContent) {
          broadcast({ type: 'message.new', chatId, from: 'agent:' + resp.agentId, senderType: 'agent', content: replyContent, timestamp: Date.now() });
        }
      }
      res.json({ ok: true, replies: result.responses.length });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // 前端：发送消息到远程实例
  app.post('/api/federation/send', requireAuth, federationAuth, async (req, res) => {
    try {
      const { targetInstance, chatId, content, senderId, senderName } = req.body || {};
      const peers = (globalThis as any).__federationPeers;
      if (!peers || !peers.has(targetInstance)) return res.status(404).json({ error: '目标实例未注册' });
      const peer = peers.get(targetInstance);
      const resp = await fetch(peer.baseUrl + '/api/federation/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, content, senderId, senderName, fromInstance: process.env.INSTANCE_ID || 'local' }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json();
      res.json(data);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });


  // ── 群聊协作模式（持久化于 chats.chat_mode，重启不丢）──
  app.get('/api/chats/:id/mode', requireAuth, (req, res) => {
    const mode = getChatMode(req.params.id as string);
    res.json({ ok: true, mode, modes: [...CHAT_MODES] });
  });

  app.post('/api/chats/:id/mode', requireAuth, (req, res) => {
    try {
      const { mode } = req.body || {};
      if (!setChatMode(req.params.id as string, mode)) {
        return res.status(400).json({ error: '无效模式，可选: ' + CHAT_MODES.join(', ') });
      }
      res.json({ ok: true, mode });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // v1.4 工作区模式兼容 API
  app.get('/api/workspace-mode', requireAuth, (req, res) => {
    const mode = (globalThis as any).__workspaceMode || 'personal';
    const root = (globalThis as any).__workspaceRoot || process.cwd();
    res.json({ mode, collabMode: mode === 'collab', workspaceRoot: root });
  });
  app.post('/api/workspace-mode', requireAuth, (req, res) => {
    const { mode, workspaceRoot } = req.body || {};
    const newMode = mode === 'collab' ? 'collab' : 'personal';
    const newRoot = workspaceRoot || process.cwd();
    (globalThis as any).__workspaceMode = newMode;
    (globalThis as any).__workspaceRoot = newRoot;
    res.json({ mode: newMode, collabMode: newMode === 'collab', workspaceRoot: newRoot });
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
  // 标签 API
  app.get('/api/tags', requireAuth, (req, res) => {
    res.json({
      ok: true,
      tags: ['技术', '产品', '设计', '运营', 'SRE', 'AI', '工具', '游戏', '音乐', '写作', '翻译', '法律', '教育', '金融', '医疗', '其他']
    });
  });

  // 时间工具 API
  app.get('/api/time', (req, res) => {
    const now = new Date();
    res.json({
      iso: now.toISOString(),
      local: now.toLocaleString('zh-CN'),
      unix: now.getTime(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
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

  process.on('SIGINT', async () => {
    console.log('Closing...');
    cronScheduler.stop();
    sessionManager.close();
    telegramAdapter?.stop();
    await channelManager.closeAll();
    await browserManager.close();
    await mcpManager.closeAll();
    await closeDB(dbPath);
    server.close();
    process.exit(0);
  });
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

// ═══ 优雅退出 ═══
let _shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n[Shutdown] 收到 ${signal}，开始优雅退出...`);
  try { await saveToDisk(); console.log('[Shutdown] 数据库已保存'); } catch (e: unknown) { console.error('[Shutdown] 保存失败:', (e as Error)?.message); }
  try { await closeDB(); console.log('[Shutdown] 数据库已关闭'); } catch (e: unknown) {}
  console.log('[Shutdown] 退出完成');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));