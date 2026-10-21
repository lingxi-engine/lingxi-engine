/**
 * 回归测试：本次修复的真实 Bug
 *
 * BUG-1: db.ts 中 markDirty() 被写进 SQL 模板字符串 → SQL 语法错误
 *        （LAN 群成员添加功能直接挂掉）
 * BUG-2: fact-conflict-detector.ts 双重转义 → 正则失效
 *        （LLM 冲突检测的 JSON 提取恒为空 / 规则模式匹配不到）
 * BUG-3: manager.update 变 async 后调用点漏 await → 异常被静默吞掉
 * BUG-4: parseResponse 贪婪正则 → 真实 LLM 输出带围栏时静默降级为「无冲突」
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..', '..');

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('BUG-1: db.ts 中 markDirty() 不得混入 SQL 字符串', () => {
  const src = readSrc('src/storage/db.ts');

  it('markDirty() 调用前一行不得是反引号模板 SQL 的延续', () => {
    const lines = src.split(/\r?\n/);
    const offenders: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*markDirty\(\);?\s*$/.test(lines[i])) continue;
      const prev = (lines[i - 1] || '').trim();
      // 上一行若以反引号/逗号结尾且本行缩进更深，说明落在 SQL 模板串里
      if (/`\s*,?$/.test(prev) && /^\s{4,}/.test(lines[i])) {
        offenders.push(`line ${i + 1}: prev=[${prev}] cur=[${lines[i].trim()}]`);
      }
    }
    expect(offenders, 'markDirty() 被写进了 SQL 模板字符串:\n' + offenders.join('\n')).toEqual([]);
  });

  it('lan_group_members 插入语句结构完整', () => {
    const i = src.indexOf('INSERT OR REPLACE INTO lan_group_members');
    expect(i).toBeGreaterThan(-1);
    const seg = src.slice(i, i + 300);
    expect(seg).toContain('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    expect(seg).not.toMatch(/markDirty\(\);/);
  });
});

describe('BUG-2: fact-conflict-detector.ts 不得双重转义', () => {
  const src = readSrc('src/memory/fact-conflict-detector.ts');

  it('矛盾模式正则用 \\s 而非 \\\\s', () => {
    expect(src).not.toMatch(/\[：:\]\\\\s\*/);
    expect(src).toMatch(/\[：:\]\\s\*/);
  });

  it('不得残留贪婪 JSON 提取正则', () => {
    expect(src).not.toMatch(/response\.match\(\/\\\\\{/);
    expect(src).not.toMatch(/response\.match\(\/\\\{\[\\s\\S\]\*\\\}\/\)/);
    expect(src).toContain('extractJsonObject(response)');
  });

  it('buildPrompt 模板里不得出现字面量 \\\\n（会挤成一坨）', () => {
    const s = src.indexOf('private buildPrompt');
    const e = src.indexOf('private parseResponse');
    const seg = src.slice(s, e);
    // 模板字符串里出现反斜杠+n 两字符 -> 运行时输出字面 "\n"，LLM 收到的是挤在一起的提示词
    const scrubbed = seg.replace(/\.join\('\\n'\)/g, '.join(JOIN_NL)');
    expect(scrubbed, 'buildPrompt 存在字面 \\n，LLM 会收到挤在一起的提示词').not.toContain('\\n');
  });
});

describe('BUG-4: extractJsonObject 必须稳健处理真实 LLM 输出', () => {
  it('裸 JSON', async () => {
    const { extractJsonObject } = await import('../json-extract.js');
    expect(JSON.parse(extractJsonObject('{"conflicts":[]}')).conflicts).toEqual([]);
  });

  it('带前后废话', async () => {
    const { extractJsonObject } = await import('../json-extract.js');
    const s = '好的，我来分析。\n{"conflicts":[{"index":1}]}\n以上是我的判断。';
    expect(JSON.parse(extractJsonObject(s)).conflicts).toHaveLength(1);
  });

  it('带 ```json 代码围栏', async () => {
    const { extractJsonObject } = await import('../json-extract.js');
    const s = '前置说明\n```json\n{"conflicts":[{"index":1,"reason":"direct_contradiction"}]}\n```\n后置说明';
    const r = JSON.parse(extractJsonObject(s));
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].reason).toBe('direct_contradiction');
  });

  it('JSON 字符串里含花括号不被截断', async () => {
    const { extractJsonObject } = await import('../json-extract.js');
    const s = '{"note":"这里有个 } 花括号","conflicts":[{"index":2}]}';
    const r = JSON.parse(extractJsonObject(s));
    expect(r.conflicts).toHaveLength(1);
    expect(r.note).toBe('这里有个 } 花括号');
  });

  it('非法输入不抛异常，退化为 {}', async () => {
    const { extractJsonObject } = await import('../json-extract.js');
    expect(extractJsonObject('')).toBe('{}');
    expect(extractJsonObject('完全不是 JSON')).toBe('{}');
    expect(extractJsonObject('{"未闭合":')).toBe('{}');
  });

  it('LLM 冲突检测端到端能识别出冲突（带围栏的真实响应）', async () => {
    const { LLMConflictDetector } = await import('../fact-conflict-detector.js');
    const det = new LLMConflictDetector(async () => (
      '前置说明\n```json\n{"conflicts":[{"index":1,"reason":"direct_contradiction","severity":"high","suggestion":"replace_old"}]}\n```\n后置说明'
    ) as any);
    const existing = new Map<string, any>([
      ['职业', { key: '职业', value: '教师', source: 'assistant', confidence: 0.5, createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000 }],
    ]);
    const newFact: any = { key: '职业', value: '医生', source: 'user', confidence: 0.9, createdAt: Date.now(), updatedAt: Date.now() };
    const res = await det.detect(newFact, existing);
    expect(res.hasConflict).toBe(true);
    expect(res.conflicts.length).toBeGreaterThan(0);
    expect(res.conflicts[0].existingKey).toBe('职业');
  });
});

describe('BUG-3: manager.update 的所有调用点必须 await', () => {
  const files = ['src/routes/agent.ts', 'src/routes/auth-main.ts', 'src/routes/auth.ts'];

  it('每个 manager.update 调用点都带 await', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readSrc(f).split(/\r?\n/);
      lines.forEach((l, i) => {
        if (/manager\.update\s*\(/.test(l) && !/await\s+manager\.update\s*\(/.test(l)) {
          offenders.push(`${f}:${i + 1} ${l.trim()}`);
        }
      });
    }
    expect(offenders, '漏 await 会让异常变成 unhandled rejection:\n' + offenders.join('\n')).toEqual([]);
  });

  it('含 await 的调用点所在 handler 必须是 async', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readSrc(f).split(/\r?\n/);
      lines.forEach((l, i) => {
        if (!/await\s+manager\.update\s*\(/.test(l)) return;
        for (let j = i; j >= 0; j--) {
          if (/^\s*(router|app)\.(get|post|put|patch|delete)\s*\(/.test(lines[j])) {
            if (!/async\s*\(/.test(lines[j])) {
              offenders.push(`${f}:${i + 1} 所在 handler 非 async -> ${lines[j].trim().slice(0, 80)}`);
            }
            break;
          }
        }
      });
    }
    expect(offenders, '非 async handler 里出现 await 是语法错误:\n' + offenders.join('\n')).toEqual([]);
  });
});
