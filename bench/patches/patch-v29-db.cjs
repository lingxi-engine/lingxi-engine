// patch-v29-db.cjs — 给 db.ts 新增 listChatMemoryPairs()（幂等）
// 用途：Dreamer 自动整理记忆时需要遍历所有有记忆的 (chat_id, agent_id) 对
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', '..', 'src', 'storage', 'db.ts');
let src = fs.readFileSync(target, 'utf8');

const funcName = 'export function listChatMemoryPairs';
if (src.includes(funcName)) {
  console.log('已应用（跳过）：listChatMemoryPairs 已存在');
  process.exit(0);
}

// 注意：db.ts 使用 CRLF 换行
const anchor = `export function getChatMemories(chatId: string) {\r\n  return queryObjects("SELECT * FROM chat_memories WHERE chat_id = ?", [chatId]);\r\n}`;

if (!src.includes(anchor)) {
  console.error('锚点未命中，终止（避免误改）');
  process.exit(1);
}

const addition = anchor + `\r\n\r\nexport function listChatMemoryPairs(): Array<{ chat_id: string; agent_id: string }> {\r\n  return queryObjects("SELECT DISTINCT chat_id, agent_id FROM chat_memories WHERE memory_summary IS NOT NULL AND length(memory_summary) >= 100");\r\n}`;

src = src.replace(anchor, addition);
fs.writeFileSync(target, src, 'utf8');
console.log('INSERTED: listChatMemoryPairs 已添加到 db.ts');
