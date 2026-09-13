import path from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * 灵犀引擎 · 流式 UI 功能测试
 * 不装 jsdom，用最小 DOM 桩跑真实的 markdownToHtml / streamRenderNow 源码。
 * 覆盖：块级 markdown、段落换行、表格回归、snake_case 防误伤、链接协议白名单、
 *       半截围栏补齐、裸星号不吃、光标插入与收尾摘除。
 */
import fs from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const app = fs.readFileSync(path.join(ROOT, 'web/js/app.js'), 'utf8');

// ── 从真实源码里抠出待测函数（顶层 function，以行首 } 结束）──
function extract(name) {
  const key = 'function ' + name + '(';
  const a = app.indexOf(key);
  if (a < 0) throw new Error('未找到函数: ' + name);
  const b = app.indexOf('\n}', a);
  if (b < 0) throw new Error('函数体边界异常: ' + name);
  return app.slice(a, b + 2);
}

const NAMES = ['esc', 'markdownToHtml', 'mdRenderBlocks', 'mdRenderInline', 'parseMarkdownTable',
  'balanceCodeFences', 'streamRenderNow', 'streamFinish', 'streamScheduleRender', 'streamAutoScroll'];
const src = NAMES.map(extract).join('\n');

// ── 最小 DOM 桩 ──
function escHtml(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
class El {
  constructor(tag) { this.tag = tag; this._html = ''; this.children = []; this.style = {}; this.dataset = {}; this.classList = { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }, contains(c) { return this._s.has(c); } }; }
  set textContent(v) { this._text = String(v); this._html = escHtml(v); }
  get textContent() { return this._text || this._html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  querySelector(sel) { return this._q ? this._q(sel) : null; }
  insertAdjacentHTML(pos, html) { this._html += html; }
}
const document = {
  createElement(tag) { return new El(tag); },
  getElementById() { return null; },
};
const t = (k) => k;
const highlightBlocks = () => {};

const sandbox = new Function('document', 't', 'highlightBlocks',
  '"use strict";' + src + '\nreturn { markdownToHtml, balanceCodeFences, streamRenderNow, streamFinish, streamScheduleRender };');
const api = sandbox(document, t, highlightBlocks);

// ── 断言框架 ──
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  → ' + extra : '')); }
}
function has(hay, needle, name) { ok(name, hay.includes(needle), '实际输出: ' + hay.slice(0, 220)); }

console.log('\n【1】块级 Markdown 渲染');
const md = api.markdownToHtml([
  '# 一级标题',
  '',
  '正文里有 **粗体**、*斜体* 和 ~~删除线~~。',
  '',
  '## 二级标题',
  '',
  '- 无序甲',
  '- 无序乙',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '> 引用一行',
  '> 引用二行',
  '',
  '---',
  '',
  '行内 `code` 与 [链接](https://example.com)。',
].join('\n'));
has(md, '<h1 class="md-h">一级标题</h1>', 'H1 标题');
has(md, '<h2 class="md-h">二级标题</h2>', 'H2 标题');
has(md, '<strong>粗体</strong>', '粗体');
has(md, '<em>斜体</em>', '斜体');
has(md, '<del>删除线</del>', '删除线');
has(md, '<ul><li>无序甲</li><li>无序乙</li></ul>', '无序列表聚合');
has(md, '<ol><li>有序一</li><li>有序二</li></ol>', '有序列表聚合');
has(md, '<blockquote class="md-quote">引用一行<br>引用二行</blockquote>', '引用块聚合');
has(md, '<hr class="md-hr">', '分隔线');
has(md, '<code>code</code>', '行内代码');
has(md, '<a href="https://example.com" target="_blank" rel="noopener noreferrer">链接</a>', '链接渲染');

