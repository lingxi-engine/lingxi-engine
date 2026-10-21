/**
 * 从 LLM 响应中提取最外层 JSON 对象。
 *
 * 背景：原实现用贪婪正则 /\{[\s\S]*\}/ 直接从响应里抠 JSON，
 * 但真实 LLM 输出往往带前后废话和 ```json 代码围栏，贪婪匹配会连围栏一起吞掉，
 * 导致 JSON.parse 抛异常 -> 被 catch 吞掉 -> 冲突检测静默降级为「无冲突」。
 * 这个 bug 很隐蔽：功能看起来正常，只是从来不报警。
 *
 * 现在：
 *   1) 优先取 ```json ... ``` 围栏
 *   2) 否则用括号配对扫描出第一个平衡的 JSON 对象（正确处理字符串内的花括号）
 */
export function extractJsonObject(text: string): string {
  if (!text) return '{}';

  // 兼容 llmCall 返回 { content: string } 这类包装对象
  let raw: any = text;
  if (typeof raw === 'object') {
    raw = raw.content ?? raw.text ?? raw.response ?? raw.message ?? '';
  }
  if (typeof raw !== 'string') return '{}';

  // 1) 代码围栏优先
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const scope = fenced ? fenced[1] : raw;

  // 2) 括号配对扫描出第一个平衡的 JSON 对象
  const start = scope.indexOf('{');
  if (start === -1) return '{}';

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < scope.length; i++) {
    const ch = scope[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return scope.slice(start, i + 1);
    }
  }
  return '{}';
}
