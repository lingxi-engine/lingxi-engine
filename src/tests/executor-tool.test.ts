/**
 * executor-tool.test.ts - ExecutorTool 单元测试（vitest, P1/B2）
 *
 * 对齐 P0 完整版 ExecutorTool（validate 返回 string[]、ExecutorToolError 错误分类）：
 *   - validate(input): string[]（空数组 = 通过）
 *   - dryRun(input, ctx?): 同步无副作用预演 → { aborted, plannedIterations, toolNames, notes }
 *   - execute(input, ctx): 委托 runToolsLoop；错误分类 abort/timeout/cancel/unknown
 *   - classifyExecutorError: 纯函数，中英文消息识别
 *
 * 运行: npm test（vitest）
 */
import { describe, it, expect, vi } from "vitest";
import {
  ExecutorTool,
  ExecutorToolError,
  EXECUTOR_TOOL_DEFINITION,
  classifyExecutorError,
} from "../tools/executor-tool.js";
import type { ExecutorToolInput, ExecutorToolContext } from "../tools/executor-tool.js";
import { ToolRegistry } from "../tools/registry.js";
import type { RunToolsResult } from "../tools/executor.js";

// ═══════════════════════════════════════════════
// 测试脚手架
// ═══════════════════════════════════════════════

/** 真实 registry：echo 工具 + 技能绑定，供 runToolsLoop 正常执行 */
function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.registerTool(
    {
      name: "echo",
      description: "echo back",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    async (args) => ({ echoed: args.text })
  );
  reg.registerSkill({
    id: "test-skill",
    name: "Test",
    description: "test skill",
    tools: ["echo"],
    prompt: "",
  });
  reg.bindSkills("test-agent", ["test-skill"]);
  return reg;
}

