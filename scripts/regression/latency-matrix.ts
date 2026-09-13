/**
 * 多 provider 首块延迟 + 增量流式对照表
 * 目的：回答「为什么观感不如别家」——看模型是不是先想 10~80 秒才吐第一个字。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const providers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/providers.json'), 'utf8'));
const list = Array.isArray(providers) ? providers : (providers.providers || []);

const pick = (prefix: string) => list.find((p: any) => String(p.id || '').startsWith(prefix));
const mk = (p: any) => new OpenAI({ apiKey: p.apiKey || p.api_key, baseURL: p.baseUrl || p.base_url });

const PROMPT = '用中文写 120 字短文，含一个 ## 标题和一个三项列表。直接输出 Markdown。';

const TARGETS: Array<{ provider: string; models: string[] }> = [
  { provider: 'local-ollama', models: ['qwen3.8:27b', 'glm-5.2:cloud', 'kimi-k2.7-code:cloud'] },
  { provider: 'openrouter', models: ['liquid/lfm-2.5-2.6b:free', 'meta-llama/llama-3.3-70b-instruct'] },
  { provider: 'deepseek', models: ['deepseek-chat', 'deepseek-v4-flash'] },
  { provider: 'nvidia-', models: ['z-ai/glm-5.3-flash'] },
];

async function probe(client: any, model: string) {
  const t0 = Date.now();
  let first = 0, chunks = 0, chars = 0, think = 0;
  try {
    const stream: any = await client.chat.completions.create({
      model, stream: true, max_tokens: 600,
      messages: [{ role: 'system', content: '你是中文写作助手。' }, { role: 'user', content: PROMPT }],
    });
    for await (const c of stream) {
      const d: any = c?.choices?.[0]?.delta || {};
      if (d.reasoning_content) think += String(d.reasoning_content).length;
      if (d.content) { if (!first) first = Date.now(); chunks++; chars += d.content.length; }
    }
    const total = Date.now() - t0;
    const verdict = chunks > 3 ? '真增量 ✅' : chunks > 0 ? '整块吐 ⚠️' : '只有 reasoning ⚠️';
    console.log(
      `${model.padEnd(36)} 首块 ${String(first ? ((first - t0) / 1000).toFixed(1) + 's' : '--').padStart(7)}` +
      `  总 ${String((total / 1000).toFixed(1) + 's').padStart(7)}  chunks ${String(chunks).padStart(4)}` +
      `  content ${String(chars).padStart(5)}  think ${String(think).padStart(5)}  ${verdict}`
    );
  } catch (e: any) {
    console.log(`${model.padEnd(36)} ✗ ${String(e?.status || '')} ${String(e?.message || e).slice(0, 80)}`);
  }
}

for (const t of TARGETS) {
  const p = pick(t.provider);
  if (!p) { console.log(`[跳过] 未找到 provider: ${t.provider}`); continue; }
  console.log(`\n── ${t.provider} (${p.baseUrl || p.base_url}) ──`);
  const client = mk(p);
  for (const m of t.models) await probe(client, m);
}
