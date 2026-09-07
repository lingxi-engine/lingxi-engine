import "dotenv/config";
import { AIHub } from "../ai/hub.js";

const hub = new AIHub();
console.log("[test] providers loaded");
console.log("[test] DEFAULT_MODEL =", process.env.DEFAULT_MODEL || "(not set)");

// 模拟路由关闭场景：直接调用 generate，model 用 .env 里的 DEFAULT_MODEL (deepseek-v4-flash)
const model = process.env.DEFAULT_MODEL || "deepseek-v4-flash";
console.log("[test] calling hub.generate with model =", model);

try {
  const result = await hub.generate({
    model,
    messages: [{ role: "user", content: "say ok" }],
    maxTokens: 10,
  });
  console.log("[test] ✅ SUCCESS, content =", JSON.stringify(result.content));
  console.log("[test] usage =", JSON.stringify(result.usage));
  process.exit(0);
} catch (err: any) {
  console.error("[test] ❌ FAIL:", err.message);
  process.exit(1);
}
