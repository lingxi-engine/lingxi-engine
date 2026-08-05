// 简单测试：用 phi4-mini 做计算，确认工具调用循环
const ws = new WebSocket("ws://localhost:3456/ws?id=user-shen");

ws.onopen = async () => {
  await new Promise(r => setTimeout(r, 800));
  console.log("[Test] connected");
  ws.send(JSON.stringify({
    type: "message",
    chatId: "chat-demo-1",
    content: "帮我算 999*123"
  }));
  console.log("[Test] sent: 帮我算 999*123");
};

ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.type === "message.new" && d.senderType === "agent") {
    console.log("\n=== AI REPLY ===");
    console.log("From:", (d.from || "").slice(0, 30));
    console.log("Content:", String(d.content).slice(0, 800));
    console.log("=== END ===\n");
    setTimeout(() => process.exit(0), 3000);
  }
};

ws.onerror = (e) => { console.error("WS err"); process.exit(1); };
setTimeout(() => { console.log("[Test] 60s timeout"); process.exit(1); }, 60000);
