/**
 * registry.test.ts — ToolRegistry 单元测试 (vitest, P0/A1+B2)
 *
 * 覆盖：
 *   1. registerTool / registerToolInstance — 注册 & 重复检测
 *   2. listTools / listToolsForAgent — 查询
 *   3. execute — 实例优先 > handler 回退
 *   4. skills — registerSkill / bindSkills / listToolsForSkills
 */
import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import type { ToolDefinition } from '../tools/types.js';
import type { ITool } from '../tools/tool-base.js';

// ── Fixtures ──

const dummyToolDef: ToolDefinition = {
  name: 'test-tool',
  description: 'A test tool',
  parameters: { type: 'object', properties: { x: { type: 'string' } } },
};

const dummySkill = {
  id: 'skill-1',
  name: 'Test Skill',
  description: 'desc',
  tools: ['test-tool'],
  prompt: '',
};

class FakeTool implements ITool {
  name = 'fake-tool';
  permissions = ['test:run'];
  validate() { return true; }
  async dryRun() { return { ok: true, dry: true }; }
  async execute(input: any) { return { ok: true, input }; }
}

const fakeToolDef: ToolDefinition = {
  name: 'fake-tool',
  description: 'A fake ITool',
  parameters: { type: 'object', properties: {} },
};

// ═══════════════════════════════════════════════
// registerTool / registerToolInstance
// ═══════════════════════════════════════════════

describe('ToolRegistry — registration', () => {
  it('registerTool stores tool + handler', () => {
    const reg = new ToolRegistry();
    const handler = vi.fn(async () => 'ok');
    reg.registerTool(dummyToolDef, handler);
    expect(reg.getTool('test-tool')).toBe(dummyToolDef);
    expect(reg.listTools()).toHaveLength(1);
  });

  it('registerToolInstance stores tool + instance', () => {
    const reg = new ToolRegistry();
    const instance = new FakeTool();
    reg.registerToolInstance(fakeToolDef, instance);
    expect(reg.getTool('fake-tool')).toBe(fakeToolDef);
    expect(reg.listTools()).toHaveLength(1);
  });

  it('throws on duplicate tool name', () => {
    const reg = new ToolRegistry();
    reg.registerTool(dummyToolDef, vi.fn());
    expect(() => reg.registerTool(dummyToolDef, vi.fn())).toThrow('already registered');
  });

  it('throws on duplicate instance name', () => {
    const reg = new ToolRegistry();
    reg.registerToolInstance(fakeToolDef, new FakeTool());
    expect(() => reg.registerToolInstance(fakeToolDef, new FakeTool())).toThrow('already registered');
  });
});

// ═══════════════════════════════════════════════
// execute — instance priority over handler
// ═══════════════════════════════════════════════

describe('ToolRegistry — execute', () => {
  it('uses ITool instance when registered', async () => {
    const reg = new ToolRegistry();
    const instance = new FakeTool();
    reg.registerToolInstance(fakeToolDef, instance);
    const res = await reg.execute({ id: 'c1', name: 'fake-tool', arguments: { foo: 'bar' } });
    expect(res.success).toBe(true);
    expect(res.result).toEqual({ ok: true, input: { foo: 'bar' } });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('falls back to handler when no instance', async () => {
    const reg = new ToolRegistry();
    const handler = vi.fn(async (args: any) => `handled: ${args.x}`);
    reg.registerTool(dummyToolDef, handler);
    const res = await reg.execute({ id: 'c2', name: 'test-tool', arguments: { x: 'hello' } });
    expect(res.success).toBe(true);
    expect(res.result).toBe('handled: hello');
  });

  it('returns error for unknown tool', async () => {
    const reg = new ToolRegistry();
    const res = await reg.execute({ id: 'c3', name: 'nope', arguments: {} });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Unknown tool');
  });

  it('catches handler errors gracefully', async () => {
    const reg = new ToolRegistry();
    reg.registerTool(dummyToolDef, async () => { throw new Error('boom'); });
    const res = await reg.execute({ id: 'c4', name: 'test-tool', arguments: {} });
    expect(res.success).toBe(false);
    expect(res.error).toBe('boom');
  });
});

// ═══════════════════════════════════════════════
// Skills
// ═══════════════════════════════════════════════

describe('ToolRegistry — skills', () => {
  it('registerSkill + bindSkills + listToolsForAgent', () => {
    const reg = new ToolRegistry();
    reg.registerTool(dummyToolDef, vi.fn());
    reg.registerSkill(dummySkill);
    reg.bindSkills('agent-1', ['skill-1']);
    const tools = reg.listToolsForAgent('agent-1');
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test-tool');
  });

  it('listToolsForAgent returns empty for unbound agent', () => {
    const reg = new ToolRegistry();
    reg.registerTool(dummyToolDef, vi.fn());
    reg.registerSkill(dummySkill);
    expect(reg.listToolsForAgent('unknown')).toHaveLength(0);
  });

  it('listToolsForSkills works', () => {
    const reg = new ToolRegistry();
    reg.registerTool(dummyToolDef, vi.fn());
    reg.registerSkill(dummySkill);
    const tools = reg.listToolsForSkills(['skill-1']);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test-tool');
  });

  it('warns on unknown tool reference in skill', () => {
    const reg = new ToolRegistry();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.registerSkill({ ...dummySkill, tools: ['nonexistent'] });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════
// executeAll (batch)
// ═══════════════════════════════════════════════

describe('ToolRegistry — executeAll', () => {
  it('executes multiple tools in parallel', async () => {
    const reg = new ToolRegistry();
    reg.registerTool(dummyToolDef, async () => 'ok1');
    const results = await reg.executeAll([
      { id: 'b1', name: 'test-tool', arguments: {} },
      { id: 'b2', name: 'test-tool', arguments: {} },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);
  });
});