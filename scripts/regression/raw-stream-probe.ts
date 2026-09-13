/**
 * 裸流式对照：直接用 OpenAI SDK 开 stream:true，看 provider 到底吐几块。
 * 用来区分「我们的 requestCompletion 没走流式」还是「provider 端自己缓冲」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const providers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/providers.json'), 'utf8'));
const list = Array.isArray(providers) ? providers : (providers.providers || []);
const nv = list.find((p: any) => String(p.id || '').startsWith('nvidia-'));
const client = new OpenAI({ apiKey: nv.apiKey || nv.api_key, baseURL: nv.baseUrl || nv.base_url });

const PROMPT = '用中文写 150 字短文，含一个 ## 标题和一个三项列表。直接输出 Markdown。';
const MODELS = [
  'openai/gpt-oss-20b',
  'z-ai/glm-5.3-flash',
  'nvidia/nemotron-3-super-120b-a12b',
  'deepseek-ai/deepseek-v4-flash-0731',
];

async function probe(model: string) {
  const t0 = Date.now();
  let first = 0, chunks = 0, chars = 0, think = 0;
  try {
    const stream: any = await client.chat.completions.create({
      model,
      stream: true,
      max_tokens: 800,
      messages: [
        { role: 'system', content: '你是中文写作助手。' },
        { role: 'user', content: PROMPT },
      ],
    });
    for await (const c of stream) {
      const d: any = c?.choices?.[0]?.delta || {};
      const txt = d.content || '';
      if (d.reasoning_content) think += String(d.reasoning_content).length;
      if (txt) {
        if (!first) first = Date.now();
        chunks++; chars += txt.length;
      }
    }
    const total = Date.now() - t0;
    console.log(
      `${model.padEnd(42)} 首块 ${String(first ? first - t0 : -1).padStart(6)}ms  总 ${String(total).padStart(6)}ms  ` +
      `chunks ${String(chunks).padStart(4)}  content ${String(chars).padStart(5)}字符  reasoning ${think}字符`
    );
    return { model, first: first - t0, total, chunks, chars, ok: true };
  } catch (e: any) {
    const total = Date.now() - t0;
    console.log(`${model.padEnd(42)} ✗ ${total}ms  ${String(e?.status || '')} ${String(e?.message || e).slice(0, 90)}`);
    return { model, ok: false };
  }
}

const out = [];
for (const m of MODELS) out.push(await probe(m));
const viable = out.filter((r: any) => r.ok && r.chunks > 3);
console.log('\n真·增量流式的模型数：', viable.length, '/', MODELS.length);
if (viable.length) {
  console.log('结论：provider 侧流式正常 → 问题若存在就在我们的封装层');
} else {
  console.log('结论：该 provider 端有缓冲/或全在 reasoning，需换模型或改判定口径');
}