/** mock AI client：第一轮返回 tool_calls(echo)，之后返回纯文本"任务完成" */
function makeMockClient() {
  let round = 0;
  return {
    chat: {
      completions: {
        create: async (_params: unknown, _opts?: unknown) => {
          round++;
          if (round === 1) {
            return {
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        id: "call-1",
                        type: "function",
                        function: { name: "echo", arguments: JSON.stringify({ text: "hello" }) },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          }
          return {
            choices: [{ message: { role: "assistant", content: "任务完成" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          };
        },
      },
    },
  };
}

function baseCtx(over: Partial<ExecutorToolContext> = {}): ExecutorToolContext {
  return {
    client: makeMockClient() as unknown as ExecutorToolContext["client"],
    model: "mock-model",
    registry: makeRegistry(),
    ...over,
  };
}

async function captureError(p: () => Promise<unknown>): Promise<unknown> {
  try {
    await p();
    return null;
  } catch (e) {
    return e;
  }
}

// ═══════════════════════════════════════════════
// validate
// ═══════════════════════════════════════════════

describe("ExecutorTool.validate", () => {
  it("empty object -> errors", () => {
    expect(new ExecutorTool().validate({}).length).toBeGreaterThan(0);
  });

  it("valid input -> no errors", () => {
    expect(new ExecutorTool().validate({ task: "do something" })).toEqual([]);
  });

  it("out-of-range maxIterations -> error", () => {
    expect(new ExecutorTool().validate({ task: "x", maxIterations: 9999 }).length).toBeGreaterThan(0);
  });

  it("out-of-range temperature -> error", () => {
    expect(new ExecutorTool().validate({ task: "x", temperature: 5 }).length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// dryRun（同步、无副作用预演）
// ═══════════════════════════════════════════════

describe("ExecutorTool.dryRun", () => {
  it("fake input: aborted=false with planned budget and tool list", () => {
    const tool = new ExecutorTool();
    const reg = makeRegistry();
    const preview = tool.dryRun(
      { task: "dry run task", agentId: "test-agent", maxIterations: 10 },
      { registry: reg, agentId: "test-agent" }
    );

    expect(preview.aborted).toBe(false);
    expect(preview.plannedIterations).toBe(10);
    expect(preview.toolsAvailable).toBeGreaterThan(0);
    expect(preview.toolNames).toContain("echo");
  });

  it("defaults plannedIterations to 50", () => {
    expect(new ExecutorTool().dryRun({ task: "x" }).plannedIterations).toBe(50);
  });

  it("invalid input: plannedIterations=0 and notes report validation failure", () => {
    const preview = new ExecutorTool().dryRun({} as ExecutorToolInput);
    expect(preview.aborted).toBe(false);
    expect(preview.plannedIterations).toBe(0);
    expect(preview.notes.some((n) => n.includes("校验失败"))).toBe(true);
  });

  it("aborted signal is reflected as aborted=true", () => {
    const ac = new AbortController();
    ac.abort();
    expect(new ExecutorTool().dryRun({ task: "x" }, { signal: ac.signal }).aborted).toBe(true);
  });

  it("has no side effects: AI client is never called", () => {
    const client = { chat: { completions: { create: vi.fn() } } };
    new ExecutorTool().dryRun(
      { task: "x", agentId: "test-agent" },
      {
        registry: makeRegistry(),
        agentId: "test-agent",
        client: client as unknown as ExecutorToolContext["client"],
        model: "m",
      }
    );
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════
// execute：错误分类（B2 核心要求）
// ═══════════════════════════════════════════════

describe("ExecutorTool.execute error classification", () => {
  it("signal already aborted before start -> kind=abort", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await captureError(() =>
      new ExecutorTool().execute({ task: "x", agentId: "test-agent" }, baseCtx({ signal: ac.signal }))
    );
    expect(err).toBeInstanceOf(ExecutorToolError);
    expect((err as ExecutorToolError).kind).toBe("abort");
  });

  it("registry throws timeout error -> kind=timeout", async () => {
    const badReg = {
      listToolsForAgent: () => {
        throw new Error("Request timeout: upstream unreachable");
      },
    } as unknown as ToolRegistry;
    const err = await captureError(() =>
      new ExecutorTool().execute({ task: "x", agentId: "test-agent" }, baseCtx({ registry: badReg }))
    );
    expect(err).toBeInstanceOf(ExecutorToolError);
    expect((err as ExecutorToolError).kind).toBe("timeout");
  });

  it("registry throws cancel error -> kind=cancel", async () => {
    const badReg = {
      listToolsForAgent: () => {
        throw new Error("User cancelled the operation");
      },
    } as unknown as ToolRegistry;
    const err = await captureError(() =>
      new ExecutorTool().execute({ task: "x", agentId: "test-agent" }, baseCtx({ registry: badReg }))
    );
    expect(err).toBeInstanceOf(ExecutorToolError);
    expect((err as ExecutorToolError).kind).toBe("cancel");
  });

  it("registry throws unknown error -> kind=unknown", async () => {
    const badReg = {
      listToolsForAgent: () => {
        throw new Error("Something exploded unexpectedly");
      },
    } as unknown as ToolRegistry;
    const err = await captureError(() =>
      new ExecutorTool().execute({ task: "x", agentId: "test-agent" }, baseCtx({ registry: badReg }))
    );
    expect(err).toBeInstanceOf(ExecutorToolError);
    expect((err as ExecutorToolError).kind).toBe("unknown");
  });

  it("validation failure -> kind=unknown with 参数校验失败 message", async () => {
    const err = await captureError(() =>
      new ExecutorTool().execute({ task: "" } as unknown as ExecutorToolInput, baseCtx())
    );
    expect(err).toBeInstanceOf(ExecutorToolError);
    expect((err as ExecutorToolError).kind).toBe("unknown");
    expect((err as ExecutorToolError).message).toContain("参数校验失败");
  });

  it("missing agentId -> kind=unknown mentioning agentId", async () => {
    const err = await captureError(() => new ExecutorTool().execute({ task: "x" }, baseCtx()));
    expect(err).toBeInstanceOf(ExecutorToolError);
    expect((err as ExecutorToolError).kind).toBe("unknown");
    expect((err as ExecutorToolError).message).toContain("agentId");
  });

  it("abort during execution -> kind=abort with partialResult preserved", async () => {
    const ac = new AbortController();
    const client = {
      chat: {
        completions: {
          create: async (_p: unknown, _o?: unknown) => {
            // 第一轮调用时触发 abort，模拟执行中被取消
            ac.abort();
            return {
              choices: [{ message: { role: "assistant", content: "第一轮回复" } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            };
          },
        },
      },
    };
    const err = await captureError(() =>
      new ExecutorTool().execute(
        { task: "x", agentId: "test-agent", maxIterations: 5 },
        baseCtx({ client: client as unknown as ExecutorToolContext["client"], signal: ac.signal })
      )
    );
    expect(err).toBeInstanceOf(ExecutorToolError);
    expect((err as ExecutorToolError).kind).toBe("abort");
    // partialResult 保留：已完成的迭代信息在 result 中
    const partial = (err as unknown as { partialResult?: RunToolsResult }).partialResult;
    expect(partial).toBeDefined();
    expect(partial!.iterations).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════
// classifyExecutorError（纯函数）
// ═══════════════════════════════════════════════

describe("classifyExecutorError", () => {
  it("classifies english messages", () => {
    expect(classifyExecutorError("Request aborted by user")).toBe("abort");
    expect(classifyExecutorError("ETIMEDOUT on socket")).toBe("timeout");
    expect(classifyExecutorError("operation cancelled")).toBe("cancel");
    expect(classifyExecutorError("weird failure")).toBe("unknown");
  });

  it("classifies chinese messages", () => {
    expect(classifyExecutorError("请求超时")).toBe("timeout");
    expect(classifyExecutorError("任务已取消")).toBe("cancel");
  });

  it("aborted signal takes priority over message content", () => {
    const ac = new AbortController();
    ac.abort();
    expect(classifyExecutorError("anything at all", ac.signal)).toBe("abort");
  });
});

// ═══════════════════════════════════════════════
// execute 正常完成路径
// ═══════════════════════════════════════════════

describe("ExecutorTool.execute success path", () => {
  it("mock AI converges in two rounds with one echo tool call", async () => {
    const result = await new ExecutorTool().execute(
      { task: "调用 echo 工具然后完成任务", agentId: "test-agent", maxIterations: 5 },
      baseCtx()
    );
    expect(result.aborted).toBe(false);
    expect(result.iterations).toBeGreaterThanOrEqual(2);
    expect(result.finalContent).toContain("任务完成");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].toolName).toBe("echo");
    expect(result.toolResults[0].success).toBe(true);
  });

  it("registered executor is visible via listToolsForAgent", () => {
    const tool = new ExecutorTool();
    const reg = makeRegistry();
    reg.registerToolInstance(EXECUTOR_TOOL_DEFINITION, tool, {
      context: { registry: reg, agentId: "test-agent" },
    });
    const names = reg.listToolsForAgent("test-agent").map((t) => t.name);
    expect(names).toContain("executor");
    expect(names).toContain("echo");
  });
});