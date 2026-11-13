/**
 * A2A 协议（Agent2Agent Protocol）适配层
 * 规范：https://a2a-protocol.org/latest/specification/
 *
 * 暴露端点：
 *   GET  /.well-known/agent.json              → Agent Card（免鉴权，供发现）
 *   GET  /a2a/agents                          → 本实例所有 Agent 的 Agent Card 列表
 *   POST /a2a                                 → JSON-RPC 2.0 统一入口
 *        method: tasks/send                   { message: { role:'user', parts:[{type:'text',text}] }, contextId?, metadata? }
 *        method: tasks/sendSubscribe          同上，SSE 流式返回（working → completed/failed）
 *        method: tasks/get                    { id }
 *        method: tasks/cancel                 { id }
 *        method: agent/getAuthenticatedExtendedCard
 *
 * 鉴权：Authorization: Bearer <JWT>（与 Web 登录同一套 token），
 *       或 x-api-key: <A2A_API_KEY>（机器对机器，需在 .env 配置）。
 *       未带凭证 → 401（JSON-RPC error -32001）。
 * 开关：A2A_ENABLED=false 关闭（默认开启）。
 *
 * 任务落地：每个 task 绑定一个持久 chat（a2a-task-<id>），
 * 用户消息与 agent 回复都走 db.addMessage，重启后 tasks/get 仍可读历史。
 */

import { Router, type Express, type Request, type Response } from 'express';
import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

import { verifyAccessToken } from '../auth/index.js';
import * as db from '../storage/db.js';
import type { MessageRouter } from '../core/router.js';
import type { AgentManager } from '../agents/manager.js';

// ── 类型 ──

type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled' | 'input-required';

interface A2ATask {
  id: string;
  contextId: string;          // 对应 chatId
  status: { state: TaskState; message?: any; timestamp: string };
  history: any[];
  artifacts: any[];
  metadata?: Record<string, any>;
  kind: 'task';
}

interface A2AContext {
  router: MessageRouter;
  manager: AgentManager;
}

// 进行中的任务（内存态 + AbortController，用于 cancel）
const activeTasks = new Map<string, { task: A2ATask; ctrl: AbortController }>();

function nowIso(): string { return new Date().toISOString(); }

function readVersion(): string {
  try {
    const p = path.join(process.cwd(), 'version.txt');
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  } catch { /* ignore */ }
  return '2.0.0';
}

function baseUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || `localhost:${process.env.PORT || 3456}`;
  return `${proto}://${host}`;
}

/** 构造 Agent Card（可独立测试） */
export function buildAgentCard(opts: {
  agentId: string;
  name: string;
  description: string;
  url: string;
  version: string;
  skills?: Array<{ id: string; name: string; description: string; tags: string[] }>;
}): any {
  return {
    name: opts.name,
    description: opts.description,
    url: opts.url,
    provider: { organization: '灵犀引擎', url: 'https://www.lingxi-engine.com' },
    version: opts.version,
    protocolVersion: '0.3.0',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    authentication: { schemes: ['bearer', 'apiKey'] },
    defaultInputModes: ['text', 'text/plain'],
    defaultOutputModes: ['text', 'text/plain'],
    skills: opts.skills && opts.skills.length > 0 ? opts.skills : [
      { id: 'chat', name: '对话', description: '与灵犀 Agent 进行多轮对话，支持工具调用与长任务', tags: ['chat', 'general'] },
    ],
    supportsAuthenticatedExtendedCard: true,
    agentId: opts.agentId,
  };
}

/** 解析 JSON-RPC 请求体（可独立测试） */
export function parseJsonRpc(body: any): { jsonrpc: string; id: string | number | null; method: string; params: any } | { error: any } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: { code: -32600, message: 'Invalid Request: body must be a JSON-RPC 2.0 object' } };
  }
  if (body.jsonrpc !== '2.0') {
    return { error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } };
  }
  if (typeof body.method !== 'string' || !body.method) {
    return { error: { code: -32600, message: 'Invalid Request: method is required' } };
  }
  return { jsonrpc: '2.0', id: body.id ?? null, method: body.method, params: body.params ?? {} };
}

// ── 鉴权中间件 ──

function a2aAuth(req: Request, res: Response, next: any): void {
  // 1) x-api-key 机器凭证
  const apiKey = process.env.A2A_API_KEY;
  const presented = String(req.headers['x-api-key'] || '');
  if (apiKey && presented && crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(apiKey))) {
    (req as any).a2aCaller = { kind: 'apiKey' };
    return next();
  }
  // 2) Bearer JWT —— 解析出 userId，再映射到该用户的 agent
  const auth = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) {
    const payload = verifyAccessToken(m[1].trim());
    if (payload?.sub) {
      (req as any).a2aCaller = { kind: 'jwt', userId: payload.sub };
      return next();
    }
  }
  res.status(401).json({
    jsonrpc: '2.0', id: null,
    error: { code: -32001, message: 'Unauthorized: provide Authorization: Bearer <JWT> or x-api-key' },
  });
}

