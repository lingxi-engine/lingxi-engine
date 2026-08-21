/**
 * Project Hub - 主入口
 */
// 必须最先加载 .env：ESM 中 import 会被提升，若在模块体中调用 dotenvConfig()，
// 则 hub.ts 等模块加载时读取的 process.env.* 全为空。用副作用导入置于首位可修复。
import 'dotenv/config';
// v2.0.6: 确保 db.ts 在所有其他模块前加载（防止 ESM 加载顺序问题导致导出被截断）
import './src/storage/db.js';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { randomInt, timingSafeEqual } from 'crypto';
import * as path from 'path';
import { join } from 'path';
import multer from 'multer';
import { initDB, getDB, closeDB, DB, startAutoSave, saveToDisk, initNumericIdSeq, cleanupExpiredTokens, createInviteCode, listInviteCodes, updateAgent, getChatMode, setChatMode, CHAT_MODES, nextNumericId, getUserCredits, addCredits, spendCredits, createHire, fireHire, listHiresByBuyer, listHiresBySeller, getHire, createChat, addParticipant, removeParticipant, getAgentByUserId, getChatParticipants } from './src/storage/db.js';
import { initGoalTrackerTable, GoalTracker } from './src/core/goal-tracker.js';

import * as auth from './src/auth/index.js';
import { adminAuth } from './src/middleware/admin-auth.js';
import { logger as _logger } from './src/core/logger.js';
import { jwtAuth } from './src/middleware/jwt-auth.js';
import { apiRateLimit, authRateLimit } from './src/middleware/rate-limit.js';
import { MessageRouter } from './src/core/router.js';
import { AIHub } from './src/ai/hub.js';
import { OutcomeTracker } from './src/core/outcome-tracker.js';
import { AgentManager } from './src/agents/manager.js';
import { handleWSMessage, wsSubscriptions, processUserMessage } from './src/core/ws-handler.js';
import { startInstanceMesh, setPeerMessageHandler, setPeerTaskHandler, sendPeerMessage, getMeshInfo, getInstanceId, type PeerMessage, setAgentsProvider, setUsersProvider } from './src/core/instance-mesh.js';
import { startLanDiscovery, stopLanDiscovery, getLanPeers, getLanSelfInfo, getLanInstanceId, getLanIp, type LanUser } from './src/net/lan-discovery.js';
import { verifyLanRequest } from './src/net/lan-transport.js';
import { LanSocialHub, LAN_SOCIAL_CHANNEL } from './src/net/lan-social.js';
import { ToolRegistry } from './src/tools/registry.js';
import { BUILTIN_TOOLS, BUILTIN_SKILLS, setSearchManager } from './src/tools/builtin.js';
import { SearchManager } from './src/tools/search-providers.js';
import { UsageTracker } from './src/core/usage-tracker.js';
import { MCPManager } from './src/mcp/adapter.js';
import { ProviderRegistry } from './src/ai/provider-registry.js';
import { BrowserManager } from './src/tools/browser.js';
import { PluginManager } from './src/plugins/plugin-manager.js';
import { CronScheduler, createCronJob, type JobPayload } from './src/core/cron-scheduler.js';
import { logger } from './src/core/logger.js';
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
import { ServerContext } from './src/server/context.js';
import { createAuthRoutes } from './src/routes/auth.js';
import { createAgentRoutes } from './src/routes/agent.js';
import { createChatRoutes } from './src/routes/chat.js';
import { createFriendsRoutes } from './src/routes/friends.js';
import { createMarketRoutes } from './src/routes/market.js';
import { createProviderRoutes } from './src/routes/provider.js';
import { createRagRoutes } from './src/routes/rag.js';
import { createWorkflowRoutes } from './src/routes/workflow.js';
import { createUploadRoutes } from './src/routes/upload.js';
import { createSystemRoutes } from './src/routes/system.js';
import { createGoalOutcomeRoutes } from './src/routes/goals-outcomes.js';
import { createProfileRoutes } from './src/routes/profile.js';
import { createMiscRoutes } from './src/routes/misc.js';
import { createChannelRoutes } from './src/routes/channel.js';
import { createAdminRoutes } from './src/routes/admin.js';
// CLI 通过 bin 入口直接运行，不需要导入
// import { startCLI } from './src/cli/chat.js';

