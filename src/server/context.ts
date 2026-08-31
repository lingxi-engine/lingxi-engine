/**
 * ServerContext — 共享服务上下文
 * 
 * 所有路由模块通过此上下文访问共享的管理器实例，
 * 避免全局变量 (globalThis.__xxx) 滥用。
 */
import type { Express } from 'express';
import type { DB } from '../storage/db.js';
import type { AIHub } from '../ai/hub.js';
import type { AgentManager } from '../agents/manager.js';
import type { MessageRouter } from '../core/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ProviderRegistry } from '../ai/provider-registry.js';
import type { MCPManager } from '../mcp/adapter.js';
import type { BrowserManager } from '../tools/browser.js';
import type { PluginManager } from '../plugins/plugin-manager.js';
import type { CronScheduler } from '../core/cron-scheduler.js';
import type { SessionManager } from '../core/session-manager.js';
import type { SubAgentManager } from '../core/subagent-manager.js';
import type { ApprovalManager } from '../core/approval.js';
import type { HookManager } from '../core/hooks.js';
import type { InboxManager } from '../core/inbox.js';
import type { ChannelManager } from '../channels/manager.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { TTSManager } from '../voice/tts.js';
import type { STTManager } from '../voice/stt.js';
import type { CustomProviderManager } from '../ai/custom-providers.js';
import type { DebugPanel } from '../dev/debug-panel.js';
import type { VisionManager } from '../ai/vision.js';
import type { PushNotificationManager } from '../core/push.js';
import type { SearchManager } from '../tools/search-providers.js';
import type { TelegramAdapter } from '../channels/telegram.js';
import type { OutcomeTracker } from '../core/outcome-tracker.js';

export interface ServerContext {
  app: Express;
  db: DB;
  aiHub: AIHub;
  manager: AgentManager;
  router: MessageRouter;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  mcpManager: MCPManager;
  browserManager: BrowserManager;
  pluginManager: PluginManager;
  cronScheduler: CronScheduler;
  sessionManager: SessionManager;
  subAgentManager: SubAgentManager;
  approvalManager: ApprovalManager;
  hookManager: HookManager;
  inboxManager: InboxManager;
  channelManager: ChannelManager;
  skillManager: SkillManager;
  ttsManager: TTSManager;
  sttManager: STTManager;
  customProviderManager: CustomProviderManager;
  debugPanel: DebugPanel;
  visionManager: VisionManager;
  pushManager: PushNotificationManager;
  searchManager: SearchManager;
  telegramAdapter: TelegramAdapter | null;
  outcomeTracker: OutcomeTracker;  // v1.7.2: 评分卡追踪器
  dataDir: string;
  defaultModel: string;
  broadcast: (event: any) => void;
}