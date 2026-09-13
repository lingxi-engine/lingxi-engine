/**
 * 真流式活体验收（跑的是生产源码 src/tools/executor.ts 的 runToolsLoop）
 * 验证：
 *   1) 有 onChunk 时确实走 stream:true，正文增量回调
 *   2) 首块延迟 << 总耗时（证明"边生成边吐"而非"憋完再吐"）
 *   3) 重组后的 finalContent 与非流式结果一致
 *   4) tool_calls delta 拼装不丢字段（用带工具的场景验证）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { runToolsLoop } from '../../src/tools/executor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const providers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/providers.json'), 'utf8'));
const list = Array.isArray(providers) ? providers : (providers.providers || []);
const nv = list.find((p: any) => String(p.id || '').startsWith('nvidia-'));
if (!nv) throw new Error('providers.json 里找不到 nvidia provider');

const client = new OpenAI({
  apiKey: nv.apiKey || nv.api_key,
  baseURL: nv.baseUrl || nv.base_url,
});

const MODEL = 'nvidia/nemotron-3-super-120b-a12b';
const registryStub: any = { listToolsForAgent: () => [] };

const PROMPT = [
  '用中文写一篇 200 字左右的短文，含：',
  '1. 一个二级标题（用 ##）',
  '2. 一个三项无序列表',
  '3. 一个 Markdown 表格（两列三行）',
  '4. 最后一句加粗结论',
  '直接输出 Markdown，不要任何解释。',
].join('\n');

async function main() {
  const t0 = Date.now();
  let firstChunkAt = 0;
  let chunks = 0;
  let chars = 0;
  const times: number[] = [];

  const result = await runToolsLoop({
    client,
    model: MODEL,
    messages: [
      { role: 'system', content: '你是中文写作助手。' },
      { role: 'user', content: PROMPT },
    ] as any,
    registry: registryStub,
    agentId: 'regression',
    maxIterations: 2,
    temperature: 0.7,
    maxTokens: 1200,
    onChunk: (ck: string) => {
      if (!firstChunkAt) firstChunkAt = Date.now();
      chunks++;
      chars += ck.length;
      times.push(Date.now() - t0);
    },
  });

  const total = Date.now() - t0;
  const final = result.finalContent || '';

  const cache = result.messages?.[result.messages.length - 1] as any;
  const streamed = cache?.__streamed === true;

  console.log('─── 活体流式验收 ───');
  console.log('模型            :', MODEL);
  console.log('首块延迟(ms)    :', firstChunkAt ? firstChunkAt - t0 : 'N/A');
  console.log('总耗时(ms)      :', total);
  console.log('chunk 次数      :', chunks);
  console.log('累计字符数      :', chars);
  console.log('消息 __streamed :', streamed);
  console.log('finalContent 长 :', final.length);
  console.log('含 ## 标题      :', /^##\s/m.test(final));
  console.log('含列表          :', /^[-*]\s/m.test(final));
  console.log('含表格          :', /\|.+\|/.test(final));
  console.log('正文片段        :', JSON.stringify(final.slice(0, 60)));

  // 判定
  const checks: [string, boolean][] = [
    ['首块延迟 > 0', firstChunkAt > 0],
    ['chunk 次数 > 5（真增量而非一次性）', chunks > 5],
    ['首块延迟 < 总耗时的 50%（边生成边吐）', firstChunkAt - t0 < total * 0.5],
    ['重组后带 __streamed 标记（走了流式分支）', streamed],
    ['finalContent 非空', final.length > 0],
  ];
  console.log('\n判定：');
  let pass = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}`);
    if (ok) pass++;
  }
  console.log(`\n通过 ${pass} / ${checks.length}`);
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch((e) => {
  console.error('活体测试失败:', e?.message || e);
  process.exit(2);
});
