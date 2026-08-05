import { AIHub } from "../src/ai/hub.js";

const hub = new AIHub();
console.log("Models:", JSON.stringify(hub.listModels()));

try {
  const result = await hub.generate({
    model: "phi4-mini:latest",
    messages: [{ role: "user", content: "你好" }],
    maxTokens: 100,
  });
  console.log("AI Reply:", result.content);
} catch (err: any) {
  console.error("AI FAIL:", err.message);
}