/** 取调用方对应的 agentId：JWT → 用户 agent；apiKey → 第一个 agent（或 A2A_DEFAULT_AGENT） */
function resolveAgentId(req: Request): string | null {
  const caller = (req as any).a2aCaller;
  if (!caller) return null;
  if (caller.kind === 'jwt' && caller.userId) {
    const agent = db.getAgentByUserId(caller.userId);
    if (agent?.id) return agent.id;
    return null;
  }
  if (caller.kind === 'apiKey') {
    const preferred = process.env.A2A_DEFAULT_AGENT;
    if (preferred && db.getAgent(preferred)) return preferred;
    const first = db.listAgents()[0];
    return first?.id ?? null;
  }
  return null;
}

// ── 任务执行 ──

function extractText(params: any): string {
  const msg = params?.message;
  const parts = msg?.parts;
  if (Array.isArray(parts)) {
    return parts.filter((p: any) => p?.type === 'text' || p?.kind === 'text').map((p: any) => String(p.text ?? '')).join('\n');
  }
  if (typeof msg?.text === 'string') return msg.text;
  if (typeof params?.text === 'string') return params.text;
  return '';
}

function ensureTaskChat(taskId: string, contextId?: string): string {
  const chatId = contextId || `a2a-task-${taskId}`;
  if (!db.getChatById(chatId)) {
    db.createChat(chatId, 'private', undefined, `A2A Task ${taskId}`);
  }
  return chatId;
}

async function runTask(ctx: A2AContext, task: A2ATask, agentId: string, onEvent?: (ev: any) => void): Promise<void> {
  const { ctrl } = activeTasks.get(task.id)!;
  try {
    task.status = { state: 'working', timestamp: nowIso() };
    onEvent?.({ kind: 'status', state: 'working' });

    const userMsgId = 'a2a-u-' + crypto.randomUUID().slice(0, 8);
    const userText = task.history.find((m: any) => m.role === 'user')?.parts?.[0]?.text || '';
    db.addMessage({
      id: userMsgId, chatId: task.contextId, senderType: 'user', senderId: 'a2a-caller',
      content: userText, type: 'text', timestamp: Date.now(),
    });

    const reply = await ctx.router.generateReply(
      task.contextId, agentId, userMsgId,
      onEvent ? (chunk: string) => onEvent({ kind: 'chunk', text: chunk }) : undefined,
      undefined, undefined, undefined, undefined,
      ctrl.signal,
    );

    task.status = { state: 'completed', timestamp: nowIso() };
    task.artifacts.push({ artifactId: crypto.randomUUID(), name: 'response', parts: [{ type: 'text', text: reply || '' }] });
    onEvent?.({ kind: 'status', state: 'completed', final: true });
  } catch (err: any) {
    const aborted = ctrl.signal.aborted || /abort/i.test(String(err?.message || ''));
    task.status = { state: aborted ? 'canceled' : 'failed', message: { role: 'agent', parts: [{ type: 'text', text: String(err?.message || err) }] }, timestamp: nowIso() };
    onEvent?.({ kind: 'status', state: task.status.state, final: true, error: String(err?.message || err) });
  } finally {
    activeTasks.delete(task.id);
  }
}

function makeTask(params: any, agentId: string): A2ATask {
  const id = String(params?.id || crypto.randomUUID());
  const text = extractText(params);
  const task: A2ATask = {
    kind: 'task',
    id,
    contextId: '',
    status: { state: 'submitted', timestamp: nowIso() },
    history: [{ role: 'user', parts: [{ type: 'text', text }] }],
    artifacts: [],
    metadata: { ...(params?.metadata || {}), agentId },
  };
  return task;
}

// ── 路由工厂 ──

