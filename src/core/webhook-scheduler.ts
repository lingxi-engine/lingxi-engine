/**
 * Webhook 触发器 (Webhook Scheduler) — 对齐 OpenClaw Inbound Webhooks
 *
 * 解决问题：灵犀 cron 只有时间触发；外部系统（GitHub、监控告警、CI、
 * 第三方服务）无法主动唤醒灵犀执行任务。
 *
 * 设计：
 *   - 每个 webhook 有一个 secret token，调用方带 token 才能触发（防滥用）
 *   - 触发后走与 cron 相同的 payload 通道（agentMessage / systemEvent / toolCall）
 *   - 持久化到 data/webhooks.json
 *
 * 用法（index.ts）：
 *   import { WebhookScheduler } from './src/core/webhook-scheduler.js';
 *   const webhookScheduler = new WebhookScheduler(dispatch);
 *   webhookScheduler.start();
 *   registerWebhookRoutes(app, webhookScheduler, requireAuth);
 *
 * 调用方（外部系统）：
 *   curl -X POST http://localhost:3000/api/webhook/trigger/<hookId> \
 *        -H "Content-Type: application/json" \
 *        -d '{"token":"xxx","payload":"GitHub PR #123 已合并"}'
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

export interface WebhookJob {
  id: string;
  name: string;
  secret: string;
  enabled: boolean;
  /** 触发后投递给 agent 的提示词模板，{payload} 会被替换为 webhook body */
  promptTemplate: string;
  chatId?: string;
  agentId?: string;
  /** 可选：IP 白名单 */
  allowedIps?: string[];
  triggerCount: number;
  lastTriggerAt?: number;
  createdAt: number;
}

export type WebhookDispatch = (job: WebhookJob, body: any) => Promise<void>;

export class WebhookScheduler {
  private hooks = new Map<string, WebhookJob>();
  private dispatch: WebhookDispatch;
  private persistPath: string;

  constructor(dispatch: WebhookDispatch, dataDir?: string) {
    this.dispatch = dispatch;
    this.persistPath = join(dataDir || join(process.cwd(), 'data'), 'webhooks.json');
  }

  start(): void {
    this.loadFromDisk();
    console.log(`[Webhook] 触发器已启动, ${this.hooks.size} 个 webhook`);
  }

  /** 外部系统调用入口：验证 token → 执行 dispatch */
  async trigger(hookId: string, token: string, body: any): Promise<{ ok: boolean; error?: string }> {
    const hook = this.hooks.get(hookId);
    if (!hook) return { ok: false, error: 'webhook 不存在' };
    if (!hook.enabled) return { ok: false, error: 'webhook 已禁用' };
    if (hook.secret && token !== hook.secret) return { ok: false, error: 'token 不匹配' };

    hook.triggerCount++;
    hook.lastTriggerAt = Date.now();
    this.persistToDisk();
    try {
      await this.dispatch(hook, body);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: `执行失败: ${err.message}` };
    }
  }

  createHook(opts: { name: string; promptTemplate: string; chatId?: string; agentId?: string; enabled?: boolean }): WebhookJob {
    const id = 'wh-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
    const hook: WebhookJob = {
      id, name: opts.name,
      secret: randomBytes(16).toString('hex'),
      enabled: opts.enabled ?? true,
      promptTemplate: opts.promptTemplate,
      chatId: opts.chatId, agentId: opts.agentId,
      triggerCount: 0, createdAt: Date.now(),
    };
    this.hooks.set(id, hook);
    this.persistToDisk();
    return hook;
  }

  removeHook(id: string): boolean {
    const ok = this.hooks.delete(id);
    if (ok) this.persistToDisk();
    return ok;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const hook = this.hooks.get(id);
    if (!hook) return false;
    hook.enabled = enabled;
    this.persistToDisk();
    return true;
  }

  getHook(id: string): WebhookJob | undefined { return this.hooks.get(id); }
  listHooks(): WebhookJob[] { return Array.from(this.hooks.values()); }

  private persistToDisk(): void {
    try {
      writeFileSync(this.persistPath, JSON.stringify(this.listHooks(), null, 2), 'utf8');
    } catch (err: any) {
      console.error('[Webhook] 持久化失败:', err.message);
    }
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const data = JSON.parse(readFileSync(this.persistPath, 'utf8'));
      if (!Array.isArray(data)) return;
      for (const h of data) this.hooks.set(h.id, h);
      console.log(`[Webhook] 从磁盘恢复 ${this.hooks.size} 个 webhook`);
    } catch (err: any) {
      console.error('[Webhook] 加载持久化数据失败:', err.message);
    }
  }
}

/** REST 路由：管理 + 触发。触发端点无需登录（token 即凭证），管理端需 requireAuth */
export function registerWebhookRoutes(app: any, scheduler: WebhookScheduler, requireAuth: any) {
  // 触发端点（外部系统调用，token 鉴权，不走 session）
  app.post('/api/webhook/trigger/:hookId', express_json, async (req: any, res: any) => {
    const { hookId } = req.params;
    const token = req.body?.token || req.headers['x-webhook-token'] || '';
    const result = await scheduler.trigger(hookId, String(token), req.body);
    if (!result.ok) return res.status(403).json({ ok: false, error: result.error });
    res.json({ ok: true });
  });

  // 管理端点
  app.get('/api/webhooks', requireAuth, (_req: any, res: any) => {
    res.json({ ok: true, hooks: scheduler.listHooks() });
  });

  app.post('/api/webhooks', requireAuth, (req: any, res: any) => {
    const { name, promptTemplate, chatId, agentId, enabled } = req.body || {};
    if (!name || !promptTemplate) return res.status(400).json({ error: 'name/promptTemplate 必填' });
    const hook = scheduler.createHook({ name, promptTemplate, chatId, agentId, enabled });
    res.json({ ok: true, hook });
  });

  app.delete('/api/webhooks/:id', requireAuth, (req: any, res: any) => {
    res.json({ ok: scheduler.removeHook(req.params.id) });
  });

  app.patch('/api/webhooks/:id', requireAuth, (req: any, res: any) => {
    res.json({ ok: scheduler.setEnabled(req.params.id, !!req.body?.enabled) });
  });

  console.log('[Webhook] 路由已注册: POST /api/webhook/trigger/:hookId, GET/POST/DELETE/PATCH /api/webhooks');
}

/** express.json() 的懒加载包装（避免顶层 import 依赖顺序问题） */
function express_json(req: any, res: any, next: any) {
  import('express').then(m => m.json()(req, res, next)).catch(next);
}
