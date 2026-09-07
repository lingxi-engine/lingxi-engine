/**
 * executor-tool.test.ts — ExecutorTool 单元测试 (vitest, P0/A1+B2)
 *
 * 覆盖：
 *   1. validate() — 合法/非法输入
 *   2. dryRun()   — 不执行副作用，返回预览
 *   3. execute()  — 超时中断 (AbortSignal + timeoutMs)
 *   4. 错误分类   — validation / timeout / aborted / runtime
 */
import { describe, it, expect } from 'vitest';
import { ExecutorTool, ExecutorError } from '../tools/executor-tool.js';

// ── Fakes ──

const fakeClient = {
  chat: {
    completions: {
      async create() {
        return {
          choices: [{ message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      },
    },
  },
};

const dummyRegistry = {
  listToolsForAgent: () => [],
  listTools: () => [],
  getTool: () => undefined,
  execute: async () => ({ callId: 'x', toolName: 'x', success: true, result: null, durationMs: 0 }),
};

function makeValidInput(overrides: Record<string, any> = {}) {
  return {
    client: fakeClient,
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    registry: dummyRegistry,
    agentId: 'agent-test',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════
// validate
// ═══════════════════════════════════════════════

describe('ExecutorTool.validate', () => {
  it('accepts valid input', () => {
    const tool = new ExecutorTool();
    expect(tool.validate(makeValidInput())).toBe(true);
  });

  it('rejects null/undefined', () => {
    const tool = new ExecutorTool();
    expect(tool.validate(null as any)).toBe(false);
    expect(tool.validate(undefined as any)).toBe(false);
  });

  it('rejects missing client', () => {
    const tool = new ExecutorTool();
    expect(tool.validate(makeValidInput({ client: undefined }))).toBe(false);
  });

  it('rejects empty model string', () => {
    const tool = new ExecutorTool();
    expect(tool.validate(makeValidInput({ model: '' }))).toBe(false);
  });

  it('rejects non-array messages', () => {
    const tool = new ExecutorTool();
    expect(tool.validate(makeValidInput({ messages: 'not-array' }))).toBe(false);
  });

  it('rejects missing registry', () => {
    const tool = new ExecutorTool();
    expect(tool.validate(makeValidInput({ registry: null }))).toBe(false);
  });

  it('rejects missing agentId', () => {
    const tool = new ExecutorTool();
    expect(tool.validate(makeValidInput({ agentId: '' }))).toBe(false);
  });
});

// ═══════════════════════════════════════════════
// dryRun
// ═══════════════════════════════════════════════

describe('ExecutorTool.dryRun', () => {
  it('returns non-aborted result for valid input', async () => {
    const tool = new ExecutorTool();
    const res = await tool.dryRun(makeValidInput());
    expect(res.aborted).toBe(false);
    expect(res.finalContent).toContain('dry-run');
    expect(res.iterations).toBe(0);
    expect(res.toolResults).toEqual([]);
  });

  it('returns aborted result for invalid input', async () => {
    const tool = new ExecutorTool();
    const res = await tool.dryRun({} as any);
    expect(res.aborted).toBe(true);
    expect(res.finalContent).toContain('invalid');
  });

  it('does NOT call runToolsLoop (no side effects)', async () => {
    const tool = new ExecutorTool();
    const res = await tool.dryRun(makeValidInput());
    // dryRun should return immediately without executing
    expect(res.messages).toEqual([]);
    expect(res.toolResults).toEqual([]);
  });
});

// ═══════════════════════════════════════════════
// execute — error classification
// ═══════════════════════════════════════════════

describe('ExecutorTool.execute — error handling', () => {
  it('throws ExecutorError(validation) for invalid input', async () => {
    const tool = new ExecutorTool();
    await expect(tool.execute({} as any)).rejects.toMatchObject({
      kind: 'validation',
    });
  });

  it('throws ExecutorError(timeout) when timeoutMs exceeded', async () => {
    // Use a client that never returns → triggers timeout
    const hangingClient = {
      chat: {
        completions: {
          create: () => new Promise(() => {}), // never resolves
        },
      },
    };
    const tool = new ExecutorTool();
    const input = makeValidInput({ client: hangingClient });
    await expect(tool.execute(input, { timeoutMs: 100 })).rejects.toMatchObject({
      kind: 'timeout',
    });
  }, 5000);

  it('throws ExecutorError(aborted) when external signal already aborted', async () => {
    const tool = new ExecutorTool();
    const ac = new AbortController();
    ac.abort();
    const input = makeValidInput({ signal: ac.signal });
    await expect(tool.execute(input)).rejects.toMatchObject({
      kind: 'aborted',
    });
  });

  it('throws ExecutorError(runtime) on generic execution failure', async () => {
    const errorClient = {
      chat: {
        completions: {
          create: () => Promise.reject(new Error('API exploded')),
        },
      },
    };
    const tool = new ExecutorTool();
    const input = makeValidInput({ client: errorClient });
    await expect(tool.execute(input, { timeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'runtime',
    });
  }, 10000);
});

// ═══════════════════════════════════════════════
// ExecutorError class
// ═══════════════════════════════════════════════

describe('ExecutorError', () => {
  it('carries kind and cause', () => {
    const cause = new Error('boom');
    const e = new ExecutorError('runtime', 'wrapped', cause);
    expect(e.kind).toBe('runtime');
    expect(e.message).toContain('wrapped');
    expect(e.cause).toBe(cause);
    expect(e.name).toBe('ExecutorError');
  });
});