export function registerA2ARoutes(app: Express, ctx: A2AContext): void {
  if (String(process.env.A2A_ENABLED ?? '1').toLowerCase() === 'false') {
    console.log('[A2A] 已通过 A2A_ENABLED=false 关闭');
    return;
  }

  // Agent Card 发现（免鉴权）
  app.get('/.well-known/agent.json', (req: Request, res: Response) => {
    const agents = db.listAgents();
    const primary = agents[0];
    res.json(buildAgentCard({
      agentId: primary?.id || 'lingxi',
      name: '灵犀引擎' + (primary?.displayName ? ` · ${primary.displayName}` : ''),
      description: '本地优先的 AI 助手引擎：9 渠道接入、56 工具、记忆系统、多智能体协作。支持 A2A 协议互操作。',
      url: `${baseUrl(req)}/a2a`,
      version: readVersion(),
    }));
  });

  const r = Router();
  r.use(a2aAuth);

  // Agent 列表
  r.get('/agents', (req: Request, res: Response) => {
    const url = `${baseUrl(req)}/a2a`;
    const ver = readVersion();
    const cards = db.listAgents().map((a: any) => buildAgentCard({
      agentId: a.id,
      name: `灵犀 · ${a.display_name || a.id}`,
      description: a.personality || '灵犀 AI Agent',
      url, version: ver,
    }));
    res.json({ ok: true, agents: cards });
  });

  // JSON-RPC 统一入口
  r.post('/', async (req: Request, res: Response) => {
    const parsed = parseJsonRpc(req.body);
    if ('error' in parsed) {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: parsed.error });
    }
    const { id, method, params } = parsed;
    const agentId = resolveAgentId(req);
    if (!agentId) {
      return res.status(403).json({ jsonrpc: '2.0', id, error: { code: -32002, message: 'No agent bound to this credential' } });
    }

    try {
      switch (method) {
        case 'agent/getAuthenticatedExtendedCard': {
          const agent = db.getAgent(agentId);
          return res.json({
            jsonrpc: '2.0', id,
            result: buildAgentCard({
              agentId,
              name: `灵犀 · ${agent?.display_name || agentId}`,
              description: agent?.personality || '灵犀 AI Agent',
              url: `${baseUrl(req)}/a2a`,
              version: readVersion(),
            }),
          });
        }

        case 'tasks/send': {
          const task = makeTask(params, agentId);
          task.contextId = ensureTaskChat(task.id, params?.contextId ? String(params.contextId) : undefined);
          const ctrl = new AbortController();
          activeTasks.set(task.id, { task, ctrl });
          // 异步执行，立即返回 submitted
          void runTask(ctx, task, agentId);
          return res.json({ jsonrpc: '2.0', id, result: task });
        }

        case 'tasks/sendSubscribe': {
          const task = makeTask(params, agentId);
          task.contextId = ensureTaskChat(task.id, params?.contextId ? String(params.contextId) : undefined);
          const ctrl = new AbortController();
          activeTasks.set(task.id, { task, ctrl });

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const send = (result: any, final: boolean) => {
            res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { ...result, final } })}\n\n`);
          };
          send({ id: task.id, contextId: task.contextId, kind: 'status', status: task.status }, false);
          req.on('close', () => { try { ctrl.abort(); } catch { /* ignore */ } });
          await runTask(ctx, task, agentId, (ev) => {
            if (ev.kind === 'status') {
              send({ id: task.id, contextId: task.contextId, kind: 'status', status: task.status, artifacts: task.artifacts }, !!ev.final);
            }
          });
          try { res.end(); } catch { /* client gone */ }
          return;
        }

        case 'tasks/get': {
          const tid = String(params?.id || '');
          const active = activeTasks.get(tid);
          if (active) return res.json({ jsonrpc: '2.0', id, result: active.task });
          // 从持久 chat 重建历史
          const chatId = `a2a-task-${tid}`;
          const chat = db.getChatById(chatId);
          if (!chat) {
            return res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found' } });
          }
          const msgs = db.listMessages(chatId, 50);
          return res.json({
            jsonrpc: '2.0', id,
            result: {
              kind: 'task', id: tid, contextId: chatId,
              status: { state: 'completed', timestamp: nowIso() },
              history: msgs.map((m: any) => ({ role: m.sender_type === 'user' ? 'user' : 'agent', parts: [{ type: 'text', text: m.content }] })),
              artifacts: [],
            },
          });
        }

        case 'tasks/cancel': {
          const tid = String(params?.id || '');
          const active = activeTasks.get(tid);
          if (!active) {
            return res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Task not found or already finished' } });
          }
          active.ctrl.abort();
          active.task.status = { state: 'canceled', timestamp: nowIso() };
          return res.json({ jsonrpc: '2.0', id, result: active.task });
        }

        default:
          return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err: any) {
      return res.status(500).json({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message || err) } });
    }
  });

  app.use('/a2a', r);
  console.log('[A2A] Agent2Agent 协议已启用: GET /.well-known/agent.json | POST /a2a (JSON-RPC: tasks/send, tasks/sendSubscribe, tasks/get, tasks/cancel)');
}
