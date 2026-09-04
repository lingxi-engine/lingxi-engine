/**
 * executor-tool.smoke.ts - ExecutorTool 冒烟测试（P1/B1 CI 用）
 *
 * 运行: npm run test:smoke
 *   即 node --loader tsx src/tests/executor-tool.smoke.ts
 *
 * 覆盖场景（不烧真实 token，AI client 为假实现）：
 *   1. validate：空 task 报错、正常输入通过
 *   2. dryRun：同步无副作用（AI client 零调用）
 *   3. execute：纯文本任务一轮闭环
 *   4. execute：AI 调 echo 工具 → 结果回喂 → 完成
 *   5. execute：signal 已 abort → 快速失败（abort 分类）
 *   6. classifyExecutorError：中英文消息识别
 */

import {
  ExecutorTool,
  ExecutorToolError,
  EXECUTOR_TOOL_DEFINITION,
  classifyExecutorError,
} from "../tools/executor-tool.js";
import type { ExecutorToolContext } from "../tools/executor-tool.js";
import { ToolRegistry } from "../tools/registry.js";

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 真 registry：echo 工具 + 技能绑定，供 runToolsLoop 正常执行 */
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
    description: "smoke skill",
    tools: ["echo"],
    prompt: "",
  });
  reg.bindSkills("smoke-agent", ["smoke-skill"]);
  return reg;
}

/** 假 AI client：按脚本依次返回响应 */
function makeFakeClient(responses: any[]): { client: any; calls: () => number } {
  let n = 0;
  return {
    client: {
      chat: {
        completions: {
          create: async () => {
            const r = responses[Math.min(n, responses.length - 1)];
            n++;
            return r;
          },
        },
      },
    },
    calls: () => n,
  };
}

/** 纯文本响应（无 tool_calls → 循环一轮即完成） */
function textResp(content: string): any {
  return {
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

/** 工具调用响应 */
function toolCallResp(name: string, args: Record<string, unknown>): any {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
          finish_reason: "tool_calls",
        },
      },
    ],
  };
}

async function main(): Promise<void> {
  console.log("\n=== ExecutorTool 冒烟测试 ===\n");

  const tool = new ExecutorTool();

  // ── 场景 1: validate ──
  console.log("[1] validate 参数校验");
  const emptyErrs = tool.validate({ task: "" });
  ok("空 task 被拒绝", emptyErrs.length > 0);
  const goodErrs = tool.validate({ task: "hello" });
  ok("正常输入通过", goodErrs.length === 0);

  // ── 场景 2: dryRun 无副作用 ──
  console.log("[2] dryRun 无副作用预演");
  const reg = makeRegistry();
  const fake = makeFakeClient([textResp("done")]);
  const ctx: ExecutorToolContext = {
    client: fake.client,
    model: "fake-model",
    registry: reg,
    agentId: "smoke-agent",
  };
  const dry = (tool as any).dryRun({ task: "preview" }, ctx);
  ok("dryRun 返回预演结果", dry != null);
  ok("dryRun 零 AI 调用", fake.calls() === 0, `实际调用 ${fake.calls()} 次`);

  // ── 场景 3: execute 纯文本闭环 ──
  console.log("[3] execute 纯文本任务");
  const fake3 = makeFakeClient([textResp("任务完成")]);
  const r3 = await tool.execute({ task: "说句话" }, { ...ctx, client: fake3.client });
  ok("execute 返回 finalContent", r3.finalContent === "任务完成");
  ok("iterations >= 1", r3.iterations >= 1);

  // ── 场景 4: execute 工具调用闭环 ──
  console.log("[4] execute AI 调用 echo 工具");
  const fake4 = makeFakeClient([
    toolCallResp("echo", { text: "hi" }),
    textResp("工具结果已收到"),
  ]);
  const r4 = await tool.execute({ task: "调用 echo" }, { ...ctx, client: fake4.client });
  ok("工具调用后完成", r4.finalContent === "工具结果已收到");
  ok("toolResults 有记录", Array.isArray(r4.toolResults) && r4.toolResults.length >= 1);

  // ── 场景 5: abort 快速失败 ──
  console.log("[5] signal 已 abort 快速失败");
  const ac = new AbortController();
  ac.abort();
  try {
    await tool.execute({ task: "x" }, { ...ctx, signal: ac.signal });
    ok("应抛 ExecutorToolError", false, "未抛错");
  } catch (e) {
    ok(
      "抛出 abort 分类错误",
      e instanceof ExecutorToolError && e.kind === "abort",
      String(e)
    );
  }

  // ── 场景 6: 错误分类 ──
  console.log("[6] classifyExecutorError 识别");
  ok("中文'中止'→ abort", classifyExecutorError("任务被中止") === "abort");
  ok("英文'aborted'→ abort", classifyExecutorError("request aborted") === "abort");
  ok("timeout → timeout", classifyExecutorError("operation timed out") === "timeout");
  ok("cancel → cancel", classifyExecutorError("user cancelled") === "cancel");
  ok("其他 → unknown", classifyExecutorError("weird failure") === "unknown");

  // ── 汇总 ──
  console.log(`\n=== 结果: ${passed} 通过 / ${failed} 失败 ===`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log("ALL_OK=True");
}

main().catch((e) => {
  console.error("SMOKE_FATAL:", e);
  process.exit(1);
});