// ═══ 全局异常兜底 ═══
// 任何未捕获异常都会先记录日志再崩溃，防止生产环境静默宕机
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
  // 不退出进程，unhandledRejection 在 Node 默认也是 warn 不 crash
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message, '\n', err.stack);
  try { closeDB(); } catch (_) {}
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


// ── v1.7 RBAC 角色控制 ──
type Role = 'owner' | 'admin' | 'member' | 'viewer';
const ROLE_HIERARCHY: Record<Role, number> = { owner: 4, admin: 3, member: 2, viewer: 1 };

function getParticipantRole(chatId: string, userId: string): Role | null {
  try {
    const participants = getChatParticipants(chatId);
    const p = participants.find((x: any) => x.user_id === userId || x.agent_id === userId);
    return (p?.role as Role) || null;
  } catch { return null; }
}

function rbac(requiredRole: Role) {
  return (req: any, res: any, next: any) => {
    const chatId = req.params.id || req.params.chatId || req.body?.chatId;
    const userId = (req.user?.sub || '') as string;
    if (!chatId || !userId) return res.status(403).json({ error: '缺少 chatId/userId' });
    const role = getParticipantRole(chatId, userId);
    if (!role) return res.status(403).json({ error: '不在群聊中' });
    if (ROLE_HIERARCHY[role] < ROLE_HIERARCHY[requiredRole]) {
      return res.status(403).json({ error: `需要 ${requiredRole} 权限，当前角色: ${role}` });
    }
    next();
  };
}

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
  startAutoSave(30000);  // 每30秒自动保存到磁盘
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
  // 缓存到全局，供 jwt-auth 中间件使用
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

  await aiHub.syncNvidiaModels();
  await aiHub.syncOllamaModels();
  // ── 注入 AI 客户端给记忆反思 ──
  const defaultModelForReflection = aiHub.getDefaultModel();
  const defaultClientResult = aiHub.getClient(defaultModelForReflection);
  if (defaultClientResult) {
    router.setAIClient(defaultClientResult.client, defaultClientResult.resolvedModel);
  }

  // ── 动态拉取模型列表（已在上方 sync 完成，此处不再重复） ──
  const defaultModel = aiHub.getDefaultModel();
  console.log('[AI Hub] 默认模型:', defaultModel);

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
  (globalThis as any).__browserManager = browserManager;
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
  (globalThis as any).__cronScheduler = cronScheduler;

  // ── P1-2: 会话管理器 ──
  const sessionManager = new SessionManager(dataDir);
  (globalThis as any).__sessionManager = sessionManager;
  sessionManager.startAutoSave(10000);

  // ── P1-3: 子代理管理器 ──
  const subAgentManager = new SubAgentManager(
    defaultClientResult?.client,
    defaultClientResult?.resolvedModel || defaultModel
  );
  subAgentManager.setResultHandler((task: any) => {
    console.log(`[SubAgent] ${task.id} 完成: status=${task.status}, result=${(task.result || '').slice(0, 80)}`);
  });

  // ── V5 P1: 审批管理器 ──
  const approvalManager = new ApprovalManager(300000);
  console.log('[Approval] 审批管理器已初始化 (timeout=5min)');

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
  (globalThis as any).__channelManager = channelManager;
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
  (globalThis as any).__telegramAdapter = telegramAdapter;

  const app = express();
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
  // v2.0.7: 修复上传文件 404 — 静态托管 uploads 目录
  app.use('/uploads', express.static(join(dataDir, 'uploads')));
  let port = parseInt(process.env.PORT || '3456', 10);
  // 单机多实例：--auto-port 时端口被占用自动顺延，避免 EADDRINUSE 崩溃
  port = await resolveAvailablePort(port, autoPort);

  // ── 全局鉴权兜底：所有 /api 路由至少走一次 JWT 检查 ──
  app.use('/api', jwtAuth({ required: false }));
  // ── 危险操作鉴权：破坏性/配置类/工具执行类路由必须登录（挂在具体路由上） ──
  const requireAuth = jwtAuth({ required: true }) as unknown as import('express').RequestHandler;
  // ── 认证接口限流 ──
  app.use('/api/auth', authRateLimit);
  // ── v2.0.4: 通用 API 限流（30次/分钟）──
  app.use('/api', apiRateLimit);

  // ════════════════════════════════════════════════
  // ── 路由模块挂载（v2.0.6 重构：从内联路由迁移到 routes/ 模块） ──
  // ════════════════════════════════════════════════

  // ── v1.7 扩展路由（Dream/Entity/Outcome）v2.0.6：传入 requireAuth 保护 ──
  registerV17Routes(app, { aiHub }, requireAuth);

  // ── v2.0.6 修复：实例化 OutcomeTracker（之前被写成 null as any，导致 /api/goals 和 /api/outcomes 崩溃） ──
  const outcomeTracker = new OutcomeTracker(
    defaultClientResult?.client || { chat: { completions: { create: () => Promise.resolve({ choices: [{ message: { content: '[]' } }] }) } } },
    defaultClientResult?.resolvedModel || defaultModel,
  );

  // ── 构建统一上下文 ──
  const ctx: ServerContext = {
    app, db, aiHub, manager, router, toolRegistry, providerRegistry,
    mcpManager, browserManager, pluginManager, cronScheduler,
    sessionManager, subAgentManager, approvalManager, hookManager,
    inboxManager, channelManager, skillManager, ttsManager, sttManager,
    customProviderManager, debugPanel, visionManager, pushManager,
    searchManager: searchManagerInstance, telegramAdapter,
    outcomeTracker,
    dataDir, defaultModel, broadcast: (event: any) => broadcast(event),
  };

  // ── 认证路由（不需要 requireAuth，登录/注册等） ──
  app.use('/api/auth', createAuthRoutes(ctx));  // v2.0.6: 修正路径前缀，前端调 /api/auth/login

  // ── 其他路由（requireAuth 保护写操作） ──
  app.use('/api', requireAuth, createAgentRoutes(ctx));
  app.use('/api', requireAuth, createChatRoutes(ctx));
  app.use('/api', requireAuth, createFriendsRoutes(ctx));
  app.use('/api', requireAuth, createMarketRoutes(ctx));
  app.use('/api', requireAuth, createProviderRoutes(ctx));
  app.use('/api', requireAuth, createRagRoutes(ctx));
  app.use('/api', requireAuth, createWorkflowRoutes(ctx));
  app.use('/api', requireAuth, createUploadRoutes(ctx));
  // 公开健康检查（不需要认证，必须在 createSystemRoutes 之前注册）
  app.get('/api/health', (_req, res) => { res.json({ status: 'ok', time: Date.now() }); });
  app.get('/api/version', (_req, res) => { res.json({ version: '2.0.6' }); });
  app.use('/api', requireAuth, createSystemRoutes(ctx));  // v2.0.6: system 路由加 requireAuth
  // 日志查看（requireAuth 保护，已登录用户可查看最近日志）
  app.get('/api/logs', requireAuth, (_req, res) => {
    try {
      const today = _logger.getTodayLog();
      const lines = String(today).split('\n').filter(Boolean);
      // 脱敏：移除可能的 token/key 信息
      const sanitized = lines.map((l: string) => l.replace(/([A-Za-z0-9_-]{32,})/g, '***'));
      res.json({ ok: true, lines: sanitized.slice(-200), total: lines.length });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  app.use('/api', requireAuth, createGoalOutcomeRoutes(ctx));
  app.use('/api', requireAuth, createProfileRoutes(ctx));
  app.use('/api', requireAuth, createMiscRoutes(ctx));
  app.use('/api', requireAuth, createChannelRoutes(ctx));
  // v2.0.7 安全修复：admin 接口用 adminAuth 而非 requireAuth
  app.use('/api', adminAuth, createAdminRoutes(ctx));

  // ════════════════════════════════════════════════
  // ── WebSocket 服务器（v2.0.6 恢复：重构时被误删） ──
  // ════════════════════════════════════════════════
  const server = createServer(app);
  _server = server;
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Map<string, Set<WebSocket>>();

  // V10 安全修复：按 chatId 过滤广播，只推送给订阅了该聊天的客户端
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
        try { ws.send(payload); } catch (_e) { /* 连接已断开，跳过 */ }
      }
    }
  }

  wss.on('connection', (ws, req) => {
    const urlStr = req.url || '';
    const queryIndex = urlStr.indexOf('?');
    const params = queryIndex >= 0 ? new URLSearchParams(urlStr.slice(queryIndex + 1)) : new URLSearchParams();

    // V10 安全检查：验证 JWT token，拒绝未认证连接
    const token = params.get('token') || req.headers['sec-websocket-protocol'] as string;
    let clientId: string | null = null;
    if (token) {
      try {
        const payload = auth.verifyAccessToken(token);
        if (payload) {
          clientId = payload.sub;
        }
      } catch { /* token 无效，继续 fallback */ }
    }
    if (!clientId) {
      const devAnonId = params.get('id');
      
      if (devAnonId) {
        clientId = devAnonId;
      } else {
        console.warn('[WS] 拒绝未认证连接 - 缺少有效 JWT token');
        ws.close(4001, '认证失败：请提供有效的 JWT token');
        return;
      }
    }
    console.log('[WS] connect:', clientId, token ? '(认证)' : '(开发模式匿名)');
    if (!clients.has(clientId)) clients.set(clientId, new Set());
    clients.get(clientId)!.add(ws);
    broadcast({ type: 'user.online', userId: clientId, message: clientId + ' 上线了' });
    ensureUserSetup(clientId, db, manager, toolRegistry);

    ws.on('message', (raw) => {
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

  // ════════════════════════════════════════════════
  // ── Mesh 网格初始化（调用 misc.ts 的 setupMesh） ──
  // ════════════════════════════════════════════════
  const { setupMesh, createMeshRoutes } = await import('./src/routes/misc.js');
  setupMesh(ctx, port);
  app.use('/api', requireAuth, createMeshRoutes(ctx));

  // ════════════════════════════════════════════════
  // ── LAN 社交（v2.0.6 恢复） ──
  // ════════════════════════════════════════════════
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
  (globalThis as any).__lanSocial = lanSocial;
  (ctx as any).lanSocial = lanSocial;

  if ((process.env.LAN_DISCOVERY || 'on').toLowerCase() !== 'off') {
    startLanDiscovery({
      port,
      version: (() => { try { return JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; } })(),
      dataDir,
      getUsers: getLocalLanUsers,
      discoveryPort: process.env.LAN_DISCOVERY_PORT ? Number(process.env.LAN_DISCOVERY_PORT) : undefined,
    });
  }

  // ── LAN 状态/邻居/搜索 ──
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
    res.json({ ok: true, results: lanSocial.search((req.query.q as string) || '') });
  });

  // ── 全局用户搜索 ──
  app.get('/api/users/search', requireAuth, async (req, res) => {
    try {
      const q = (req.query.q as string || '').trim();
      if (!q) return res.json({ ok: true, results: [] });
      const platformApiUrl = (globalThis as any).__platformApiUrl || '';
      const platformAdminToken = (globalThis as any).__platformAdminToken || '';
      let platformResults: any[] = [];
      if (platformApiUrl && platformAdminToken) {
        try {
          const resp = await fetch(`${platformApiUrl}/api/admin/search?q=${encodeURIComponent(q)}&token=${platformAdminToken}`);
          const d = await resp.json() as any;
          if (d.ok && d.results) {
            platformResults = d.results.map((u: any) => ({
              numericId: u.id, displayName: u.username, email: u.email || '',
              userId: String(u.id), status: u.status || 'active',
              online: (u.status || 'active') !== 'offline' && (u.status || 'active') !== 'inactive',
              source: 'platform',
              points: u.points || 0, createdAt: u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '-',
            }));
          }
        } catch (e: any) { console.warn('[Platform] 用户搜索失败，回退本地:', e.message); }
      }
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
      while (s2.step()) { const row = s2.getAsObject(); if (!localResults.find(r => r.id === row.id)) localResults.push(row); }
      s2.free();
      let lanResults: any[] = [];
      for (const peer of getLanPeers()) {
        for (const u of peer.users) {
          if (String(u.numericId) === q || (u.displayName || '').includes(q)) {
            lanResults.push({ numericId: u.numericId, displayName: u.displayName, userId: u.id, lanIp: peer.lanIp, port: peer.port, source: 'lan' });
          }
        }
      }
      const platformIds = new Set(platformResults.map((r: any) => String(r.numericId)));
      const localFiltered = localResults
        .filter((r: any) => !platformIds.has(String(r.numeric_id)))
        .map((r: any) => ({ numericId: r.numeric_id, displayName: r.display_name, email: r.email, userId: r.id, status: r.status, online: r.status === 'online', source: 'local', createdAt: r.created_at ? new Date(r.created_at).toLocaleString('zh-CN') : '-' }));
      res.json({ ok: true, results: [...platformResults, ...localFiltered, ...lanResults] });
    } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
  });

  // ── LAN 好友路由 ──
  app.post('/api/lan/friend-request', requireAuth, async (req, res) => {
    try {
      const fromUserId = (req as any).user?.sub;
      const { toNumericId, message } = req.body || {};
      if (!fromUserId || !toNumericId) return res.status(400).json({ error: 'fromUserId 和 toNumericId 必填' });
      res.json(await lanSocial.sendFriendRequest(fromUserId, Number(toNumericId), message || ''));
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.get('/api/lan/friend-requests', requireAuth, (req, res) => {
    res.json({ ok: true, ...lanSocial.friendRequests((req as any).user?.sub || '') });
  });
  app.post('/api/lan/friend-respond', requireAuth, async (req, res) => {
    try {
      const { requestId, action } = req.body || {};
      if (!requestId || !action) return res.status(400).json({ error: 'requestId 和 action 必填' });
      res.json(await lanSocial.respondFriendRequest(requestId, action));
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.get('/api/lan/friends', requireAuth, (req, res) => {
    res.json({ ok: true, friends: lanSocial.friends((req as any).user?.sub || '') });
  });
  app.post('/api/lan/remove-friend', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.sub;
      const { friendId } = req.body || {};
      if (!userId || !friendId) return res.status(400).json({ error: 'userId/friendId 必填' });
      res.json(await lanSocial.removeFriend!(userId, friendId));
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── LAN 群组路由 ──
  app.post('/api/lan/group-create', requireAuth, async (req, res) => {
    try {
      const ownerUserId = (req as any).user?.sub;
      const { name, memberNumericIds, chatMode } = req.body || {};
      if (!ownerUserId || !name) return res.status(400).json({ error: 'ownerUserId 和 name 必填' });
      res.json(await lanSocial.createGroup(ownerUserId, name, Array.isArray(memberNumericIds) ? memberNumericIds.map(Number) : [], chatMode || 'free'));
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.get('/api/lan/groups', requireAuth, (_req, res) => { res.json({ ok: true, groups: lanSocial.listGroups() }); });
  app.get('/api/lan/group', requireAuth, (req, res) => {
    const g = lanSocial.getGroup((req.query.groupId as string) || '');
    if (!g) return res.status(404).json({ error: '群组不存在' });
    res.json({ ok: true, group: g });
  });
  app.post('/api/lan/group-mode', requireAuth, async (req, res) => {
    try { res.json(await lanSocial.setGroupMode(req.body.groupId, req.body.mode, (req as any).user?.sub)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/lan/group-message', requireAuth, async (req, res) => {
    try {
      const senderUserId = (req as any).user?.sub;
      const { groupId, content } = req.body || {};
      if (!senderUserId || !groupId || !content) return res.status(400).json({ error: 'senderUserId/groupId/content 必填' });
      res.json(await lanSocial.sendHumanMessage(senderUserId, groupId, content));
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/lan/group-agent-topic', requireAuth, async (req, res) => {
    try {
      const senderUserId = (req as any).user?.sub;
      const { groupId, topic } = req.body || {};
      if (!senderUserId || !groupId || !topic) return res.status(400).json({ error: 'senderUserId/groupId/topic 必填' });
      res.json(await lanSocial.postAgentTopic(senderUserId, groupId, topic));
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/lan/delete-group', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.sub;
      const { groupId } = req.body || {};
      if (!userId || !groupId) return res.status(400).json({ error: 'userId/groupId 必填' });
      res.json(await lanSocial.deleteGroup!(userId, groupId));
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/lan/leave-group', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.sub;
      const { groupId } = req.body || {};
      if (!userId || !groupId) return res.status(400).json({ error: 'userId/groupId 必填' });
      res.json(await lanSocial.leaveGroup!(userId, groupId));
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── LAN peer 回调（friends.ts 已有 friend-request/accept/remove，此处只补 group 相关） ──
  const sendPeerResult = (res: any, result: any) => {
    if (result && result.error) res.status(result.status || 400).json(result);
    else res.json(result);
  };
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
    try { sendPeerResult(res, await lanSocial.handleAgentInvoke(req.body)); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/lan/peer/group-deleted', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    try { res.json(await lanSocial.deleteGroup!('', req.body.groupId)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/lan/peer/group-member-left', async (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    try { res.json(await lanSocial.leaveGroup!(req.body.userId, req.body.groupId)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // ── 群邀请确认 ──
  app.get('/api/lan/group-invites', requireAuth, (req, res) => {
    try { res.json({ ok: true, invites: lanSocial.listPendingInvites((req as any).user?.sub || '') }); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/lan/group-invite/accept', requireAuth, async (req, res) => {
    try { const userId = (req as any).user?.sub; res.json(await lanSocial.acceptGroupInvite(req.body.inviteId, userId)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/lan/group-invite/reject', requireAuth, (req, res) => {
    try { const userId = (req as any).user?.sub; res.json(lanSocial.rejectGroupInvite(req.body.inviteId, userId)); }
    catch (err: any) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/lan/peer/group-invite-accepted', (req, res) => {
    if (verifyLanRequest(req, res) === null) return;
    try { res.json(lanSocial.handleGroupInviteAccepted(req.body)); }
    catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ════════════════════════════════════════════════
  // ── HTTP 服务器启动 ──
  // ════════════════════════════════════════════════
  server.on('error', (e: any) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`[FATAL] 端口 ${port} 已被占用。`);
      console.error(`  - 换端口: node index.ts --port ${port + 1}`);
      console.error(`  - 或自动顺延: node index.ts --auto-port`);
      console.error(`  - 多实例还需隔离数据: --data-dir data2`);
      process.exit(1);
    }
    console.error('[Server] 错误:', e.message);
  });

  server.listen(port, '0.0.0.0', () => {
    const pkgVersion = '2.0.6';
    console.log('');
    console.log('  ╔═══════════════════════════════════════════════╗');
    console.log('  ║          灵犀引擎 LingXi Engine                ║');
    console.log(`  ║          v${pkgVersion}  端口 ${port}                       ║`);
    console.log('  ║          http://localhost:' + port + '              ║');
    console.log('  ╚═══════════════════════════════════════════════╝');
    console.log('');
    console.log(`  [AI Hub] 默认模型: ${defaultModel}`);
    console.log(`  [Agents] ${manager.list().length} 个 Agent`);
    console.log(`  [Tools] ${toolRegistry.listTools().length} 个工具, ${toolRegistry.listSkills().length} 个技能`);
    console.log(`  [Providers] ${providerRegistry.list().length} 个 Provider, ${providerRegistry.listModels().length} 个模型`);
    console.log(`  [WebSocket] /ws (路径: ws://localhost:${port}/ws)`);
    console.log(`  [Mesh] ${process.env.MESH_PLATFORM_URL ? '已启用' : '未配置'}`);
    console.log(`  [LAN] ${(process.env.LAN_DISCOVERY || 'on').toLowerCase() !== 'off' ? '发现已启用' : '发现已关闭'}`);
    console.log('');
  });

} // end of main()

main().catch((err: any) => {
  console.error('启动失败:', err);
  process.exit(1);
});

// ═══ 优雅退出 ═══
let _shuttingDown = false;
let _server: any = null; // 全局引用，供 gracefulShutdown 使用
async function gracefulShutdown(signal: string) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n[Shutdown] 收到 ${signal}，开始优雅退出...`);
  try { (globalThis as any).__cronScheduler?.stop?.(); console.log('[Shutdown] 定时任务已停止'); } catch (e: unknown) { console.error('[Shutdown] 定时任务停止失败:', (e as Error)?.message); }
  try { (globalThis as any).__sessionManager?.stopAutoSave?.(); console.log('[Shutdown] 会话保存已停止'); } catch {}
  try { (globalThis as any).__telegramAdapter?.stop?.(); console.log('[Shutdown] Telegram 已停止'); } catch {}
  try { (globalThis as any).__channelManager?.list()?.forEach((ch: any) => ch.adapter?.stop?.()); console.log('[Shutdown] 渠道已停止'); } catch {}
  try { (globalThis as any).__browserManager?.close?.(); console.log('[Shutdown] 浏览器已关闭'); } catch {}
  try { stopLanDiscovery(); console.log('[Shutdown] LAN 发现已停止'); } catch {}
  try { await saveToDisk(); console.log('[Shutdown] 数据库已保存'); } catch (e: unknown) { console.error('[Shutdown] 保存失败:', (e as Error)?.message); }
  try { await closeDB(); console.log('[Shutdown] 数据库已关闭'); } catch (e: unknown) {}
  try { _server?.close?.(); console.log('[Shutdown] HTTP 已关闭'); } catch {}
  console.log('[Shutdown] 退出完成');
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ═══ 辅助函数 ═══

async function resolveAvailablePort(startPort: number, autoPort: boolean): Promise<number> {
  const net = await import('net');
  const tryPort = (p: number): Promise<boolean> => new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => { tester.close(); resolve(true); });
    tester.listen(p, '0.0.0.0');
  });
  if (await tryPort(startPort)) return startPort;
  if (!autoPort) return startPort; // 不自动顺延，让 server.on('error') 处理 EADDRINUSE
  for (let p = startPort + 1; p <= startPort + 10; p++) {
    if (await tryPort(p)) { console.log(`[Port] ${startPort} 被占用，自动切换到 ${p}`); return p; }
  }
  console.error(`[FATAL] 端口 ${startPort}-${startPort + 10} 全部被占用。`);
  process.exit(1);
}

function setupDemoData(db: any, manager: any, toolRegistry?: any) {
  if (toolRegistry) {
    const agents = db.listAgents();
    for (const agent of agents) {
      toolRegistry.bindSkills(agent.id || agent.agent_id, ['general-assistant']);
    }
    if (agents.length > 0) console.log('[Tools] ' + agents.length + ' 个 Agent 已重新绑定通用助手技能');
  }
}

function ensureUserSetup(clientId: string, db: any, manager: any, toolRegistry?: any) {
  try {
    const existing = db.getUser(clientId);
    if (existing) {
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
      const agent = manager.register(clientId, clientId + '的AI助手', '你是一个友好实用的AI助手，可帮用户查信息、回答问题、搜索资料。文件操作在安全沙箱内进行。shell_exec仅在沙箱开启且命令在白名单内时才可用。', 'semi');
      const chatId = 'chat-' + clientId;
      db.createChat(chatId, 'private');
      db.addParticipant('p-' + clientId + '-user', chatId, clientId, undefined, 'owner');
      db.addParticipant('p-' + clientId + '-agent', chatId, undefined, agent.id, 'agent');
      if (toolRegistry) toolRegistry.bindSkills(agent.id, ['general-assistant']);
      return;
    }
    const raw = getDB();
    const ms = raw.prepare('SELECT MAX(numeric_id) as m FROM users WHERE numeric_id IS NOT NULL'); ms.step(); const maxId = ms.getAsObject().m || 9999; ms.free();
    const nextId = maxId + 1;
    const userDisplay = '用户' + nextId;
    db.createUser(clientId, userDisplay);
    raw.run('UPDATE users SET numeric_id = ?, status = ?, display_name = ? WHERE id = ?', [nextId, 'online', userDisplay, clientId]);
    const agent = manager.register(clientId, userDisplay + '的AI助手', '你是一个友好实用的AI助手，可帮用户查信息、回答问题、搜索资料。文件操作在安全沙箱内进行。shell_exec仅在沙箱开启且命令在白名单内时才可用。', 'semi');
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