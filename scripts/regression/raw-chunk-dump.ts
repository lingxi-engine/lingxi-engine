/**
 * 原始 SSE chunk 结构 dump：看看 local-ollama / openrouter 免费模型到底把正文放哪个字段。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const providers = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/providers.json'), 'utf8'));
const list = Array.isArray(providers) ? providers : (providers.providers || []);

const TARGETS = process.argv.slice(2);
if (!TARGETS.length) {
  console.log('用法: tsx raw-chunk-dump.ts <providerId前缀>/<model>');
  process.exit(0);
}

for (const t of TARGETS) {
  const [prefix, ...rest] = t.split('/');
  const model = rest.join('/');
  const p = list.find((x: any) => String(x.id || '').startsWith(prefix));
  if (!p) { console.log(`[跳过] ${t}: 无 provider`); continue; }
  const base = p.baseUrl || p.base_url;
  const key = p.apiKey || p.api_key || '';
  console.log(`\n══════ ${prefix} :: ${model} @ ${base} ══════`);

  const res = await fetch(base.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, stream: true, max_tokens: 300,
      messages: [{ role: 'user', content: '说一句话介绍你自己。' }],
    }),
  });
  console.log('HTTP', res.status, res.headers.get('content-type'));
  if (!res.ok) { console.log(String(await res.text()).slice(0, 400)); continue; }

  const reader = (res.body as any).getReader();
  const dec = new TextDecoder();
  let buf = '', n = 0;
  const shapes = new Map<string, number>();
  let samples: string[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const ln of lines) {
      const s = ln.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j: any;
      try { j = JSON.parse(payload); } catch { continue; }
      n++;
      const d = j?.choices?.[0]?.delta ?? j?.choices?.[0]?.message ?? j?.delta ?? {};
      const keys = Object.keys(d || {}).join(',') || '(none)';
      shapes.set(keys, (shapes.get(keys) || 0) + 1);
      if (samples.length < 4) samples.push(JSON.stringify(j).slice(0, 300));
      if (n >= 400) break;
    }
  }
  console.log('chunk 总数:', n);
  console.log('delta 字段分布:');
  for (const [k, v] of shapes) console.log(`   [${v}] ${k}`);
  console.log('前几个原始 chunk:');
  for (const s of samples) console.log('   ', s);
}
