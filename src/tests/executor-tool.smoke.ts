/**
 * executor-tool.smoke.ts - ExecutorTool 冒烟测试
 *
 * 验收目标（P0 任务）：
 *   1. ExecutorTool.validate / dryRun / execute 存在且行为正确
 *   2. execute 尊重 input.signal（AbortSignal），abort 时抛出明确错误（kind=abort）
 *   3. 错误分类：abort / timeout / cancel / unknown
 *   4. registry.registerToolInstance 注册后 executor 出现在 listToolsForAgent
 *
 * 运行: node --loader tsx src/tests/executor-tool.smoke.ts
 */

import { ExecutorTool, ExecutorToolError, EXECUTOR_TOOL_DEFINITION, classifyExecutorError } from "../tools/executor-tool.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolCallRequest } from "../tools/types.js";

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 构建最小 mock registry：一个 echo 工具 + 一个技能 ──
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
    id: "smoke-skill",
    name: "Smoke",
    description: "smoke test skill",
    tools: ["echo", "executor"],
    prompt: "",
  });
  reg.bindSkills("smoke-agent", ["smoke-skill"]);
  return reg;
}

// ── mock AI client：第一轮返回 tool_calls，第二轮返回纯文本 ──
function makeMockClient() {
  let round = 0;
  return {
    chat: {
      completions: {
        create: async (params: any) => {
          round++;
          if (round === 1) {
            return {
              choices: [{
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{
                    id: "call-1",
                    type: "function",
                    function: { name: "echo", arguments: JSON.stringify({ text: "hello" }) },
                  }],
                },
              }],
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

async function main() {
  console.log("═══ ExecutorTool 冒烟测试 ═══\n");

  // ── 场景 1: validate ──
  console.log("场景 1: validate 参数校验");
  {
    const tool = new ExecutorTool();
    assert("空对象报错", tool.validate({}).length > 0);
    assert("缺 task 报错", tool.validate({ agentId: "x" }).length > 0);
    assert("合法输入通过", tool.validate({ task: "do something" }).length === 0);
    assert("maxIterations 越界报错", tool.validate({ task: "x", maxIterations: 9999 }).length > 0);
    assert("temperature 越界报错", tool.validate({ task: "x", temperature: 5 }).length > 0);
  }

  // ── 场景 2: dryRun 无副作用 ──
  console.log("\n场景 2: dryRun 预演");
  {
    const tool = new ExecutorTool();
    const reg = makeRegistry();
    reg.registerToolInstance(EXECUTOR_TOOL_DEFINITION, tool, { context: { registry: reg, agentId: "smoke-agent" } });
    const preview = tool.dryRun({ task: "预演任务" }, { registry: reg, agentId: "smoke-agent" });
    assert("dryRun 返回 aborted=false", preview.aborted === false);
    assert("plannedIterations 默认 50", preview.plannedIterations === 50);
    assert("工具集包含 echo", preview.toolNames.includes("echo"));
    assert("校验失败时 dryRun 报告错误", tool.dryRun({} as any).notes.some(n => n.includes("校验失败")));
  }

  // ── 场景 3: execute 正常完成（mock AI 两轮收敛）──
  console.log("\n场景 3: execute 正常完成");
  {
    const tool = new ExecutorTool();
    const reg = makeRegistry();
    const result = await tool.execute(
      { task: "调用 echo 工具然后完成任务", agentId: "smoke-agent", maxIterations: 5 },
      { client: makeMockClient(), model: "mock-model", registry: reg }
    );
    assert("finalContent 非空", result.finalContent.includes("任务完成"));
    assert("iterations > 0", result.iterations > 0);
    assert("aborted=false", result.aborted === false);
    assert("工具结果有 1 条 echo", result.toolResults.length === 1 && result.toolResults[0].toolName === "echo");
    assert("echo 执行成功", result.toolResults[0].success === true);
  }

  // ── 场景 4: signal 中止 → 抛出 kind=abort 的明确错误 ──
  console.log("\n场景 4: signal 中止（启动前 + 执行中）");
  {
    const tool = new ExecutorTool();
    const reg = makeRegistry();

    // 4a: 启动前已 abort → 快速失败
    const ac1 = new AbortController();
    ac1.abort();
    let threw4a = false;
    let kind4a = "";
    try {
      await tool.execute(
        { task: "x", agentId: "smoke-agent" },
        { client: makeMockClient(), model: "m", registry: reg, signal: ac1.signal }
      );
    } catch (e: any) {
      threw4a = true;
      kind4a = e instanceof ExecutorToolError ? e.kind : "";
    }
    assert("启动前 abort 快速失败", threw4a);
    assert("错误 kind=abort", kind4a === "abort", `实际 ${kind4a}`);

    // 4b: 执行中 abort → runToolsLoop 返回 aborted=true → 抛出明确错误
    const ac2 = new AbortController();
    let callCount = 0;
    const slowClient = {
      chat: { completions: { create: async (params: any) => {
        callCount++;
        if (callCount === 1) {
          // 第一轮正常返回 tool_call
          return {
            choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "echo", arguments: "{\"text\":\"a\"}" } }] } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        }
        // 第二轮前触发 abort
        ac2.abort();
        return {
          choices: [{ message: { role: "assistant", content: "继续干活" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        };
      } } },
    };
    let threw4b = false;
    let kind4b = "";
    try {
      await tool.execute(
        { task: "x", agentId: "smoke-agent", maxIterations: 10 },
        { client: slowClient, model: "m", registry: reg, signal: ac2.signal }
      );
    } catch (e: any) {
      threw4b = true;
      kind4b = e instanceof ExecutorToolError ? e.kind : "";
    }
    assert("执行中 abort 抛出错误", threw4b);
    assert("错误 kind=abort", kind4b === "abort", `实际 ${kind4b}`);
  }

  // ── 场景 5: 错误分类 classifyExecutorError ──
  console.log("\n场景 5: 错误分类");
  {
    assert("timeout 识别", classifyExecutorError("Request timed out after 30s") === "timeout");
    assert("中文超时识别", classifyExecutorError("任务执行超时") === "timeout");
    assert("cancel 识别", classifyExecutorError("Request was canceled") === "cancel");
    assert("abort 识别", classifyExecutorError("AbortError: request aborted") === "abort");
    assert("signal.aborted 优先判 abort", (() => { const c = new AbortController(); c.abort(); return classifyExecutorError("anything", c.signal); })() === "abort");
    assert("unknown 兜底", classifyExecutorError("weird error") === "unknown");
  }

  // ── 场景 6: registry 注册 + listToolsForAgent 可见 ──
  console.log("\n场景 6: registry 注册与可见性");
  {
    const tool = new ExecutorTool();
    const reg = makeRegistry();
    reg.registerToolInstance(EXECUTOR_TOOL_DEFINITION, tool, { context: { registry: reg, agentId: "smoke-agent" } });
    const visible = reg.listToolsForAgent("smoke-agent").map(t => t.name);
    assert("executor 出现在 listToolsForAgent", visible.includes("executor"), `实际 [${visible.join(",")}]`);
    assert("getToolInstance 返回实例", reg.getToolInstance("executor") instanceof ExecutorTool);

    // 通过 registry.execute 走 handler 双通道（校验失败路径）
    const badReq: ToolCallRequest = { id: "r1", name: "executor", arguments: {} };
    const badRes = await reg.execute(badReq);
    assert("registry.execute 校验失败返回 error", badRes.success === false && (badRes.error || "").includes("参数校验失败"));
  }

  // ── 汇总 ──
  console.log(`\n═══ 结果: ${passed} 通过, ${failed} 失败 ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("冒烟测试异常:", e);
  process.exit(1);
});