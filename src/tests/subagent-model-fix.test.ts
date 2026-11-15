/**
 * FIX-SUBAGENT(2026-11-14) 回归测试
 * 根因：WS 拆分第一步派发的子代理钉死启动时 DEFAULT_MODEL 客户端（该通道欠费 402 → 第一步必挂），
 *       且失败后级联 skipped 的步骤前端无渲染分支（永久 ⏳）。
 * 覆盖：
 *  1) SubAgentManager.setClientResolver —— 子代理按任务模型经 resolver（AIHub）解析客户端
 *  2) resolver 异常/空结果 → 回退构造时默认客户端（不炸）
 *  3) 无 resolver → 旧行为不变（向后兼容）
 *  4) 源码守卫：WS 继承模型+工具、失败回退、skipped 补发、前端 skipped 渲染
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SubAgentManager } from '../core/subagent-manager.js';

const ROOT = path.resolve(__dirname, '../..');

function fakeClient(tag: string, capture: Array<{ tag: string; model: string }>) {
  return {
    chat: {
      completions: {
        create: async (args: any) => {
          capture.push({ tag, model: args.model });
          return { choices: [{ message: { content: 'ok-' + tag } }] };
        },
      },
    },
  };
}

async function runOnce(mgr: SubAgentManager, model?: string) {
  const id = await mgr.spawn({
    objective: '只回复两个字：收到',
    parentId: 'test-parent',
    chatId: 'test-chat',
    model,
    timeoutSeconds: 10,
  });
  const t = await mgr.awaitResult(id, 15000);
  return t;
}

describe('SubAgentManager 模型继承（FIX-SUBAGENT-MODEL）', () => {
  it('resolver 存在时：用 resolver 返回的客户端+解析后模型，而非默认客户端', async () => {
    const cap: Array<{ tag: string; model: string }> = [];
    const mgr = new SubAgentManager(fakeClient('default', cap), 'default-model');
    mgr.setClientResolver((m) => ({ client: fakeClient('resolved', cap), resolvedModel: 'resolved-' + (m || 'none') }));
    const t = await runOnce(mgr, 'agent-model');
    expect(t?.status).toBe('completed');
    expect(cap.length).toBe(1);
    expect(cap[0].tag).toBe('resolved');
    expect(cap[0].model).toBe('resolved-agent-model');
  });

  it('任务未指定模型：spawn 以管理器默认模型兜底（既有行为），仍走 resolver 客户端', async () => {
    const cap: Array<{ tag: string; model: string }> = [];
    const received: Array<string | undefined> = [];
    const mgr = new SubAgentManager(fakeClient('default', cap), 'default-model');
    mgr.setClientResolver((m) => {
      received.push(m);
      return { client: fakeClient('resolved', cap), resolvedModel: 'resolved-' + (m || 'none') };
    });
    const t = await runOnce(mgr);
    expect(t?.status).toBe('completed');
    expect(received[0]).toBe('default-model'); // spawn 阶段 opts.model || this.aiModel 兜底
    expect(cap[0].tag).toBe('resolved');
    expect(cap[0].model).toBe('resolved-default-model');
  });

  it('resolver 抛异常：回退默认客户端，任务不炸', async () => {
    const cap: Array<{ tag: string; model: string }> = [];
    const mgr = new SubAgentManager(fakeClient('default', cap), 'default-model');
    mgr.setClientResolver(() => { throw new Error('hub down'); });
    const t = await runOnce(mgr, 'agent-model');
    expect(t?.status).toBe('completed');
    expect(cap[0].tag).toBe('default');
    expect(cap[0].model).toBe('agent-model');
  });

  it('resolver 返回 null：回退默认客户端', async () => {
    const cap: Array<{ tag: string; model: string }> = [];
    const mgr = new SubAgentManager(fakeClient('default', cap), 'default-model');
    mgr.setClientResolver(() => null);
    const t = await runOnce(mgr, 'agent-model');
    expect(t?.status).toBe('completed');
    expect(cap[0].tag).toBe('default');
  });

  it('未注入 resolver：旧行为不变（默认客户端 + opts.model）', async () => {
    const cap: Array<{ tag: string; model: string }> = [];
    const mgr = new SubAgentManager(fakeClient('default', cap), 'default-model');
    const t = await runOnce(mgr, 'some-model');
    expect(t?.status).toBe('completed');
    expect(cap[0].tag).toBe('default');
    expect(cap[0].model).toBe('some-model');
  });
});

describe('源码守卫：拆分链路修复不回退', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  it('ws-handler：spawn 继承父 Agent 模型与工具注册表', () => {
    const s = read('src/core/ws-handler.ts');
    expect(s).toContain('model: router.getAgentRequestedModel(agentId)');
    expect(s).toContain('toolRegistry: wsToolRegistry || undefined');
  });

  it('ws-handler：子代理失败/异常回退主模型（不再直接 return 判死）', () => {
    const s = read('src/core/ws-handler.ts');
    expect(s).toContain('FIX-SUBAGENT-FALLBACK');
    expect(s).toContain('fallback to main model');
    // 旧的一刀切失败返回必须消失
    expect(s).not.toContain('return errMsg;');
    expect(s).not.toContain('st.status = subSuccess ? \'done\' : \'failed\'');
  });

  it('ws-handler：skipped 步骤补发 step_done(skipped)', () => {
    const s = read('src/core/ws-handler.ts');
    expect(s).toContain('FIX-SKIPPED-RENDER');
    expect(s).toContain('success: false, skipped: true');
  });

  it('router：暴露 getAgentRequestedModel（与 generateReply 同取值逻辑）', () => {
    const s = read('src/core/router.ts');
    expect(s).toContain('getAgentRequestedModel(agentId: string): string');
    expect(s).toContain("agent?.model || this.aiHub.getDefaultModel?.() || ''");
  });

  it('index.ts：注入 AIHub resolver + toolRegistry', () => {
    const s = read('index.ts');
    expect(s).toContain('setSubAgentManagerForWS(subAgentManager, toolRegistry)');
    expect(s).toContain("subAgentManager.setClientResolver((m?: string) => aiHub.getClient(m || ''))");
  });

  it('subagent-manager：工具循环与纯文本分支都用解析后的 exec 客户端', () => {
    const s = read('src/core/subagent-manager.ts');
    expect(s).toContain('client: exec.client');
    expect(s).toContain('model: exec.model');
    expect(s).toContain('resolveExecutionClient');
  });

  it('前端：step_done 识别 skipped，icons/colors 有 skipped 分支（不再永久 ⏳）', () => {
    const s = read('web/js/app.js');
    expect(s).toContain("msg.skipped ? 'skipped' :");
    expect(s).toContain("skipped: '\\u23ED\\uFE0F'");
    expect(s).toContain("skipped: 'var(--text3)'");
  });
});