console.log('\n【2】回归：此前换行被 HTML 折叠成一坨');
const p = api.markdownToHtml('第一行\n第二行\n\n新段落');
ok('单换行也成段', p.includes('<p class="md-p">第一行</p>') && p.includes('<p class="md-p">第二行</p>'), p);
ok('空行分段', p.includes('<p class="md-p">新段落</p>'), p);

console.log('\n【3】回归：表格');
const tbl = api.markdownToHtml('| 模型 | 状态 |\n|---|---|\n| A | ✅ |\n| B | ❌ |');
has(tbl, '<div class="md-table-wrap"><table class="md-table">', '表格包装');
has(tbl, '<th style="text-align:left">模型</th>', '表头');
has(tbl, '<table class="md-table">', 'table 未被段落包裹');

console.log('\n【4】回归：代码块');
const cb = api.markdownToHtml('说明：\n\n```js\nconst a = 1;\n```\n\n结束');
has(cb, '<pre><code class="language-js">const a = 1;</code></pre>', '围栏代码块');
ok('代码块不被裹进 <p>', cb.includes('\n<pre>') || cb.startsWith('<pre>') || !cb.includes('<p class="md-p"><pre>'), cb);

console.log('\n【5】防误伤：snake_case / 裸星号 / 异常链接');
const snake = api.markdownToHtml('变量 foo_bar_baz 和 a_b_c 保持原样');
ok('snake_case 不被斜体化', snake.includes('foo_bar_baz') && !snake.includes('<em>'), snake);
const star = api.markdownToHtml('2 * 3 = 6 表示乘法');
ok('裸星号不吃', star.includes('2 * 3 = 6') && !star.includes('<em>'), star);
const evil = api.markdownToHtml('[点我](javascript:alert(1))');
ok('javascript: 链接被拦', !evil.includes('<a ') && evil.includes('javascript:alert(1)'), evil);

console.log('\n【6】流式辅助');
const bal = api.balanceCodeFences('```js\nconst a = 1;');
ok('半截围栏自动补齐', bal.endsWith('```') && bal.split('```').length - 1 === 2, JSON.stringify(bal));
const bal2 = api.balanceCodeFences('```js\nconst a = 1;\n```');
ok('闭合围栏不重复补', bal2 === '```js\nconst a = 1;\n```', JSON.stringify(bal2));

console.log('\n【7】streamRenderNow：光标插入 / 收尾摘除');
const el = new El('div');
const contentEl = new El('div');
el._q = (sel) => (sel === '.msg-content' ? contentEl : null);
const s = { el, content: '**流式中** 的正文', think: '', _dead: false };

api.streamRenderNow(s, false);
ok('流式中渲染出 Markdown', contentEl.innerHTML.includes('<strong>流式中</strong>'), contentEl.innerHTML);
ok('流式中尾部挂光标', contentEl.innerHTML.includes('class="stream-cursor"'), contentEl.innerHTML);

api.streamRenderNow(s, true);
ok('收尾摘掉光标', !contentEl.innerHTML.includes('stream-cursor'), contentEl.innerHTML);
ok('收尾保留 Markdown', contentEl.innerHTML.includes('<strong>流式中</strong>'), contentEl.innerHTML);

console.log('\n【8】streamFinish：状态清理');
const el2 = new El('div');
const contentEl2 = new El('div');
let dotRemoved = false;
el2._q = (sel) => {
  if (sel === '.msg-content') return contentEl2;
  if (sel === '.typing-dot') return { remove() { dotRemoved = true; } };
  if (sel === '.stream-cursor') return null;
  return null;
};
const s2 = { el: el2, content: '收尾正文', think: '', thinkEl: null, _dead: false };
api.streamFinish(s2);
ok('标记 _dead 停止后续节流回调', s2._dead === true);
ok('移除 typing-dot', dotRemoved === true);
ok('streaming class 已摘', el2.classList.contains('streaming') === false);
ok('最终内容落地', contentEl2.innerHTML.includes('收尾正文'), contentEl2.innerHTML);

console.log('\n════════════════════════════════');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
