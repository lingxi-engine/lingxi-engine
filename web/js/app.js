// ── Error Guard ──
window.onerror = function(msg, url, line) {
  console.error('[GlobalError]', msg, 'at', url + ':' + line);
  toast(t('err.jsError', { msg: String(msg).slice(0, 60) }));
  return false;
};
window.addEventListener('unhandledrejection', function(e) {
  console.error('[Unhandled]', e.reason);
});

// ── State ──
let ws = null, clientId = null, currentChat = null;
let myChats = [], unreadCounts = {}, reconnectAttempts = 0, reconnectTimer = null;
let myFriends = [], incomingRequests = [], searchResults = [], currentFriendTab = 'friends';
let requestNotifyCount = 0, currentFile = null, isMentioning = false, mentionList = [], mentionIndex = -1;
// 乐观渲染去重：记录客户端已立即渲染的消息，服务端回传时跳过避免重。
const _optimisticSent = new Set();
let streamingMsgs = {};
// 流式收尾后短暂保留 msgId → 已渲染的气泡段（segments），供随后的 message.new 按 msgId 校正而非重复追加
let recentStreamed = {};
let connectIntended = false;
let sendQueue = [];        // 排队消息：Agent 回复中时先存这里，回复结束后按序自动发。
let generatingChats = {};  // chatId -> 当前进行中的回复数（start/end 成对，用于判断是。生成。。
let _currentAskGoalId = null;  // 当前反问的目标ID，供多选表单按钮回溯使。

// 持久化未读计数（v2.1.3: 。web/app.js 同步过来，F5 刷新后保留未读红点）
function saveUnreadCounts() {
  try { localStorage.setItem('lingxi-unread', JSON.stringify(unreadCounts)); } catch(e) {}
}
function restoreUnreadCounts() {
  try { unreadCounts = JSON.parse(localStorage.getItem('lingxi-unread') || '{}'); } catch(e) { unreadCounts = {}; }
}

// ══。Panel Switching ══。
function switchPanel(name) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
  document.querySelectorAll('.content-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (name === 'market') loadMarket();
  if (name === 'tools') loadTools();
  if (name === 'social') loadSocial();
}

let marketTab = 'browse';
let currentDetailId = null;

function switchMarketTab(tab) {
  marketTab = tab;
  document.getElementById('marketTabBrowse').style.background = tab === 'browse' ? 'var(--accent)' : 'var(--bg3)';
  document.getElementById('marketTabBrowse').style.color = tab === 'browse' ? '#fff' : 'var(--text2)';
  document.getElementById('marketTabMine').style.background = tab === 'mine' ? 'var(--accent)' : 'var(--bg3)';
  document.getElementById('marketTabMine').style.color = tab === 'mine' ? '#fff' : 'var(--text2)';
  loadMarket();
}

function showPublishForm() { document.getElementById('publishForm').style.display = 'block'; }

async function loadMarket() {
  const search = document.getElementById('marketSearch')?.value?.toLowerCase() || '';
  const cat = document.getElementById('marketCategory')?.value || '';
  const sort = document.getElementById('marketSort')?.value || 'hot';
  const grid = document.getElementById('listingGrid');
  try {
    const d = await api('/api/market/list', 'GET');
    let listings = d.listings || [];
    // 筛。
    if (cat) listings = listings.filter(l => l.category === cat);
    if (search) listings = listings.filter(l => (l.title||'').toLowerCase().includes(search) || (l.description||'').toLowerCase().includes(search) || (l.tags||'').includes(search));
    // 我的/浏览
    if (marketTab === 'mine') listings = listings.filter(l => String(l.publisher_id) === String(localStorage.getItem('userId') || clientId || ''));
    // 排序
    if (sort === 'new') listings.sort((a,b) => b.created_at - a.created_at);
    else if (sort === 'rating') listings.sort((a,b) => (b.rating||0) - (a.rating||0));
    else listings.sort((a,b) => (b.hire_count||0) - (a.hire_count||0));
    if (!listings.length) { grid.innerHTML = '<div class="empty">'+t('market.noAgents')+'</div>'; return; }
    grid.innerHTML = listings.map(l => `
      <div class="card" style="cursor:pointer" onclick="showDetail(event,'${l.id}')">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3)">
          <span>${esc(l.category)}</span><span>${l.currency==='usd'?'$':l.currency==='cny'?'¥':'🪙'}${l.price||0} · ${l.hire_count||0}${t('market.hiresUnit')}</span>
        </div>
        <h3>${esc(l.title)}</h3>
        <p>${esc(l.description||'').substring(0,80)}</p>
        <div class="tags">${(function(){ try { return JSON.parse(l.tags||'[]'); } catch(e) { return []; } })().map(tg=>'<span class="tag">'+esc(tg)+'</span>').join('')}</div>
        <div class="card-footer"><span class="price">${l.currency==='usd'?'$':l.currency==='cny'?'¥':'🪙'}${l.price||0}${l.currency==='credits'?' '+t('market.points'):''}</span><button class="btn primary" onclick="event.stopPropagation();hireAgent('${l.id}')">🤝</button></div>
      </div>`).join('');
  } catch(e) { grid.innerHTML = '<div class="empty">'+t('err.loadFail')+'</div>'; }
}

function showDetail(e, id) {
  const d = JSON.parse(JSON.stringify(
    [...document.getElementById('listingGrid').querySelectorAll('.card')].map(c => ({
      title: c.querySelector('h3')?.textContent,
      desc: c.querySelector('p')?.textContent,
      cat: c.querySelector('span')?.textContent,
    }))
  ));
  currentDetailId = id;
  // 重新。server 取完整数。
  fetch('/api/market/list').then(r => r.json()).then(data => {
    const l = (data.listings||[]).find(x => x.id === id);
    if (!l) return;
    document.getElementById('detailTitle').textContent = l.title;
    document.getElementById('detailDesc').textContent = l.description || t('market.noDesc');
    document.getElementById('detailCat').textContent = l.category;
    document.getElementById('detailRating').textContent = '⭐' + (l.rating||0);
    document.getElementById('detailHires').textContent = l.hire_count||0;
    document.getElementById('detailTags').innerHTML = JSON.parse(l.tags||'[]').map(t=>'<span class="tag">'+esc(t)+'</span>').join('');
    document.getElementById('detailHireBtn').onclick = () => { hireAgent(id); closeDetail(); };
    document.getElementById('detailOverlay').style.display = 'block';
    document.getElementById('detailModal').style.display = 'block';
  });
}

function closeDetail() {
  document.getElementById('detailOverlay').style.display = 'none';
  document.getElementById('detailModal').style.display = 'none';
  currentDetailId = null;
}

function hireFromDetail() {
  if (currentDetailId) { hireAgent(currentDetailId); closeDetail(); }
}

async function publishAgent() {
  if (!clientId) return toast(t('toast.connectFirst'));
  const title = document.getElementById('pubTitle').value.trim();
  const desc = document.getElementById('pubDesc').value.trim();
  const category = document.getElementById('pubCategory').value;
  const itemType = (document.getElementById('pubItemType') || {}).value || 'agent';
  const currency = (document.getElementById('pubCurrency') || {}).value || 'credits';
  const price = parseFloat(document.getElementById('pubPrice').value) || 10;
  const tags = (document.getElementById('pubTags')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
  if (!title) return toast(t('toast.enterName'));
  try {
    const _uid = localStorage.getItem('userId') || clientId;
    const d = await api('/api/market/publish', 'POST', { agentId: clientId, publisherId: _uid, title, description: desc, category, price, currency, tags, itemType });
    if (d.ok) { toast(t('market.publishSuccess')); document.getElementById('publishForm').style.display='none'; loadMarket(); }
    else toast('⚠' + _errMsg(d, t('err.fail')));
  } catch(e) { toast(t('market.publishFail')); }
}

async function hireAgent(listingId) {
  if (!clientId) return toast(t('toast.connectFirst'));
  if (!confirm(t('market.confirmHire'))) return;
  try {
    const _buyer = localStorage.getItem('userId') || clientId; const d = await api('/api/market/hire', 'POST', { listingId, buyerId: _buyer });
    if (d.ok) { toast(t('market.hireSuccess')); loadMarket(); }
    else toast('⚠' + _errMsg(d, t('err.fail')));
  } catch(e) { toast(t('market.hireFail')); }
}

async function loadTools() {
  try {
    const d = await api('/api/tools', 'GET');
    const tools = d.tools || [];
    document.getElementById('toolsGrid').innerHTML = tools.map(tool => `
      <div class="card"><h3>🔧 ${esc(tool.name||'?')}</h3><p style="font-size:12px;color:var(--text2)">${esc(tool.description||'')}</p></div>
    `).join('') || '<div class="empty">'+t('tools.none')+'</div>';
  } catch(e) { document.getElementById('toolsGrid').innerHTML = '<div class="empty">'+t('err.loadFail')+'</div>'; }
  loadRagDocs();
  loadWorkspace();
}

// ══。知识。(v2.0.6) ══。
async function loadRagDocs() {
  const el = document.getElementById('ragDocsList');
  if (!el) return;
  el.textContent = t('common.loading');
  try {
    const d = await api('/api/rag/documents', 'GET');
    if (!d.ok) { el.textContent = '⚠' + _errMsg(d, t('err.loadFail')); return; }
    const docs = d.documents || [];
    if (!docs.length) { el.innerHTML = '<div style="color:var(--text3)">' + t('rag.noDocs') + '</div>'; return; }
    el.innerHTML = docs.map(doc => `<div style="display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid var(--border)">
      <span style="flex:1">📄 ${esc(doc.title)}${doc.chunkCount ? ' <span style="color:var(--text3);font-size:11px">(' + t('rag.chunks', {n: doc.chunkCount}) + ')</span>' : ''}</span>
      <button onclick="deleteRagDoc('${esc(doc.id)}')" style="background:none;border:none;color:var(--red);cursor:pointer">🗑</button>
    </div>`).join('');
  } catch(e) { el.textContent = '⚠' + (e.message || t('err.networkError')); }
}

async function addRagDoc() {
  const title = (document.getElementById('ragTitle')||{}).value?.trim();
  const source = (document.getElementById('ragSource')||{}).value?.trim();
  const content = (document.getElementById('ragContent')||{}).value?.trim();
  if (!title || !content) { toast(t('rag.fillTitleContent')); return; }
  try {
    const d = await api('/api/rag/documents', 'POST', { title, source, content, mimeType: 'text/plain' });
    if (d.ok) { toast(t('rag.added', {n: d.chunkCount||0})); loadRagDocs(); document.getElementById('ragContent').value=''; }
    else toast('⚠' + _errMsg(d, t('err.addFail')));
  } catch(e) { toast('⚠' + t('err.addFail') + ': ' + e.message); }
}

async function deleteRagDoc(id) {
  if (!confirm(t('rag.confirmDelete'))) return;
  try {
    const d = await api('/api/rag/documents/' + encodeURIComponent(id), 'DELETE');
    if (d.ok) { toast(t('toast.deleted')); loadRagDocs(); }
    else toast('⚠' + _errMsg(d, t('err.deleteFail')));
  } catch(e) { toast('⚠' + t('err.deleteFail')); }
}

async function searchRag() {
  const q = (document.getElementById('ragQuery')||{}).value?.trim();
  const out = document.getElementById('ragSearchOut');
  if (!q) { toast(t('rag.enterQuery')); return; }
  out.textContent = t('rag.searching');
  try {
    const d = await api('/api/rag/search?q=' + encodeURIComponent(q), 'GET');
    if (!d.ok) { out.textContent = '⚠' + _errMsg(d, t('rag.searchFail')); return; }
    const hits = d.hits || [];
    if (!hits.length) { out.innerHTML = '<div style="color:var(--text3)">' + t('search.noResult') + '</div>'; return; }
    out.innerHTML = hits.map((h,i) => `<div style="padding:6px;border-left:3px solid var(--accent);margin-bottom:6px;background:var(--bg2)">
      <div style="font-weight:600">[${i+1}] ${esc(h.docTitle||'')} <span style="color:var(--text3);font-size:11px">${t('rag.relevance', {score: h.score.toFixed ? h.score.toFixed(2) : h.score})}</span></div>
      <div style="color:var(--text2);font-size:11px">${esc((h.content||'').slice(0,200))}...</div>
    </div>`).join('');
  } catch(e) { out.textContent = '⚠' + t('rag.searchFail'); }
}

async function scanWorkspaceDocs() {
  if (!confirm(t('rag.confirmScan'))) return;
  try {
    const d = await api('/api/rag/scan-workspace', 'POST');
    if (d.ok) {
      toast(t('rag.scanDone', {imported: d.imported||0, skipped: d.skipped||0}));
      loadRagDocs();
    } else toast('⚠' + _errMsg(d, t('err.scanFail')));
  } catch(e) { toast('⚠' + t('err.scanFail') + ': ' + e.message); }
}

// ══。工作。(v2.0.6) ══。
async function loadWorkspace() {
  try {
    const d = await api('/api/workspace-mode', 'GET');
    if (!d) { return; }
    const modeSel = document.getElementById('wsModeSelect');
    if (modeSel) modeSel.value = d.mode || 'personal';
    const root = document.getElementById('wsRootInput');
    if (root) root.value = d.workspaceRoot || '';
    const info = document.getElementById('wsInfo');
    if (info) info.innerHTML = t('ws.currentPrefix') + '<b style="color:var(--accent)">' + esc(d.workspaceRoot||'') + '</b> ' + t('ws.modeInfo', {mode: d.mode==='collab'?t('ws.modeCollab'):t('ws.modePersonal')});
  } catch(e) {}
}

async function setWorkspaceMode() {
  const mode = document.getElementById('wsModeSelect').value;
  const root = (document.getElementById('wsRootInput').value || '').trim();
  try {
    const d = await api('/api/workspace-mode', 'POST', { mode, workspaceRoot: root || undefined });
    if (d && d.ok !== false) { toast(t('ws.switched', {mode})); loadWorkspace(); }
    else toast('⚠' + (d?.error || t('err.setFail')));
  } catch(e) { toast('⚠' + t('err.setFail') + ': ' + e.message); }
}

async function saveWorkspace() {
  setWorkspaceMode();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── 代码高亮 ──
// ── Markdown 渲染（v2.1.0 增强：块级 + 行内）──
// 说明：旧版只处理 ``` 代码块、表格、行内代码，正文里的换行会被 HTML 折叠，
// AI 的长回复在气泡里挤成一坨；也没有标题/粗体/列表，所以 `**加粗**`、`### 标题`
// 会以原文裸奔。现在补齐块级与行内规则，流式期间也能边流边成型。
function markdownToHtml(text) {
  if (text == null) return '';
  // 占位符仓库：先把代码块/行内代码抽走，避免被后续行内规则误伤
  const stash = [];
  const keep = (html) => { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000'; };

  // 1) 转义 HTML
  let html = esc(String(text));

  // 2) 转换 ``` 代码块（先抽成占位符）
  html = html.replace(/```(\w*)[ \t]*\r?\n([\s\S]*?)```/g, function(match, lang, code) {
    const safeLang = lang ? lang.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
    const langAttr = safeLang ? ' class="language-' + safeLang + '"' : '';
    return '\n' + keep('<pre><code' + langAttr + '>' + code.replace(/^\r?\n/, '').replace(/\s+$/, '') + '</code></pre>') + '\n';
  });

  // 3) 转换行内代码 `code`（同样抽成占位符）
  html = html.replace(/`([^`\n]+)`/g, function(m, code) { return keep('<code>' + code + '</code>'); });

  // 4) 转换 Markdown 表格
  html = parseMarkdownTable(html);

  // 5) 块级元素（标题 / 分隔线 / 引用 / 列表 / 段落）
  html = mdRenderBlocks(html);

  // 6) 行内元素（粗体 / 斜体 / 删除线 / 链接）
  html = mdRenderInline(html);

  // 7) 还原占位符
  html = html.replace(/\u0000(\d+)\u0000/g, function(m, i) { return stash[Number(i)] != null ? stash[Number(i)] : m; });
  return html;
}

// 块级渲染：逐行判定，列表/引用需要聚合连续行
function mdRenderBlocks(html) {
  const lines = String(html).split('\n');
  const out = [];
  let list = null; // { tag: ul|ol, items: [] }
  const flushList = () => {
    if (!list) return;
    out.push('<' + list.tag + '>' + list.items.map(function(it) { return '<li>' + it + '</li>'; }).join('') + '</' + list.tag + '>');
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const s = line.trim();

    // 空行 → 断开列表
    if (!s) { flushList(); continue; }

    // 独占一行的占位符（代码块等）→ 原样输出，不包 <p>
    if (/^\u0000\d+\u0000$/.test(s)) { flushList(); out.push(s); continue; }

    // 已是块级 HTML（表格包装、嵌套结构）→ 原样输出
    if (/^<(div|table|pre|blockquote|ul|ol|h[1-6]|hr|p)\b/i.test(s)) { flushList(); out.push(s); continue; }

    // 标题 # ~ ######
    const h = s.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) { flushList(); out.push('<h' + h[1].length + ' class="md-h">' + h[2] + '</h' + h[1].length + '>'); continue; }

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(s)) { flushList(); out.push('<hr class="md-hr">'); continue; }

    // 引用（esc 之后 > 已变成 &gt;）
    if (/^&gt;\s?/.test(s)) {
      flushList();
      const q = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i++;
      }
      i--;
      out.push('<blockquote class="md-quote">' + q.join('<br>') + '</blockquote>');
      continue;
    }

    // 无序列表
    const ul = s.match(/^[-*+]\s+(\S.*)$/);
    if (ul) { if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; } list.items.push(ul[1]); continue; }

    // 有序列表
    const ol = s.match(/^\d+[.)]\s+(\S.*)$/);
    if (ol) { if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; } list.items.push(ol[1]); continue; }

    // 普通段落
    flushList();
    out.push('<p class="md-p">' + s + '</p>');
  }
  flushList();
  return out.join('\n');
}

// 行内渲染：粗体 / 斜体 / 删除线 / 链接
// 注意：不下划线斜体（_x_）—— 会在 snake_case 标识符上误伤，宁可少渲染也别渲染错。
function mdRenderInline(html) {
  let out = html;
  // 链接 [文本](url)—— 只放行 http/https/mailto，挡掉 javascript: 之类
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function(m, label, url) {
    if (!/^(https?:|mailto:|\/|#|\.)/i.test(url)) return m;
    return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
  });
  // 删除线 ~~x~~
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  // 粗体 **x**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 斜体 *x*（要求紧跟非空白、结尾非空白，避免吃掉裸星号）
  out = out.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
  return out;
}

// 补齐未闭合的 ``` 围栏，让"半截代码块"在流式期间也能正常解析成 <pre><code>
function balanceCodeFences(text) {
  const n = (String(text).match(/```/g) || []).length;
  return (n % 2 === 1) ? String(text) + '\n```' : String(text);
}

function parseMarkdownTable(html) {
  // 匹配连续。| 的行块（兼容。无首尾管道符两种格式。
  const tableRegex = new RegExp('((?:^|\\n)((?:[^\\n]*\\|[^\\n]*(?:\\r?\\n|$))+))', 'g');
  return html.replace(tableRegex, function(block) {
    var lines = block.trim().split(/\r?\n/).filter(function(l) { return l.trim(); });
    if (lines.length < 2) return block;

    // 第一行必须含 |
    if (!lines[0].includes('|')) return block;

    // 第二行必须是分隔行：只含 | - : 和空。
    var sepLine = lines[1].trim();
    if (!sepLine.includes('|')) return block;
    var sepClean = sepLine.replace(/\|/g, '').replace(/-/g, '').replace(/:/g, '').replace(/ /g, '').trim();
    if (sepClean !== '') return block;

    // 解析对齐方式
    var aligns = sepLine.split('|').map(function(cell) {
      cell = cell.trim();
      if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
      if (cell.endsWith(':')) return 'right';
      if (cell.startsWith(':')) return 'left';
      return 'left';
    });

    function parseRow(line) {
      var s = line.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map(function(c) { return c.trim(); });
    }

    var headerCells = parseRow(lines[0]);
    if (headerCells.length < 2) return block; // 不是真正的表。

    var bodyRows = [];
    for (var i = 2; i < lines.length; i++) {
      if (!lines[i].includes('|')) break; // 遇到不含 | 的行，表格结。
      bodyRows.push(parseRow(lines[i]));
    }

    var out = '<div class="md-table-wrap"><table class="md-table">';
    // thead
    out += '<thead><tr>';
    headerCells.forEach(function(cell, idx) {
      var align = aligns[idx] || 'left';
      out += '<th style="text-align:' + align + '">' + cell + '</th>';
    });
    out += '</tr></thead>';
    // tbody
    out += '<tbody>';
    bodyRows.forEach(function(row) {
      out += '<tr>';
      row.forEach(function(cell, idx) {
        var align = aligns[idx] || 'left';
        out += '<td style="text-align:' + align + '">' + cell + '</td>';
      });
      out += '</tr>';
    });
    out += '</tbody></table></div>';

    return '\n' + out + '\n';
  });
}

function highlightBlocks(container) {
  if (typeof hljs === 'undefined') return;
  container.querySelectorAll('pre code').forEach(block => {
    try {
      const result = hljs.highlightAuto(block.textContent);
      if (result.language) {
        block.classList.add('language-' + result.language);
      }
      block.innerHTML = result.value;
    } catch(e) {
      // 降级：不打断渲染
    }
  });
}

// ── Diff 渲染 ──
function renderDiff(text) {
  if (!text || typeof text !== 'string') return null;
  // Try parsing as JSON first (tool results are JSON strings)
  let obj = null;
  try { obj = JSON.parse(text); } catch(e) {}
  if (obj && obj.diff && typeof obj.diff === 'string') {
    text = obj.diff;
  }
  // 检。unified diff 格式: 。--- / +++ / @@ 开。
  if (!text.match(/^(---|\+{3}|@@)/m)) return null;

  const lines = text.split('\n');
  const htmlLines = [];
  for (const line of lines) {
    if (line.startsWith('---') || line.startsWith('+++')) {
      htmlLines.push('<span class="diff-header">' + esc(line) + '</span>');
    } else if (line.startsWith('@@')) {
      htmlLines.push('<span class="diff-hunk">' + esc(line) + '</span>');
    } else if (line.startsWith('+')) {
      htmlLines.push('<span class="diff-add">' + esc(line) + '</span>');
    } else if (line.startsWith('-')) {
      htmlLines.push('<span class="diff-remove">' + esc(line) + '</span>');
    } else {
      htmlLines.push('<span class="diff-context">' + esc(line) + '</span>');
    }
  }
  return '<div class="diff-view">' + htmlLines.join('\n') + '</div>';
}
// ── Connection ──
function getOrCreateUserId() {
  try {
    let id = localStorage.getItem('lingxi-user-id');
    if (!id) {
      id = 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
      localStorage.setItem('lingxi-user-id', id);
    }
    return id;
  } catch(e) { return 'u-' + Date.now().toString(36); }
}

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const id = getOrCreateUserId();
  connectIntended = true;
  try {
    if (ws) {
      // 。先剥离旧连接的全部事件句柄再关闭——否则旧 socket 。onclose 会再次触。
      // scheduleReconnect()，把刚建好的新连接又关掉，形。每秒闪一次重。的死循环
      try { ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null; ws.close(); } catch(e){}
    }
    clientId = id;
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const url = wsProto + location.host + '/ws?id=' + encodeURIComponent(id) + (authToken ? '&token=' + encodeURIComponent(authToken) : '');
    const socket = new WebSocket(url);
    ws = socket;
    socket.onopen = function() {
      if (ws !== socket) return; // 已被更新的连接替换，忽略
      reconnectAttempts = 0;
      restoreUnreadCounts();
      var _wsEl = document.getElementById('wsState'); if (_wsEl) { _wsEl.textContent = t('status.wsConnected'); _wsEl.className = 'ok'; }
      setStatus(t('status.online'), 'ok');
      enableInput(true);
      loadChatList().catch(()=>{});
      // 。v2.0.5: 重连后恢复上次打开的聊。
      var _lastSavedChat = localStorage.getItem('lingxi-last-chat');
      if (_lastSavedChat && myChats.some(function(c3){ return c3.id === _lastSavedChat; })) {
        switchChat(_lastSavedChat);
      }
      loadFriends().catch(()=>{});
      loadRequests().catch(()=>{});
      loadModels().catch(()=>{});
      loadProfileCard().catch(()=>{});
      // 提前加载用户 numericId（供好友面板和跨平台聊天用）
      if (!lanMeId) {
        if (authToken) {
          platformApi('/api/user/me', 'GET').then(d => { if (d && d.ok && d.user) { lanMeId = d.user.id || d.user.sub || null; } }).catch(()=>{});
        } else {
          // v2.0.11: 未登录时不调 /api/auth/me（会返回 admin-auto 。'admin'，不是真实用户ID。
          // 直接。clientId 作为 fromUserId，因为本地模式下 clientId 就是 DB 中的用户ID
          // lanMeId 保持 null，sendRequest 。fromUserId = lanMeId || clientId = clientId
        }
      }
      // 订阅局域网社交通知频道
      try { socket.send(JSON.stringify({ type: 'subscribe', chatId: '__lan_social__' })); } catch(_e) {}
      // 恢复上次局域网群组（v2.1.3: F5 刷新后保留打开的群组）
      try {
        var _savedLanGroup = JSON.parse(localStorage.getItem('lingxi-lan-group') || 'null');
        if (_savedLanGroup && typeof lanCurrentGroup !== 'undefined') {
          lanCurrentGroup = _savedLanGroup;
        }
      } catch(_e2) {}
      // 重连后重新订阅当前打开的局域网群组（否则群消息会静默中断）
      try {
        if (typeof lanCurrentGroup !== 'undefined' && lanCurrentGroup && socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'subscribe', chatId: lanCurrentGroup.humanChatId }));
          socket.send(JSON.stringify({ type: 'subscribe', chatId: lanCurrentGroup.agentChatId }));
        }
      } catch(_e) {}
    };
    socket.onmessage = function(e) {
      if (ws !== socket) return;
      try { handleMessage(JSON.parse(e.data)); } catch(err) { console.error('[WS msg]', err); }
    };
    socket.onclose = function() {
      if (ws !== socket) return; // 此连接是被主动替换的旧连接，不重连、不改状。
      setStatus(t('status.disconnected'), 'err');
      var _wsEl2 = document.getElementById('wsState'); if (_wsEl2) { _wsEl2.textContent = t('status.wsNotConnected'); _wsEl2.className = 'err'; }
      enableInput(false);
      scheduleReconnect();
    };
    socket.onerror = function(err) { console.error('[WS err]', err); };
  } catch(e) { toast(t('err.connectFail', { msg: e.message })); }
}

function scheduleReconnect() {
  if (reconnectAttempts >= 5) {
    setStatus(t('status.maxReconnect'), 'err');
    return;
  }
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 15000);
  reconnectAttempts++;
  setStatus(t('status.reconnecting', { n: reconnectAttempts, s: Math.round(delay/1000) }), 'err');
  reconnectTimer = setTimeout(connect, delay);
}

function setStatus(text, cls) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.style.color = cls === 'ok' ? '#4ade80' : cls === 'err' ? '#ef4444' : '#888';
}

function enableInput(on) {
  document.getElementById('input').disabled = !on;
  document.getElementById('sendBtn').disabled = !on;
}

// auto-connect on load
window.addEventListener('load', function() {
  // ── i18n 初始化：构建语言切换器并应用持久。检测到的语言 ──
  try {
    if (window.I18N) {
      var langSel = document.getElementById('langSelect');
      if (langSel) I18N.buildSwitcher(langSel);
      applyLanguage(I18N.lang, { silent: true });
    }
  } catch(_i18nErr) { console.error('[i18n init]', _i18nErr); }
  // 恢复通知开。UI 状。
  try { restoreNotifyUI(); } catch(_notifyErr) { /* 静默 */ }
  setTimeout(function() {
    connectIntended = true;
    connect();
    refreshStatusBar();
    fetchVersion();
    loadModels().catch(()=>{});
    loadTaskMonitor().catch(()=>{});
    loadRightGoals().catch(()=>{});
    loadProfileCard().catch(()=>{});
  }, 300);
});

// ── i18n 语言切换回调：刷新所有动态文本（状态栏 / 顶栏状。/ 登录弹窗。──
window.onLanguageChange = function() {
  try {
    reapplyDynamicStatus();
    syncAuthModalLang();
  } catch(e) { console.error('[i18n onChange]', e); }
};
function reapplyDynamicStatus() {
  var connected = (typeof ws !== 'undefined') && ws && ws.readyState === 1;
  setStatus(connected ? t('status.online') : t('status.disconnected'), connected ? 'ok' : 'err');
  var wsEl = document.getElementById('wsState');
  if (wsEl) { wsEl.textContent = connected ? t('status.wsConnected') : t('status.wsNotConnected'); wsEl.className = connected ? 'ok' : 'err'; }
  refreshStatusBar();
}
function syncAuthModalLang() {
  var modal = document.getElementById('authModal');
  if (!modal || modal.style.display !== 'block') return;
  if (authMode === 'register') {
    document.getElementById('authTitle').textContent = t('auth.register');
    document.getElementById('authSubmitBtn').textContent = t('auth.register');
    document.getElementById('authUsername').placeholder = t('auth.regUserPh');
    var swT = document.getElementById('authSwitchText'); if (swT) swT.textContent = t('auth.hasAccount');
    var swL = document.getElementById('authSwitchLink'); if (swL) swL.textContent = t('auth.loginLink');
  } else {
    document.getElementById('authTitle').textContent = t('auth.login');
    document.getElementById('authSubmitBtn').textContent = t('auth.login');
    document.getElementById('authUsername').placeholder = t('auth.loginUserPh');
    var swT2 = document.getElementById('authSwitchText'); if (swT2) swT2.textContent = t('auth.noAccount');
    var swL2 = document.getElementById('authSwitchLink'); if (swL2) swL2.textContent = t('auth.register');
  }
}

// ════════════════════════════════════════════
// 桌面通知 + 提示。
// ════════════════════════════════════════════
var _audioCtx = null;
function playNotifySound() {
  try {
    if (localStorage.getItem('lingxi-notify') !== '1') return;
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    var osc = _audioCtx.createOscillator();
    var gain = _audioCtx.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, _audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, _audioCtx.currentTime + 0.18);
    osc.connect(gain); gain.connect(_audioCtx.destination);
    osc.start(); osc.stop(_audioCtx.currentTime + 0.2);
  } catch (e) { /* 音频不可用时静默 */ }
}
function notifyIncoming(msg) {
  try {
    if (localStorage.getItem('lingxi-notify') !== '1') return;
    var title = msg.senderName || t('notify.appName');
    var body = (msg.content || '').slice(0, 80);
    playNotifySound();
    showNotification(title, body);
  } catch (e) { /* 静默 */ }
}
function requestNotifyPermission() {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  } catch (e) { /* 静默 */ }
}
function setNotifyPref(on) {
  localStorage.setItem('lingxi-notify', on ? '1' : '0');
  if (on) requestNotifyPermission();
}
function setNotifyAlways(on) {
  localStorage.setItem('lingxi-notify-always', on ? '1' : '0');
}
function testNotify() {
  requestNotifyPermission();
  playNotifySound();
  showNotification(t('notify.appName'), t('notify.testBody'));
  toast(t('notify.testDone'));
}
// 恢复通知开。UI 状。
function restoreNotifyUI() {
  try {
    var tg = document.getElementById('notifyToggle'); if (tg) tg.checked = localStorage.getItem('lingxi-notify') === '1';
    var al = document.getElementById('notifyAlwaysToggle'); if (al) al.checked = localStorage.getItem('lingxi-notify-always') === '1';
  } catch (e) { /* 静默 */ }
}

function toggleChatSearch() {
  var bar = document.getElementById('chatSearchBar');
  var res = document.getElementById('chatSearchResults');
  if (!bar) return;
  var showing = bar.style.display !== 'none';
  bar.style.display = showing ? 'none' : 'flex';
  if (res) res.style.display = 'none';
  if (!showing) { var inp = document.getElementById('chatSearchInput'); if (inp) inp.focus(); }
}

// ════════════════════════════════════════════
// 消息搜索
// ════════════════════════════════════════════
async function searchMessages() {
  var input = document.getElementById('chatSearchInput');
  var q = input ? input.value.trim() : '';
  var box = document.getElementById('chatSearchResults');
  if (!q) { if (box) box.innerHTML = ''; return; }
  if (!box) return;
  box.innerHTML = '<div style="padding:8px;color:#888">' + t('chat.searching') + '</div>';
  try {
    var url = '/api/search/messages?q=' + encodeURIComponent(q) + (currentChat ? '&chatId=' + encodeURIComponent(currentChat) : '');
    var d = await api(url);
    renderSearchResults(d.results || []);
  } catch (e) {
    box.innerHTML = '<div style="padding:8px;color:#ef4444">' + t('err.searchFail') + '</div>';
  }
}
function renderSearchResults(results) {
  var box = document.getElementById('chatSearchResults');
  if (!box) return;
  if (!results.length) { box.innerHTML = '<div style="padding:8px;color:#888">' + t('chat.searchEmpty') + '</div>'; return; }
  box.innerHTML = '<div style="padding:4px 8px;font-size:11px;color:#888">' + t('chat.searchResults') + ' · ' + results.length + '</div>' +
    results.map(function (r) {
      var preview = esc((r.content || '').slice(0, 60));
      var date = new Date(r.timestamp).toLocaleString();
      return '<div class="search-hit" onclick="openSearchResult(\'' + esc(r.chat_id) + '\')" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--border);font-size:12px">' +
        '<div style="opacity:.85">' + preview + '</div>' +
        '<div style="font-size:10px;color:#888">' + esc(r.chat_id) + ' · ' + date + '</div></div>';
    }).join('');
}
function openSearchResult(chatId) {
  var box = document.getElementById('chatSearchResults'); if (box) box.innerHTML = '';
  var input = document.getElementById('chatSearchInput'); if (input) input.value = '';
  if (typeof switchChat === 'function') switchChat(chatId);
}

// ════════════════════════════════════════════
// 数据导出 / 备份
// ════════════════════════════════════════════
function exportBackup() {
  try {
    var a = document.createElement('a');
    a.href = '/api/export/backup';
    a.download = 'lingxi-backup-' + Date.now() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    toast(t('settings.exportStarted'));
  } catch (e) { toast(t('err.operationFail')); }
}

function fetchVersion() {
  fetch('/api/version').then(r=>r.json()).then(d=>{
    document.getElementById('verTag').textContent = d.version || 'v?';
  }).catch(()=>{});
}

// ── WS Message Router ──
function handleMessage(msg) {
  // 局域网社交消息单独路由，避免串到主聊天面板
  if (msg && ((msg.chatId && (String(msg.chatId).startsWith('langroup-') || msg.chatId === '__lan_social__')) || (msg.type && String(msg.type).startsWith('lan.')))) {
    handleLanMessage(msg);
    return;
  }
  switch(msg.type) {
    case 'message.new':
      if (msg.chatId && msg.chatId !== currentChat) {
        unreadCounts[msg.chatId] = (unreadCounts[msg.chatId] || 0) + 1; saveUnreadCounts();
        renderChatList();
        notifyIncoming(msg);
      }
      if (msg.msgId && recentStreamed[msg.msgId]) {
        // ⭐ 已按「段」流式渲染过：message.new 只把最后一段校正为最终正文，绝不重复追加气泡
        const rs = recentStreamed[msg.msgId];
        const lastEl = rs.segments && rs.segments[rs.segments.length - 1];
        if (lastEl && msg.content) {
          const contentEl = lastEl.querySelector('.msg-content');
          if (contentEl) { contentEl.innerHTML = markdownToHtml(balanceCodeFences(msg.content)); highlightBlocks(lastEl); }
        }
        delete recentStreamed[msg.msgId];
      } else if (msg.msgId && streamingMsgs[msg.msgId]) {
        // end 尚未到达的竞态：校正当前活动段
        const s = streamingMsgs[msg.msgId];
        ensureStreamSegment(s);
        if (s.el) { s.content = msg.content || ''; finishSegmentEl(s); }
      } else {
        // 段模型下 s.el 可能为 null（已封块），遍历所有段且做空值守卫，避免 TypeError
        const isStreamingDuplicate = msg.from && msg.content && Object.values(streamingMsgs).some(s =>
          (s.segments || (s.el ? [s.el] : [])).some(seg => {
            const c = seg && seg.querySelector && seg.querySelector('.msg-content');
            return c && c.textContent === msg.content;
          })
        );
        // 乐观渲染去重：如果是服务端回传的用户自己消息，且已立即渲染过，跳。
        // 归一化：回传 from 可能是数字ID/带前缀ID，发送时已把多种自身 ID 形态都加入去重集合
        const _echoFromRaw = String(msg.from || msg.senderId || '');
        const _echoKey = (msg.chatId || '') + '|' + (msg.content || '') + '|' + _echoFromRaw;
        const _echoKeyAlt = (msg.chatId || '') + '|' + (msg.content || '') + '|' + _echoFromRaw.replace(/^user-/, '');
        const isOptimisticDuplicate = _optimisticSent.has(_echoKey) || _optimisticSent.has(_echoKeyAlt);
        if (isOptimisticDuplicate) {
          _optimisticSent.delete(_echoKey); _optimisticSent.delete(_echoKeyAlt); // 命中后立即清。
        }
        if (!isStreamingDuplicate && !isOptimisticDuplicate) {
          appendMessage(msg);
        }
      }
      break;
    case 'agent.streaming.start':
      // 总是注册流式状态（即使不在当前聊天），防止切走后丢。
      generatingChats[msg.chatId] = (generatingChats[msg.chatId] || 0) + 1;
      updateGenUI();
      appendStreamingMsg(msg);
      // ── Safety Net: 120s 超时自动清理，防。end 事件丢失导致永久排队 ──
      (function(cid, mid){
        setTimeout(function(){
          if (streamingMsgs[mid]) {
            console.warn('[SafetyNet] streaming ' + mid + ' 超时(120s)，强制清理');
            delete streamingMsgs[mid];
            if (generatingChats[cid] > 0) generatingChats[cid] = 0;
            updateGenUI();
            maybeFlushQueue(cid);
          }
        }, 120000);
      })(msg.chatId, msg.msgId);
      break;
    case 'tool.call':
      if (msg.chatId === currentChat) {
        appendToolCallRow(msg);
      }
      break;
    case 'tool.result':
      updateToolCallRow(msg);
      break;
    case 'subagent.result':
      if (typeof loadSubAgents === 'function') loadSubAgents();
      break;
    case 'agent.streaming.seal':
      // ⭐ 时序封块：本轮正文已流完、后端即将插入工具卡。定稿当前气泡，
      //   下一段正文新建气泡排在工具卡之后，杜绝「文字压在工具卡上方」的倒置。
      if (streamingMsgs[msg.msgId]) sealStreamSegment(streamingMsgs[msg.msgId]);
      break;
    case 'agent.streaming.chunk':
      if (streamingMsgs[msg.msgId]) {
        const s = streamingMsgs[msg.msgId];
        ensureStreamSegment(s); // seal 后新建气泡，保证排在工具卡之后
        if (s.el) { s.content += msg.chunk || ''; streamScheduleRender(s); }
      }
      break;
    case 'agent.streaming.think':
      if (streamingMsgs[msg.msgId]) {
        const s = streamingMsgs[msg.msgId];
        ensureStreamSegment(s);
        if (s.thinkEl) { s.think = (s.think || '') + (msg.think || ''); streamScheduleThink(s); }
      }
      break;
    case 'task.progress':
      handleTaskProgress(msg);
      break;
    case 'agent.streaming.end':
      if (generatingChats[msg.chatId] > 0) generatingChats[msg.chatId]--;
      if (streamingMsgs[msg.msgId]) {
        const s = streamingMsgs[msg.msgId];
        // 收尾：定稿当前段（最终 Markdown + 高亮 + 摘光标 + 收思考区），并标记 _dead 停止节流
        streamFinish(s);
        // ⭐ 记录已流式渲染的气泡段，供随后的 message.new 按 msgId 校正而非重复追加
        if (msg.msgId) { recentStreamed[msg.msgId] = { chatId: s.chatId, segments: (s.segments || []).slice(), ts: Date.now() }; pruneRecentStreamed(); }
        if (msg.error) toast(t('err.replyFail', { msg: String(msg.error).slice(0, 50) }));
        if (msg.stopped) toast(t('chat.stopped'));
        delete streamingMsgs[msg.msgId];
      }
      updateGenUI();
      updateCtxInfo();
      maybeFlushQueue(msg.chatId);
      break;
    case 'friend.request':
      // v2.1.7: 不再本地自增（接口一旦失败红点会永久虚高），红点一律以服务端 pending 数为准
      toast(t('friends.requestReceived', { name: (msg.fromName || msg.fromUserId) }));
      loadRequests().catch(function(e){ console.warn('[friend.request] refresh failed', e); });
      break;
    case 'friend.accepted':
      toast(t('friends.requestAccepted')); loadFriends(); loadRequests();
      break;
    case 'stop.ack':
      // 服务端确认停止：立即强制清理生成状态，不等 streaming.end（防。end 丢失导致永久卡住。
      if (msg.stopped && msg.chatId) {
        forceResetGenerating(msg.chatId);
      }
      break;
    case 'welcome': case 'user.online': case 'user.offline': break;
    case 'error':
      console.error('[WS error]', msg.message, msg.detail);
      // 在聊天区域显示完整错误信。
      if (msg.chatId === currentChat || !msg.chatId) {
        const container = document.getElementById('messages');
        if (container) {
          const errDiv = document.createElement('div');
          errDiv.className = 'msg-row ai';
          errDiv.innerHTML = '<div class="msg-avatar ai">!</div><div class="msg-bubble" style="background:#ef444422;border:1px solid #ef444444;color:#ffc0c0;border-radius:12px 12px 12px 4px">' +
            '<div style="font-size:12px;font-weight:600;margin-bottom:4px">'+t('err.title')+'</div>' +
            '<div style="font-size:12px">' + esc(msg.message || t('err.unknown')) + '</div>' +
            (msg.detail ? '<details style="margin-top:6px;font-size:11px;color:#aaa"><summary>'+t('err.details')+'</summary><pre style="margin-top:4px;white-space:pre-wrap">' + esc(JSON.stringify(msg.detail, null, 2)) + '</pre></details>' : '') +
            '</div>';
          container.appendChild(errDiv);
          container.scrollTop = container.scrollHeight;
        }
      }
      toast(t('err.error', { msg: (msg.message||'').slice(0,80) }));
      break;

    case 'session.restore':
      // v2.0.6: 服务端重启后恢复会话上下。
      console.log('[Session] 收到恢复信息, lastChatId:', msg.lastChatId, '会话。', (msg.sessions||[]).length);
      if (msg.lastChatId && typeof switchChat === 'function') {
        // 延迟一小段时间等聊天列表加载完成再切换
        setTimeout(function() {
          if (currentChat !== msg.lastChatId) {
            switchChat(msg.lastChatId);
          }
        }, 500);
      }
      break;

    default: break;
  }
}

function updateBadge() {
  const b = document.getElementById('reqBadge');
  if (!b) return;
  if (requestNotifyCount > 0) { b.style.display = ''; b.textContent = requestNotifyCount; }
  else { b.style.display = 'none'; }
}

// ── Chat List ──
async function loadChatList() {
  try {
    // v2.1.4: 查询 ID 口径与创建侧（newChat/showCreateGroup 写 participant 用 lanMyId()）保持一致。
    // 未登录时 lanMyId() 回退 clientId，行为不变；登录后用平台登录 ID，否则 participant.user_id 不匹配导致新建会话/群聊不显示。
    // lanMeId 惰性解析（首屏 loadChatList 可能早于 loadSocial），登录态先从平台解析一次，同 showCreateGroup 做法。
    if (!lanMeId && authToken) {
      try { const _d = await platformApi('/api/user/me', 'GET'); if (_d && _d.ok && _d.user) lanMeId = _d.user.id || _d.user.sub || null; } catch(_e) {}
    }
    const res = await api('/api/chats?userId=' + encodeURIComponent(lanMyId()));
    // 。v2.1.1: 按最近活跃排序（F5 后兜底打开。myChats[0] 即最近会话，而非最早创建的会话。
    myChats = (res.chats || []).slice().sort(function(a, b){ return (b.last_message_at || b.created_at || 0) - (a.last_message_at || a.created_at || 0); });
    renderChatList();
    if (myChats.length > 0 && !currentChat) {
      // 。v2.1.1 修复 F5 刷新后会话内容丢失：优先恢复上次打开的会话（lingxi-last-chat。
      var _last = null;
      try { _last = localStorage.getItem('lingxi-last-chat'); } catch(_e) {}
      var _target = (_last && myChats.some(function(c4){ return c4.id === _last; })) ? _last : myChats[0].id;
      switchChat(_target);
    }
  } catch(e) { console.error('[ChatList]', e); }
}

function renderChatList() {
  const c = document.getElementById('chatList');
  if (!myChats.length) { c.innerHTML = '<div class="empty" style="height:auto;padding:16px">'+t('sidebar.noChats')+'</div>'; return; }
  c.innerHTML = myChats.map(ch => {
    const active = ch.id === currentChat ? ' active' : '';
    const unread = unreadCounts[ch.id] || 0;
    const badge = unread ? '<span class="notify-dot">' + unread + '</span>' : '';
    var displayName = ch.name || ch.id.replace(/^(chat-|team-)/, '');
    var icon = ch.type === 'group' ? '👥' : '💬';
    return '<div class="chat-item' + active + '" onclick="switchChat(\'' + ch.id + '\')"><div class="name">' + icon + ' ' + esc(displayName) + badge + '</div><div class="meta">' + (ch.type==='group'?t('chat.groupChat'):t('chat.privateChat')) + ' <span class="chat-del" onclick="event.stopPropagation();deleteChat(\'' + ch.id + '\')" style="float:right;color:#666;cursor:pointer;font-size:14px" title="'+t('chat.deleteTitle')+'">🗑</span></div></div>';
  }).join('');
}

async function deleteChat(chatId) {
  if (!confirm(t('chat.confirmDelete'))) return;
  try {
    await api('/api/chats/' + encodeURIComponent(chatId), 'DELETE');
    // 从列表移。
    myChats = myChats.filter(c => c.id !== chatId);
    delete unreadCounts[chatId]; saveUnreadCounts();
    // 如果删的是当前会话，切换到第一个或清空
    if (currentChat === chatId) {
      currentChat = null;
      document.getElementById('chatTitle').textContent = '';
      document.getElementById('messages').innerHTML = '<div class="empty">'+t('chat.selectOrCreate')+'</div>';
      streamingMsgs = {};
      if (myChats.length > 0) switchChat(myChats[0].id);
    }
    renderChatList();
    toast(t('chat.deleted'));
  } catch(e) { toast(t('err.deleteFail') + ': ' + (e.message || '')); }
}

async function switchChat(chatId) {
  // 。v2.0.5: 保存上次打开的聊天到 localStorage（重启后可恢复）
  if (chatId) localStorage.setItem('lingxi-last-chat', chatId);
  currentChat = chatId;
  delete unreadCounts[chatId]; saveUnreadCounts();
  updateGenUI();
  // 从聊天列表找显示。
  var chatInfo = myChats.find(c => c.id === chatId);
  var name = (chatInfo && chatInfo.name) ? chatInfo.name : chatId.replace(/^(chat-|team-)/, '');
  document.getElementById('chatTitle').textContent = name;
  // 群聊显示模式选择。
  var modeSel = document.getElementById('chatModeSelect');
  if (modeSel) {
    if (chatInfo && chatInfo.type === 'group') {
      modeSel.style.display = '';
      loadChatMode(chatId);
    } else {
      modeSel.style.display = 'none';
    }
  }
  const container = document.getElementById('messages');
  container.innerHTML = '<div class="empty">'+t('common.loading')+'</div>';
  // 移动端：收起会话列表，进入聊天界面，显示返回按钮
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar').classList.remove('show');
    document.getElementById('sidebarOverlay').classList.remove('show');
    document.querySelector('.content').classList.remove('hide-mobile');
    const mb = document.getElementById('mobileBackBtn'); if (mb) mb.style.display = '';
  }
  try {
    const res = await api('/api/chats/' + encodeURIComponent(chatId) + '/messages');
    // 。v2.1.1: 接口报错。01/403/500）时明确提示，而不是误显示"暂无消息"
    if (!res || res.ok === false || res.error) throw new Error(_errMsg(res, t('err.loadFail')));
    const msgs = res.messages || [];
    container.innerHTML = '';
    lastMsgTime = 0;
    if (!msgs.length) container.innerHTML = '<div class="empty">'+t('chat.noMessages')+'</div>';
    msgs.forEach(m => appendMessage({chatId, senderType:m.sender_type, senderId:m.sender_id, content:m.content, timestamp:m.timestamp, metadata:m.metadata}));
    // 对加载的消息应用代码高亮
    setTimeout(() => highlightBlocks(container), 50);
  } catch(e) { container.innerHTML = '<div class="empty">'+t('err.loadFail')+(e && e.message ? ': '+esc(e.message) : '')+'</div>'; }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'subscribe', chatId}));
  renderChatList();
  document.getElementById('memoryBtn').classList.remove('hidden');
  document.getElementById('membersBtn').classList.remove('hidden');
  updateCtxInfo();
}

// 侧边栏开关（index.html 。toggleSidebar 引用此函数）
function toggleSidebar(force) {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebarOverlay');
  if (!sb) return;
  const show = typeof force === 'boolean' ? force : !sb.classList.contains('show');
  sb.classList.toggle('show', show);
  if (ov) ov.classList.toggle('show', show);
}
// 移动端遮罩点击关闭侧栏（index.html #sidebarOverlay 的 onclick 调用）
function hideSidebar() { toggleSidebar(false); }

// 移动端返回列。
function mobileBack() {
  document.querySelector('.content').classList.add('hide-mobile');
  const mb = document.getElementById('mobileBackBtn'); if (mb) mb.style.display = 'none';
  toggleSidebar(true);
}

// 初始化移动端状。
if (window.innerWidth <= 768) {
  document.querySelector('.content').classList.add('hide-mobile');
}

// ── Agent 信息缓存（名。模型徽章，供消息渲染显示命名与所用模型） ──
var _agentInfoMap = null;
async function _ensureAgentInfoMap() {
  if (_agentInfoMap) return _agentInfoMap;
  _agentInfoMap = {};
  try {
    const d = await api('/api/agents');
    for (const a of (d.agents || [])) {
      const raw = String(a.id || '');
      _agentInfoMap[raw] = a;
      const noAgent = raw.replace(/^agent:/, '').replace(/^agent-/, '');
      _agentInfoMap[noAgent] = a;
      _agentInfoMap[noAgent.replace(/^user-/, '')] = a;
    }
  } catch(e) {}
  return _agentInfoMap;
}
function _agentNameLine(senderId) {
  const raw = String(senderId || '');
  let info = (_agentInfoMap && (_agentInfoMap[raw] || _agentInfoMap[raw.replace(/^agent:/, '').replace(/^agent-/, '')] || _agentInfoMap[raw.replace(/^agent:/, '').replace(/^agent-/, '').replace(/^user-/, '')])) || {};
  const name = info.displayName || raw.replace(/^agent:/, '').replace(/^agent-/, '').replace(/^user-/, '') || 'AI';
  const model = info.model || '';
  return '<div class="msg-sender" style="font-size:10px;color:var(--text3);margin-bottom:2px">🤖 ' + esc(name) +
    (model ? ' <span style="color:#8ab4f8;background:rgba(138,180,248,0.12);padding:0 5px;border-radius:8px;font-size:9px">' + esc(model) + '</span>' : '') + '</div>';
}
_ensureAgentInfoMap();

// ── Message Rendering (V5 气泡样式) ──
function appendMessage(msg) {
  const senderId = msg.senderId || msg.sender_id;
  const content = msg.content;
  const chatId = msg.chatId || msg.chat_id;
  if (!senderId || !content) return;
  const container = document.getElementById('messages');
  if (chatId && currentChat && chatId !== currentChat) return;
  const empty = container.querySelector('.empty'); if (empty) empty.remove();
  
  const isAgent = (msg.senderType || msg.sender_type) === 'agent' || senderId.startsWith('agent-');
  // isMe 兼容多种自身 ID 形态：clientId（u-xxx）、真实登。id（lanMeId）、去前缀形。
  const _isMeId = senderId === clientId
    || (typeof lanMeId !== 'undefined' && lanMeId && (senderId === String(lanMeId) || senderId === 'user-' + String(lanMeId).replace(/^user-/, '')))
    || senderId === (typeof lanMyId === 'function' ? String(lanMyId()) : '');
  const isMe = _isMeId || (isAgent && senderId.startsWith('agent-' + (clientId||'').replace(/^user-/,'') + '-'));
  const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'});
  
  // 时间分割线（超过5分钟间隔。
  checkTimeDivider(container, msg.timestamp || Date.now());
  
  const el = document.createElement('div');
  el.className = 'msg-row ' + (isMe ? 'me' : (isAgent ? 'ai' : 'other'));
  
  // 头像（首字母。
  const displayName = senderId.replace(/^agent-|^user-/, '').charAt(0).toUpperCase() || '?';
  const avatarClass = isAgent ? 'ai' : 'human';
  const avatarIcon = isAgent ? '🤖' : displayName;
  
  // 解析消息内容
  let bubbleContent = '';
  if (msg.fileType === 'image' || (content && content.match && content.match(/^\/uploads\/.+\.(jpg|jpeg|png|gif|webp)$/i))) {
    // 图片消息
    bubbleContent = '<img class="msg-img" src="' + esc(content) + '" onclick="window.open(this.src)" alt="'+t('chat.imageAlt')+'">';
  } else if (msg.fileType === 'voice' || (content && content.match && content.match(/^\/uploads\/.+\.(webm|mp3|wav|m4a)$/i))) {
    // 语音消息
    const duration = msg.duration || 0;
    bubbleContent = '<div class="voice-player"><button class="voice-play-btn" onclick="playVoice(this,\'' + esc(content) + '\')">▶</button><div class="voice-wave">' + Array(12).fill(0).map(()=>'<span style="height:'+(4+Math.random()*16)+'px"></span>').join('') + '</div><span class="voice-duration">' + duration + '"</span></div>';
  } else if (msg.fileType === 'file' || (content && content.match && content.match(/^\/uploads\//))) {
    // 文件消息
    bubbleContent = '📎 <a href="' + esc(content) + '" target="_blank" style="color:#4a9eff">' + esc(msg.originalName || content.split('/').pop()) + '</a>';
  } else {
    // 文本消息（支持引用回复）+ Markdown 渲染
    if (isAgent) {
      // AI 消息使用 Markdown 渲染
      let text = markdownToHtml(content);
      if (text.startsWith('> ') && text.includes('\n')) {
        const lines = text.split('\n');
        const quoted = lines[0];
        const rest = lines.slice(1).join('\n').trim();
        bubbleContent = '<div class="msg-reply-ref">' + quoted + '</div><div class="msg-content">' + rest + '</div>';
      } else {
        bubbleContent = '<div class="msg-content">' + text + '</div>';
      }
    } else {
      let text = esc(content);
      if (text.startsWith('> ') && text.includes('\n')) {
        const lines = text.split('\n');
        const quoted = lines[0];
        const rest = lines.slice(1).join('\n').trim();
        bubbleContent = '<div class="msg-reply-ref">' + quoted + '</div><div class="msg-content">' + rest + '</div>';
      } else {
        bubbleContent = '<div class="msg-content">' + text + '</div>';
      }
    }
  }
  
  // 消息操作菜单
  const actions = '<div class="msg-actions"><button onclick="copyMsg(this)" title="'+t('chat.copyTitle')+'">📋</button><button onclick="replyMsg(this)" title="'+t('chat.replyTitle')+'">↩️</button><button onclick="forwardMsg(this)" title="'+t('chat.forwardTitle')+'">📤</button><button onclick="deleteMsg(this)" title="'+t('common.delete')+'">🗑。/button></div>';
  
  // v2.0.18: 渲染持久化推理过程（刷新后仍可见；双键兼容: 历史用 reasoning_content, 新数据用 reasoning）
  let _thinkBlock = '';
  try {
    const _md = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata || '{}') : (msg.metadata || {});
    const _rt = _md && (_md.reasoning || _md.reasoning_content);
    if (_rt) {
      _thinkBlock = '<div class="msg-think" style="cursor:pointer;font-size:12px;color:#8b949e;font-style:italic;padding-bottom:6px;border-bottom:1px solid #30363d;margin-bottom:6px;max-height:3em;overflow:hidden;white-space:pre-wrap" title="' + t('chat.expandThink') + '" onclick="var m=this.style.maxHeight;this.style.maxHeight=(m===' + "'none'" + '?' + "'3em'" + ':' + "'none'" + ');this.style.overflow=(m===' + "'none'" + '?' + "'hidden'" + ':' + "'visible'" + ')">' + esc(_rt) + '</div>';
    }
  } catch (e) {}
  el.innerHTML = '<div class="msg-avatar ' + esc(avatarClass) + '">' + esc(avatarIcon) + '</div>' +
    '<div style="max-width:70%">' + (isAgent ? _agentNameLine(senderId) : '') + '<div class="msg-bubble">' + _thinkBlock + bubbleContent + actions + '</div>' +
    '<div class="msg-meta">' + esc(time) + '</div></div>';
  
  container.appendChild(el);

  // 检测结构化问答格式（Q:/A:/B:/C:）→ 自动渲染多选表。
  if (isAgent && content.includes && content.includes('Q:') && content.includes('A:')) {
    setTimeout(function() { renderGoalQAForm(content, el, chatId); }, 200);
  }

  container.scrollTop = container.scrollHeight;
  updateCtxInfo();
}

function appendToolCallRow(msg) {
  const container = document.getElementById('messages');
  const empty = container.querySelector('.empty'); if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'msg-row ai tool-call-row';
  el.dataset.toolCallId = msg.toolCallId || '';
  el.dataset.startedAt = String(Date.now());
  const desc = msg.description || '';
  let argsText = '';
  try { argsText = JSON.stringify(msg.args || {}, null, 2); } catch (e) { argsText = String(msg.args || ''); }
  el.innerHTML =
    '<div class="msg-avatar ai">\u2699</div>' +
    '<div style="max-width:70%"><div class="msg-bubble tool-bubble">' +
      '<div class="tool-head"><span class="tool-spinner"></span>' +
        '<b class="tool-name">' + esc(msg.toolName || '') + '</b>' +
        (desc ? '<span class="tool-desc">' + esc(desc) + '</span>' : '') +
        '<span class="tool-status"></span>' +
        '<button type="button" class="tool-toggle" title="参数 / 结果">+</button>' +
      '</div>' +
      '<pre class="tool-args"></pre>' +
      '<div class="tool-result"></div>' +
    '</div></div>';
  const argsEl = el.querySelector('.tool-args');
  if (argsEl) argsEl.textContent = argsText.slice(0, 1500);
  const tg = el.querySelector('.tool-toggle');
  if (tg) tg.onclick = function() {
    el.classList.toggle('tool-open');
    this.textContent = el.classList.contains('tool-open') ? '\u2212' : '+';
  };
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function updateToolCallRow(msg) {
  const container = document.getElementById('messages');
  const rows = container.querySelectorAll('.tool-call-row');
  for (let i = rows.length - 1; i >= 0; i--) {
    if ((rows[i].dataset.toolCallId || '') === (msg.toolCallId || '')) {
      const row = rows[i];
      const head = row.querySelector('.tool-head');
      // spinner → 结果图标
      const sp = row.querySelector('.tool-spinner');
      if (sp) sp.remove();
      const st = row.querySelector('.tool-status');
      if (st) st.textContent = msg.success ? '\u2713' : '\u2717';
      row.classList.add(msg.success ? 'tool-ok' : 'tool-fail');
      // 耗时（tabular-nums 对齐）
      const started = Number(row.dataset.startedAt || 0);
      if (started && head) {
        const dur = ((Date.now() - started) / 1000).toFixed(1) + 's';
        let dEl = head.querySelector('.tool-dur');
        if (!dEl) { dEl = document.createElement('span'); dEl.className = 'tool-dur'; head.insertBefore(dEl, head.querySelector('.tool-toggle')); }
        dEl.textContent = dur;
      }
      // 失败原因
      if (!msg.success && msg.error && head) {
        const eEl = document.createElement('span');
        eEl.className = 'tool-err';
        eEl.textContent = String(msg.error).slice(0, 200);
        head.appendChild(eEl);
      }
      if (msg.success && msg.result) {
        let resultText = '';
        try { resultText = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2); } catch(e) {}
        if (resultText) {
          const diffHtml = renderDiff(resultText);
          const resBox = row.querySelector('.tool-result');
          if (resBox) {
            if (diffHtml) resBox.innerHTML = diffHtml;
            else resBox.textContent = resultText.slice(0, 4000);
          }
        }
      }
      break;
    }
  }
  container.scrollTop = container.scrollHeight;
}

// ══════════════════════════════════════════════════════════
// 流式渲染器（v2.1.0）
// 之前流式期间是把原文塞进 textContent：看不到排版、裸奔 `**加粗**`，
// 等全部生成完才"啪"一下变 Markdown，闪一下很出戏。
// 现在：按 STREAM_RENDER_MS 节流做增量 Markdown 渲染 + 尾部闪烁光标 + 贴底跟随。
// ══════════════════════════════════════════════════════════
const STREAM_RENDER_MS = 80;       // 基础节流窗口 ≈12.5fps，兼顾顺滑与 CPU
const STREAM_HARD_DEGRADE = 12000; // 超过此字数：流式期间降级为纯文本，避免每帧全量 Markdown 卡顿

// 动态节流：内容越长重排代价越大，间隔相应放大（80→160→320ms）
function streamRenderDelay(s) {
  const n = (s && s.content) ? s.content.length : 0;
  if (n < 2000) return STREAM_RENDER_MS;
  if (n < 6000) return 160;
  return 320;
}

// 贴底才自动跟随：用户往上翻历史时不打断
function streamAutoScroll(containerId) {
  const c = document.getElementById(containerId || 'messages');
  if (!c) return;
  if ((c.scrollHeight - c.scrollTop - c.clientHeight) < 140) c.scrollTop = c.scrollHeight;
}

// 构造一个流式气泡元素（首帧与 seal 后新建段共用，保证结构一致）
function buildStreamBubble(s, container) {
  const senderId = (s.from || '').replace(/^agent:/, '');
  const isMe = senderId.startsWith('agent-' + (clientId||'').replace(/^user-/,'') + '-');
  const el = document.createElement('div');
  el.className = 'msg-row ' + (isMe ? 'me' : 'ai');
  el.classList.add('streaming');
  el.innerHTML = '<div class="msg-avatar ai">🤖</div>' +
    '<div style="max-width:70%">' + _agentNameLine(senderId) + '<div class="msg-bubble"><div class="msg-think" style="display:none;font-size:12px;color:#8b949e;font-style:italic;padding-bottom:6px;border-bottom:1px solid #30363d;margin-bottom:6px"></div><div class="msg-content"></div></div>' +
    '<div class="msg-meta">' + new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) + '</div></div>';
  container.appendChild(el);
  return el;
}

// 正文流式渲染：Markdown + 尾部光标；长文降级为纯文本
function streamRenderNow(s, final) {
  if (!s || !s.el) return;
  const contentEl = s.el.querySelector('.msg-content');
  if (!contentEl) return;
  const text = s.content || '';
  if (!text) {
    if (!final) contentEl.innerHTML = '<span class="typing-dot">' + t('chat.thinking') + '</span>';
    return;
  }
  // ⭐ 长文降级：流式期间超过阈值只做纯文本渲染（textContent 天然防 XSS），
  //   收尾/封块时再一次性 Markdown 化，避免每帧全量重排把长回复拖到卡顿。
  if (!final && text.length > STREAM_HARD_DEGRADE) {
    contentEl.textContent = text;
    contentEl.insertAdjacentHTML('beforeend', '<span class="stream-cursor" aria-hidden="true"></span>');
    return;
  }
  contentEl.innerHTML = markdownToHtml(balanceCodeFences(text));
  if (final) {
    highlightBlocks(s.el);
  } else {
    contentEl.insertAdjacentHTML('beforeend', '<span class="stream-cursor" aria-hidden="true"></span>');
  }
}

function streamScheduleRender(s) {
  if (!s || s._dead || !s.el || s._renderTimer) return;
  s._renderTimer = setTimeout(function() {
    s._renderTimer = null;
    if (s._dead || !s.el) return;
    streamRenderNow(s, false);
    streamAutoScroll(s.containerId);
  }, streamRenderDelay(s));
}

// 思考区流式渲染：pre-wrap + 尾部光标
function streamScheduleThink(s) {
  if (!s || s._dead || !s.thinkEl || s._thinkTimer) return;
  s._thinkTimer = setTimeout(function() {
    s._thinkTimer = null;
    if (s._dead || !s.thinkEl) return;
    s.thinkEl.style.display = 'block';
    s.thinkEl.innerHTML = esc(s.think || '').replace(/\n/g, '<br>') + '<span class="stream-cursor think"></span>';
    streamAutoScroll(s.containerId);
  }, STREAM_RENDER_MS);
}

// 清除段级定时器：封块/收尾时防止悬挂回调误改已定稿的 DOM
function clearStreamTimers(s) {
  if (!s) return;
  if (s._renderTimer) { clearTimeout(s._renderTimer); s._renderTimer = null; }
  if (s._thinkTimer) { clearTimeout(s._thinkTimer); s._thinkTimer = null; }
}

// 定稿当前段气泡：摘流式态/光标/占位 → 最终 Markdown → 高亮
function finishSegmentEl(s) {
  if (!s || !s.el) return;
  const el = s.el;
  el.classList.remove('streaming');
  const dot = el.querySelector('.typing-dot');
  if (dot) dot.remove();
  const cur = el.querySelector('.msg-content .stream-cursor');
  if (cur) cur.remove();
  const contentEl = el.querySelector('.msg-content');
  if (contentEl) {
    if (s.content) { contentEl.innerHTML = markdownToHtml(balanceCodeFences(s.content)); highlightBlocks(el); }
    else contentEl.innerHTML = '';
  }
}

// 收起当前段思考区：摘尾部光标
function collapseThinkEl(s) {
  if (!s || !s.thinkEl) return;
  const cur = s.thinkEl.querySelector('.stream-cursor');
  if (cur) cur.remove();
}

// ⭐ 确保有活动段气泡：seal 之后 s.el 置空，下一段正文到达时在容器末尾新建气泡。
//   此刻工具卡已排在前面，新气泡自然落在工具卡之后 → 严格时序，杜绝倒置。
function ensureStreamSegment(s) {
  if (!s || s.el) return;
  const container = document.getElementById(s.containerId || 'messages');
  if (!container) return;
  const el = buildStreamBubble(s, container);
  s.el = el;
  s.thinkEl = el.querySelector('.msg-think');
  s.content = '';
  s.think = '';
  if (s.segments) s.segments.push(el); else s.segments = [el];
}

// ⭐ 时序封块：本轮正文流完、后端即将插入工具卡。定稿当前气泡并置空活动段，
//   下一段正文将新建气泡排在工具卡之后。
function sealStreamSegment(s) {
  if (!s || !s.el) return;
  clearStreamTimers(s);
  finishSegmentEl(s);
  collapseThinkEl(s);
  s.el = null;
  s.thinkEl = null;
  s.content = '';
  s.think = '';
}

// recentStreamed 保鲜：TTL 30s + 上限 50，防内存泄漏
function pruneRecentStreamed() {
  const now = Date.now();
  let keys = Object.keys(recentStreamed);
  for (let i = 0; i < keys.length; i++) {
    const rs = recentStreamed[keys[i]];
    if (!rs || (now - (rs.ts || 0)) > 30000) delete recentStreamed[keys[i]];
  }
  keys = Object.keys(recentStreamed);
  if (keys.length > 50) {
    keys.sort(function(a, b) { return (recentStreamed[a].ts || 0) - (recentStreamed[b].ts || 0); });
    for (let j = 0; j < keys.length - 50; j++) delete recentStreamed[keys[j]];
  }
}

// 流式收尾：定稿当前段 + 停节流（不封块，_dead 阻断后续调度）
function streamFinish(s) {
  if (!s) return;
  clearStreamTimers(s);
  finishSegmentEl(s);
  collapseThinkEl(s);
  s._dead = true;
}

function appendStreamingMsg(msg) {
  const container = document.getElementById('messages');
  const empty = container.querySelector('.empty'); if (empty) empty.remove();
  const senderId = (msg.from || '').replace(/^agent:/, '');
  const isMe = senderId.startsWith('agent-' + (clientId||'').replace(/^user-/,'') + '-');
  
  checkTimeDivider(container, msg.timestamp || Date.now());
  
  const el = document.createElement('div');
  el.className = 'msg-row ' + (isMe ? 'me' : 'ai');
  el.classList.add('streaming');
  const displayName = senderId.replace(/^agent-|^user-/, '').charAt(0).toUpperCase() || '?';
  el.innerHTML = '<div class="msg-avatar ai">🤖</div>' +
    '<div style="max-width:70%">' + _agentNameLine(senderId) + '<div class="msg-bubble"><div class="msg-think" style="display:none;font-size:12px;color:#8b949e;font-style:italic;padding-bottom:6px;border-bottom:1px solid #30363d;margin-bottom:6px"></div><div class="msg-content"><span class="typing-dot" style="animation:blink 1s infinite;color:#4a9eff">。/span></div></div>' +
    '<div class="msg-meta">' + new Date(msg.timestamp || Date.now()).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) + '</div></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  streamingMsgs[msg.msgId] = {
    el: el, content: '', think: '', thinkEl: el.querySelector('.msg-think'),
    chatId: msg.chatId, containerId: 'messages', from: msg.from || '',
    segments: [el], _dead: false, _renderTimer: null, _thinkTimer: null
  };
  // 首帧立刻显示思考占位（此前是硬编码的 typing-dot）
  streamRenderNow(streamingMsgs[msg.msgId], false);
}

// 时间分割。
let lastMsgTime = 0;
function checkTimeDivider(container, timestamp) {
  if (timestamp - lastMsgTime > 5 * 60 * 1000) {
    const divider = document.createElement('div');
    divider.className = 'msg-time-divider';
    divider.textContent = new Date(timestamp).toLocaleString('zh-CN', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    container.appendChild(divider);
  }
  lastMsgTime = timestamp;
}

// 消息操作
function copyMsg(btn) {
  const content = btn.closest('.msg-bubble').querySelector('.msg-content');
  if (content) { navigator.clipboard.writeText(content.textContent); toast(t('toast.copied')); }
}
function replyMsg(btn) {
  const content = btn.closest('.msg-bubble').querySelector('.msg-content');
  if (!content) return;
  const input = document.getElementById('input');
  input.value = '> ' + content.textContent.slice(0, 80) + '\n' + input.value;
  input.focus();
}
function deleteMsg(btn) {
  if (confirm(t('chat.confirmDeleteMsg'))) {
    const row = btn.closest('.msg-row');
    const msgId = row ? row.dataset.id || row.getAttribute('data-msg-id') : null;
    if (msgId && currentChat) {
      api('/api/chats/' + encodeURIComponent(currentChat) + '/messages/' + encodeURIComponent(msgId), 'DELETE').catch(()=>{});
    }
    if (row) row.remove();
    updateCtxInfo();
  }
}
function forwardMsg(btn) {
  const content = btn.closest('.msg-bubble').querySelector('.msg-content');
  if (!content) return;
  const chatId = prompt(t('chat.forwardPh'));
  if (!chatId || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'message', chatId: chatId, content: content.textContent }));
  toast(t('chat.forwarded'));
}

// 语音播放
let currentAudio = null;
function playVoice(btn, url) {
  if (currentAudio && !currentAudio.paused) {
    currentAudio.pause();
    btn.classList.remove('playing');
    btn.textContent = '🔊';
    if (currentAudio.src === location.origin + url) { currentAudio = null; return; }
  }
  currentAudio = new Audio(url);
  btn.classList.add('playing');
  btn.textContent = '🔊';
  currentAudio.play();
  currentAudio.onended = () => { btn.classList.remove('playing'); btn.textContent = '🔊'; currentAudio = null; };
  currentAudio.onerror = () => { btn.classList.remove('playing'); btn.textContent = '🔊'; toast(t('err.playFail')); currentAudio = null; };
}

// V5 通知
let notificationPermission = false;
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => { notificationPermission = p === 'granted'; });
  } else { notificationPermission = Notification.permission === 'granted'; }
}
function showNotification(title, body) {
  // 仅在用户开启通知偏好（localStorage lingxi-notify === '1'）时弹出。
  // 默认只在窗口失焦时弹，lingxi-notify-always === '1' 时始终弹。
  if (localStorage.getItem('lingxi-notify') !== '1') return;
  if (!notificationPermission) return;
  var always = localStorage.getItem('lingxi-notify-always') === '1';
  if (!always && !document.hidden) return;
  new Notification(title, { body, icon: '/favicon.ico' });
}
requestNotificationPermission();

// ── Send ──
// 新建会话
function newChat() {
  if (!clientId) { toast(t('toast.notConnected')); return; }
  const newId = 'chat-' + clientId + '-' + Date.now().toString(36);
  // 立即切换到新会话，不。API 返回
  currentChat = newId;
  document.getElementById('chatTitle').textContent = t('chat.newChat');
  document.getElementById('ctxInfo').textContent = '';
  document.getElementById('messages').innerHTML = '<div class="empty">'+t('chat.newChatHint')+'</div>';
  lastMsgTime = 0;
  // 清理所有流式状。
  streamingMsgs = {};
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'subscribe', chatId: newId}));
  // 异步创建后端记录：聊。+ 用户 participant + AI Agent participant
  api('/api/chats', 'POST', { id: newId, type: 'private', name: t('chat.newChat') }).then(() => {
    // 加用。
    api('/api/participants', 'POST', { id: 'p-' + newId + '-me', chatId: newId, userId: lanMyId(), role: 'owner' })
      .catch(function(e) { console.warn('participant user:', e); return api('/api/participants', 'POST', { id: 'p-' + newId + '-me', chatId: newId, userId: clientId, role: 'owner' }); })
      .catch(function(e) { console.warn('participant user retry:', e); });
    // 。AI Agent 。查已。Agent 列表，把第一个加进来
    api('/api/agents').then(d => {
      const agents = d.agents || [];
      if (agents.length > 0) {
        const agent = agents[0];
        api('/api/participants', 'POST', { id: 'p-' + newId + '-agent', chatId: newId, agentId: agent.id, role: 'agent' })
          .then(() => loadChatList())
          .catch(e => console.warn('participant agent:', e));
      } else {
        loadChatList();
      }
    }).catch(e => { console.warn('agents:', e); loadChatList(); });
  }).catch(e => console.warn('create chat:', e));
}

// 更新上下文信息（消息。+ token 估算。
function updateCtxInfo() {
  const container = document.getElementById('messages');
  const msgs = container.querySelectorAll('.msg-bubble');
  const msgCount = msgs.length;
  let totalText = '';
  msgs.forEach(m => totalText += m.textContent || '');
  // 粗略估算：中。字≈1.5token，英。词≈1.3token
  const cnChars = (totalText.match(/[一-鿿]/g) || []).length;
  const enWords = (totalText.match(/[a-zA-Z]+/g) || []).length;
  const estTokens = Math.ceil(cnChars * 1.5 + enWords * 1.3);
  // 路由开启时实际生效的是回复模型，显示真实生效模型而非顶部下拉框的静态。
  let model;
  if (document.getElementById('routeEnabled')?.checked && document.getElementById('replyModelSelect')?.value) {
    model = document.getElementById('replyModelSelect').value;
  } else {
    model = document.getElementById('headerModelSelect')?.value || t('misc.default');
  }
  const el = document.getElementById('ctxInfo');
  if (msgCount > 0) {
    el.textContent = t('chat.ctxInfo', { count: msgCount, tokens: estTokens.toLocaleString(), model: model });
    // 。20000 token 显示警告
    if (estTokens > 20000) {
      el.style.color = '#faad14';
      el.textContent += t('chat.ctxLarge');
    } else if (estTokens > 28000) {
      el.style.color = '#e74c3c';
      el.textContent += t('chat.ctxCompact');
    } else {
      el.style.color = '#666';
    }
  } else {
    el.textContent = '';
  }
}

function isChatGenerating(chatId) {
  return (generatingChats[chatId] || 0) > 0;
}
// 强制重置某聊天的生成状态（安全。/ 手动恢复。
function forceResetGenerating(chatId) {
  if (generatingChats[chatId]) {
    console.warn('[ForceReset] chatId=' + chatId + ' generating=' + generatingChats[chatId] + ' 。0');
    generatingChats[chatId] = 0;
    // 清理该聊天所有残留的 streaming msg
    for (const mid in streamingMsgs) {
      if (streamingMsgs[mid] && streamingMsgs[mid].chatId === chatId) delete streamingMsgs[mid];
    }
    updateGenUI();
    maybeFlushQueue(chatId);
  }
}
// 根据"当前聊天是否生成。/ 队列是否有消。刷新停止按钮和排队提。
function updateGenUI() {
  const stopBar = document.getElementById('stopBar');
  const queueBar = document.getElementById('queueBar');
  const busy = !!(currentChat && isChatGenerating(currentChat));
  if (stopBar) stopBar.style.display = busy ? 'flex' : 'none';
  if (queueBar) {
    if (sendQueue.length) {
      queueBar.style.display = 'flex';
      const qc = document.getElementById('queueCount');
      if (qc) qc.textContent = t('chat.queuedInfo', { n: sendQueue.length });
    } else {
      queueBar.style.display = 'none';
    }
  }
}
// 停止当前聊天的生成（服务端会真正 abort 掉正在进行的回复。
function stopGeneration() {
  if (!currentChat || !ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'stop', chatId: currentChat }));
  toast(t('chat.stopRequested'));
}
function clearQueue() {
  sendQueue = [];
  updateGenUI();
  toast(t('chat.queueCleared'));
}
// 某聊天回复结束后，若队列里有该聊天的消息则自动发送下一。
function maybeFlushQueue(chatId) {
  if (!sendQueue.length) return;
  if (!ws || ws.readyState !== 1) return;
  // 找到队列中第一个"其聊天已不在生成中"的消息发送。
  // 原实现只看队首，若队首属于别的聊天，会挡住后面已结束聊天的消息，导致永久卡队列。
  let nextIdx = -1;
  for (let i = 0; i < sendQueue.length; i++) {
    if (!isChatGenerating(sendQueue[i].chatId)) { nextIdx = i; break; }
  }
  if (nextIdx === -1) return; // 所有排队消息的聊天都还在生成中，继续等
  const next = sendQueue.splice(nextIdx, 1)[0];
  // 支持文件类排队消息（。fileType/originalName）和普通文本消。
  var sendPayload = { type: 'message', chatId: next.chatId, content: next.content };
  if (next.fileType) { sendPayload.fileType = next.fileType; sendPayload.originalName = next.originalName; }
  ws.send(JSON.stringify(sendPayload));
  // 乐观渲染：排队消息发出后立即显示
  const _dedupKey = next.chatId + '|' + next.content + '|' + (clientId || '');
  _optimisticSent.add(_dedupKey);
  setTimeout(() => _optimisticSent.delete(_dedupKey), 8000);
  var renderMsg = { chatId: next.chatId, senderId: clientId || 'user', senderType: 'user', content: next.content, timestamp: Date.now() };
  if (next.fileType) { renderMsg.fileType = next.fileType; renderMsg.originalName = next.originalName; }
  appendMessage(renderMsg);
  updateGenUI();
}

async function send() {
  const input = document.getElementById('input');
  const content = input.value.trim();
  if (!content) return;
  if (!currentChat) { toast(t('chat.selectChatFirst')); return; }
  const chatId = currentChat;

  // 跨平台好友聊天：。HTTP -> 本地引擎 -> Mesh 中继
  if (String(chatId).startsWith('chat-platform-')) {
    if (!ws || ws.readyState !== 1) { toast(t('chat.engineNotConnected')); return; }
    input.value = '';
    const _uid = String(lanMeId || clientId || 'user');
    appendMessage({ chatId, senderId: _uid, senderType: 'user', content, timestamp: Date.now() });
    // 乐观渲染去重：把多种自身 ID 形态都加入去重集合，服务端回传时命中即跳过（修复重复消息）
    [_uid, String(lanMeId || ''), String(clientId || ''), String(lanMeId || '').replace(/^user-/, '')].filter(Boolean).forEach(function(uid) {
      const _k = chatId + '|' + content + '|' + uid;
      _optimisticSent.add(_k);
      setTimeout(function() { _optimisticSent.delete(_k); }, 8000);
    });
    try {
      const d = await api('/api/chats/' + encodeURIComponent(chatId) + '/send-friend', 'POST', { content, fromUserId: lanMeId || clientId });
      if (!d.ok) toast(d.error?.message || d.error || t('err.sendFail'));
    } catch(e) { toast(t('err.sendFail') + ': ' + (e.message || '')); }
    return;
  }

  if (!ws || ws.readyState !== 1) return;
  if (isChatGenerating(chatId)) {
    // Agent 正在回复 。先排队，等回复结束后按序自动发送，避免并发回复互相打断
    sendQueue.push({ chatId: chatId, content: content });
    input.value = '';
    updateGenUI();
    toast(t('chat.queuedAuto', { n: sendQueue.length }));
    return;
  }
  ws.send(JSON.stringify({ type: 'message', chatId: chatId, content: content }));
  input.value = '';
  // 乐观渲染：立即在本地显示用户消息，不等服务端回传
  const _dedupKey = chatId + '|' + content + '|' + (clientId || '');
  _optimisticSent.add(_dedupKey);
  setTimeout(() => _optimisticSent.delete(_dedupKey), 8000); // 8秒后清理
  appendMessage({ chatId, senderId: clientId || 'user', senderType: 'user', content, timestamp: Date.now() });
}

document.getElementById('input').addEventListener('keydown', function(e) {
  if (isMentioning && e.key === 'Enter') { e.preventDefault(); selectMention(mentionIndex); return; }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  checkMention();
});
document.getElementById('input').addEventListener('input', checkMention);

// ── 粘贴截图 ──
document.addEventListener('paste', function(e) {
  const items = e.clipboardData?.items || [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      uploadAndSendFile(file);
      break;
    }
  }
});

// ── 拖拽图片 ──
document.addEventListener('dragover', function(e) { e.preventDefault(); });
document.addEventListener('drop', function(e) {
  e.preventDefault();
  const files = e.dataTransfer?.files || [];
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      uploadAndSendFile(file);
      break;
    }
  }
});

// ── 通用文件上传发。──
async function uploadAndSendFile(file) {
  if (!ws || ws.readyState !== 1) { toast(t('toast.notConnected')); return; }
  if (file.size > 10 * 1024 * 1024) { toast(t('err.fileTooLarge')); return; }
  if (!currentChat) { toast(t('chat.selectChatFirst')); return; }
  const chatId = currentChat;
  const fd = new FormData();
  fd.append('file', file);
  var token = localStorage.getItem('authToken');
  try {
    var headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api/upload', { method: 'POST', headers: headers, body: fd });
    const data = await res.json();
    if (data.ok) {
      const msgType = file.type.startsWith('image/') ? 'image' : 'file';
      // 检查是否生成中：生成中时排队，避免并发
      if (isChatGenerating(chatId)) {
        sendQueue.push({ chatId: chatId, content: data.url, fileType: msgType, originalName: file.name, isFile: true });
        updateGenUI();
        toast(t('chat.queuedAuto', { n: sendQueue.length }));
      } else {
        ws.send(JSON.stringify({ type: 'message', chatId: chatId, content: data.url, originalName: file.name, fileType: msgType }));
        // 乐观渲染：文。图片消息立即显示
        const _dedupKey = chatId + '|' + data.url + '|' + (clientId || '');
        _optimisticSent.add(_dedupKey);
        setTimeout(() => _optimisticSent.delete(_dedupKey), 8000);
        appendMessage({ chatId, senderId: clientId || 'user', senderType: 'user', content: data.url, fileType: msgType, originalName: file.name, timestamp: Date.now() });
      }
    } else { toast(t('err.uploadFail') + ': ' + (data?.error?.message || data?.error || '')); }
  } catch(err) { toast(t('err.uploadError') + ': ' + (err.message || '')); }
}

// ── File Upload ──
// 点击 📎 按钮选择文件后直接上传发送（与粘。拖拽行为一致）
function onFileSelected(input) {
  const file = input.files[0];
  if (!file) return;
  uploadAndSendFile(file);
  input.value = ''; // 重置以便再次选择同一文件
}
function previewFile() {
  const input = document.getElementById('fileInput');
  const file = input.files[0];
  if (!file) return;
  currentFile = file;
  document.getElementById('filePreviewName').textContent = file.name + ' (' + (file.size/1024).toFixed(1) + 'KB)';
  document.getElementById('filePreview').style.display = 'block';
}
function clearFile() {
  currentFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('filePreview').style.display = 'none';
}
async function sendFile() {
  if (!currentFile || !ws || ws.readyState !== 1) return;
  if (!currentChat) { toast(t('chat.selectChatFirst')); clearFile(); return; }
  const chatId = currentChat;
  const fd = new FormData();
  fd.append('file', currentFile);
  var token = localStorage.getItem('authToken');
  try {
    var headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api/upload', { method: 'POST', headers: headers, body: fd });
    const data = await res.json();
    if (data.ok) {
      const msgType = currentFile.type.startsWith('image/') ? 'image' : 'file';
      // 检查是否生成中：生成中时排。
      if (isChatGenerating(chatId)) {
        sendQueue.push({ chatId: chatId, content: data.url, fileType: msgType, originalName: currentFile.name, isFile: true });
        updateGenUI();
        toast(t('chat.queuedAuto', { n: sendQueue.length }));
      } else {
        ws.send(JSON.stringify({ type: 'message', chatId: chatId, content: data.url, originalName: currentFile.name, fileType: msgType }));
        // 乐观渲染
        const _dedupKey = chatId + '|' + data.url + '|' + (clientId || '');
        _optimisticSent.add(_dedupKey);
        setTimeout(() => _optimisticSent.delete(_dedupKey), 8000);
        appendMessage({ chatId, senderId: clientId || 'user', senderType: 'user', content: data.url, fileType: msgType, originalName: currentFile.name, timestamp: Date.now() });
      }
    } else { toast(t('err.uploadFail') + ': ' + (data?.error?.message || data?.error || '')); }
  } catch(e) { toast(t('err.uploadError') + ': ' + (e.message || '')); }
  clearFile();
}
// 合并文件发送逻辑。send()
const _origSend = send;
send = function() { if (currentFile) sendFile(); else _origSend(); };

// ── Mention ──
function checkMention() {
  const input = document.getElementById('input');
  const dropdown = document.getElementById('mentionDropdown');
  const text = input.value;
  const pos = input.selectionStart;
  const before = text.slice(0, pos);
  const lastAt = before.lastIndexOf('@');
  if (lastAt === -1 || before.slice(lastAt+1).includes(' ')) {
    dropdown.style.display = 'none'; isMentioning = false; return;
  }
  const query = before.slice(lastAt+1).toLowerCase();
  if (!currentChat) return;
  api('/api/chats/' + encodeURIComponent(currentChat) + '/participants').then(data => {
    mentionList = (data.participants||[]).filter(p => {
      const n = (p.display_name||p.user_id||p.agent_id||'').toLowerCase();
      return !!p.agent_id || n.includes(query);
    }).map(p => ({ id: p.agent_id||p.user_id, name: p.display_name||p.agent_id, isAgent: !!p.agent_id }));
    if (!mentionList.length) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = mentionList.map((m,i) => '<div class="mention-item'+(i===0?' active':'')+'" onclick="selectMention('+i+')">'+(m.isAgent?'🤖 ':'👤 ')+esc(m.name)+'</div>').join('');
    dropdown.style.display = 'block'; isMentioning = true; mentionIndex = 0;
  }).catch(()=>{});
}
function selectMention(i) {
  const input = document.getElementById('input');
  const text = input.value;
  const pos = input.selectionStart;
  const before = text.slice(0, pos);
  const lastAt = before.lastIndexOf('@');
  if (lastAt === -1) return;
  const m = mentionList[i]; if (!m) return;
  input.value = text.slice(0, lastAt) + '@' + m.name + ' ' + text.slice(pos);
  document.getElementById('mentionDropdown').style.display = 'none'; isMentioning = false; input.focus();
}
document.getElementById('input').addEventListener('keydown', function(e) {
  if (!isMentioning) return;
  const items = document.getElementById('mentionDropdown').querySelectorAll('.mention-item');
  if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex = (mentionIndex+1)%items.length; highlightMention(items); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex = (mentionIndex-1+items.length)%items.length; highlightMention(items); }
  else if (e.key === 'Enter' && isMentioning) { e.preventDefault(); selectMention(mentionIndex); }
  else if (e.key === 'Escape') { document.getElementById('mentionDropdown').style.display = 'none'; isMentioning = false; }
});
function highlightMention(items) { items.forEach((it,i) => it.classList.toggle('active', i===mentionIndex)); }

// ── Friends ──
function showFriendPanel() { document.getElementById('chatList').style.display='none'; document.getElementById('friendPanel').style.display='flex'; loadFriends().catch(()=>{}); loadRequests().catch(()=>{}); }
function hideFriendPanel() { document.getElementById('chatList').style.display=''; document.getElementById('friendPanel').style.display='none'; }
function switchFriendTab(tab) {
  currentFriendTab = tab;
  document.getElementById('tabFriends').className = tab==='friends'?'active':'';
  document.getElementById('tabRequests').className = tab==='requests'?'active':'';
  document.getElementById('friendsList').className = tab==='friends'?'':'hidden';
  document.getElementById('requestsList').className = tab==='requests'?'':'hidden';
  if (tab==='requests') loadRequests().catch(()=>{});
}
// ══════════════════════════════════════════
// ── 好友系统（完整版 - 走云平台 API。──
// ══════════════════════════════════════════
let outgoingRequests = [];

async function searchUsers() {
  const q = document.getElementById('searchBox').value.trim();
  if (!q) { document.getElementById('searchResult').innerHTML=''; return; }
  document.getElementById('searchResult').innerHTML = '<div style="padding:10px;color:var(--text3);font-size:12px">'+t('chat.searching')+'</div>';
  try {
    let data;
    if (authToken) {
      data = await platformApi('/api/lan/search?q=' + encodeURIComponent(q), 'GET');
      // v2.0.9: token 失效。01/ok:false）时清除。token 并回退本地免登录搜。
      if (!data || data.ok === false) { authToken = null; localStorage.removeItem('authToken'); data = await api('/api/lan/search?q=' + encodeURIComponent(q), 'GET'); }
      searchResults = (data.results || []).map(u => ({ id: String(u.numericId), displayName: u.displayName, numericId: u.numericId }));
    } else {
      // v2.0.9: 未登录也统一走免鉴权。/api/lan/search，避。/api/users 需要登录。
      data = await api('/api/lan/search?q=' + encodeURIComponent(q), 'GET');
      searchResults = (data.results || []).map(u => ({ id: String(u.numericId), displayName: u.displayName, numericId: u.numericId }));
    }
    renderSearch();
  } catch(e) { document.getElementById('searchResult').innerHTML = '<div style="padding:10px;color:#ef4444;font-size:12px">'+t('err.searchFail')+'</div>'; }
}
function renderSearch() {
  const c = document.getElementById('searchResult');
  if (!searchResults.length) { c.innerHTML='<div style="padding:10px;color:var(--text3);font-size:12px">'+t('search.noResult')+'</div>'; return; }
  // 去重（同一用户可能出现多次。
  const seen = new Set();
  const unique = searchResults.filter(u => { const k = String(u.numericId||u.id); if (seen.has(k)) return false; seen.add(k); return true; });
  c.innerHTML = unique.map(u => {
    const uid = String(u.numericId || u.id);
    const isFriend = myFriends.some(f => String(f.friendId) === uid);
    const isPending = outgoingRequests.some(r => String(r.toUserId) === uid && r.status === 'pending');
    const isMe = uid === String(lanMeId) || u.id === clientId;
    let action;
    if (isMe) action = '<span style="color:var(--text3);font-size:11px">'+t('friends.me')+'</span>';
    else if (isFriend) action = '<span style="color:#4ade80;font-size:11px">'+t('friends.isFriend')+'</span>';
    else if (isPending) action = '<span style="color:#f59e0b;font-size:11px">'+t('friends.requestedStatus')+'</span>';
    else action = '<button class="btn-sm btn-accept" onclick="sendRequest(\''+uid+'\')">'+t('social.addFriend')+'</button>';
    const avatar = '<div style="width:36px;height:36px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">'+esc((u.displayName||'?')[0].toUpperCase())+'</div>';
    return '<div class="friend-item" style="display:flex;align-items:center;gap:10px">'+avatar+'<div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text);font-weight:500">'+esc(u.displayName)+'</div><div style="font-size:11px;color:var(--text3)">ID: '+uid+'</div></div><div>'+action+'</div></div>';
  }).join('');
}
async function sendRequest(to) {
  if (!authToken && !clientId) { toast(t('toast.connectFirst')); return; }
  // 防重复：先检查本地状。
  const uid = String(to);
  if (myFriends.some(f => String(f.friendId) === uid)) { toast(t('friends.alreadyFriends')); return; }
  if (outgoingRequests.some(r => String(r.toUserId) === uid && r.status === 'pending')) { toast(t('friends.requestPending')); return; }
  try {
    const fromUserId = lanMeId || clientId;
    // v2.0.11: 。authToken 时优先走 platformApi，失败回退本地 api
    let d;
    if (authToken) {
      d = await platformApi('/api/lan/friend-request', 'POST', { fromUserId, toNumericId: Number(to), message: '' });
      if (!d || d.ok === false) { authToken = null; localStorage.removeItem('authToken'); d = await api('/api/lan/friend-request', 'POST', { fromUserId, toNumericId: Number(to), message: '' }); }
    } else {
      d = await api('/api/lan/friend-request', 'POST', { fromUserId, toNumericId: Number(to), message: '' });
    }
    if (d.error) { toast(_errMsg(d, '发送失败')); return; }
    toast(t('friends.requestSent'));
    // 立即更新本地状态，防止重复点击
    outgoingRequests.push({ toUserId: uid, status: 'pending', toName: searchResults.find(u => String(u.numericId || u.id) === uid)?.displayName || (t('profile.defaultUser') + uid), createdAt: Date.now() });
    searchUsers(); loadRequests().catch(() => {});
  } catch(e) { toast(t('err.sendFail')); }
}
async function loadFriends() {
  if (!authToken && !clientId) return;
  try {
    let d;
    if (authToken) {
      d = await platformApi('/api/lan/friends', 'GET');
      // v2.0.11: platformApi 失败时回退到本。API
      if (!d || d.ok === false) {
        authToken = null; localStorage.removeItem('authToken');
        d = await api('/api/friends/list?userId=' + encodeURIComponent(clientId));
      }
    } else {
      d = await api('/api/friends/list?userId=' + encodeURIComponent(clientId));
    }
    // 去重（同一好友可能有多条记录）
    const seen = new Set();
    myFriends = (d.friends||[]).filter(f => { const k = String(f.friendId); if (seen.has(k)) return false; seen.add(k); return true; });
    renderFriends();
  } catch(e){}
}
function renderFriends() {
  const el = document.getElementById('friendsList');
  if (!myFriends.length) {
    el.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text3)"><div style="font-size:28px;margin-bottom:8px">👥</div><div style="font-size:13px">'+t('friends.noFriends')+'</div><div style="font-size:11px;margin-top:4px">'+t('friends.searchHint')+'</div></div>';
    return;
  }
  el.innerHTML = myFriends.map(f => {
    const fid = String(f.friendId);
    const fname = f.friendName || f.displayName || (t('profile.defaultUser')+fid);
    const femail = f.friendEmail || '';
    const initial = (fname||'?')[0].toUpperCase();
    const avatar = '<div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,var(--accent),#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff;flex-shrink:0;font-weight:600">'+esc(initial)+'</div>';
    return '<div class="friend-item" style="display:flex;align-items:center;gap:10px;padding:10px">' +
      avatar +
      '<div style="flex:1;min-width:0;cursor:pointer" onclick="openChatFriend(\''+fid+'\',\''+esc(fname)+'\')">' +
        '<div style="font-size:14px;color:var(--text);font-weight:500">'+esc(fname)+'</div>' +
        '<div style="font-size:11px;color:var(--text3);margin-top:2px">ID: '+fid+(femail?' · '+esc(femail):'')+'</div>' +
      '</div>' +
      '<div style="display:flex;gap:4px;flex-shrink:0">' +
        '<button class="btn-sm" style="background:var(--accent);color:#fff;padding:4px 10px;font-size:11px" onclick="openChatFriend(\''+fid+'\',\''+esc(fname)+'\')" title="'+t('friends.sendMsg')+'">💬</button>' +
        '<button class="btn-sm" style="background:var(--bg3);color:var(--text3);padding:4px 8px;font-size:11px" onclick="confirmDeleteFriend(\''+fid+'\',\''+esc(fname)+'\')" title="'+t('friends.deleteFriend')+'">。/button>' +
      '</div></div>';
  }).join('');
}
async function openChatFriend(fid, fname) {
  const myNumericId = lanMeId || clientId;
  const chatId = 'chat-platform-' + [String(myNumericId), String(fid)].sort().join('-');
  try {
    const d = await api('/api/chats'); const exists = (d.chats||[]).some(c=>c.id===chatId);
    if (!exists) {
      await api('/api/chats', 'POST', { id: chatId, type: 'private', name: fname });
      await api('/api/participants', 'POST', { id: 'p-'+chatId+'-1', chatId, userId: String(myNumericId) });
      await api('/api/participants', 'POST', { id: 'p-'+chatId+'-2', chatId, userId: String(fid) });
    }
    hideFriendPanel(); await loadChatList(); switchChat(chatId);
  } catch(e) { console.error('[openChatFriend]', e); toast(t('err.openChatFail')); }
}
function confirmDeleteFriend(fid, fname) {
  if (confirm(t('friends.confirmDelete', {name: fname}))) {
    deleteFriend(fid);
  }
}
async function deleteFriend(fid) {
  try {
    if (authToken) {
      const d = await platformApi('/api/lan/friends/' + fid, 'DELETE');
      // v2.0.11: platformApi 失败时回退本地 API
      if (!d || d.ok === false) { authToken = null; localStorage.removeItem('authToken'); await api('/api/friends/' + fid + '?userId=' + encodeURIComponent(lanMeId || clientId), 'DELETE'); }
      else if (d.error) { toast(d.error); return; }
    } else {
      // v2.0.11: 本地 API 删除好友（后端用 DELETE /api/friends/:id?userId=xxx。
      const d = await api('/api/friends/' + fid + '?userId=' + encodeURIComponent(lanMeId || clientId), 'DELETE');
      if (d.error) { toast(d.error); return; }
    }
    toast(t('friends.deleted')); loadFriends();
  } catch(e) { toast(t('err.operationFail')); }
}
async function loadRequests() {
  if (!authToken && !clientId) return;
  try {
    let d;
    if (authToken) {
      d = await platformApi('/api/lan/friend-requests', 'GET');
      // v2.0.11: platformApi 失败。01/token无效/空响应）时回退到本。API
      // 修复：回退查询必须。lanMeId（本机真。DB 用户 ID），clientId 。friendships.to_user_id 不匹配会导致收不到请。
      if (!d || d.ok === false) {
        authToken = null; localStorage.removeItem('authToken');
        d = await api('/api/friends/requests?userId=' + encodeURIComponent(lanMeId || clientId));
      }
    } else {
      d = await api('/api/friends/requests?userId=' + encodeURIComponent(lanMeId || clientId));
    }
    incomingRequests = d.incoming||[];
    outgoingRequests = d.outgoing||[];
    // v2.1.7: 红点只数待处理申请(pending)，历史 accepted/denied 不再顶数字
    requestNotifyCount = (d.pendingIncoming || incomingRequests.filter(function(r){ return r.status === 'pending'; })).length;
    updateBadge();
    renderRequests();
  } catch(e){ console.warn('[loadRequests] failed', e); }
}
function renderRequests() {
  // 收到的申。
  const inEl = document.getElementById('incomingRequests');
  if (!inEl) return;
  // v2.1.7: 「收到的好友申请」只展示 pending，历史记录不在这里重复出现
  const pendingIn = incomingRequests.filter(function(r){ return r.status === 'pending'; });
  if (!pendingIn.length) {
    inEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">'+t('friends.noNewRequests')+'</div>';
  } else {
    inEl.innerHTML = pendingIn.map(r => {
      const name = r.fromName || (t('profile.defaultUser')+r.fromUserId);
      const initial = name[0].toUpperCase();
      const avatar = '<div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#ef4444);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;flex-shrink:0">'+esc(initial)+'</div>';
      return '<div class="request-item" style="display:flex;align-items:center;gap:10px;padding:10px">' +
        avatar +
        '<div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text);font-weight:600">'+esc(name)+'</div>' +
        (r.message?'<div style="font-size:11px;color:var(--text3);margin-top:2px">'+t('friends.messageLabel')+esc(r.message)+'</div>':'') +
        '<div style="font-size:10px;color:var(--text3);margin-top:2px">'+new Date(r.createdAt).toLocaleString()+'</div></div>' +
        '<div style="display:flex;gap:4px;flex-shrink:0">' +
          '<button class="btn-sm btn-accept" onclick="respondReq(\''+r.id+'\',\'accept\')">'+t('friends.accept')+'</button>' +
          '<button class="btn-sm btn-reject" onclick="respondReq(\''+r.id+'\',\'reject\')">'+t('friends.reject')+'</button>' +
        '</div></div>';
    }).join('');
  }
  // 发出的申。
  const outEl = document.getElementById('outgoingRequests');
  if (!outEl) return;
  if (!outgoingRequests.length) {
    outEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">'+t('friends.noSentRequests')+'</div>';
  } else {
    outEl.innerHTML = outgoingRequests.map(r => {
      const name = r.toName || (t('profile.defaultUser')+r.toUserId);
      const initial = name[0].toUpperCase();
      const statusLabel = r.status === 'pending' ? '<span style="color:#f59e0b;font-size:11px">'+t('friends.statusPending')+'</span>' :
        r.status === 'accepted' ? '<span style="color:#4ade80;font-size:11px">'+t('friends.statusAccepted')+'</span>' :
        '<span style="color:#ef4444;font-size:11px">'+t('friends.statusRejected')+'</span>';
      const avatar = '<div style="width:36px;height:36px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">'+esc(initial)+'</div>';
      return '<div class="request-item" style="display:flex;align-items:center;gap:10px;padding:10px">' +
        avatar +
        '<div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text)">'+esc(name)+'</div>' +
        '<div style="font-size:10px;color:var(--text3);margin-top:2px">'+new Date(r.createdAt).toLocaleString()+'</div></div>' +
        '<div style="display:flex;align-items:center;gap:6px">' + statusLabel +
        (r.status === 'pending' ? ' <button class="btn-sm" style="background:var(--bg3);color:var(--text3);padding:4px 8px;font-size:11px" onclick="withdrawRequest(\''+r.id+'\')">'+t('friends.withdraw')+'</button>' : '') +
        '</div></div>';
    }).join('');
  }
}
async function respondReq(rid, action) {
  try {
    let d;
    if (authToken) {
      d = await platformApi('/api/lan/friend-respond', 'POST', { requestId: rid, action });
      // v2.0.11: platformApi 失败时回退本地 API
      if (!d || d.ok === false) { authToken = null; localStorage.removeItem('authToken'); d = await api('/api/friends/respond', 'POST', { requestId: rid, action }); }
      if (d.error) { toast(d.error); return; }
    } else {
      d = await api('/api/friends/respond', 'POST', { requestId: rid, action });
      if (d.error) { toast(d.error); return; }
    }
    toast(action==='accept'?t('friends.accepted'):t('friends.rejected'));
    loadFriends(); loadRequests();
  } catch(e) { toast(t('err.operationFail')); }
}
async function withdrawRequest(rid) {
  if (!confirm(t('friends.confirmWithdraw'))) return;
  try {
    if (authToken) {
      const d = await platformApi('/api/lan/friend-request/' + rid, 'DELETE');
      if (d.error) { toast(d.error); return; }
    }
    toast(t('friends.withdrawn')); loadRequests();
  } catch(e) { toast(t('err.operationFail')); }
}

// ── 个人中心搜索用户（走云平台） ──
async function searchUser() {
  const q = (document.getElementById('userSearchInput') || {}).value || '';
  const box = document.getElementById('userSearchResults');
  if (!box) return;
  if (!q || !q.trim()) { box.innerHTML = ''; return; }
  box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">'+t('chat.searching')+'</div>';
  try {
    let results = [];
    if (authToken) {
      const d = await platformApi('/api/lan/search?q=' + encodeURIComponent(q.trim()), 'GET');
      // v2.0.9: token 失效时清除旧 token 并回退本地免登录搜。
      const d2 = (!d || d.ok === false) ? await ((authToken = null, localStorage.removeItem('authToken')), api('/api/lan/search?q=' + encodeURIComponent(q.trim()), 'GET')) : d;
      results = (d2.results || []).map(u => ({ numericId: u.numericId, displayName: u.displayName }));
    } else {
      const d = await api('/api/lan/search?q=' + encodeURIComponent(q.trim()), 'GET');
      results = (d.results || []).map(u => ({ numericId: u.numericId, displayName: u.displayName }));
    }
    // 去重
    const seen = new Set();
    results = results.filter(u => { const k = String(u.numericId); if (seen.has(k)) return false; seen.add(k); return true; });
    if (!results.length) { box.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:8px">'+t('friends.userNotFound')+'</div>'; return; }
    box.innerHTML = results.map(u => {
      const isFriend = myFriends.some(f => String(f.friendId) === String(u.numericId));
      const isPending = outgoingRequests.some(r => String(r.toUserId) === String(u.numericId) && r.status === 'pending');
      const isMe = String(u.numericId) === String(lanMeId);
      let action;
      if (isMe) action = '<span style="color:var(--text3);font-size:11px">'+t('friends.meShort')+'</span>';
      else if (isFriend) action = '<span style="color:#4ade80;font-size:11px">'+t('friends.isFriend')+'</span>';
      else if (isPending) action = '<span style="color:#f59e0b;font-size:11px">'+t('friends.requestedStatus')+'</span>';
      else action = '<button class="btn-sm btn-accept" onclick="sendRequest(\''+u.numericId+'\')">'+t('social.addFriend')+'</button>';
      const initial = (u.displayName||'?')[0].toUpperCase();
      const avatar = '<div style="width:36px;height:36px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">'+esc(initial)+'</div>';
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border)">'+avatar+'<div style="flex:1"><div style="font-size:13px;color:var(--text)">'+esc(u.displayName)+'</div><div style="font-size:11px;color:var(--text3)">ID: '+u.numericId+'</div></div>'+action+'</div>';
    }).join('');
  } catch(e) { box.innerHTML = '<div style="color:#ef4444;font-size:12px;padding:8px">'+t('err.searchFail')+'</div>'; }
}

// ── Create Group ──
function showCreateGroup() {
  // 弹窗让用户输入群聊名称，建群后自动弹出多选勾选面板（不再手输序号。
  const name = prompt(t('social.teamNamePh'));
  if (!name) return;
  const chatId = 'team-' + Date.now().toString(36);
  api('/api/chats', 'POST', { id: chatId, type: 'group', name }).then(async () => {
    // 解析真实登录用户 ID（平台数。ID）；clientId（u-xxx）与 JWT sub 不匹配会导致 participant 写入。403 拒绝
    if (!lanMeId && authToken) {
      try { const d = await platformApi('/api/user/me', 'GET'); if (d && d.ok && d.user) lanMeId = d.user.id || d.user.sub || null; } catch(_e) {}
    }
    // 把创建者加。owner —。失败自动降级重试 + 回读验证（修。建群后侧边栏看不到群"。
    try {
      var tryOwner = function(uid) { return api('/api/participants', 'POST', {
        id: 'p-' + chatId + '-creator',
        chatId: chatId,
        userId: uid,
        role: 'owner'
      }).then(function(){ return true; }).catch(function(){ return false; }); };
      var ownerOk = await tryOwner(lanMyId());
      if (!ownerOk && lanMeId && String(lanMeId) !== String(clientId)) ownerOk = await tryOwner(clientId);
      if (!ownerOk && authToken) {
        try { var d2 = await platformApi('/api/user/me', 'GET'); if (d2 && d2.ok && d2.user) { lanMeId = d2.user.id || d2.user.sub || null; if (lanMeId && String(lanMeId) !== String(lanMyId())) ownerOk = await tryOwner(lanMeId); } } catch(_e) {}
      }
      if (!ownerOk) {
        try { var pd2 = await api('/api/chats/' + encodeURIComponent(chatId) + '/participants'); ownerOk = (pd2.participants || []).some(function(p){ return p.user_id === lanMyId() && p.role === 'owner'; }); } catch(_e) {}
      }
      if (!ownerOk) toast('⚠️ 群已创建，但创建者入群写入失败，刷新后可能不显示（请检查登录身份）');
    } catch(_e) { toast('⚠️ 群已创建，但创建者入群写入异常'); }
    loadChatList();
    switchChat(chatId);
    // 建群后自动弹出多选勾选面板：直接勾选要加入。AI/好友，批量添。
    showAgentPicker(chatId);
  }).catch(()=>toast(t('err.createFail')));
}

// ── Agent 多选勾选面板（建群/加人共用；勾选式，不手输编号。──
var _pickerChatId = null;
function showAgentPicker(chatId) {
  _pickerChatId = chatId || currentChat;
  var old = document.getElementById('agentPickerWrap');
  if (old) old.remove();
  var wrap = document.createElement('div');
  wrap.id = 'agentPickerWrap';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  wrap.innerHTML = '<div style="background:#1e1f26;border:1px solid #333;border-radius:10px;width:480px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column">' +
    '<div style="padding:12px 16px;border-bottom:1px solid #333;font-size:14px;font-weight:600">🤖 选择AI加入团队（勾选，可多选）</div>' +
    '<div id="agentPickerList" style="flex:1;overflow-y:auto;padding:6px 0;min-height:120px"></div>' +
    '<div style="padding:10px 16px;border-top:1px solid #333;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
    '<button class="btn-sm" onclick="agentPickerAll(true)">全。/button>' +
    '<button class="btn-sm" onclick="agentPickerAll(false)">' + t('common.clear') + '</button>' +
    '<span id="agentPickerCount" style="flex:1;font-size:12px;color:#999"></span>' +
    '<button class="btn-sm btn-accept" onclick="agentPickerAdd()">确定添加</button>' +
    '<button class="btn-sm" onclick="hideAgentPicker()">' + t('common.cancel') + '</button>' +
    '</div></div>';
  wrap.addEventListener('click', function(e) { if (e.target === wrap) hideAgentPicker(); });
  document.body.appendChild(wrap);
  loadAgentPickerList();
}
function hideAgentPicker() { var w = document.getElementById('agentPickerWrap'); if (w) w.remove(); _pickerChatId = null; }
async function loadAgentPickerList() {
  var c = document.getElementById('agentPickerList');
  if (!c) return;
  c.innerHTML = '<div style="padding:10px;color:#888;font-size:12px">' + t('common.loading') + '</div>';
  try {
    var d = await api('/api/agents');
    var agents = d.agents || [];
    if (!agents.length) { c.innerHTML = '<div style="padding:10px;color:#888;font-size:12px">' + t('members.noneAvailable') + '</div>'; return; }
    // 已在该群。agent 显示为已勾选并禁用，避免重复添。
    var existing = {};
    try {
      var pd = await api('/api/chats/' + encodeURIComponent(_pickerChatId) + '/participants');
      (pd.participants || []).forEach(function(m) { if (m.agent_id) existing[m.agent_id] = true; });
    } catch(e) {}
    c.innerHTML = agents.map(function(a) {
      var disabled = existing[a.id] ? ' checked disabled' : '';
      return '<label style="display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid #222;cursor:pointer">' +
        '<input type="checkbox" class="agentPickerCb" value="' + esc(a.id) + '"' + disabled + '>' +
        '<span style="font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🤖 ' + esc(a.displayName) + '</span>' +
        '<span style="font-size:10px;color:#8ab4f8;background:rgba(138,180,248,0.12);padding:1px 6px;border-radius:8px;flex-shrink:0">' + esc(a.model || 'default') + '</span>' +
        '</label>';
    }).join('');
    agentPickerRefreshCount();
  } catch(e) { c.innerHTML = '<div style="padding:10px;color:#f66;font-size:12px">' + t('err.loadFail') + '</div>'; }
}
function agentPickerAll(on) { document.querySelectorAll('.agentPickerCb').forEach(function(cb){ if (!cb.disabled) cb.checked = on; }); agentPickerRefreshCount(); }
function agentPickerRefreshCount() {
  var n = document.querySelectorAll('.agentPickerCb:checked:not(:disabled)').length;
  var el = document.getElementById('agentPickerCount');
  if (el) el.textContent = '已选 ' + n + ' 人';
}
async function agentPickerAdd() {
  var ids = [];
  document.querySelectorAll('.agentPickerCb:checked:not(:disabled)').forEach(function(cb){ ids.push(cb.value); });
  if (!ids.length) { toast('请先勾选要加入的AI'); return; }
  var chatId = _pickerChatId;
  var added = 0;
  for (var i = 0; i < ids.length; i++) {
    try {
      await api('/api/participants', 'POST', { id: 'p-' + chatId + '-' + ids[i], chatId: chatId, agentId: ids[i], role: 'member' });
      added++;
    } catch(e) {}
  }
  toast(t('social.teamCreated', { n: added }));
  hideAgentPicker();
  renderMembers();
}

// ── Members Panel ──
// 缓存模型列表，避免每次渲染成员都请求
var _cachedModels = null;
async function _getModelList() {
  if (_cachedModels) return _cachedModels;
  try {
    const d = await api('/api/providers');
    let models = d.models || [];
    if (models.length === 0 && d.providers) {
      models = d.providers.flatMap(p => (p.models||[]).map(m => ({id:m.id||m.name||m, provider:p.id, providerName:p.name})));
    }
    _cachedModels = models;
    return models;
  } catch(e) { return []; }
}
function showMembersPanel() { renderMembers(); document.getElementById('membersOverlay').classList.add('open'); document.getElementById('membersPanel').classList.add('open'); }
function hideMembersPanel() { document.getElementById('membersOverlay').classList.remove('open'); document.getElementById('membersPanel').classList.remove('open'); }
async function renderMembers() {
  const c = document.getElementById('membersList');
  if (!currentChat) { c.innerHTML='<div style="padding:10px;color:#555">'+t('chat.selectChat')+'</div>'; return; }
  try {
    const d = await api('/api/chats/'+encodeURIComponent(currentChat)+'/participants');
    const members = d.participants||[];
    // 获取模型列表用于 AI 成员的模型下。
    const models = await _getModelList();
    // 获取所。agent 信息（含 model 字段。
    let agentMap = {};
    try {
      const ad = await api('/api/agents');
      for (const a of (ad.agents||[])) agentMap[a.id] = a;
    } catch(e) {}
    c.innerHTML = members.map(m => {
      const agentInfo = agentMap[m.agent_id] || {};
      const name = agentInfo.displayName || m.display_name || m.user_id || m.agent_id || '?';
      const icon = m.agent_id ? '🤖' : '👤';
      // AI 成员渲染模型选择下拉。
      if (m.agent_id) {
        const currentModel = agentInfo.model || '';
        const modelOpts = models.map(md => {
          const label = (md.providerName||md.provider||'') + ' / ' + md.id;
          const sel = (md.id === currentModel) ? ' selected' : '';
          return '<option value="'+esc(md.id)+'"'+sel+'>'+esc(label)+'</option>';
        }).join('');
        return '<div style="padding:8px 14px;border-bottom:1px solid #222">'
          + '<div style="display:flex;justify-content:space-between;align-items:center">'
          + '<span>' + icon + ' ' + esc(name) + '</span>'
          + '<button class="btn-sm" style="color:var(--red);border-color:var(--red);font-size:10px;padding:2px 6px" onclick="removeMember(\''+esc(m.agent_id)+'\',true)">'+t('common.remove')+'</button>'
          + '</div>'
          + '<select onchange="setAgentModel(\''+esc(m.agent_id)+'\',this.value)" style="width:100%;margin-top:4px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:11px">'
          + '<option value="">'+t('settings.defaultModel')+'</option>'
          + modelOpts
          + '</select>'
          + '</div>';
      }
      // 普通用户成。
      return '<div style="padding:8px 14px;border-bottom:1px solid #222;display:flex;justify-content:space-between;align-items:center">'
        + '<span>' + icon + ' ' + esc(name) + '</span>'
        + '<button class="btn-sm" style="color:var(--red);border-color:var(--red);font-size:10px;padding:2px 6px" onclick="removeMember(\''+esc(m.user_id||'')+'\',false)">'+t('common.remove')+'</button>'
        + '</div>';
    }).join('');
  } catch(e) { c.innerHTML='<div style="padding:10px;color:#555">'+t('err.loadFail')+'</div>'; }
}
async function setAgentModel(agentId, model) {
  try {
    await api('/api/agents/'+encodeURIComponent(agentId), 'PATCH', { model: model, modelSource: 'manual' });
    toast('⚠' + t('chat.modelSet', { model: model || t('settings.defaultModel') }));
  } catch(e) { toast('⚠' + t('err.setFail')); }
}
async function removeMember(mid, isAgent) {
  if (!currentChat || !mid) return;
  try {
    // 后端 DELETE /api/participants：AI 成员。agentId，真人传 id
    const body = isAgent ? { agentId: mid, chatId: currentChat } : { id: mid, chatId: currentChat };
    await api('/api/participants', 'DELETE', body);
    renderMembers();
    toast(t('toast.removed'));
  } catch(e) { toast(t('err.removeFail')); }
}
async function loadAvailableMembers() {
  if (!currentChat || !clientId) { toast(t('toast.connectAndSelect')); return; }
  const box = document.getElementById('availableMembers');
  if (!box) return;
  box.innerHTML = '<div style="padding:6px;color:#888;font-size:11px">' + t('common.loading') + '</div>';
  try {
    // 可添加的人（好友。
    let members = [];
    try {
      const d = await api('/api/chats/' + encodeURIComponent(currentChat) + '/available-members?userId=' + encodeURIComponent(clientId));
      members = d.members || [];
    } catch(e) {}
    // 可添加的 AI（全部智能体，带模型徽章。
    let agents = [];
    try {
      const ad = await api('/api/agents');
      agents = (ad.agents || []).map(a => ({ id: a.id, displayName: a.displayName, model: a.model || 'default', type: 'ai-agent' }));
    } catch(e) {}
    // 已存在的成员（避免重复添加）
    let existing = {};
    try {
      const pd = await api('/api/chats/' + encodeURIComponent(currentChat) + '/participants');
      (pd.participants || []).forEach(m => { if (m.agent_id) existing[m.agent_id] = true; if (m.user_id) existing['u:' + m.user_id] = true; });
    } catch(e) {}
    const rows = [];
    agents.forEach(a => {
      if (existing[a.id]) return;
      rows.push('<label style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #222;cursor:pointer;font-size:12px">' +
        '<input type="checkbox" class="availMemberCb" data-type="agent" value="' + esc(a.id) + '">' +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">🤖 ' + esc(a.displayName) + '</span>' +
        '<span style="font-size:10px;color:#8ab4f8;background:rgba(138,180,248,0.12);padding:0 6px;border-radius:8px;flex-shrink:0">' + esc(a.model) + '</span>' +
        '<span onclick="event.preventDefault();event.stopPropagation();renameAgent(this)" data-id="' + esc(a.id) + '" style="cursor:pointer;font-size:11px;color:#ffb74d;flex-shrink:0;padding:0 4px" title="改名">✏️</span></label>');
    });
    members.forEach(m => {
      const key = 'u:' + (m.id || m.user_id);
      if (existing[key]) return;
      rows.push('<label style="display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #222;cursor:pointer;font-size:12px">' +
        '<input type="checkbox" class="availMemberCb" data-type="user" value="' + esc(m.id || m.user_id) + '">' +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">👤 ' + esc(m.displayName || m.name || m.id || '') + '</span></label>');
    });
    if (!rows.length) { box.innerHTML = '<div style="padding:6px;color:#555;font-size:11px">' + t('members.noneAvailable') + '</div>'; return; }
    box.innerHTML = rows.join('') +
      '<div style="display:flex;align-items:center;gap:6px;padding:8px 10px">' +
      '<button class="btn-sm" onclick="availMemberAll(true)">全。/button>' +
      '<button class="btn-sm" onclick="availMemberAll(false)">' + t('common.clear') + '</button>' +
      '<span id="availMemberCount" style="flex:1;font-size:11px;color:#999"></span>' +
      '<button class="btn-sm btn-accept" onclick="batchAddMembers()">批量添加</button></div>';
    availMemberRefreshCount();
  } catch(e) { box.innerHTML = '<div style="padding:6px;color:#f66;font-size:11px">' + t('err.loadFail') + '</div>'; }
}
async function renameAgent(btn) {
  const id = btn.getAttribute('data-id');
  if (!id) return;
  let oldName = '';
  try {
    const d = await api('/api/agents');
    (d.agents || []).forEach(a => { if (String(a.id) === id) oldName = a.displayName || ''; });
  } catch(e) {}
  const name = prompt('给这个智能体起个新名字：', oldName || '');
  if (!name || !name.trim()) return;
  try {
    const r = await api('/api/agents/' + encodeURIComponent(id), 'PATCH', { displayName: name.trim() });
    if (r && r.ok) {
      toast('。已改名：' + name.trim());
      _agentInfoMap = null;
      _ensureAgentInfoMap();
      loadAvailableMembers();
      renderMembers();
    } else { toast('改名失败'); }
  } catch(e) { toast('改名失败'); }
}
function availMemberAll(on) { document.querySelectorAll('.availMemberCb').forEach(cb => cb.checked = on); availMemberRefreshCount(); }
function availMemberRefreshCount() {
  const el = document.getElementById('availMemberCount');
  if (el) el.textContent = '已选 ' + document.querySelectorAll('.availMemberCb:checked').length + ' 人';
}
async function batchAddMembers() {
  if (!currentChat) return;
  const picks = Array.from(document.querySelectorAll('.availMemberCb:checked'));
  if (!picks.length) { toast('请先勾选要添加的成员'); return; }
  let added = 0;
  for (const cb of picks) {
    const mid = cb.value, type = cb.getAttribute('data-type');
    try {
      const body = type === 'agent'
        ? { id: 'p-' + currentChat + '-' + mid, chatId: currentChat, agentId: mid, role: 'member' }
        : { id: 'p-' + currentChat + '-' + mid, chatId: currentChat, userId: mid };
      await api('/api/participants', 'POST', body);
      added++;
    } catch(e) {}
  }
  toast(t('social.teamCreated', { n: added }));
  renderMembers();
  loadAvailableMembers();
}
async function addMember(mid, isAgent) {
  if (!currentChat) return;
  try {
    const body = isAgent
      ? { id: 'p-' + currentChat + '-' + mid, chatId: currentChat, agentId: mid, role: 'member' }
      : { id: 'p-' + currentChat + '-' + mid, chatId: currentChat, userId: mid };
    await api('/api/participants', 'POST', body);
    renderMembers();
    loadAvailableMembers();
    toast(t('toast.added'));
  } catch(e) { toast(t('err.addFail')); }
}

// ── Agent Management ──
function showAgentMgmt(){document.getElementById('agentMgmtOverlay').classList.add('open');document.getElementById('agentMgmtPanel').classList.add('open');loadAgentMgmt();}
function hideAgentMgmt(){document.getElementById('agentMgmtOverlay').classList.remove('open');document.getElementById('agentMgmtPanel').classList.remove('open');}
async function loadAgentMgmt(){const c=document.getElementById('agentMgmtList');c.innerHTML='<div style="padding:10px;color:var(--text3)">'+t('common.loading')+'</div>';try{const d=await api('/api/agents');const agents=d.agents||[];var nameCount={};for(var a of agents){nameCount[a.displayName]=(nameCount[a.displayName]||0)+1;}var dupNames=Object.keys(nameCount).filter(function(n){return nameCount[n]>1;});var html='<div style="font-size:11px;color:var(--text3);margin-bottom:6px">'+t('agentMgmt.total',{n:agents.length});if(dupNames.length)html+=' | <span style="color:var(--red)">'+t('agentMgmt.dups',{n:dupNames.length})+'</span>';html+='</div>';html+=agents.map(function(a){var isDup=nameCount[a.displayName]>1;var badge=isDup?' <span style="color:var(--red);font-size:10px">['+t('agentMgmt.dupTag')+']</span>':'';return '<div style="padding:8px 10px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center"><div style="flex:1;min-width:0"><div style="font-size:12px">'+esc(a.displayName)+badge+'</div><div style="font-size:10px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.id)+' | '+esc(a.model||'default')+'</div></div><button class="btn-sm" style="color:var(--red);border-color:var(--red);font-size:10px;padding:2px 8px;flex-shrink:0;margin-left:6px" onclick="deleteAgentMgmt(\''+esc(a.id)+'\',\''+esc(a.displayName)+'\')">'+t('common.delete')+'</button></div>';}).join('');c.innerHTML=html;}catch(e){c.innerHTML='<div style="padding:10px;color:var(--red)">'+t('err.loadFail')+'</div>';}}
async function deleteAgentMgmt(agentId,displayName){if(!confirm(t('agentMgmt.confirmDelete',{name:displayName})))return;try{await api('/api/agents/'+encodeURIComponent(agentId),'DELETE');toast(t('toast.deleted'));loadAgentMgmt();}catch(e){toast(t('err.deleteFail'));}}
async function batchDeleteDefaultAgents(){if(!confirm(t('agentMgmt.confirmBatch')))return;try{var d=await api('/api/agents');var agents=d.agents||[];var toDelete=agents.filter(function(a){return a.displayName==='AI助手';});if(!toDelete.length){toast(t('agentMgmt.noDup'));return;}var deleted=0;for(var i=0;i<toDelete.length;i++){try{await api('/api/agents/'+encodeURIComponent(toDelete[i].id),'DELETE');deleted++;}catch(e){}}toast(t('agentMgmt.batchDone',{n:deleted}));loadAgentMgmt();}catch(e){toast(t('err.loadFail'));}}

// ── Multi-AI Interact ──
var _multiAIHistory=[];
function showMultiAI(){document.getElementById('multiAIOverlay').classList.add('open');document.getElementById('multiAIPanel').classList.add('open');loadMultiAIModels();}
function hideMultiAI(){document.getElementById('multiAIOverlay').classList.remove('open');document.getElementById('multiAIPanel').classList.remove('open');}
async function loadMultiAIModels(){const c=document.getElementById('multiAIModels');c.innerHTML='<div style="padding:6px;color:var(--text3);font-size:11px">'+t('common.loading')+'</div>';try{const d=await api('/api/providers');var models=d.models||[];if(models.length===0&&d.providers){models=d.providers.flatMap(function(p){return(p.models||[]).map(function(m){return{id:m.id||m.name||m,provider:p.id,providerName:p.name};});});}c.innerHTML=models.map(function(m){var mid=esc(m.id||m);var label=esc((m.providerName||m.provider||'')+' / '+(m.id||m));return '<label style="display:flex;align-items:center;gap:6px;padding:4px 6px;cursor:pointer;font-size:12px"><input type="checkbox" value="'+mid+'" class="multiAIModelCb"><span>'+label+'</span></label>';}).join('');}catch(e){c.innerHTML='<div style="padding:6px;color:var(--red);font-size:11px">'+t('err.loadFail')+'</div>';}}
function multiAISelectAll(){document.querySelectorAll('.multiAIModelCb').forEach(function(cb){cb.checked=true;});}
function multiAIDeselectAll(){document.querySelectorAll('.multiAIModelCb').forEach(function(cb){cb.checked=false;});}
function multiAIGetSelected(){var s=[];document.querySelectorAll('.multiAIModelCb').forEach(function(cb){if(cb.checked)s.push(cb.value);});return s;}
function multiAIStreamMsg(model){var c=document.getElementById('multiAIChat');var div=document.createElement('div');div.style.cssText='margin-bottom:8px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,0.03)';div.innerHTML='<div style="font-size:11px;color:var(--accent);margin-bottom:2px">🤖 '+esc(model)+'</div><div class="multiAIStreamText" style="font-size:13px;white-space:pre-wrap"></div>';c.appendChild(div);c.scrollTop=c.scrollHeight;return div.querySelector('.multiAIStreamText');}
async function multiAISend(){var input=document.getElementById('multiAIInput');var msg=input.value.trim();if(!msg)return;var models=multiAIGetSelected();if(models.length===0){toast(t('multiAI.selectAtLeastOne'));return;}var mode=document.getElementById('multiAIMode').value;input.value='';var c=document.getElementById('multiAIChat');var udiv=document.createElement('div');udiv.style.cssText='margin-bottom:8px;padding:6px 8px;border-radius:6px';udiv.innerHTML='<div style="font-size:11px;color:var(--text);margin-bottom:2px">👤</div><div style="font-size:13px;white-space:pre-wrap">'+esc(msg)+'</div>';c.appendChild(udiv);c.scrollTop=c.scrollHeight;_multiAIHistory.push({role:'user',content:msg});input.disabled=true;var sendBtn=input.nextElementSibling;if(sendBtn)sendBtn.disabled=true;var streamEls={},modelReplies={};try{var resp=await fetch('/api/multi-ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:mode,models:models,message:msg,history:_multiAIHistory.slice(-10)})});var reader=resp.body.getReader();var decoder=new TextDecoder();var buffer='';while(true){var result=await reader.read();if(result.done)break;buffer+=decoder.decode(result.value,{stream:true});var lines=buffer.split('\n');buffer=lines.pop();var eventType='';for(var i=0;i<lines.length;i++){var line=lines[i];if(line.startsWith('event: '))eventType=line.slice(7);else if(line.startsWith('data: ')){try{var data=JSON.parse(line.slice(6));if((eventType==='start'||eventType==='chunk')&&!streamEls[data.model]){streamEls[data.model]=multiAIStreamMsg(data.model);modelReplies[data.model]='';}if(eventType==='chunk'){modelReplies[data.model]+=data.text;streamEls[data.model].textContent=modelReplies[data.model];document.getElementById('multiAIChat').scrollTop=999999;}else if(eventType==='tool'){if(!streamEls[data.model])streamEls[data.model]=multiAIStreamMsg(data.model);var tdiv=document.createElement('div');tdiv.style.cssText='font-size:10px;color:var(--purple);margin-top:4px;padding:2px 4px;background:rgba(128,0,128,0.1);border-radius:3px';tdiv.textContent='🔧 '+data.tool+': '+(data.result||data.error||'').slice(0,100);streamEls[data.model].parentElement.appendChild(tdiv);document.getElementById('multiAIChat').scrollTop=999999;}else if(eventType==='error'){if(!streamEls[data.model])streamEls[data.model]=multiAIStreamMsg(data.model);streamEls[data.model].textContent='⚠'+(data.error||'Error');streamEls[data.model].style.color='var(--red)';}}catch(e){}}}}for(var m in modelReplies){if(modelReplies[m])_multiAIHistory.push({role:'assistant',content:'['+m+']: '+modelReplies[m]});}}catch(e){var ediv=document.createElement('div');ediv.style.cssText='margin-bottom:8px;padding:6px 8px;color:var(--red);font-size:13px';ediv.textContent='⚠'+e.message;c.appendChild(ediv);}input.disabled=false;if(sendBtn)sendBtn.disabled=false;input.focus();}

// ── Memory Panel ──
function showMemoryPanel() {
  document.getElementById('memoryOverlay').classList.add('open');
  document.getElementById('memoryPanel').classList.add('open');
  document.getElementById('memoryMeta').textContent = '';
  loadMemoryContent();
}
function closeMemoryPanel() {
  document.getElementById('memoryOverlay').classList.remove('open');
  document.getElementById('memoryPanel').classList.remove('open');
}
async function loadMemoryContent() {
  if (!currentChat) { document.getElementById('memoryContent').textContent=t('chat.selectChat'); return; }
  try {
    const d = await api('/api/chats/'+encodeURIComponent(currentChat)+'/participants');
    const agents = (d.participants||[]).filter(p=>p.agent_id);
    if (!agents.length) { document.getElementById('memoryContent').textContent=t('memory.noAI'); return; }
    const mem = await api('/api/agents/'+encodeURIComponent(agents[0].agent_id)+'/memory');
    document.getElementById('memoryContent').textContent = mem.memory || t('memory.none');
    document.getElementById('memoryMeta').textContent = agents[0].agent_id;
  } catch(e) { document.getElementById('memoryContent').textContent=t('err.loadFail'); }
}
async function searchMemory() {
  const q = document.getElementById('memorySearchInput').value.trim();
  if (!q) { toast(t('search.enterQuery')); return; }
  const agentId = document.getElementById('memoryMeta').textContent.trim();
  if (!agentId) { toast(t('chat.selectChat')); return; }
  try {
    const d = await api('/api/memory/search?q=' + encodeURIComponent(q) + '&agentId=' + encodeURIComponent(agentId));
    const results = d.hits || d.results || [];
    document.getElementById('memorySearchResults').innerHTML = results.length ?
      results.map(r => '<div style="padding:6px;border-bottom:1px solid #222;font-size:12px;color:#ccc">' + esc(r.text||r.content||JSON.stringify(r)).slice(0,100) + '<span style="color:#666;font-size:10px"> ('+((r.score||0)*100).toFixed(0)+'%)</span></div>').join('') :
      '<div style="color:#555;font-size:11px">'+t('search.noMatch')+'</div>';
  } catch(e) { toast(t('err.searchFail')); }
}
async function reflectMemory() {
  if (!currentChat) { toast(t('chat.selectChat')); return; }
  toast(t('memory.reflecting'));
  try {
    const d = await api('/api/chats/'+encodeURIComponent(currentChat)+'/participants');
    const agents = (d.participants||[]).filter(p=>p.agent_id);
    if (!agents.length) { toast(t('memory.noAIShort')); return; }
    await api('/api/agents/'+encodeURIComponent(agents[0].agent_id)+'/reflect', 'POST', {});
    toast(t('memory.reflected')); loadMemoryContent();
  } catch(e) { toast(t('memory.reflectFail') + ': ' + e.message); }
}
document.addEventListener('keydown', function(e) { if (e.key === 'Escape') { closeMemoryPanel(); closeSettings(); hideMembersPanel(); toggleAdmin(false); } });

// ── Settings ──
function openSettings() { document.getElementById('settingsOverlay').classList.add('open'); document.getElementById('settingsPanel').classList.add('open'); loadModels().catch(()=>{}); loadProviders().catch(()=>{}); loadRuntimeSettings().catch(()=>{}); onProviderTypeChange(); }
function closeSettings() { document.getElementById('settingsOverlay').classList.remove('open'); document.getElementById('settingsPanel').classList.remove('open'); }

// ════════════════════════════════════════════
// 运行时设置（超时/日志级别，对。index.html 「⚡ 超时与日志」卡片）
// ════════════════════════════════════════════
async function loadRuntimeSettings() {
  try {
    var d = await api('/api/settings', 'GET');
    if (d && d.ok && d.settings) {
      var s = d.settings;
      var el;
      el = document.getElementById('setOrchestratorTimeout'); if (el) el.value = s.orchestratorTimeoutSeconds || 120;
      el = document.getElementById('setTaskTimeout'); if (el) el.value = s.taskTimeoutSeconds || 120;
      el = document.getElementById('setChatTimeout'); if (el) el.value = s.chatTimeoutSeconds || 120;
      el = document.getElementById('setLogLevel'); if (el) el.value = s.logLevel || 'info';
      el = document.getElementById('setFileLogging'); if (el) el.checked = s.fileLogging !== false;
    }
  } catch(e) { console.warn('[Settings] load failed:', e); }
}

async function saveRuntimeSettings() {
  var body = {
    orchestratorTimeoutSeconds: parseInt(document.getElementById('setOrchestratorTimeout')?.value || '120'),
    taskTimeoutSeconds: parseInt(document.getElementById('setTaskTimeout')?.value || '120'),
    chatTimeoutSeconds: parseInt(document.getElementById('setChatTimeout')?.value || '120'),
    logLevel: document.getElementById('setLogLevel')?.value || 'info',
    fileLogging: document.getElementById('setFileLogging')?.checked !== false,
  };
  var msg = document.getElementById('settingsSaveMsg');
  try {
    var d = await api('/api/settings', 'POST', body);
    if (d && d.ok) {
      if (msg) { msg.textContent = '✅ 已保存'; msg.style.color = 'var(--green)'; }
      toast('设置已保存');
      setTimeout(function(){ if (msg) msg.textContent = ''; }, 3000);
    } else {
      if (msg) { msg.textContent = '⚠' + (d?.error || '保存失败'); msg.style.color = 'var(--red)'; }
    }
  } catch(e) {
    if (msg) { msg.textContent = '⚠' + e.message; msg.style.color = 'var(--red)'; }
  }
}

async function loadModels() {
  try {
    const d = await api('/api/providers');
    const hSel = document.getElementById('headerModelSelect');
    // 修复: /api/providers 返回 providers 不是 models, 。providers 展平 models
    let models = d.models || [];
    if (models.length === 0 && d.providers) {
      models = d.providers.flatMap(p => (p.models||[]).map(m => ({id:m.id||m.name||m, provider:p.id, providerName:p.name})));
    }
    // 也尝。/api/models 作为补充
    if (models.length === 0) {
      try { const md = await api('/api/models'); if (md.models) models = md.models; } catch(e) {}
    }
    const opts = models.map(m => '<option value="'+esc(m.id)+'">' + esc(m.providerName||m.provider||'') + ' / ' + esc(m.id) + '</option>').join('');
    if (hSel) {
      hSel.innerHTML = opts || '<option value="">'+t('settings.noModel')+'</option>';
      // 修复模型名显示写死：优先恢复用户上次手动选择的模型（localStorage），
      // 其次才用服务。defaultModel，避免每。loadModels 都被重置
      const savedModel = localStorage.getItem('lingxi-selected-model');
      if (savedModel && hSel.querySelector('option[value="'+savedModel+'"]')) {
        hSel.value = savedModel;
      } else if (d.defaultModel && hSel.querySelector('option[value="'+d.defaultModel+'"]')) {
        hSel.value = d.defaultModel;
      }
    }
    document.getElementById('modelInfo').textContent = models.length === 0 ? t('settings.noModelWarn') : t('settings.modelCountAvail', { n: models.length });
    const mcEl = document.getElementById('modelCount'); if (mcEl) mcEl.textContent = models.length;
    // 同步填充路由下拉。
    const routeOpts = '<option value="">'+t('settings.sameAsCurrentModel')+'</option>' + opts;
    const toolSel = document.getElementById('toolModelSelect');
    const replySel = document.getElementById('replyModelSelect');
    if (toolSel) toolSel.innerHTML = routeOpts;
    if (replySel) replySel.innerHTML = routeOpts;
    // 选项填充完毕后，加载已保存的路由配置
    await loadModelRoute();
  } catch(e) { document.getElementById('modelInfo').textContent=t('err.loadFail') + ': ' + (e.message||t('err.networkError')); }
}
async function switchHeaderModel(mid) {
  if (!mid) return;
  // 持久化用户选择，刷。重载后仍显示用户选中的模型（修复模型名显示写死）
  try { localStorage.setItem('lingxi-selected-model', mid); } catch(e) {}
  // 检查路由是否开。
  const routeEnabled = document.getElementById('routeEnabled')?.checked;
  if (routeEnabled) {
    // 多模型模式：顶部选的是回复模。
    try { await api('/api/model-route', 'PUT', { replyModel: mid }); } catch(e) {}
    // 同步设置面板
    const replySel = document.getElementById('replyModelSelect');
    if (replySel) replySel.value = mid;
    updateRouteTag();
  } else {
    // 单模型模式：顶部选的就是唯一模型，更新所。Agent
    try { await api('/api/providers/default','PUT',{model:mid}); } catch(e) {}
    try { const d = await api('/api/agents'); const list = d.agents || [];
      for (const a of list) { try { await api('/api/agents/' + encodeURIComponent(a.id), 'PATCH', { model: mid, modelSource: 'manual' }); } catch(_){} }
    } catch(e) {}
    document.getElementById('routeModeTag').style.display = 'none';
  }
}
async function saveModelRoute() {
  const tool = document.getElementById('toolModelSelect')?.value || '';
  const reply = document.getElementById('replyModelSelect')?.value || '';
  const enabled = document.getElementById('routeEnabled')?.checked;
  try {
    await api('/api/model-route', 'PUT', { toolModel: tool, replyModel: reply, enabled: '' + enabled });
    const info = document.getElementById('routeInfo');
    if (enabled && (tool || reply)) {
      info.textContent = t('settings.routeToolReply', { tool: (tool||t('misc.default')), reply: (reply||t('misc.default')) });
      info.style.color = '#4ade80';
    } else if (enabled) {
      info.textContent = t('settings.routeEnabledDefault');
      info.style.color = '#4ade80';
    } else {
      info.textContent = t('settings.routeOffFull');
      info.style.color = '#888';
    }
    updateRouteTag();
  } catch(e) { document.getElementById('routeInfo').textContent = '⚠' + t('err.saveFail'); }
}

function updateRouteTag() {
  const routeEnabled = document.getElementById('routeEnabled')?.checked;
  const tag = document.getElementById('routeModeTag');
  if (!tag) return;
  if (routeEnabled) {
    const tool = document.getElementById('toolModelSelect')?.value;
    const reply = document.getElementById('replyModelSelect')?.value;
    // 显示简短模型名（取最后一段）
    const short = (s) => (s||'').split('/').pop() || s;
    const toolName = short(tool) || t('misc.default');
    const replyName = short(reply) || t('misc.default');
    const headerSelect = document.getElementById('headerModelSelect');
    // 同步 header 下拉框显示回复模。
    if (headerSelect && reply) {
      for (const opt of headerSelect.options) {
        if (opt.value === reply || opt.textContent?.includes(replyName)) { headerSelect.value = opt.value; break; }
      }
      // 如果 header 里没有匹配项，追加一个临。option
      if (headerSelect.value !== reply && ![...headerSelect.options].some(o => o.value === reply)) {
        const opt = new Option('💬'+replyName, reply);
        headerSelect.add(opt, 0);
        headerSelect.value = reply;
      }
    }
    // 同步设置面板里的下拉。
    const replySel = document.getElementById('replyModelSelect');
    if (replySel && reply) replySel.value = reply;
    tag.textContent = '🔧' + toolName + ' 。💬' + replyName;
    tag.style.cssText = 'display:inline;background:#4ade8022;color:#4ade80;border:1px solid #4ade8044';
  } else {
    tag.style.display = 'none';
  }
}
async function loadModelRoute() {
  try {
    const d = await api('/api/model-route');
    const toolSel = document.getElementById('toolModelSelect');
    const replySel = document.getElementById('replyModelSelect');
    const chk = document.getElementById('routeEnabled');
    if (d.toolModel) toolSel.value = d.toolModel;
    if (d.replyModel) replySel.value = d.replyModel;
    const enabled = d.enabled !== 'false' && d.enabled !== false;
    if (chk) chk.checked = enabled;
    const info = document.getElementById('routeInfo');
    if (enabled && (d.toolModel || d.replyModel)) {
      info.textContent = t('settings.routeToolReplyPlain', { tool: (d.toolModel||t('misc.default')), reply: (d.replyModel||t('misc.default')) });
      info.style.color = '#888';
    } else if (enabled) {
      info.textContent = t('settings.enabledDefault');
      info.style.color = '#888';
    } else {
      info.textContent = t('settings.routeOff');
      info.style.color = '#888';
    }
    updateRouteTag();
  } catch(e) {}
}

async function toggleModelRoute(enabled) {
  // 直接触发保存
  await saveModelRoute();
  // 刷新顶部标签
  updateRouteTag();
}

async function loadProviders() {
  try {
    const d = await api('/api/providers');
    const list = d.providers || [];
    document.getElementById('providerList').innerHTML = !list.length ? '<span style="color:var(--text3);font-size:11px">'+t('settings.noProvider')+'</span>' :
      list.map(p => {
        var keyStatus = p.hasKey ? '🟢' : (p.isLocal ? '🟢' : '🔴');
        return '<div style="padding:8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px" id="prov-' + esc(p.id) + '">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
            '<span style="font-size:12px;font-weight:600;color:var(--text)">' + keyStatus + ' ' + esc(p.name||p.id) + '</span>' +
            '<div>' +
              '<span style="font-size:10px;color:' + (p.enabled?'var(--green)':'var(--text3)') + ';margin-right:8px">' + (p.enabled?t('settings.enabled'):t('settings.disabled')) + '</span>' +
              '<button onclick="toggleEditKey(\''+esc(p.id)+'\')" title="'+t('settings.editKey')+'" style="background:none;border:1px solid var(--accent);color:var(--accent);border-radius:4px;cursor:pointer;font-size:11px;padding:2px 8px;line-height:1;margin-right:4px">🔑</button>' +
              '<button onclick="deleteProvider(\''+esc(p.id)+'\')" title="'+t('settings.deleteProviderTitle')+'" style="background:none;border:1px solid var(--red);color:var(--red);border-radius:4px;cursor:pointer;font-size:11px;padding:2px 8px;line-height:1">。/button>' +
            '</div>' +
          '</div>' +
          (p.models||[]).map(m => '<span class="model-tag" style="display:inline-flex;align-items:center;background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:3px 4px 3px 8px;border-radius:3px;font-size:11px;margin:2px">' + esc(m) + '<button onclick="removeModel(\''+esc(p.id)+'\',\''+esc(m)+'\')" title="'+t('settings.removeModel')+'" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px;line-height:1;margin-left:4px;padding:0 4px" class="model-del-btn">×</button></span>').join('') +
          '<button onclick="toggleAddModel(\''+esc(p.id)+'\')" title="添加模型" style="display:inline-flex;align-items:center;background:var(--bg2);border:1px dashed var(--accent);color:var(--accent);padding:3px 8px;border-radius:3px;font-size:11px;margin:2px;cursor:pointer">。模型</button>' +
          '<div id="addModelBox-' + esc(p.id) + '" style="display:none;margin-top:6px">' +
            '<div style="display:flex;gap:4px;align-items:center">' +
              '<input id="addModelInput-' + esc(p.id) + '" placeholder="输入模型名称，逗号分隔多个" style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px">' +
              '<button onclick="addModelToProvider(\''+esc(p.id)+'\')" class="btn" style="font-size:11px;padding:4px 10px">添加</button>' +
              '<button onclick="toggleAddModel(\''+esc(p.id)+'\')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">。/button>' +
            '</div>' +
            '<div id="addModelMsg-' + esc(p.id) + '" style="font-size:10px;margin-top:4px;min-height:14px"></div>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--text3);margin-top:4px;word-break:break-all">' + esc(p.baseUrl||'') + '</div>' +
          '<div id="editKey-' + esc(p.id) + '" style="display:none;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">' +
            '<div style="display:flex;gap:4px;align-items:center">' +
              '<input type="password" id="keyInput-' + esc(p.id) + '" placeholder="'+t('settings.newKeyPh')+'" style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px">' +
              '<button onclick="saveProviderKey(\''+esc(p.id)+'\')" class="btn" style="font-size:11px;padding:4px 10px">' + t('common.save') + '</button>' +
              '<button onclick="toggleEditKey(\''+esc(p.id)+'\')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">。/button>' +
            '</div>' +
            '<div id="keyMsg-' + esc(p.id) + '" style="font-size:10px;margin-top:4px;min-height:14px"></div>' +
          '</div>' +
        '</div>';
      }).join('');
  } catch(e) {}
}
function toggleEditKey(id) {
  var el = document.getElementById('editKey-' + id);
  if (!el) return;
  var showing = el.style.display !== 'none';
  el.style.display = showing ? 'none' : 'block';
  if (!showing) { var inp = document.getElementById('keyInput-' + id); if (inp) inp.focus(); }
}
async function saveProviderKey(id) {
  var inp = document.getElementById('keyInput-' + id);
  var msgEl = document.getElementById('keyMsg-' + id);
  if (!inp) return;
  var key = inp.value.trim();
  if (!key) { if (msgEl) { msgEl.textContent = t('settings.errKeyRequired'); msgEl.style.color = '#ef4444'; } return; }
  try {
    var d = await api('/api/providers/' + encodeURIComponent(id), 'PUT', { apiKey: key });
    if (d.ok) {
      if (msgEl) { msgEl.textContent = t('settings.keySaved'); msgEl.style.color = '#4ade80'; }
      toast(t('settings.keySaved'));
      setTimeout(function() { loadProviders(); loadModels(); }, 600);
    } else {
      if (msgEl) { msgEl.textContent = '⚠' + _errMsg(d, t('err.fail')); msgEl.style.color = '#ef4444'; }
    }
  } catch(e) {
    if (msgEl) { msgEl.textContent = '⚠' + t('err.networkError'); msgEl.style.color = '#ef4444'; }
  }
}
function toggleAddModel(id) {
  var el = document.getElementById('addModelBox-' + id);
  if (!el) return;
  var showing = el.style.display !== 'none';
  el.style.display = showing ? 'none' : 'block';
  if (!showing) { var inp = document.getElementById('addModelInput-' + id); if (inp) inp.focus(); }
}

// ── 模型管理（右侧栏"⚙️ 模型管理"区块）──
async function addModelToProviderUI() {
  const sel = document.getElementById('addModelProvider');
  const nameInput = document.getElementById('addModelName');
  if (!sel || !nameInput) { toast('模型管理表单元素缺失'); return; }
  const id = sel.value;
  const modelName = nameInput.value.trim();
  if (!id) { toast('请先选择 Provider'); return; }
  if (!modelName) { toast('请输入模型名称'); return; }
  nameInput.value = '';
  await addModelToProviderUI._add(id, modelName);
  try { refreshModelMgr(); } catch (_e) {}
}

// 复用既有 addModelToProvider(id)：它读取 addModelInput-{id} 输入框与 addModelMsg-{id} 提示框
addModelToProviderUI._add = async function(id, modelName) {
  const holder = document.createElement('div');
  holder.style.display = 'none';
  holder.innerHTML = '<input id="addModelInput-' + id + '"><div id="addModelMsg-' + id + '"></div>';
  document.body.appendChild(holder);
  document.getElementById('addModelInput-' + id).value = modelName;
  await addModelToProvider(id);
  holder.remove();
};

async function refreshModelMgr() {
  try {
    const d = await api('/api/providers');
    const list = d.providers || [];
    const sel = document.getElementById('addModelProvider');
    if (sel) {
      sel.innerHTML = list.length
        ? list.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name || p.id) + '</option>').join('')
        : '<option value="">（暂无 Provider，请先在上方添加）</option>';
    }
    const listEl = document.getElementById('modelMgrList');
    if (listEl) {
      listEl.innerHTML = list.length
        ? list.map(p => {
            const ms = (p.models || []).map(m => esc(m)).join(', ');
            return '<div style="margin-bottom:4px"><b style="color:var(--text)">' + esc(p.name || p.id) + '</b>: ' + (ms || '<span style="color:var(--text3)">（无模型）</span>') + '</div>';
          }).join('')
        : '<span style="color:var(--text3)">（暂无 Provider）</span>';
    }
    const st = document.getElementById('modelMgrStatus');
    if (st) st.textContent = 'Provider: ' + list.length + ' · 模型总数: ' + list.reduce((n, p) => n + (p.models || []).length, 0);
  } catch (e) {
    const st = document.getElementById('modelMgrStatus');
    if (st) st.textContent = '加载失败: ' + e;
  }
}

// loadProviders 刷新后同步模型管理区块（只挂一次）
(function() {
  if (window.__modelMgrHooked) return;
  window.__modelMgrHooked = true;
  const orig = loadProviders;
  loadProviders = function() {
    try { refreshModelMgr(); } catch (_e) {}
    return orig.apply(this, arguments);
  };
  const kick = function() { try { refreshModelMgr(); } catch (_e) {} };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', kick);
  } else {
    kick();
  }
})();

async function addModelToProvider(id) {
  var inp = document.getElementById('addModelInput-' + id);
  var msgEl = document.getElementById('addModelMsg-' + id);
  if (!inp) return;
  var modelsStr = inp.value.trim();
  if (!modelsStr) { if (msgEl) { msgEl.textContent = '请输入模型名'; msgEl.style.color = '#ef4444'; } return; }
  var newModels = modelsStr.split(',').map(function(x){return x.trim()}).filter(Boolean);
  if (msgEl) { msgEl.textContent = '添加。..'; msgEl.style.color = '#faad14'; }
  try {
    // 先获取当。provider 信息（拿到已。models。
    var provData = await api('/api/providers');
    var prov = (provData.providers || []).find(function(p){return p.id === id});
    var existingModels = (prov && prov.models) ? prov.models : [];
    // 合并去重
    var merged = existingModels.slice();
    newModels.forEach(function(m){ if (merged.indexOf(m) === -1) merged.push(m); });
    // PUT 更新
    var d = await api('/api/providers/' + encodeURIComponent(id), 'PUT', { models: merged });
    if (d.ok) {
      if (msgEl) { msgEl.textContent = '✅ 已添加'; msgEl.style.color = '#4ade80'; }
      toast('模型已添加');
      inp.value = '';
      setTimeout(function(){ loadProviders(); loadModels(); }, 500);
    } else {
      if (msgEl) { msgEl.textContent = '⚠' + _errMsg(d, '添加失败'); msgEl.style.color = '#ef4444'; }
    }
  } catch(e) {
    if (msgEl) { msgEl.textContent = '⚠' + t('err.networkError'); msgEl.style.color = '#ef4444'; }
  }
}

async function deleteProvider(id) {
  if (!confirm(t('settings.confirmDeleteProvider', { id: id }))) return;
  try {
    const d = await api('/api/providers/' + encodeURIComponent(id), 'DELETE');
    if (d.ok) { toast(t('toast.deleted')); loadProviders(); loadModels(); }
    else { toast(t('err.deleteFail')); }
  } catch(e) { toast(t('err.deleteFail')); }
}
async function removeModel(providerId, modelName) {
  if (!confirm(t('settings.confirmRemoveModel', { model: modelName }))) return;
  try {
    const d = await api('/api/providers/' + encodeURIComponent(providerId) + '/models/' + encodeURIComponent(modelName), 'DELETE');
    if (d.ok) { toast(t('settings.modelRemoved')); loadProviders(); loadModels(); }
    else { toast('⚠' + _errMsg(d, t('err.fail'))); }
  } catch(e) { toast(t('err.deleteFail')); }
}
async function addProvider() {
  var selectType = document.getElementById('newProviderType').value;
  const type = selectType === '__custom_type__' ? (document.getElementById('newProviderCustomType').value.trim() || 'custom') : selectType;
  const apiKey = document.getElementById('newProviderKey').value.trim();
  const baseUrl = document.getElementById('newProviderUrl').value.trim();
  const modelsStr = document.getElementById('newProviderModels').value.trim();
  const _msgEl = document.getElementById('addProviderMsg');
  const setMsg = (txt, color) => { if (_msgEl) { _msgEl.textContent = txt; _msgEl.style.color = color; } else toast(txt); };
  const isLocalType = ['ollama','custom','llama-cpp','vllm','lm-studio','tgi','text-gen-webui','__custom_type__'].includes(type) || selectType === '__custom_type__';
  if (!apiKey && !isLocalType) { setMsg(t('settings.errKeyRequired'), '#ef4444'); return; }
  if (!modelsStr) { setMsg(t('settings.errModelRequired'), '#ef4444'); return; }
  const name = document.getElementById('newProviderName').value.trim() || type;
  const id = type + '-' + Date.now();
  const models = modelsStr.split(',').map(s=>s.trim()).filter(Boolean);
  const urls = { openai:'https://api.openai.com/v1', anthropic:'https://api.anthropic.com/v1', google:'https://generativelanguage.googleapis.com/v1beta/openai', deepseek:'https://api.deepseek.com/v1', openrouter:'https://openrouter.ai/api/v1' };
  try {
    const d = await api('/api/providers', 'POST', { id, type, name, apiKey, baseUrl: baseUrl||urls[type]||'', models, isLocal: false });
    if (d.ok) { setMsg(t('settings.addSuccess'), '#4ade80'); loadProviders(); loadModels(); document.getElementById('newProviderKey').value=''; document.getElementById('newProviderModels').value=''; }
    else { setMsg('⚠'+_errMsg(d, t('err.fail')), '#ef4444'); }
  } catch(e) { setMsg('⚠' + t('err.networkError'), '#ef4444'); }
}

const PROVIDER_PRESETS = {
  deepseek: {name:'DeepSeek',url:'https://api.deepseek.com/v1',models:'deepseek-v4-pro,deepseek-v4-flash,deepseek-chat,deepseek-reasoner',keyHint:'sk-xxx'},
  zhipu: {name:'智谱GLM',url:'https://open.bigmodel.cn/api/paas/v4',models:'glm-5.2,glm-5.1,glm-5-turbo,glm-4.7,glm-4.7-flash',keyHint:'智谱API Key',nk:'provider.zhipu',hk:'provider.keyZhipu'},
  moonshot: {name:'Kimi',url:'https://api.moonshot.ai/v1',models:'kimi-latest,kimi-k2.6,kimi-k2.7-code,moonshot-v1-128k',keyHint:'Kimi API Key'},
  nvidia: {name:'NVIDIA NIM',url:'https://integrate.api.nvidia.com/v1',models:'minimaxai/minimax-m3,z-ai/glm-5.2,stepfun-ai/step-3.7-flash,qwen/qwen3-next-80b-a3b-instruct,deepseek-ai/deepseek-v4-flash',keyHint:'__hintFree__'},
  minimax: {name:'MiniMax',url:'https://api.minimax.io/v1',models:'MiniMax-M3,abab6.5-chat',keyHint:'MiniMax Key'},
  qwen: {name:'通义千问',url:'https://dashscope.aliyuncs.com/compatible-mode/v1',models:'qwen3.7-max,qwen3.7-plus,qwen3.6-flash,qwen-max',keyHint:'DashScope Key',nk:'provider.qwen'},
  baidu: {name:'百度文心',url:'https://qianfan.baidubce.com/v2',models:'ernie-4.0-turbo,ernie-3.5-turbo',keyHint:'千帆API Key',nk:'provider.baidu',hk:'provider.keyBaidu'},
  yi: {name:'零一万物',url:'https://api.lingyiwanwu.com/v1',models:'yi-large,yi-medium,yi-lightning',keyHint:'Yi API Key',nk:'provider.yi'},
  baichuan: {name:'百川',url:'https://api.baichuan-ai.com/v1',models:'Baichuan4,Baichuan3-Turbo',keyHint:'百川API Key',nk:'provider.baichuan',hk:'provider.keyBaichuan'},
  stepfun: {name:'阶跃星辰',url:'https://api.stepfun.com/v1',models:'step-3-8k,step-3.7-flash',keyHint:'StepFun Key',nk:'provider.stepfun'},
  siliconflow: {name:'硅基流动',url:'https://api.siliconflow.cn/v1',models:'Qwen/Qwen3-235B-A22B,deepseek-ai/deepseek-v4-flash',keyHint:'硅基流动Key',nk:'provider.siliconflow',hk:'provider.keySiliconflow'},
  iflytek: {name:'讯飞星火',url:'https://spark-api-open.xf-yun.com/v1',models:'spark-v4.0,spark-v3.5',keyHint:'讯飞API Key',nk:'provider.iflytek',hk:'provider.keyIflytek'},
  volcengine: {name:'火山引擎',url:'https://ark.cn-beijing.volces.com/api/v3',models:'doubao-pro-128k,doubao-pro-32k',keyHint:'火山引擎Key',nk:'provider.volcengine',hk:'provider.keyVolc'},
  tencent: {name:'腾讯混元',url:'https://api.hunyuan.cloud.tencent.com/v1',models:'hunyuan-turbo,hunyuan-standard',keyHint:'腾讯云Key',nk:'provider.tencent',hk:'provider.keyTencent'},
  openai: {name:'OpenAI',url:'https://api.openai.com/v1',models:'gpt-5.6-luna-pro,gpt-4o,gpt-4o-mini',keyHint:'sk-xxx'},
  anthropic: {name:'Claude',url:'https://api.anthropic.com/v1',models:'claude-sonnet-5,claude-sonnet-4,claude-opus-4',keyHint:'sk-ant-xxx'},
  google: {name:'Gemini',url:'https://generativelanguage.googleapis.com/v1beta/openai',models:'gemini-3-pro-image,gemini-2.0-flash',keyHint:'Google AI Key'},
  groq: {name:'Groq',url:'https://api.groq.com/openai/v1',models:'llama-3.3-70b-versatile',keyHint:'gsk_xxx'},
  mistral: {name:'Mistral',url:'https://api.mistral.ai/v1',models:'mistral-large-latest,mistral-small,codestral-latest',keyHint:'Mistral Key'},
  xai: {name:'Grok',url:'https://api.x.ai/v1',models:'grok-4.5,grok-3,grok-3-mini',keyHint:'xai-xxx'},
  openrouter: {name:'OpenRouter',url:'https://openrouter.ai/api/v1',models:'z-ai/glm-5.2,openai/gpt-5.6-luna-pro,anthropic/claude-sonnet-5',keyHint:'sk-or-xxx'},
  together: {name:'Together AI',url:'https://api.together.xyz/v1',models:'meta-llama/Llama-3.3-70B-Instruct-Turbo',keyHint:'API Key'},
  fireworks: {name:'Fireworks',url:'https://api.fireworks.ai/inference/v1',models:'accounts/fireworks/models/llama-v3p3-70b-instruct',keyHint:'API Key'},
  perplexity: {name:'Perplexity',url:'https://api.perplexity.ai',models:'llama-3.1-sonar-large-128k-online',keyHint:'pplx-xxx'},
  ollama: {name:'Ollama',url:'http://localhost:11434/v1',models:'',keyHint:'__hintLocal__'},
  'llama-cpp': {name:'llama.cpp',url:'http://localhost:8080/v1',models:'',keyHint:'__hintLocal__'},
  vllm: {name:'vLLM',url:'http://localhost:8000/v1',models:'',keyHint:'__hintLocal__'},
  'lm-studio': {name:'LM Studio',url:'http://localhost:1234/v1',models:'',keyHint:'__hintLocal__'},
  custom: {name:'__custom__',url:'',models:'',keyHint:'API Key'},
};
function onProviderTypeChange() {
  var type = document.getElementById('newProviderType').value;
  // 显示/隐藏自定义类型输入框
  var customTypeInput = document.getElementById('newProviderCustomType');
  if (customTypeInput) {
    customTypeInput.style.display = (type === '__custom_type__') ? 'block' : 'none';
  }
  if (type === '__custom_type__') {
    // 完全自定义：清空预设，让用户手动填写所有字。
    document.getElementById('newProviderName').value = '';
    document.getElementById('newProviderUrl').value = '';
    document.getElementById('newProviderModels').value = '';
    document.getElementById('newProviderKey').placeholder = 'API Key（本地可留空）';
    if (customTypeInput) customTypeInput.focus();
    return;
  }
  var p = PROVIDER_PRESETS[type];
  if (!p) return;
  var presetName = p.name === '__custom__' ? t('misc.custom') : (p.nk ? t(p.nk) : p.name);
  var hint = p.keyHint === '__hintFree__' ? t('misc.keyHintFree') : (p.keyHint === '__hintLocal__' ? t('misc.keyHintLocal') : (p.hk ? t(p.hk) : p.keyHint));
  document.getElementById('newProviderName').value = presetName;
  document.getElementById('newProviderUrl').value = p.url;
  document.getElementById('newProviderModels').value = p.models;
  document.getElementById('newProviderKey').placeholder = hint;
}

async function connectOllama() {
  const url = document.getElementById('ollamaUrl').value.trim();
  const sEl = document.getElementById('ollamaStatus');
  const mEl = document.getElementById('ollamaModels');
  sEl.textContent=t('settings.connecting'); sEl.style.color='#faad14';
  try {
    const baseUrl = url.replace(/\/v1$/,'');
    const ctrl = new AbortController(); const timeout = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(baseUrl + '/api/tags', { signal: ctrl.signal }); clearTimeout(timeout);
    const d = await r.json();
    const models = (d.models||[]).map(m=>m.name||m.id);
    if (!models.length) { sEl.textContent=t('status.connectedNoModel'); sEl.style.color='#faad14'; return; }
    sEl.textContent=t('settings.modelCount', { n: models.length }); sEl.style.color='#4ade80';
    mEl.innerHTML = models.map(m => '<span class="tag" onclick="document.getElementById(\'headerModelSelect\').value=\''+esc(m)+'\';switchHeaderModel(\''+esc(m)+'\')">' + esc(m) + '</span>').join(' ');
    api('/api/providers','POST',{id:'local-ollama',type:'ollama',name:t('settings.ollamaLocal'),apiKey:'ollama',baseUrl:baseUrl+'/v1',models:models,isLocal:true,enabled:true});
    loadModels();
  } catch(e) { sEl.textContent='⚠' + e.message; sEl.style.color='#ef4444'; }
}

async function pullOllamaCloud(modelId) {
  var sEl = document.getElementById('ollamaStatus') || document.getElementById('localStatus');
  if (!sEl) sEl = document.getElementById('ollamaStatus');
  if (sEl) { sEl.textContent=t('settings.addingModel', { id: modelId }); sEl.style.color='#faad14'; }
  try {
    await fetch('http://localhost:11434/api/pull', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: modelId, stream: false}), signal: AbortSignal.timeout(30000),
    });
    await api('/api/providers','POST',{id:'ollama-cloud',type:'ollama',name:'Ollama Cloud',apiKey:'ollama',baseUrl:'http://localhost:11434/v1',models:[modelId],isLocal:false});
    await api('/api/providers/default','PUT',{model:modelId});
    document.getElementById('headerModelSelect').value = modelId;
    if (sEl) { sEl.textContent=t('settings.modelReady', { id: modelId }); sEl.style.color='#4ade80'; }
    toast(t('settings.modelAdded', { id: modelId }));
    loadModels();
  } catch(e) { if (sEl) { sEl.textContent='⚠' + e.message; sEl.style.color='#ef4444'; } toast('⚠' + e.message); }
}


// ── v1.3 补全：审。提示。视觉/TTS ──

async function loadApprovals() {
  try {
    const d = await api('/api/approval/pending');
    const items = d.pending || [];
    let html = '';
    if (!items.length) { html = '<span style="color:#555">'+t('admin.noApprovals')+'</span>'; }
    else {
      for (const item of items) {
        const risk = item.risk || 'low';
        const color = risk === 'high' ? '#ef4444' : risk === 'medium' ? '#faad14' : '#4ade80';
        html += '<div style="margin-bottom:4px;padding:4px;border-left:3px solid ' + color + '">' +
          '<div style="font-size:11px">' + esc(item.action || item.type || t('admin.approval')) + ': ' + esc(item.summary || item.description || '') + '</div>' +
          '<button onclick="respondApproval(\''+esc(item.id)+'\',\'accept\')" style="font-size:10px;padding:2px 6px;background:#2a4a2a;border:1px solid #4ade80;color:#4ade80;border-radius:3px;cursor:pointer;margin-top:2px">'+t('admin.approve')+'</button> ' +
          '<button onclick="respondApproval(\''+esc(item.id)+'\',\'reject\')" style="font-size:10px;padding:2px 6px;background:#4a2a2a;border:1px solid #ef4444;color:#ef4444;border-radius:3px;cursor:pointer;margin-top:2px">'+t('admin.reject')+'</button>' +
          '</div>';
      }
    }
    document.getElementById('approvalList').innerHTML = html;
  } catch(e) { document.getElementById('approvalList').innerHTML = '<span style="color:#f44">'+t('err.loadFail')+'</span>'; }
}
async function respondApproval(id, action) {
  try {
    await api('/api/approval/' + encodeURIComponent(id), 'POST', { action });
    toast(action === 'accept' ? t('admin.approved') : t('admin.rejected'));
    loadApprovals();
  } catch(e) { toast('⚠' + t('err.operationFail')); }
}

async function loadPromptAgentSelect() {
  try {
    const d = await api('/api/agents');
    const agents = d.agents || [];
    const sel = document.getElementById('promptAgentSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">'+t('admin.selectAgent')+'</option>' +
      agents.map(a => '<option value="'+esc(a.id)+'">'+esc(a.displayName || a.id)+'</option>').join('');
  } catch(e) {}
}
async function loadAgentPrompt() {
  const agentId = document.getElementById('promptAgentSelect').value;
  if (!agentId) return;
  try {
    const d = await api('/api/agents/' + agentId + '/memory');
    document.getElementById('promptEditArea').value = d.personality || d.memory_summary || '';
  } catch(e) { toast('⚠' + t('err.loadFail')); }
}
async function saveAgentPrompt() {
  const agentId = document.getElementById('promptAgentSelect').value;
  const prompt = document.getElementById('promptEditArea').value;
  if (!agentId) { toast(t('admin.selectAgentFirst')); return; }
  try {
    await api('/api/agents/' + agentId + '/memory', 'PUT', { personality: prompt });
    toast(t('admin.promptSaved'));
  } catch(e) { toast('⚠' + t('err.saveFail') + ': ' + e.message); }
}

async function uploadVision(event) {
  const file = event.target.files[0];
  if (!file) return;
  document.getElementById('visionResult').textContent = t('admin.analyzing');
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('prompt', t('admin.visionPrompt'));
    var visToken = localStorage.getItem('authToken');
    var visHeaders = {};
    if (visToken) visHeaders['Authorization'] = 'Bearer ' + visToken;
    const r = await fetch('/api/vision/analyze', { method: 'POST', headers: visHeaders, body: fd });
    const d = await r.json();
    if (d.ok && d.result) {
      document.getElementById('visionResult').textContent = d.result;
    } else {
      document.getElementById('visionResult').textContent = '⚠' + _errMsg(d, t('admin.analyzeFail'));
    }
  } catch(e) { document.getElementById('visionResult').textContent = '⚠' + e.message; }
}

async function loadVoiceStatus() {
  try {
    const d = await api('/api/voice/status');
    const el = document.getElementById('voiceStatus');
    if (!el) return;
    const tts = d.tts || {};
    el.textContent = 'TTS: ' + (tts.available ? t('admin.ttsAvailable') : t('admin.ttsNotConfigured')) + ' | STT: ' + (d.stt?.available ? '✅' : '❌');
  } catch(e) {}
}
async function testTTS() {
  const voice = document.getElementById('ttsVoiceSelect').value;
  try {
    const r = await api('/api/voice/tts', 'POST', { text: t('admin.ttsTestText'), voice });
    if (r.ok && r.audio) {
      const audio = new Audio('data:audio/mp3;base64,' + r.audio);
      audio.play();
      toast(t('admin.playing'));
    } else {
      toast(t('admin.ttsUnavailable', {msg: r.error || ''}));
    }
  } catch(e) { toast(t('admin.ttsFail', {msg: e.message})); }
}


// ── 注册/登录 ──
let authToken = null;
const PLATFORM_URL = window.LINGXI_PLATFORM_URL || '';  // v2.0.12: 接回云平台，恢复中心化账号体系。如需纯本地模式，改为 ''

// 通用 API：本地（不带平台 token，本地引擎 JWT 与平台不一致）
async function api(url, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) {
    let d = null; try { d = await r.json(); } catch (e) {}
    console.warn('[api]', method || 'GET', url, r.status, d && d.error ? (d.error.code || d.error.message || d.error) : '');
    return d || { ok: false, error: { code: 'HTTP_' + r.status, message: r.statusText } };
  }
  return r.json();
}
// 云平。API：注。登录/市场
async function platformApi(url, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(PLATFORM_URL + url, opts); return r.json();
}
function esc(s) { if (s == null) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML.replace(/'/g, '&#39;'); }
// v1.9.8: 安全提取错误消息——API 可能返回 {error: {code, message}} 对象而非字符。
function _errMsg(d, fallback) { if (!d) return fallback || ''; var e = d.error; if (!e) return fallback || ''; if (typeof e === 'string') return e; if (typeof e === 'object') return e.message || e.msg || e.code || JSON.stringify(e); return String(e); }
let authMode = 'login';

function showLoginModal() {
  authMode = 'login';
  document.getElementById('authTitle').textContent = t('auth.login');
  document.getElementById('authEmailRow').style.display = 'none';
  document.getElementById('authInviteRow').classList.add('hidden');
  document.getElementById('authSubmitBtn').textContent = t('auth.login');
  document.getElementById('authMsg').innerHTML = '<a href="#" onclick="showForgotPassword()" style="color:#4a9eff;font-size:11px">' + t('auth.forgot') + '</a>';
  document.getElementById('authOverlay').style.display = 'block';
  document.getElementById('authModal').style.display = 'block';
  document.getElementById('authUsername').placeholder = t('auth.loginUserPh');
  const swT = document.getElementById('authSwitchText'); if (swT) swT.textContent = t('auth.noAccount');
  const swL = document.getElementById('authSwitchLink'); if (swL) swL.textContent = t('auth.register');
}
function showRegisterModal() {
  authMode = 'register';
  document.getElementById('authTitle').textContent = t('auth.register');
  document.getElementById('authEmailRow').style.display = '';
  document.getElementById('authInviteRow').classList.remove('hidden');
  document.getElementById('authSubmitBtn').textContent = t('auth.register');
  document.getElementById('authMsg').textContent = '';
  document.getElementById('authOverlay').style.display = 'block';
  document.getElementById('authModal').style.display = 'block';
  document.getElementById('authUsername').placeholder = t('auth.regUserPh');
  const swT = document.getElementById('authSwitchText'); if (swT) swT.textContent = t('auth.hasAccount');
  const swL = document.getElementById('authSwitchLink'); if (swL) swL.textContent = t('auth.loginLink');
}
function switchAuthMode() {
  if (authMode === 'login') showRegisterModal(); else showLoginModal();
}
function closeAuthModal() {
  document.getElementById('authOverlay').style.display = 'none';
  document.getElementById('authModal').style.display = 'none';
}
async function submitAuth() {
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  if (!username) { document.getElementById('authMsg').textContent = t('auth.errNoUser'); return; }
  if (username.length < 2 || username.length > 20) { document.getElementById('authMsg').textContent = t('auth.errUserLen'); return; }
  if (!password || password.length < 6) { document.getElementById('authMsg').textContent = t('auth.errPwdLen'); return; }
  document.getElementById('authMsg').textContent = t('auth.processing');
  document.getElementById('authSubmitBtn').disabled = true;
  try {
    let r;
    if (authMode === 'register') {
      const email = document.getElementById('authEmail').value.trim();
      const invite = document.getElementById('authInviteCode').value.trim();
      const payload = { display_name: username, password, email, invite_code: invite, agent_binding: 'auto_default' };
      try { r = await platformApi('/api/auth/register', 'POST', payload); }
      catch (pe) { r = await api('/api/auth/register', 'POST', payload); } // 云平台不可达时回退本地引擎
    } else {
      const loginPayload = { email: username, password };
      try { r = await platformApi('/api/auth/login', 'POST', loginPayload); if (!r.token && !r.accessToken) throw new Error('platform miss'); }
      catch (pe) { r = await api('/api/auth/login', 'POST', loginPayload); }
    }
    const tk = r.token || r.accessToken;
    if (tk) {
      authToken = tk;
      localStorage.setItem('authToken', authToken);
      const user = r.user || {};
      // v2.3.1: 保存用户ID/昵称，供市场发布/我的发布/独立市场页使用
      const _uid = String(user.id || user.sub || user.userId || '');
      if (_uid) localStorage.setItem('userId', _uid);
      const _dn = user.username || user.display_name || user.displayName || username;
      if (_dn) localStorage.setItem('displayName', _dn);
      _applyAuthedUser(user);
      document.getElementById('userInfoName').textContent = '👤 ' + (user.username || user.display_name || user.displayName || username);
      document.getElementById('userInfo').style.display = 'flex';
      document.getElementById('loginArea').style.display = 'none';
      document.getElementById('loginArea').style.display = '';
      document.getElementById('loginButtons').style.display = 'none';
      closeAuthModal();
      connect();
      toast('⚠' + (authMode === 'register' ? t('auth.registerSuccess') : t('auth.loginSuccess')));
    } else {
      document.getElementById('authMsg').textContent = '⚠' + (r.error || t('err.fail'));
    }
  } catch(e) {
    document.getElementById('authMsg').textContent = '⚠' + e.message;
  }
  document.getElementById('authSubmitBtn').disabled = false;
}
async function logout() {
  try { await api('/api/auth/logout', 'POST'); } catch {}
  try { await platformApi('/api/auth/logout', 'POST'); } catch {}
  authToken = null;
  localStorage.removeItem('authToken');
  localStorage.removeItem('userId');
  localStorage.removeItem('displayName');
  document.getElementById('loginArea').style.display = 'none';
  document.getElementById('loginButtons').style.display = '';
  if (ws) try { ws.close(); } catch {}
  toast(t('auth.loggedOut'));
}
// v2.3.1: 登录态应用（平台/本地两种 user 结构兼容）
function _applyAuthedUser(u) {
  if (!u) return;
  if (u.id || u.sub) localStorage.setItem('userId', String(u.id || u.sub));
  const dn = u.display_name || u.displayName || u.username || (u.numeric_id ? t('profile.defaultUser') + u.numeric_id : t('profile.defaultUser'));
  if (dn) localStorage.setItem('displayName', dn);
  document.getElementById('userInfoName').textContent = '👤 ' + dn;
  document.getElementById('userInfo').style.display = 'flex';
  document.getElementById('loginArea').style.display = 'none';
  document.getElementById('loginArea').style.display = '';
  document.getElementById('loginButtons').style.display = 'none';
  connect();
}

function checkAuthStatus() {
  const saved = localStorage.getItem('authToken');
  if (saved) {
    authToken = saved;
    // v2.3.1: 平台 token 先在平台验证（本地引擎 JWT 与平台不一致，避免误判未登录）
    fetch(PLATFORM_URL + '/api/user/me', { headers: { 'Authorization': 'Bearer ' + saved } })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.user) { _applyAuthedUser(d.user); }
        else {
          // 平台验不过 → 回退本地
          fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + saved } })
            .then(r2 => r2.json())
            .then(d2 => {
              if (d2.ok && d2.user) _applyAuthedUser(d2.user);
              else { authToken = null; localStorage.removeItem('authToken'); connect(); }
            })
            .catch(() => connect());
        }
      })
      .catch(() => {
        fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + saved } })
          .then(r2 => r2.json())
          .then(d2 => { if (d2.ok && d2.user) _applyAuthedUser(d2.user); else connect(); })
          .catch(() => connect());
      });
  } else {
    // 未登录（游客）直接连，避免 F5 刷新后 WebSocket 不连
    connect();
  }
}


// ── 左侧栏个人信息卡。──
async function getCurrentUserId() {
  var token = localStorage.getItem('authToken');
  if (!token) return clientId || '';
  try {
    var r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
    var d = await r.json();
    if (d && d.ok && d.user) return d.user.id || d.user.sub || '';
  } catch(e) {}
  return clientId || '';
}
async function loadProfileCard() {
  try {
    var token = localStorage.getItem('authToken');
    var u = null;
    if (token) {
      try {
        var r = await fetch(PLATFORM_URL + '/api/user/me', { headers: { 'Authorization': 'Bearer ' + token } });
        var d = await r.json();
        if (d && d.ok && d.user) u = d.user;
      } catch(e) {}
      if (!u) {
        try {
          var r2 = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
          var d2 = await r2.json();
          if (d2 && d2.ok && d2.user) u = d2.user;
        } catch(e) {}
      }
    }
    if (!u && clientId) {
      u = { id: clientId, display_name: t('profile.defaultUser') };
    }
    if (!u) return;
    var userId = u.id || u.sub || '';
    var name = u.display_name || u.displayName || u.username || (u.numeric_id ? t('profile.defaultUser') + u.numeric_id : t('profile.defaultUser'));
    var idShow = u.numeric_id || u.numericId || u.id || '';
    var avatarUrl = u.avatar_url || u.avatarUrl || '';
    var bio = u.bio || '';
    var credits = u.credits || u.points || 0;
    var rating = t('common.none');
    var tokens = 0;
    var calls = 0;
    var email = u.email || '';
    var createdAt = u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '-';
    try {
      var pr = await api('/api/profile?userId=' + encodeURIComponent(userId));
      if (pr && pr.ok && pr.profile) {
        var p = pr.profile;
        // 过滤本地默认名称。用户+nid"模式），避免覆盖真实姓名
        if (p.display_name && !/^用户\d+$/.test(p.display_name)) name = p.display_name;
        idShow = p.numeric_id || p.id || idShow;
        avatarUrl = p.avatar_url || avatarUrl;
        bio = p.bio || bio;
        email = p.email || email;
        createdAt = p.created_at ? new Date(p.created_at).toLocaleString('zh-CN') : createdAt;
        credits = pr.credits || 0;
        if (pr.ratings && pr.ratings.avgRating) rating = t('profile.starUnit', {n: Number(pr.ratings.avgRating).toFixed(1)});
        if (pr.ratings && pr.ratings.count) rating += t('profile.ratingCount', {n: pr.ratings.count});
        if (pr.usage) { tokens = pr.usage.totalTokens || 0; calls = pr.usage.calls || 0; }
      }
    } catch(e) {}
    var el;
    el = document.getElementById('pcAvatar'); if (el) { if (avatarUrl) { el.style.backgroundImage = 'url(' + esc(avatarUrl) + ')'; el.style.backgroundSize = 'cover'; } el.textContent = avatarUrl ? '' : esc((name[0]||'U').toUpperCase()); }
    el = document.getElementById('pcName'); if (el) el.textContent = name;
    el = document.getElementById('pcId'); if (el) el.textContent = 'ID: ' + esc(String(idShow));
    el = document.getElementById('pcCredits'); if (el) el.textContent = t('profile.creditsVal', {n: Number(credits).toLocaleString()});
    el = document.getElementById('pdName'); if (el) el.textContent = name;
    el = document.getElementById('pdId'); if (el) el.textContent = esc(String(idShow));
    el = document.getElementById('pdEmail'); if (el) el.textContent = esc(email || t('profile.notSet'));
    // v2.4.0: 钱包余额（USD/CNY）
    try {
      var wr = await api('/api/wallet?userId=' + encodeURIComponent(userId));
      if (wr && wr.ok) {
        var wu = Number(wr.balanceUsd) || 0, wc = Number(wr.balanceCny) || 0;
        var pw = document.getElementById('pdWallet'); if (pw) pw.textContent = '$' + wu.toFixed(2) + ' / ¥' + wc.toFixed(2);
        var pw2 = document.getElementById('pcWallet'); if (pw2) pw2.textContent = '$' + wu.toFixed(2) + ' / ¥' + wc.toFixed(2);
      }
    } catch(_we) {}
    el = document.getElementById('pdCredits'); if (el) el.textContent = '⚠' + Number(credits).toLocaleString();
    el = document.getElementById('pdRating'); if (el) el.textContent = rating;
    el = document.getElementById('pdUsage'); if (el) el.textContent = t('profile.usageLine', {tokens: Number(tokens).toLocaleString(), calls: Number(calls).toLocaleString()});
    el = document.getElementById('pdBio'); if (el) el.textContent = bio ? t('profile.bioPrefix') + esc(bio) : t('profile.noBio');
  } catch(e) { console.error('[loadProfileCard]', e); }
}


// ── 钱包：模拟充值（测试模式，未接真实支付）──
// v2.4.0: 钱包充值（模拟，未接真实支付）
function openRechargeModal() {
  var ov = document.getElementById('rechargeOverlay');
  var m = document.getElementById('rechargeModal');
  if (ov) ov.style.display = 'block';
  if (m) m.style.display = 'block';
}
function closeRechargeModal() {
  var ov = document.getElementById('rechargeOverlay');
  var m = document.getElementById('rechargeModal');
  if (ov) ov.style.display = 'none';
  if (m) m.style.display = 'none';
}
async function doRechargeModal() {
  var currency = document.getElementById('rcCurrency') ? document.getElementById('rcCurrency').value : 'usd';
  var amount = parseFloat(document.getElementById('rcAmount') ? document.getElementById('rcAmount').value : '0');
  if (!(amount > 0)) { toast('请输入有效金额'); return; }
  var uid = await getCurrentUserId();
  if (!uid) { toast('请先登录'); return; }
  try {
    var d = await api('/api/wallet/recharge', 'POST', { userId: uid, currency: currency, amount: amount });
    if (d && d.ok) {
      toast((currency === 'usd' ? '$' : '¥') + amount + ' 充值成功（模拟，未产生真实扣款）');
      closeRechargeModal();
      loadProfileCard().catch(function(){});
    } else {
      toast('充值失败：' + ((d && d.error) || '未知错误'));
    }
  } catch(e) { toast('充值失败：' + e.message); }
}

async function addWalletCredits() {
  // v2.4.2 修复：左侧栏快捷充值改走钱包接口（原为积分接口，钱充错口袋）
  openRechargeModal();
}

// ── 编辑资料 ──
async function editProfile() {
  var token = localStorage.getItem('authToken');
  if (!token) { toast(t('auth.loginFirst')); return; }
  // 获取当前用户 ID
  var userId = await getCurrentUserId();
  if (!userId) { toast(t('profile.noUserInfo')); return; }
  // 获取当前资料
  var curName = '', curBio = '';
  try {
    var pr = await api('/api/profile?userId=' + encodeURIComponent(userId));
    if (pr && pr.ok && pr.profile) {
      curName = pr.profile.display_name || '';
      curBio = pr.profile.bio || '';
    }
  } catch(e) {}
  // 弹出编辑。
  var newName = prompt(t('profile.enterNewName'), curName);
  if (newName === null) return;
  var newBio = prompt(t('profile.enterBio'), curBio);
  if (newBio === null) return;
  try {
    var r = await api('/api/profile', 'PUT', { userId: userId, displayName: newName, bio: newBio });
    if (r && r.ok) {
      toast(t('profile.updated'));
      loadProfileCard();
    } else {
      toast('⚠' + t('err.updateFail') + ': ' + (r?.error || t('err.unknown')));
    }
  } catch(e) { toast('⚠' + t('err.updateFail') + ': ' + e.message); }
}

// ── 上传头像 ──
function uploadAvatar() {
  var token = localStorage.getItem('authToken');
  if (!token) { toast(t('auth.loginFirst')); return; }
  var input = document.getElementById('avatarFileInput');
  if (input) input.click();
}
async function doUploadAvatar(input) {
  var file = input.files[0];
  if (!file) return;
  input.value = ''; // 重置以便下次可选同一文件
  var userId = await getCurrentUserId();
  if (!userId) { toast(t('profile.noUserInfo')); return; }
  // 校验文件类型
  if (!/^image\//.test(file.type)) { toast(t('profile.pickImage')); return; }
  if (file.size > 5 * 1024 * 1024) { toast(t('profile.imageTooLarge')); return; }
  var fd = new FormData();
  fd.append('file', file);
  fd.append('userId', userId);
  try {
    toast(t('common.uploading'));
    var token = localStorage.getItem('authToken');
    var res = await fetch('/api/profile/avatar', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    var data = await res.json();
    if (data && data.ok) {
      toast(t('profile.avatarOk'));
      loadProfileCard();
    } else {
      toast('⚠' + t('err.uploadFail') + ': ' + (data?.error || t('err.unknown')));
    }
  } catch(e) { toast('⚠' + t('err.uploadFail') + ': ' + e.message); }
}

// ── 积分明细 ──
async function showCreditsDetail() {
  var token = localStorage.getItem('authToken');
  if (!token) { toast(t('auth.loginFirst')); return; }
  var userId = await getCurrentUserId();
  if (!userId) { toast(t('profile.noUserInfo')); return; }
  // 获取积分余额
  var credits = 0, totalEarned = 0, totalSpent = 0;
  try {
    var pr = await api('/api/profile?userId=' + encodeURIComponent(userId));
    if (pr && pr.ok) {
      credits = pr.credits || 0;
      totalEarned = pr.totalEarned || 0;
      totalSpent = pr.totalSpent || 0;
    }
  } catch(e) {}
  // 获取积分历史
  var history = [];
  try {
    var hr = await api('/api/credits/history?userId=' + encodeURIComponent(userId));
    if (hr && hr.ok && hr.history) history = hr.history;
  } catch(e) {}
  // 构建弹窗内容
  var html = '<div style="margin-bottom:12px">';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:14px">';
  html += '<div style="text-align:center;background:var(--bg3);border-radius:8px;padding:10px"><div style="font-size:18px;font-weight:700;color:var(--accent)">' + Number(credits).toLocaleString() + '</div><div style="font-size:10px;color:var(--text3)">' + t('profile.creditsNow') + '</div></div>';
  html += '<div style="text-align:center;background:var(--bg3);border-radius:8px;padding:10px"><div style="font-size:18px;font-weight:700;color:#4ade80">' + Number(totalEarned).toLocaleString() + '</div><div style="font-size:10px;color:var(--text3)">' + t('profile.creditsEarned') + '</div></div>';
  html += '<div style="text-align:center;background:var(--bg3);border-radius:8px;padding:10px"><div style="font-size:18px;font-weight:700;color:#f59e0b">' + Number(totalSpent).toLocaleString() + '</div><div style="font-size:10px;color:var(--text3)">' + t('profile.creditsSpent') + '</div></div>';
  html += '</div>';
  if (history.length > 0) {
    html += '<div style="font-size:13px;color:var(--text2);margin-bottom:8px">' + t('profile.creditsHistory') + '</div>';
    html += '<div style="max-height:300px;overflow-y:auto">';
    for (var i = 0; i < history.length; i++) {
      var h = history[i];
      var isEarn = h.amount > 0;
      var time = h.created_at ? new Date(h.created_at).toLocaleString('zh-CN') : '';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid var(--border)">';
      html += '<div><span style="color:' + (isEarn ? '#4ade80' : '#f59e0b') + ';font-weight:600">' + (isEarn ? '+' : '') + h.amount + '</span> <span style="font-size:11px;color:var(--text3);margin-left:6px">' + esc(h.reason || '') + '</span></div>';
      html += '<div style="font-size:10px;color:var(--text3)">' + esc(time) + '</div>';
      html += '</div>';
    }
    html += '</div>';
  } else {
    html += '<div style="text-align:center;color:var(--text3);padding:20px 0">' + t('profile.noCreditsHistory') + '</div>';
  }
  html += '</div>';
  // 用已有的 profileModal 显示
  var box = document.getElementById('profileContent');
  if (box) {
    document.getElementById('profileOverlay').style.display = 'block';
    document.getElementById('profileModal').style.display = 'block';
    box.innerHTML = html;
  }
}

// ── 个人中心弹窗 ──
function showProfileModal() {
  document.getElementById('profileOverlay').style.display = 'block';
  document.getElementById('profileModal').style.display = 'block';
  loadProfile();
}
function closeProfileModal() {
  document.getElementById('profileOverlay').style.display = 'none';
  document.getElementById('profileModal').style.display = 'none';
}
async function loadProfile() {
  const box = document.getElementById('profileContent');
  try {
    const token = localStorage.getItem('authToken');
    if (!token) { toast(t('auth.loginFirst')); return; }
    box.innerHTML = '<div style="text-align:center;color:var(--text3);padding:30px 0">' + t('common.loading') + '</div>';
    // ── 获取用户身份：本地引擎优先，失败回退云平台 ──
    let u = null, fromCloud = false;
    try {
      const r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
      const d = await r.json();
      if (d.ok && d.user) u = d.user;
    } catch (e) { /* 本地不可。*/ }
    if (!u) {
      try {
        const cr = await platformApi('/api/user/me', 'GET');
        if (cr && cr.ok && cr.user) { u = cr.user; fromCloud = true; }
      } catch (e) { /* 云平台不可达 */ }
    }
    if (!u) {
      box.innerHTML = '<div style="text-align:center;color:var(--red);padding:30px 0">' + t('profile.loadUserFail') + '</div>';
      return;
    }
    const userId = u.id || u.sub || '';
    // ── 组装资料数据：本。/api/profile 优先，云账号回退云平。──
    let name = u.display_name || u.username || t('profile.defaultUser'), idShow = userId, credits = 0, rating = t('common.none'), tokens = 0, calls = 0, createdAt = '-', status = t('profile.online'), ratingsHtml = '';
    let pr = null;
    if (!fromCloud) {
      try { pr = await api('/api/profile?userId=' + encodeURIComponent(userId)); } catch (e) {}
    }
    if (pr && pr.ok && pr.profile) {
      const p = pr.profile;
      // 过滤本地默认名称。用户+nid"模式），避免覆盖来自 /api/auth/me 的真实姓。
      if (p.display_name && !/^用户\d+$/.test(p.display_name)) name = p.display_name;
      idShow = p.numeric_id || p.id;
      credits = pr.credits || 0;
      rating = pr.ratings?.avgRating ? '⚠' + Number(pr.ratings.avgRating).toFixed(1) : t('common.none');
      tokens = pr.usage?.totalTokens || 0;
      calls = pr.usage?.calls || 0;
      createdAt = new Date(p.created_at).toLocaleString('zh-CN');
      status = p.status === 'offline' ? t('profile.offline') : t('profile.online');
      if ((pr.ratings?.count || 0) > 0) {
        try {
          const rr = await api('/api/ratings?userId=' + encodeURIComponent(userId));
          if (rr.ok && rr.ratings.length > 0) {
            ratingsHtml = rr.ratings.map(rt =>
              '<div style="margin-bottom:4px;padding:4px;border-left:2px solid #faad14;font-size:12px">' + '⭐'.repeat(rt.rating) + ' ' + esc(rt.comment || '') + '</div>'
            ).join('');
          }
        } catch (e) {}
      }
    } else {
      // 云账号（本地无此用户）→ 从云平台拉取完整资料
      // 注意：云平台 /api/user/profile 。/api/user/:id 路由遮蔽(。04)，须。/api/auth/me
      let cu = u;
      try {
        const cpr = await platformApi('/api/user/me', 'GET');
        if (cpr && cpr.ok && cpr.user) cu = cpr.user;
      } catch (e) { /* 用已有信息兜。*/ }
      name = cu.username || cu.display_name || cu.displayName || t('profile.defaultUser');
      idShow = cu.id || userId;
      credits = cu.points != null ? cu.points : 0;
      createdAt = cu.created_at ? new Date(cu.created_at).toLocaleString('zh-CN') : '-';
      status = cu.status === 'offline' ? t('profile.offline') : t('profile.online');
    }
    // ── 渲染个人中心卡片 ──
    const cell = 'background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center';
    const num = 'font-size:16px;font-weight:700;color:var(--accent)';
    const lab = 'font-size:10px;color:var(--text3);margin-top:2px';
    box.innerHTML =
      '<div style="text-align:center;margin-bottom:16px">' +
        '<div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#4a9eff,#4ade80);display:inline-flex;align-items:center;justify-content:center;font-size:24px;color:#fff">' + esc((name[0] || 'U').toUpperCase()) + '</div>' +
        '<div style="font-size:16px;font-weight:700;margin-top:8px">' + esc(name) + '</div>' +
        '<div style="font-size:11px;color:var(--text3)">ID: ' + esc(String(idShow)) + ' · ' + esc(status) + '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">' +
        '<div style="' + cell + '"><div style="' + num + '">' + Number(credits).toLocaleString() + '</div><div style="' + lab + '">' + t('profile.credits') + '</div></div>' +
        '<div style="' + cell + '"><div style="' + num + '">' + esc(rating) + '</div><div style="' + lab + '">' + t('profile.rating') + '</div></div>' +
        '<div style="' + cell + '"><div style="' + num + '">' + Number(tokens).toLocaleString() + '</div><div style="' + lab + '">' + t('profile.tokenUsage') + '</div></div>' +
        '<div style="' + cell + '"><div style="' + num + '">' + Number(calls).toLocaleString() + '</div><div style="' + lab + '">' + t('profile.callCount') + '</div></div>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text2);margin-bottom:12px">' + t('profile.registeredAt', {time: esc(createdAt)}) + '</div>' +
      (ratingsHtml ? '<div style="font-size:12px;color:var(--accent);margin-bottom:6px">' + t('profile.myRatings') + '</div>' + ratingsHtml : '');
  } catch (e) {
    box.innerHTML = '<div style="text-align:center;color:var(--red);padding:30px 0">' + t('err.loadFail') + ': ' + esc(e.message) + '</div>';
  }
}
async function rateMessage(msgId, rating) {
  try {
    const token = localStorage.getItem('authToken');
    if (!token) { toast(t('auth.loginFirst')); return; }
    const r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
    const d = await r.json();
    if (!d.ok) return;
    await api('/api/ratings', 'POST', { messageId: msgId, userId: d.user.id, rating });
    toast(t('profile.rated', {n: rating}));
  } catch(e) { toast(t('profile.rateFail')); }
}


// ── 群聊协作模式 ──
async function loadChatMode(chatId) {
  try {
    const d = await api('/api/chats/' + encodeURIComponent(chatId) + '/mode');
    var sel = document.getElementById('chatModeSelect');
    if (d.ok && sel) {
      var valid = Array.prototype.slice.call(sel.options).map(function(o){ return o.value; });
      sel.value = valid.indexOf(d.mode) >= 0 ? d.mode : 'free';
    }
  } catch(e) {}
}
let _modeSwitching = false;
async function setChatMode(mode) {
  if (!currentChat || _modeSwitching) return;
  var sel = document.getElementById('chatModeSelect');
  var prevMode = sel ? sel.value : null;
  _modeSwitching = true;
  if (sel) sel.disabled = true;
  try {
    await api('/api/chats/' + encodeURIComponent(currentChat) + '/mode', 'POST', { mode });
    var names = {free:t('mode.free'),route:t('mode.route'),debate:t('mode.debate'),chain:t('mode.chain'),roundtable:t('mode.roundtable'),vote:t('mode.vote'),brainstorm:t('mode.brainstorm')};
    toast(t('chat.collabMode', {mode: names[mode] || mode}));
  } catch(e) {
    if (sel && prevMode) sel.value = prevMode;
    toast('⚠' + t('err.setFail'));
  } finally {
    _modeSwitching = false;
    if (sel) sel.disabled = false;
  }
}


// ── 找回密码 ──
async function showForgotPassword() {
  var email = document.getElementById('authUsername').value.trim() || prompt(t('auth.enterEmail'));
  if (!email) return;
  try {
    var r = await api('/api/auth/forgot-password', 'POST', { email: email });
    document.getElementById('authMsg').innerHTML = '<span style="color:#4ade80">' + t('auth.resetSent', {email: esc(email)}) + '</span>';
  } catch(e) {
    document.getElementById('authMsg').innerHTML = '<span style="color:#ef4444">' + esc(e.message || t('err.sendFail')) + '</span>';
  }
}


// ── Workflow Editor ──
let wfNodes = [];
let wfConnections = [];
let wfDragging = null;
let wfConnecting = null;
let wfOffset = {x:0,y:0};
let wfSelectedNode = null;
let wfZoom = 1;
let wfPanX = 0, wfPanY = 0;
let wfPanning = false;
let wfDragStartState = null;
let wfPanStart = {x:0,y:0};
let wfUndoStack = [];
let wfRedoStack = [];

function openWorkflowEditor() {
  document.getElementById('wfOverlay').style.display = 'block';
  document.getElementById('wfEditor').style.display = 'flex';
  loadWFAgents();
  renderWF();
}
function closeWorkflowEditor() {
  document.getElementById('wfOverlay').style.display = 'none';
  document.getElementById('wfEditor').style.display = 'none';
}
async function loadWFAgents() {
  try {
    const d = await api('/api/agents');
    const agents = d.agents || [];
    document.getElementById('wfAgentList').innerHTML = agents.map((a,i) => 
      '<div class="wf-agent-item" draggable="true" ' +
      'ondragstart="wfDragAgent(event,'+i+')" ' +
      'data-agent-id="'+esc(a.id)+'" ' +
      'data-agent-name="'+esc(a.displayName||a.id)+'" ' +
      'data-agent-model="'+esc(a.model||'default')+'">' +
      esc(a.displayName||a.id)+'<br><span style="color:#666;font-size:9px">'+esc(a.model||'default')+'</span></div>'
    ).join('');
  } catch(e) {}
}
function wfDragAgent(e, idx) {
  e.dataTransfer.setData('text/plain', document.getElementById('wfAgentList').children[idx]?.textContent||'Agent');
  e.dataTransfer.setData('application/json', JSON.stringify({
    agentId: document.getElementById('wfAgentList').children[idx]?.dataset.agentId,
    agentName: document.getElementById('wfAgentList').children[idx]?.dataset.agentName,
    model: document.getElementById('wfAgentList').children[idx]?.dataset.agentModel
  }));
}
function wfAddStartNode() {
  wfPushUndo();
  wfNodes.push({id:'node-'+Date.now(), type:'start', label:t('wf.startLabel'), x:100, y:100 + wfNodes.filter(n=>n.type==='start').length*80, config:{}});
  renderWF(true);
}
function wfAddAgentNode() {
  const name = prompt(t('wf.nodeNamePh')) || 'Agent';
  wfPushUndo();
  wfNodes.push({id:'node-'+Date.now(), type:'agent', label:name, x:350, y:100 + wfNodes.filter(n=>n.type==='agent').length*120, config:{prompt:t('wf.defaultPrompt'), model:'default'}});
  renderWF(true);
}

// Drag node
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('wfCanvas')?.addEventListener('dragover', e => e.preventDefault());
  document.getElementById('wfCanvas')?.addEventListener('drop', wfHandleDrop);
});
function wfHandleDrop(e) {
  e.preventDefault();
  const rect = document.getElementById('wfCanvas').getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  try {
    const data = JSON.parse(e.dataTransfer.getData('application/json'));
    wfPushUndo();
    wfNodes.push({id:'node-'+Date.now(), type:'agent', label:data.agentName||'Agent', x:x-80, y:y-20, config:{agentId:data.agentId, prompt:'', model:data.model||'default'}});
    renderWF(true);
  } catch(e2) {}
}
// Node drag
document.addEventListener('mousedown', wfMouseDown);
function wfMouseDown(e) {
  // 画布空白区拖。。平移
  const canvasEl = document.getElementById('wfCanvas');
  if (e.target === canvasEl || e.target.id === 'wfNodes' || e.target.id === 'wfConnections') {
    wfPanning = true;
    wfPanStart = {x: e.clientX - wfPanX, y: e.clientY - wfPanY};
    canvasEl.style.cursor = 'grabbing';
    return;
  }
  const nodeEl = e.target.closest('.wf-node');
  if (!nodeEl || e.target.classList.contains('wf-delete') || e.target.classList.contains('wf-connector')) return;
  wfDragStartState = JSON.parse(JSON.stringify(wfNodes)); // 保存移动前状。
  wfDragging = nodeEl.dataset.nodeId;
  const node = wfNodes.find(n => n.id === wfDragging);
  if (!node) return;
  wfOffset = {x: e.clientX - node.x, y: e.clientY - node.y};
  wfSelectedNode = wfDragging;
  e.preventDefault();
}
document.addEventListener('mousemove', e => {
  if (wfPanning) {
    wfPanX = e.clientX - wfPanStart.x;
    wfPanY = e.clientY - wfPanStart.y;
    renderWF();
    return;
  }
  if (!wfDragging) return;
  const node = wfNodes.find(n => n.id === wfDragging);
  if (!node) return;
  node.x = Math.max(0, e.clientX - wfOffset.x);
  node.y = Math.max(0, e.clientY - wfOffset.y);
  renderWF();
});
document.addEventListener('wheel', e => {
  if (!document.getElementById('wfEditor') || document.getElementById('wfEditor').style.display === 'none') return;
  e.preventDefault();
  const zoomDelta = e.deltaY > 0 ? 0.95 : 1.05;
  wfZoom = Math.max(0.2, Math.min(3, wfZoom * zoomDelta));
  renderWF();
}, {passive: false});
document.addEventListener('dblclick', wfDblClick);

function wfDblClick(e) {
  const nodeEl = e.target.closest('.wf-node');
  if (!nodeEl) return;
  const nodeId = nodeEl.dataset.nodeId;
  const node = wfNodes.find(n => n.id === nodeId);
  if (!node || node.type !== 'agent') return;
  const newPrompt = prompt(t('wf.editPrompt'), node.config.prompt || t('wf.defaultPrompt'));
  if (newPrompt !== null) {
    node.config.prompt = newPrompt;
    const newModel = prompt(t('wf.editModel'), node.config.model || 'default');
    if (newModel !== null) node.config.model = newModel;
    renderWF();
  }
}

function wfDeleteNode(nodeId) {
  wfPushUndo();
  wfNodes = wfNodes.filter(n => n.id !== nodeId);
  wfConnections = wfConnections.filter(c => c.from !== nodeId && c.to !== nodeId);
  renderWF(true);
}
function wfStartConnection(nodeId, port) {
  if (port === 'out') wfConnecting = {from: nodeId, x:0, y:0};
}
function wfEndConnection(targetNodeId) {
  if (!wfConnecting) return;
  if (wfConnecting.from !== targetNodeId) {
    wfPushUndo();
    wfConnections.push({from: wfConnecting.from, to: targetNodeId});
    renderWF(true);
  }
  wfConnecting = null;
}
function wfDeleteConnection(from, to) {
  wfPushUndo();
  wfConnections = wfConnections.filter(c => !(c.from === from && c.to === to));
  renderWF(true);
}

document.addEventListener('mouseup', () => { 
  if (wfDragging && wfDragStartState) {
    wfPushUndo(); wfDragStartState = null;
  }
  wfDragging = null; 
  wfPanning = false;
  const canvasEl = document.getElementById('wfCanvas');
  if (canvasEl) canvasEl.style.cursor = '';
});

function renderWF() {
  const container = document.getElementById('wfNodes');
  const svg = document.getElementById('wfConnections');
  if (!container) return;
  container.innerHTML = wfNodes.map(n => 
    '<div class="wf-node'+(n.id===wfSelectedNode?' wf-selected':'')+'" data-node-id="'+n.id+'" style="left:'+n.x+'px;top:'+n.y+'px">' +
    '<div class="wf-header">'+(n.type==='start'?'🟢':'🤖')+' '+esc(n.label)+'</div>' +
    '<div class="wf-body">'+(n.type==='agent'?t('wf.instructionPrefix')+(n.config.prompt||'').slice(0,30):t('wf.flowStart'))+'</div>' +
    '<button class="wf-delete" onclick="event.stopPropagation();wfDeleteNode(\''+n.id+'\')\">×</button>' +
    (n.type!=='start'?'<div class="wf-connector wf-in" title="'+t('wf.inputTitle')+'" onclick="event.stopPropagation();wfEndConnection(\''+n.id+'\')\"></div>':'') +
    '<div class="wf-connector wf-out" title="'+t('wf.outputTitle')+'" onmousedown="event.stopPropagation();wfStartConnection(\''+n.id+'\',\'out\')"></div>' +
    '</div>'
  ).join('');

  // Draw connections
  // 更新缩放标签
  const zoomLabel = document.getElementById('wfZoomLabel');
  if (zoomLabel) zoomLabel.textContent = Math.round(wfZoom*100)+'%';
  svg.innerHTML = '<defs><marker id="wfArrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 Z" fill="#4a9eff"/></marker></defs>' +
    wfConnections.map(c => {
      const from = wfNodes.find(n=>n.id===c.from);
      const to = wfNodes.find(n=>n.id===c.to);
      if (!from || !to) return '';
      const x1 = from.x + 80, y1 = from.y + 50, x2 = to.x + 80, y2 = to.y;
      return '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" onclick="wfDeleteConnection(\''+c.from+'\',\''+c.to+'\')" style="pointer-events:all;cursor:pointer" title="'+t('wf.deleteConnTitle')+'"/>';
    }).join('');
}
// ── 撤销/重做 ──
function wfPushUndo() {
  wfUndoStack.push({nodes: JSON.parse(JSON.stringify(wfNodes)), connections: JSON.parse(JSON.stringify(wfConnections))});
  if (wfUndoStack.length > 50) wfUndoStack.shift(); // 最。0。
  wfRedoStack = []; // 新操作清空重做栈
}
function wfUndo() {
  if (wfUndoStack.length === 0) return;
  wfRedoStack.push({nodes: JSON.parse(JSON.stringify(wfNodes)), connections: JSON.parse(JSON.stringify(wfConnections))});
  const prev = wfUndoStack.pop();
  wfNodes = prev.nodes;
  wfConnections = prev.connections;
  renderWF(true); // skip push
}
function wfRedo() {
  if (wfRedoStack.length === 0) return;
  wfUndoStack.push({nodes: JSON.parse(JSON.stringify(wfNodes)), connections: JSON.parse(JSON.stringify(wfConnections))});
  const next = wfRedoStack.pop();
  wfNodes = next.nodes;
  wfConnections = next.connections;
  renderWF(true);
}
document.addEventListener('keydown', e => {
  if (!document.getElementById('wfEditor') || document.getElementById('wfEditor').style.display === 'none') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); wfUndo(); }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); wfRedo(); }
});

async function wfSaveToCloud() {
  const name = document.getElementById('wfName').value || t('wf.unnamed');
  const id = 'wf-' + Date.now();
  const data = { nodes: wfNodes, connections: wfConnections };
  try {
    await api('/api/workflows', 'POST', { id, name, data });
    toast(t('wf.saved', {name: name}));
  } catch(e) { toast('⚠' + t('err.saveFail') + ': ' + e.message); }
}
async function wfLoadFromCloud() {
  try {
    const d = await api('/api/workflows');
    if (!d.ok || !d.workflows.length) { toast(t('wf.noSaved')); return; }
    const name = prompt(t('wf.selectWf') + '\n' + d.workflows.map((w,i) => (i+1)+'. '+w.name+' ('+new Date(w.updated_at).toLocaleDateString()+')').join('\n'));
    if (!name) return;
    const idx = parseInt(name) - 1;
    if (idx < 0 || idx >= d.workflows.length) return;
    const detail = await api('/api/workflows/' + d.workflows[idx].id);
    if (detail.ok && detail.workflow) {
      const dd = detail.workflow.data;
      wfNodes = dd.nodes || [];
      wfConnections = dd.connections || [];
      document.getElementById('wfName').value = detail.workflow.name;
      renderWF();
      toast(t('wf.loaded', {name: detail.workflow.name}));
    }
  } catch(e) { toast('⚠' + t('err.loadFail') + ': ' + e.message); }
}

function wfExportJSON() {
  const name = document.getElementById('wfName').value || t('wf.defaultName');
  const json = {name, nodes:wfNodes, connections:wfConnections, exportedAt:Date.now()};
  const blob = new Blob([JSON.stringify(json,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name+'.json';
  a.click();
  toast(t('wf.exported', {name: name}));
}
function wfImportJSON(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);
      if (json.nodes) wfNodes = json.nodes;
      if (json.connections) wfConnections = json.connections;
      document.getElementById('wfName').value = json.name || '';
      renderWF();
      toast(t('wf.imported', {n: json.nodes?.length||0}));
    } catch(e2) { toast(t('wf.importFail', {msg: e2.message})); }
  };
  reader.readAsText(file);
}

// ── Theme ──
const THEMES = ['dark', 'light', 'ocean', 'warm', 'forest'];
function themeName(k) {
  var m = { dark: t('misc.themeDark'), light: t('misc.themeLight'), ocean: t('misc.themeOcean'), warm: t('misc.themeWarm'), forest: t('misc.themeForest') };
  return m[k] || k;
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const idx = THEMES.indexOf(cur);
  const next = THEMES[(idx + 1) % THEMES.length];
  setTheme(next);
  toast(t('misc.themePrefix') + themeName(next));
}
function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
}
function applyTheme(t) {
  setTheme(t);
}
checkAuthStatus();
const savedTheme = localStorage.getItem('theme') || 'dark';
applyTheme(savedTheme);

// ── Admin Panel ──
function toggleAdmin(force) {
  const panel = document.getElementById('adminPanel');
  const overlay = document.getElementById('adminOverlay');
  const isOpen = panel.classList.contains('open');
  const show = typeof force === 'boolean' ? force : !isOpen;
  panel.classList.toggle('open', show);
  overlay.classList.toggle('open', show);
  if (show) refreshAllAdmin();
}
async function refreshAllAdmin() {
  adminHealth(); adminAgents(); adminSessions(); adminSubAgents(); adminCron(); adminMCP(); adminPlugins(); loadApprovals(); loadVoiceStatus(); loadPromptAgentSelect(); loadGoals();
  refreshStatusBar(); refreshAdminVersion();
}
async function refreshStatusBar() {
  try {
    const h = await api('/api/health');
    const aEl = document.getElementById('apiHealth');
    const healthy = h.status === 'ok';
    aEl.textContent = healthy ? t('status.apiOk') : '⚠' + (h.status || t('admin.abnormal'));
    aEl.className = healthy ? 'ok' : 'err';
  } catch(e) { document.getElementById('apiHealth').textContent=t('status.apiDown'); document.getElementById('apiHealth').className='err'; }
  try {
    const agents = await api('/api/agents');
    const scEl = document.getElementById('sessionCount'); if (scEl) scEl.textContent = agents.agents ? agents.agents.length : '-';
  } catch(e){}
  try {
    const cron = await api('/api/cron');
    const tcEl = document.getElementById('taskCount'); if (tcEl) tcEl.textContent = (cron.jobs||[]).length;
  } catch(e){}
  try {
    const d = await api('/api/providers');
    const models = d.models || [];
    const mcEl = document.getElementById('modelCount'); if (mcEl) mcEl.textContent = models.length || '-';
    const hSel = document.getElementById('headerModelSelect');
    // 路由开启时显示实际生效的回复模型，避免显示写死的默认模。
    let curModel = hSel && hSel.value ? hSel.value : (models[0]?.id || '');
    if (document.getElementById('routeEnabled')?.checked && document.getElementById('replyModelSelect')?.value) {
      curModel = document.getElementById('replyModelSelect').value;
    }
    const cmdEl = document.getElementById('currentModelDisplay'); if (cmdEl) cmdEl.textContent = curModel ? '🧠 ' + (curModel.split('/').pop() || curModel) : '';
  } catch(e){}
  const wsEl = document.getElementById('wsState');
  if (ws && ws.readyState === 1) { wsEl.textContent = t('status.wsConnected'); wsEl.className = 'ok'; }
  else { wsEl.textContent = t('status.wsNotConnected'); wsEl.className = 'err'; }
}
async function adminHealth() {
  try {
    const d = await api('/api/health');
    document.getElementById('adminHealthOut').textContent = JSON.stringify(d, null, 2);
  } catch(e) { document.getElementById('adminHealthOut').textContent = '⚠' + e.message; }
}

async function loadLogs() {
  const out = document.getElementById('logsOut');
  if (!out) return;
  out.textContent = t('common.loading');
  try {
    const d = await api('/api/logs?limit=200');
    if (!d.ok) { out.textContent = '⚠' + _errMsg(d, t('err.loadFail')); return; }
    const lines = d.lines || [];
    out.textContent = lines.length ? lines.join('\n') : t('admin.noLogs');
    out.scrollTop = out.scrollHeight;
  } catch(e) { out.textContent = '⚠' + (e.message || t('err.networkError')); }
}

// ── 一键升。──
async function doUpdate() {
  const stat = document.getElementById('updateStatus');
  if (!confirm(t('admin.confirmUpdate'))) return;
  if (stat) stat.textContent = t('admin.updating');
  try {
    const d = await api('/api/update', 'POST');
    if (d.ok) {
      if (stat) stat.textContent = t('admin.updateTriggered');
      toast(t('admin.updateStarted'));
      // 10 秒后刷新页面
      setTimeout(function(){ location.reload(); }, 10000);
    } else {
      if (stat) stat.textContent = '⚠' + _errMsg(d, t('admin.updateFail'));
      toast('⚠' + t('admin.updateFail') + ': ' + _errMsg(d, t('err.unknown')));
    }
  } catch(e) {
    if (stat) stat.textContent = '⚠' + (e.message || t('err.networkError'));
  }
}

// 管理面板打开时刷新版本号
function refreshAdminVersion() {
  var v = document.getElementById('adminVerTag');
  var vt = document.getElementById('verTag');
  if (v && vt) v.textContent = vt.textContent;
}

// ── 实例组网 (Instance Mesh) ──
async function loadMesh() {
  const statusEl = document.getElementById('meshStatus');
  const peersEl = document.getElementById('meshPeers');
  const sel = document.getElementById('meshPeerSelect');
  if (!statusEl) return;
  statusEl.textContent = t('common.loading');
  try {
    const st = await api('/api/mesh/status');
    if (!st.enabled) {
      statusEl.innerHTML = '<span style="color:var(--text3)">' + t('admin.meshDisabled') + '</span>';
      peersEl.textContent = '';
      sel.innerHTML = '<option value="">' + t('admin.selectInstance') + '</option>';
      return;
    }
    const dot = st.connected ? '<span style="color:#4ade80">' + t('admin.meshConnected') + '</span>' : '<span style="color:#ef4444">' + t('admin.meshNotConnected') + '</span>';
    statusEl.innerHTML = dot + ' <span style="color:var(--text3)">' + esc(st.instanceId) + '</span><br><span style="color:var(--text3);font-size:10px">' + esc(st.lanIp || '') + ' @ ' + esc(st.platformUrl || '') + '</span>';
    const d = await api('/api/mesh/peers');
    const peers = d.instances || [];
    if (d.disabled) { peersEl.textContent = t('admin.meshNoPlatform'); }
    else if (!peers.length) { peersEl.textContent = t('admin.meshNoPeers'); }
    else {
      peersEl.innerHTML = peers.map(function(p){
        return '<div style="padding:3px 0;border-bottom:1px solid var(--border)">🟢 ' + esc(p.instanceId) + ' <span style="color:var(--text3);font-size:10px">' + esc(p.lanIp||'') + ':' + (p.port||'') + ' · ' + (p.agents?p.agents.length:0) + ' AI</span></div>';
      }).join('');
    }
    sel.innerHTML = '<option value="">' + t('admin.selectInstance') + '</option>' + peers.map(function(p){
      return '<option value="' + esc(p.instanceId) + '">' + esc(p.instanceId) + '</option>';
    }).join('');
  } catch(e) { statusEl.textContent = '⚠' + (e.message || t('err.networkError')); }
}

async function sendMeshMsg() {
  const sel = document.getElementById('meshPeerSelect');
  const input = document.getElementById('meshMsgInput');
  const toInstance = sel.value;
  const content = (input.value || '').trim();
  if (!toInstance) { toast(t('admin.selectInstanceFirst')); return; }
  if (!content) { toast(t('admin.enterMessage')); return; }
  try {
    const d = await api('/api/mesh/send', 'POST', { toInstance: toInstance, content: content });
    if (d.ok) { toast(t('admin.sentTo', {inst: toInstance})); input.value = ''; }
    else toast(t('admin.sendFailOffline'));
  } catch(e) { toast('⚠' + (e.message || t('err.sendFail'))); }
}

// ── Token 时间线渲染（30。24小时 柱状图）──
function renderUsageTimeline(items, keyField, title) {
  var max = Math.max.apply(null, items.map(function(i){ return i.totalTokens; }).concat([1]));
  var bars = items.map(function(i) {
    var h = i.totalTokens > 0 ? Math.max(3, Math.round(i.totalTokens / max * 56)) : 2;
    var label = i[keyField] + ": " + i.totalTokens.toLocaleString() + " tokens / " + i.calls + t('admin.timesUnit');
    var color = i.totalTokens > 0 ? 'var(--accent)' : 'rgba(255,255,255,.08)';
    return '<div title="' + esc(label) + '" style="flex:1;min-width:2px;height:' + h + 'px;background:' + color + ';border-radius:2px 2px 0 0"></div>';
  }).join('');
  var total = items.reduce(function(a, i){ return a + i.totalTokens; }, 0);
  return '<div style="margin-top:8px"><b>' + title + '</b> <span style="color:var(--text3);font-size:10px">。' + total.toLocaleString() + ' tokens</span>' +
    '<div style="display:flex;align-items:flex-end;gap:2px;height:60px;padding:6px 4px 2px;background:rgba(0,0,0,.25);border-radius:6px;margin-top:4px">' + bars + '</div></div>';
}
async function loadUsage() {
  try {
    const d = await api('/api/usage');
    if (!d.ok) return;
    const s = d.stats;
    let html = '';
    html += '<div style="margin-bottom:8px;padding:6px;background:rgba(0,0,0,.3);border-radius:6px">';
    html += '<b>' + t('admin.total') + '</b>: ' + s.total.calls + ' ' + t('admin.callsUnit') + ' | ' + s.total.totalTokens.toLocaleString() + ' tokens<br>';
    html += t('admin.input') + ' ' + s.total.promptTokens.toLocaleString() + ' / ' + t('admin.output') + ' ' + s.total.completionTokens.toLocaleString() + '<br>';
    html += t('admin.recent1h') + ': ' + s.recent1h.calls + ' ' + t('admin.timesUnit') + ' / ' + s.recent1h.totalTokens.toLocaleString() + ' tokens<br>';
    html += t('admin.recent24h') + ': ' + s.recent24h.calls + ' ' + t('admin.timesUnit') + ' / ' + s.recent24h.totalTokens.toLocaleString() + ' tokens';
    html += '</div>';
    if (Object.keys(s.byModel).length > 0) {
      html += '<div style="margin-top:6px"><b>' + t('admin.byModel') + '</b></div>';
      for (const [model, m] of Object.entries(s.byModel)) {
        html += '<div>' + model + ': ' + m.calls + t('admin.timesUnit') + ' / ' + m.totalTokens.toLocaleString() + ' tokens</div>';
      }
    }
    if (Object.keys(s.byType).length > 0) {
      html += '<div style="margin-top:6px"><b>' + t('admin.byType') + '</b></div>';
      const typeNames = { tool: t('admin.typeTool'), reply: t('admin.typeReply'), compaction: t('admin.typeCompaction'), summary: t('admin.typeSummary'), reflection: t('admin.typeReflection') };
      for (const [type, item] of Object.entries(s.byType)) {
        html += '<div>' + (typeNames[type]||type) + ': ' + item.calls + t('admin.timesUnit') + ' / ' + item.totalTokens.toLocaleString() + ' tokens</div>';
      }
    }
    // ── 时间线：每日(30。 + 每小。24小时) ──
    if (Array.isArray(s.daily) && s.daily.length) {
      html += renderUsageTimeline(s.daily, 'date', t('admin.dailyTimeline'));
    }
    if (Array.isArray(s.hourly) && s.hourly.length) {
      html += renderUsageTimeline(s.hourly, 'hour', t('admin.hourlyTimeline'));
    }
    document.getElementById('usageStats').innerHTML = html || t('admin.noData');
  } catch(e) { document.getElementById('usageStats').innerHTML = '<span style="color:#f44">Error: ' + esc(e.message) + '</span>'; }
}

async function resetUsage() {
  if (!confirm(t('admin.confirmResetUsage'))) return;
  try { await api('/api/usage/reset', 'POST'); loadUsage(); } catch(e) {}
}

// ── v1.8.4: 目标系统 ──
const GOAL_EMOJI = { pending: '⏳', in_progress: '🔄', done: '✅', cancelled: '❌' };
async function loadGoals() {
  const el = document.getElementById('goalsList');
  if (!el) return;
  try {
    const project = currentChat ? ('project-' + currentChat) : 'default';
    const d = await api('/api/goals?project=' + encodeURIComponent(project));
    if (!d.ok) { el.innerHTML = '⚠' + esc(_errMsg(d, t('err.loadFail'))); return; }
    const goals = d.goals || [];
    const pg = document.getElementById('goalProgress');
    if (pg) pg.textContent = d.progress ? (d.progress.done + '/' + d.progress.total) : '-';
    if (!goals.length) { el.innerHTML = '<span style="color:var(--text3)">' + t('admin.noGoals') + '</span>'; return; }
    el.innerHTML = goals.map(g => {
      const acts = [];
      if (g.status === 'pending') acts.push('<a onclick="setGoalStatus(\'' + g.id + '\',\'in_progress\')" title="' + t('admin.goalStart') + '" style="cursor:pointer;font-size:16px">▶️</a>');
      if (g.status !== 'done' && g.status !== 'cancelled') acts.push('<a onclick="setGoalStatus(\'' + g.id + '\',\'done\')" title="' + t('admin.goalDone') + '" style="cursor:pointer;font-size:16px">。/a>');
      if (g.status === 'done' || g.status === 'cancelled') acts.push('<a onclick="setGoalStatus(\'' + g.id + '\',\'pending\')" title="' + t('admin.goalRestore') + '" style="cursor:pointer;font-size:16px">↩️</a>');
      acts.push('<a onclick="askAIAboutGoal(\'' + g.id + '\',\'' + esc(g.title).replace(/'/g, "\\'") + '\')" title="' + t('admin.aiAskTitle') + '" style="cursor:pointer;font-size:16px">。/a>');
      acts.push('<a onclick="removeGoal(\'' + g.id + '\')" title="' + t('common.delete') + '" style="cursor:pointer;font-size:16px">🗑。/a>');
      const style = g.status === 'done' ? 'text-decoration:line-through;color:var(--text3)' : (g.status === 'cancelled' ? 'color:var(--text3)' : '');
      const criteria = g.acceptanceCriteria ? '<div style="font-size:10px;color:var(--text3)">' + esc(g.acceptanceCriteria) + '</div>' : '';
      return '<div style="padding:4px 0;border-bottom:1px solid var(--border)">' +
        '<span>' + (GOAL_EMOJI[g.status] || '❓') + ' <span style="' + style + '">' + esc(g.title) + '</span></span> ' +
        '<span style="float:right">' + acts.join(' ') + '</span>' + criteria + '</div>';
    }).join('');
  } catch(e) { el.innerHTML = '⚠' + esc(e.message || t('err.networkError')); }
}
async function addGoal() {
  const inp = document.getElementById('goalInput');
  const title = inp ? inp.value.trim() : '';
  if (!title) { toast(t('admin.enterGoal')); return; }
  try {
    const project = currentChat ? ('project-' + currentChat) : 'default';
    const d = await api('/api/goals', 'POST', { title, project: project });
    if (!d.ok) { toast('⚠' + _errMsg(d, t('err.addFail'))); return; }
    if (inp) inp.value = '';
    toast(t('admin.goalAdded'));
    loadGoals();
  } catch(e) { toast('⚠' + e.message); }
}
async function setGoalStatus(id, status) {
  try {
    const d = await api('/api/goals/' + id, 'PATCH', { status });
    if (!d.ok) { toast('⚠' + _errMsg(d, t('err.operationFail'))); return; }
    loadGoals();
  } catch(e) { toast('⚠' + e.message); }
}
async function removeGoal(id) {
  if (!confirm(t('admin.confirmDeleteGoal'))) return;
  try {
    const d = await api('/api/goals/' + id, 'DELETE');
    if (!d.ok) { toast('⚠' + _errMsg(d, t('err.deleteFail'))); return; }
    toast(t('common.deleted'));
    loadGoals();
  } catch(e) { toast('⚠' + e.message); }
}
// ── 反向提问：AI 针对目标提澄清问题（含多选表。+ 继续反问。──
async function askAIAboutGoal(goalId, title) {
  _currentAskGoalId = goalId;
  if (!currentChat) { toast('⚠' + t('chat.selectChatFirst')); return; }
  try {
    toast(t('admin.aiAnalyzing'));
    const extra = (typeof title === 'string' && (title.includes(';') || title.includes('自定义'))) ? title : '';
    const d = await api('/api/goals/' + encodeURIComponent(goalId) + '/ask', 'POST', { chatId: currentChat, extra: extra });
    if (d.ok) {
      toast(t('admin.aiAskSent'));
    } else {
      toast('⚠' + _errMsg(d, t('err.askFail')));
    }
  } catch(e) { toast('⚠' + e.message); }
}

// 兼容旧调用名
var askGoal = askAIAboutGoal;

// ── 目标反向提问 -> 选项表单渲染 ──
// AI 回复中包。Q:/A:/B:/C: 格式时，自动在消息下方插入多选表。
function renderGoalQAForm(content, msgEl, chatId) {
  var questions = [];
  var currentQ = null;
  var clines = content.split('\n');
  for (var i = 0; i < clines.length; i++) {
    var line = clines[i].trim();
    var qm = line.match(/^Q:?\s*(.+)/);
    var am = line.match(/^([A-C]):?\s*(.+)/);
    if (qm) { currentQ = { q: qm[1], opts: [] }; questions.push(currentQ); }
    else if (am && currentQ) { currentQ.opts.push({ key: am[1], text: am[2] }); }
  }
  if (questions.length === 0) return;

  var html = '<div style="margin:8px 0 8px 48px;padding:12px;background:var(--bg2);border-radius:8px;border:1px solid var(--border)" data-goal-id="' + esc(_currentAskGoalId || '') + '">';
  html += '<div style="font-weight:bold;margin-bottom:8px;color:var(--accent)">' + t('admin.refineTitle') + '</div>';
  for (var qi = 0; qi < questions.length; qi++) {
    var q = questions[qi];
    html += '<div style="margin-bottom:8px"><div style="font-size:12px;color:var(--text2);margin-bottom:4px">' + esc(q.q) + '</div>';
    for (var oi = 0; oi < q.opts.length; oi++) {
      var o = q.opts[oi];
      var cbId = 'ga-' + qi + '-' + oi + '-' + Date.now();
      html += '<label style="display:block;font-size:12px;cursor:pointer;padding:2px 0"><input type="checkbox" id="' + cbId + '" style="margin-right:4px">' + esc(o.text) + '</label>';
    }
    html += '</div>';
  }
  // 自定义输。
  html += '<div style="margin-bottom:8px"><div style="font-size:12px;color:var(--text2);margin-bottom:4px">' + t('admin.customExtra') + '</div>';
  html += '<input type="text" style="width:90%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg3);color:var(--text)" placeholder="' + t('admin.extraPh') + '"></div>';
  html += '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">';
  html += '<button class="btn" style="font-size:11px;background:var(--green);color:#fff" onclick="applyGoalRefine(this,\'refine\')">' + t('admin.refineBtn') + '</button>';
  html += '<button class="btn" style="font-size:11px" onclick="applyGoalRefine(this,\'criteria\')">' + t('admin.criteriaBtn') + '</button>';
  html += '<button class="btn" style="font-size:11px" onclick="applyGoalRefine(this,\'create\')">' + t('admin.newGoalBtn') + '</button>';
  html += '</div></div>';
  html += '<button class="btn" style="font-size:11px;margin-left:48px" onclick="continueReverseAsk(this)">' + t('admin.continueAskBtn') + '</button>';

  var wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  msgEl.parentNode.insertBefore(wrapper, msgEl.nextSibling);
}

// ── 多选表单按钮：完善/加入验收/生成新目。──
function applyGoalRefine(btn, action) {
  var form = btn.closest('div');
  while (form && !form.querySelector('input[type=checkbox]')) form = form.parentElement;
  if (!form) return;
  var checks = form.querySelectorAll('input[type=checkbox]:checked');
  if (!checks.length) { toast(t('admin.checkOneAtLeast')); return; }
  var selections = [];
  checks.forEach(function(c) { selections.push(c.parentElement.textContent.trim()); });
  // 也收集自定义输入
  form.querySelectorAll('input[type=text]').forEach(function(inp) { if (inp.value.trim()) selections.push(t('admin.customPrefix') + inp.value.trim()); });

  var goalId = form.getAttribute('data-goal-id') || _currentAskGoalId;
  if (!goalId) { var ri = document.querySelector('#rightGoalsList .goal-item'); if (ri) goalId = ri.getAttribute('data-goal-id'); }
  if (!goalId) { toast(t('admin.goalNotFound')); return; }

  api('/api/goals/' + goalId + '/refine', 'POST', { selections: selections, action: action }).then(function(d) {
    if (d.ok) {
      toast('⚠' + (action === 'create' ? t('admin.goalCreated') : action === 'criteria' ? t('admin.criteriaAdded') : t('admin.goalRefined')));
      if (typeof loadRightGoals === 'function') loadRightGoals();
      if (typeof loadGoals === 'function') loadGoals();
    } else toast('⚠' + _errMsg(d, t('err.operationFail')));
  }).catch(function(e) { toast('⚠' + e.message); });
}

// ── 继续反问：带已选上下文再次向AI提问 ──
function continueReverseAsk(btn) {
  var form = btn.closest('div');
  while (form && !form.querySelector('input[type=checkbox]')) form = form.parentElement;
  if (!form) return;
  var goalId = form.getAttribute('data-goal-id') || _currentAskGoalId;
  if (!goalId) { toast(t('admin.goalNotFound')); return; }
  var context = [];
  form.querySelectorAll('input[type=checkbox]:checked').forEach(function(c) { context.push(c.parentElement.textContent.trim()); });
  form.querySelectorAll('input[type=text]').forEach(function(inp) { if (inp.value.trim()) context.push(t('admin.customPrefix') + inp.value.trim()); });
  var extra = context.length ? context.join('; ') : '';
  toast(t('admin.askingMore'));
  askAIAboutGoal(goalId, extra);
}
async function adminAgents() {
  try {
    const d = await api('/api/agents');
    document.getElementById('adminAgentsOut').textContent = JSON.stringify(d.agents || [], null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminAgentsOut').textContent = '⚠' + e.message; }
}
async function adminSessions() {
  try {
    const d = await api('/api/sessions');
    document.getElementById('adminSessionsOut').textContent = JSON.stringify(d, null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminSessionsOut').textContent = '⚠' + e.message; }
}
async function adminSubAgents() {
  try {
    const d = await api('/api/subagents');
    document.getElementById('adminSubOut').textContent = JSON.stringify(d.tasks || d, null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminSubOut').textContent = '⚠' + e.message; }
}
function spawnSubAgent() {
  const task = prompt(t('admin.subagentPh'));
  if (!task || !clientId) { toast(t('toast.connectFirst')); return; }
  api('/api/subagents/spawn', 'POST', { name: t('admin.manualTask') + Date.now(), task: task, userId: clientId }).then(d => toast(t('admin.taskCreated', {id: d.id}))).catch(e => toast('⚠' + t('err.fail') + ': ' + e.message));
}
async function adminCron() {
  try {
    const d = await api('/api/cron');
    const jobs = d.jobs || [];
    const el = document.getElementById('adminCronOut');
    if (!jobs.length) { el.innerHTML = '<span style="color:var(--text3);font-size:12px">' + t('admin.noCronShort') + '</span>'; return; }
    el.innerHTML = jobs.map(j => {
      const name = j.name || j.id || t('common.unnamed');
      const expr = j.schedule?.expr || j.schedule || '-';
      const next = j.nextRun ? new Date(j.nextRun).toLocaleString() : '-';
      return '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
        '。<b>' + esc(name) + '</b>' +
        ' <span style="color:var(--text3)">' + esc(String(expr)) + '</span>' +
        ' <span style="color:var(--text3);font-size:10px">' + t('admin.nextRunShort', {time: next}) + '</span>' +
        '<span style="float:right">' +
          '<button class="btn-sm" onclick="removeCron(\'' + esc(j.id) + '\')" style="color:var(--red);border-color:var(--red);padding:1px 6px;font-size:10px">' + t('admin.cronDeleteBtn') + '</button>' +
        '</span></div>';
    }).join('');
  } catch(e) { document.getElementById('adminCronOut').textContent = '⚠' + e.message; }
}
function showAddCron() { document.getElementById('addCronForm').classList.toggle('hidden'); }
async function removeCron(id) {
  if (!confirm(t('admin.confirmDeleteCron'))) return;
  try {
    const d = await api('/api/cron/' + encodeURIComponent(id), 'DELETE');
    if (!d.ok) { toast('⚠' + _errMsg(d, t('err.deleteFail'))); return; }
    toast(t('common.deleted'));
    adminCron();
  } catch(e) { toast('⚠' + e.message); }
}
async function addCron() {
  const name = document.getElementById('cronName').value.trim();
  const expr = document.getElementById('cronExpr').value.trim();
  const tz = document.getElementById('cronTz').value.trim();
  let payload;
  try { payload = JSON.parse(document.getElementById('cronPayload').value); } catch(e) { toast(t('admin.payloadJsonError')); return; }
  if (!name || !expr) { toast(t('admin.nameExprRequired')); return; }
  try {
    const d = await api('/api/cron', 'POST', { name, schedule: { kind: 'cron', expr, tz }, payload });
    toast(t('admin.cronCreated')); document.getElementById('addCronForm').classList.add('hidden'); adminCron();
  } catch(e) { toast('⚠' + t('err.fail') + ': ' + e.message); }
}
async function adminMCP() {
  try {
    const d = await api('/api/mcp/servers');
    document.getElementById('adminMCPOut').textContent = JSON.stringify(d.servers || d, null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminMCPOut').textContent = '⚠' + e.message; }
}
function showAddMCP() { document.getElementById('addMCPForm').classList.toggle('hidden'); }
async function addMCP() {
  const name = document.getElementById('mcpName').value.trim();
  const cmd = document.getElementById('mcpCmd').value.trim();
  const argsStr = document.getElementById('mcpArgs').value.trim();
  if (!name || !cmd) { toast(t('admin.nameCmdRequired')); return; }
  const args = argsStr ? argsStr.split(',').map(s=>s.trim()) : [];
  try {
    const d = await api('/api/mcp/servers', 'POST', { id: name, name, command: cmd, args });
    toast(t('admin.mcpAdded')); document.getElementById('addMCPForm').classList.add('hidden'); adminMCP();
  } catch(e) { toast('⚠' + t('err.fail') + ': ' + e.message); }
}
async function adminPlugins() {
  try {
    const d = await api('/api/plugins');
    document.getElementById('adminPluginsOut').textContent = JSON.stringify(d.plugins || d, null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminPluginsOut').textContent = '⚠' + e.message; }
}
async function reloadPlugins() {
  try { const d = await api('/api/plugins/reload', 'POST', {}); toast(t('admin.pluginsReloaded')); adminPlugins(); }
  catch(e) { toast('⚠' + t('err.fail') + ': ' + e.message); }
}

// ── Skill binding (bonus) ──
async function bindSkill(agentId, skillName) {
  try { await api('/api/agents/'+encodeURIComponent(agentId)+'/skills', 'POST', { skill: skillName }); toast(t('admin.skillBound', {skill: skillName})); }
  catch(e) { toast(t('admin.bindFail')); }
}

// ── Utility ──
// ── V5 语音录制 ──
let mediaRecorder = null, audioChunks = [], recordingStream = null, recordingTimer = null, recordingStart = 0;
function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast(t('err.recordUnsupported')); return; }
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    recordingStream = stream;
    audioChunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mpeg';
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunks, { type: mime });
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1];
        // 上传音频文件
        const fd = new FormData();
        fd.append('file', blob, 'voice.' + (mime.includes('webm') ? 'webm' : 'mp3'));
        try {
          var vToken = localStorage.getItem('authToken');
          var vHeaders = {};
          if (vToken) vHeaders['Authorization'] = 'Bearer ' + vToken;
          const res = await fetch('/api/upload', { method: 'POST', headers: vHeaders, body: fd });
          const data = await res.json();
          if (data.ok && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'message', chatId: currentChat || 'chat-demo-1', content: data.url, fileType: 'voice', duration: Math.ceil((Date.now() - recordingStart) / 1000) }));
          }
        } catch(e) { toast(t('err.voiceUploadFail')); }
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(tr => tr.stop());
    };
    mediaRecorder.start();
    recordingStart = Date.now();
    const btn = document.getElementById('recordBtn');
    btn.classList.add('recording');
    recordingTimer = setInterval(() => {
      const sec = Math.ceil((Date.now() - recordingStart) / 1000);
      if (sec >= 60) stopRecording();
    }, 1000);
  }).catch(e => { toast(t('err.micFail')); });
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
  const btn = document.getElementById('recordBtn');
  if (btn) btn.classList.remove('recording');
}

// ── V5 收件。审批/技。渠道面板 ──
function toggleInbox() {
  const p = document.getElementById('inboxPanel');
  if (!p) return;
  p.classList.toggle('open');
  if (p.classList.contains('open')) loadInbox();
}
async function loadInbox() {
  try {
    const d = await api('/api/inbox');
    const items = d.items || [];
    const list = document.getElementById('inboxList');
    if (!list) return;
    list.innerHTML = !items.length ? '<div style="color:#555;font-size:12px;padding:8px">' + t('inbox.none') + '</div>' :
      items.map(i => '<div style="padding:8px;border-bottom:1px solid var(--border);cursor:pointer" onclick="readInbox(\'' + i.id + '\')"><div style="font-size:12px;color:' + (i.read ? 'var(--text3)' : 'var(--text)') + '">' + (i.read ? '⚪' : '🔵') + ' [' + i.type + '] ' + esc(i.title) + '</div><div style="font-size:11px;color:var(--text3)">' + new Date(i.createdAt).toLocaleString('zh-CN') + '</div></div>').join('');
    const badge = document.getElementById('inboxBadge');
    if (badge) { badge.textContent = d.unread || 0; badge.style.display = d.unread ? 'inline-flex' : 'none'; }
  } catch(e) {}
}
async function readInbox(id) {
  try { await api('/api/inbox/' + id + '/read', 'POST'); loadInbox(); } catch(e) {}
}

// ── V5 通知。──
function showNotificationBar(text) {
  const bar = document.getElementById('notificationBar');
  if (!bar) return;
  bar.textContent = text;
  bar.classList.add('show');
  setTimeout(() => bar.classList.remove('show'), 4000);
}
// 修改 handleMessage 增加通知
const _origHandleMessage = window.handleMessage;
window.handleMessage = function(msg) {
  try { _origHandleMessage(msg); } catch(e) { console.error('[handleMessage]', e); }
  if (msg.type === 'message.new' && msg.chatId !== currentChat && document.hidden) {
    showNotification(t('notify.appName'), (msg.senderName || msg.senderId || t('chat.newMessage')) + ': ' + (msg.content || '').slice(0, 50));
  }
};

// ══════════════════════════════════════════════════════════。
// 局域网社交 (LAN Social) 前端
// ══════════════════════════════════════════════════════════。
let lanTab = 'peers';
let lanSelf = null;
let lanCurrentGroup = null;      // 当前打开的群组对。
let lanStreaming = {};           // msgId -> {el, content} 智能体打字气。
let lanSearchTimer = null;
let lanMeId = null;              // 真实登录用户 id（user-xxxx。

// 返回当前登录用户 id（优先用 /api/auth/me 解析出的真实 id。
function lanMyId() { return lanMeId || clientId; }

async function loadSocial() {
  // 解析真实登录用户 id（从云平台获取，引擎 JWT_SECRET 与平台不同，相对路径会验签失败）
  if (!lanMeId && authToken) {
    try {
      const d = await platformApi('/api/user/me', 'GET');
      if (d && d.ok && d.user) lanMeId = d.user.id || d.user.sub || null;
    } catch(_e) {}
  }
  api('/api/lan/status', 'GET').then(d => {
    if (d && d.ok) {
      lanSelf = d;
      const badge = document.getElementById('lanSelfBadge');
      if (badge) badge.textContent = t('social.selfBadge', {ip: d.lanIp || '?', n: d.peerCount || 0});
    }
  }).catch(() => {});
  lanRefresh();
}

function lanSwitchTab(tab) {
  lanTab = tab;
  ['peers', 'friends', 'groups'].forEach(k => {
    const b = document.getElementById('lanTab' + k.charAt(0).toUpperCase() + k.slice(1));
    if (b) { b.style.background = k === tab ? 'var(--accent)' : 'var(--bg3)'; b.style.color = k === tab ? '#fff' : 'var(--text2)'; }
  });
  document.getElementById('lanSearchInput').value = '';
  lanRefresh();
}

function lanRefresh() {
  const list = document.getElementById('lanList');
  if (lanTab === 'peers') {
    api('/api/lan/peers', 'GET').then(d => lanRenderPeers((d && d.peers) || []));
  } else if (lanTab === 'friends') {
    if (!authToken) { list.innerHTML = '<div class="empty">' + t('social.loginToView') + '</div>'; return; }
    Promise.all([
      platformApi('/api/lan/friend-requests', 'GET'),
      platformApi('/api/lan/friends', 'GET'),
    ]).then(([rq, fr]) => lanRenderFriends((rq && rq.incoming) || [], (fr && fr.friends) || []));
  } else {
    api('/api/lan/groups', 'GET').then(d => lanRenderGroups((d && d.groups) || []));
  }
}

function lanSearch() {
  const q = document.getElementById('lanSearchInput').value.trim();
  if (lanSearchTimer) clearTimeout(lanSearchTimer);
  if (!q) { lanRefresh(); return; }
  lanSearchTimer = setTimeout(() => {
    const url = '/api/lan/search?q=' + encodeURIComponent(q);
    if (authToken) {
      platformApi(url, 'GET').then(d => {
        // v2.0.9: token 失效时清除旧 token 并回退本地免登录搜。
        if (!d || d.ok === false) { authToken = null; localStorage.removeItem('authToken'); return api(url, 'GET'); }
        return d;
      }).then(d => lanRenderSearch((d && d.results) || []));
    } else {
      api(url, 'GET').then(d => lanRenderSearch((d && d.results) || []));
    }
  }, 250);
}

function lanRenderPeers(peers) {
  const list = document.getElementById('lanList');
  if (!peers.length) { list.innerHTML = '<div class="empty">' + t('social.noPeers') + '<br><span style="font-size:11px">' + t('social.noPeersHint') + '</span></div>'; return; }
  let html = '';
  for (const p of peers) {
    html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">';
    html += '<div style="font-size:12px;color:var(--accent);margin-bottom:4px">🖥。' + esc(p.lanIp) + ':' + p.port + ' <span style="color:var(--text3);font-size:10px">v' + esc(p.version) + '</span></div>';
    for (const u of (p.users || [])) {
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;font-size:12px">' +
        '<span>👤 ' + esc(u.displayName) + ' <span style="color:var(--text3)">#' + u.numericId + '</span></span>' +
        '<button class="btn-sm" onclick="lanAddFriend(' + u.numericId + ')">' + t('social.addFriend') + '</button></div>';
    }
    html += '</div>';
  }
  list.innerHTML = html;
}

function lanRenderSearch(results) {
  const list = document.getElementById('lanList');
  if (!results.length) { list.innerHTML = '<div class="empty">' + t('social.noUserMatch') + '</div>'; return; }
  let html = '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">' + t('social.searchResults') + '</div>';
  for (const r of results) {
    html += '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:6px;font-size:12px">' +
      '<span>' + (r.local ? '🏠' : '🌐') + ' ' + esc(r.displayName) + ' <span style="color:var(--text3)">#' + r.numericId + '</span></span>' +
      (String(r.numericId) === String(lanMyId()) ? '<span style="color:var(--text3);font-size:10px">' + t('social.localMachine') + '</span>' : '<button class="btn-sm" onclick="lanAddFriend(' + r.numericId + ')">' + t('social.addFriend') + '</button>') +
      '</div>';
  }
  list.innerHTML = html;
}

function lanRenderFriends(incoming, friends) {
  const list = document.getElementById('lanList');
  let html = '';
  if (incoming.length) {
    html += '<div style="font-size:11px;color:var(--accent);margin:4px 0">' + t('social.friendRequests') + '</div>';
    for (const r of incoming) {
      html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:6px;font-size:12px">' +
        '<div>👤 ' + esc(r.fromName || r.fromUserId) + (r.fromNumericId ? ' <span style="color:var(--text3)">#' + r.fromNumericId + '</span>' : '') + '</div>' +
        (r.message ? '<div style="color:var(--text3);font-size:11px;margin:2px 0">' + esc(r.message) + '</div>' : '') +
        '<div style="display:flex;gap:6px;margin-top:4px"><button class="btn-sm" style="background:#16a34a;color:#fff" onclick="lanRespondFriend(\'' + r.id + '\',\'accept\')">' + t('social.acceptBtn') + '</button>' +
        '<button class="btn-sm" onclick="lanRespondFriend(\'' + r.id + '\',\'reject\')">' + t('social.rejectBtn') + '</button></div></div>';
    }
  }
  html += '<div style="font-size:11px;color:var(--accent);margin:4px 0">' + t('social.myFriends') + '</div>';
  if (!friends.length) {
    html += '<div class="empty">' + t('social.noFriends') + '<br><span style="font-size:11px">' + t('social.noFriendsHint') + '</span></div>';
  } else {
    for (const f of friends) {
      html += '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:6px;font-size:12px">' +
        '<span>👤 ' + esc(f.displayName) + (f.numericId ? ' <span style="color:var(--text3)">#' + f.numericId + '</span>' : '') + ' ' + (f.online ? '🟢' : '⚪') + '</span></div>';
    }
  }
  list.innerHTML = html;
}

function lanRenderGroups(groups) {
  const list = document.getElementById('lanList');
  if (!groups.length) { list.innerHTML = '<div class="empty">' + t('social.noGroups') + '<br><span style="font-size:11px">' + t('social.noGroupsHint') + '</span></div>'; return; }
  let html = '';
  for (const g of groups) {
    const active = lanCurrentGroup && lanCurrentGroup.id === g.id;
    html += '<div onclick="lanOpenGroup(\'' + g.id + '\')" style="cursor:pointer;background:' + (active ? 'var(--bg3)' : 'var(--bg)') + ';border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:6px">' +
      '<div style="font-size:13px;font-weight:600">👥 ' + esc(g.name) + '</div>' +
      '<div style="font-size:11px;color:var(--text3);margin-top:2px">' + t('social.memberMode', {n: g.memberCount || 0, mode: esc(g.chatMode || 'free')}) + '</div></div>';
  }
  list.innerHTML = html;
}

async function lanAddFriend(numericId) {
  if (!authToken) { toast(t('social.loginToAdd')); return; }
  const message = prompt(t('social.friendMsgPh', {id: numericId}), '') || '';
  try {
    const r = await platformApi('/api/lan/friend-request', 'POST', { fromUserId: lanMyId(), toNumericId: numericId, message });
    if (r && r.ok !== false && !r.error) toast(t('social.friendReqSent'));
    else toast('⚠' + (r.error || t('err.sendFail')));
  } catch (e) { toast('⚠' + e.message); }
}

async function lanRespondFriend(requestId, action) {
  try {
    const r = await platformApi('/api/lan/friend-respond', 'POST', { requestId, action });
    if (r && !r.error) toast(action === 'accept' ? t('social.friendAdded') : t('friends.rejected'));
    else toast('⚠' + (r.error || t('err.operationFail')));
    lanRefresh();
  } catch (e) { toast('⚠' + e.message); }
}

async function lanShowCreateGroup() {
  const name = prompt(t('social.groupNamePh'), t('social.defaultGroupName'));
  if (!name) return;
  // 动态弹出多选勾选面板：列出邻居用户 + 好友，勾选即可，不用手输数字ID
  showLanMemberPicker(name);
}

// ── LAN 建群成员多选面。──
var _lanPickerName = null;
function showLanMemberPicker(name) {
  _lanPickerName = name;
  var old = document.getElementById('lanPickerWrap');
  if (old) old.remove();
  var wrap = document.createElement('div');
  wrap.id = 'lanPickerWrap';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center';
  wrap.innerHTML = '<div style="background:#1e1f26;border:1px solid #333;border-radius:10px;width:480px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column">' +
    '<div style="padding:12px 16px;border-bottom:1px solid #333;font-size:14px;font-weight:600">👥 选择群成员（勾选，可多选）</div>' +
    '<div id="lanPickerList" style="flex:1;overflow-y:auto;padding:6px 0;min-height:120px"></div>' +
    '<div style="padding:10px 16px;border-top:1px solid #333;display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
    '<button class="btn-sm" onclick="lanPickerAll(true)">全。/button>' +
    '<button class="btn-sm" onclick="lanPickerAll(false)">' + t('common.clear') + '</button>' +
    '<span id="lanPickerCount" style="flex:1;font-size:12px;color:#999"></span>' +
    '<button class="btn-sm btn-accept" onclick="lanPickerCreate()">。创建群组</button>' +
    '<button class="btn-sm" onclick="hideLanPicker()">' + t('common.cancel') + '</button>' +
    '</div></div>';
  wrap.addEventListener('click', function(e) { if (e.target === wrap) hideLanPicker(); });
  document.body.appendChild(wrap);
  loadLanPickerList();
}
function hideLanPicker() { var w = document.getElementById('lanPickerWrap'); if (w) w.remove(); _lanPickerName = null; }
async function loadLanPickerList() {
  var c = document.getElementById('lanPickerList');
  if (!c) return;
  c.innerHTML = '<div style="padding:10px;color:#888;font-size:12px">' + t('common.loading') + '</div>';
  var myId = String(lanMyId());
  var rows = [];
  // 邻居引擎的用。
  try {
    var pd = await api('/api/lan/peers', 'GET');
    var peers = (pd && pd.peers) || [];
    for (var pi = 0; pi < peers.length; pi++) {
      var p = peers[pi];
      for (var ui = 0; ui < (p.users || []).length; ui++) {
        var u = p.users[ui];
        if (String(u.numericId) === myId) continue;
        rows.push({ numericId: u.numericId, label: '🖥。' + esc(p.lanIp) + ':' + p.port + ' · ' + esc(u.displayName) + ' #' + u.numericId });
      }
    }
  } catch(e) {}
  // 平台好友
  try {
    var fr = await platformApi('/api/lan/friends', 'GET');
    var friends = (fr && fr.friends) || [];
    for (var fi = 0; fi < friends.length; fi++) {
      var f = friends[fi];
      if (String(f.numericId) === myId) continue;
      rows.push({ numericId: f.numericId, label: '👤 ' + esc(f.displayName) + ' #' + f.numericId + (f.online ? ' 🟢' : ' ⚪') });
    }
  } catch(e) {}
  if (!rows.length) {
    c.innerHTML = '<div style="padding:10px;color:#888;font-size:12px">没有可选的成员（无邻居用户/好友），可直接创建单人群</div>';
    return;
  }
  c.innerHTML = rows.map(function(r) {
    return '<label style="display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid #222;cursor:pointer">' +
      '<input type="checkbox" class="lanPickerCb" value="' + r.numericId + '">' +
      '<span style="font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + r.label + '</span></label>';
  }).join('');
  lanPickerRefreshCount();
}
function lanPickerAll(on) { document.querySelectorAll('.lanPickerCb').forEach(function(cb){ cb.checked = on; }); lanPickerRefreshCount(); }
function lanPickerRefreshCount() {
  var n = document.querySelectorAll('.lanPickerCb:checked').length;
  var el = document.getElementById('lanPickerCount');
  if (el) el.textContent = '已选 ' + n + ' 人';
}
async function lanPickerCreate() {
  var ids = [];
  document.querySelectorAll('.lanPickerCb:checked').forEach(function(cb){ ids.push(Number(cb.value)); });
  try {
    const r = await api('/api/lan/group-create', 'POST', { ownerUserId: lanMyId(), name: _lanPickerName, memberNumericIds: ids, chatMode: 'free' });
    hideLanPicker();
    if (r && r.ok) { toast(t('social.groupCreated')); lanSwitchTab('groups'); lanOpenGroup(r.groupId); }
    else toast('⚠' + (r.error || t('err.createFail')));
  } catch (e) { toast('⚠' + e.message); }
}

async function lanOpenGroup(groupId) {
  try {
    const d = await api('/api/lan/group?groupId=' + encodeURIComponent(groupId), 'GET');
    if (!d || !d.group) { toast(t('social.groupNotExist')); return; }
    lanCurrentGroup = d.group; try { localStorage.setItem('lingxi-lan-group', JSON.stringify({ humanChatId: d.group.humanChatId, agentChatId: d.group.agentChatId, name: d.group.name })); } catch(e) {};
    // 订阅这个群的两个聊天，接收实时消。
    try {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'subscribe', chatId: d.group.humanChatId }));
        ws.send(JSON.stringify({ type: 'subscribe', chatId: d.group.agentChatId }));
      }
    } catch(_e) {}
    document.getElementById('lanGroupEmpty').style.display = 'none';
    document.getElementById('lanGroupView').style.display = 'flex';
    document.getElementById('lanGroupTitle').textContent = '👥 ' + d.group.name;
    const modeSel = document.getElementById('lanGroupMode');
    if (modeSel) modeSel.value = d.group.chatMode || 'free';
    document.getElementById('lanGroupMembers').textContent = (d.group.members || []).map(m => m.displayName + (m.online ? '🟢' : '⚪')).join(' · ');
    // 高亮左侧
    lanRenderGroups(await api('/api/lan/groups', 'GET').then(x => x.groups || []));
    // 载入两个聊天历史
    lanLoadHistory(d.group.humanChatId, document.getElementById('lanHumanMessages'));
    lanLoadHistory(d.group.agentChatId, document.getElementById('lanAgentMessages'));
  } catch (e) { toast('⚠' + e.message); }
}

async function lanLoadHistory(chatId, container) {
  try {
    const d = await api('/api/chats/' + encodeURIComponent(chatId) + '/messages', 'GET');
    container.innerHTML = '';
    const msgs = (d && d.messages) || [];
    if (!msgs.length) { container.innerHTML = '<div class="empty">' + t('social.noMsg') + '</div>'; return; }
    // 历史消息 DB 不存 senderName，从群成员表解析显示。
    const nameByAgent = {}, nameByUser = {};
    for (const m of (typeof lanCurrentGroup !== 'undefined' && lanCurrentGroup && lanCurrentGroup.members) || []) {
      if (m.agentId) nameByAgent[m.agentId] = m.displayName;
      if (m.userId) nameByUser[m.userId] = m.displayName;
    }
    for (const m of msgs) {
      const isAgentMsg = m.sender_type === 'agent';
      lanAppendMessage({
        chatId, msgId: m.id,
        senderId: m.sender_id, senderType: m.sender_type,
        senderName: isAgentMsg ? nameByAgent[m.sender_id] : nameByUser[m.sender_id],
        content: m.content, timestamp: m.timestamp, metadata: m.metadata,
      }, container);
    }
    container.scrollTop = container.scrollHeight;
  } catch (e) { container.innerHTML = '<div class="empty">' + t('err.loadFail') + '</div>'; }
}

async function lanSetGroupMode(mode) {
  if (!lanCurrentGroup) return;
  try {
    const r = await api('/api/lan/group-mode', 'POST', { groupId: lanCurrentGroup.id, mode });
    if (r && r.ok) toast(t('social.agentMode', {mode: mode}));
    else toast('⚠' + (r.error || t('err.setFail')));
  } catch (e) { toast('⚠' + e.message); }
}

function lanInputKey(e, kind) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); kind === 'human' ? lanSendHuman() : lanSendAgent(); }
}

async function lanSendHuman() {
  if (!lanCurrentGroup) return;
  const input = document.getElementById('lanHumanInput');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  try {
    const r = await api('/api/lan/group-message', 'POST', { senderUserId: lanMyId(), groupId: lanCurrentGroup.id, content });
    if (r && r.error) toast('⚠' + r.error);
  } catch (e) { toast('⚠' + e.message); }
}

async function lanSendAgent() {
  if (!lanCurrentGroup) return;
  const input = document.getElementById('lanAgentInput');
  const topic = input.value.trim();
  if (!topic) return;
  input.value = '';
  try {
    const r = await api('/api/lan/group-agent-topic', 'POST', { senderUserId: lanMyId(), groupId: lanCurrentGroup.id, topic });
    if (r && r.error) toast('⚠' + r.error);
  } catch (e) { toast('⚠' + e.message); }
}

// 渲染一。LAN 消息到指定容。
function lanAppendMessage(msg, container) {
  if (!container) return;
  // 去重：同一 msgId 已渲染则跳过（防重连重放 / 历史与实。echo 重叠。
  if (msg.msgId) {
    const dup = container.querySelector('[data-msgid="' + msg.msgId + '"]');
    if (dup) return dup;
  }
  const empty = container.querySelector('.empty'); if (empty) empty.remove();
  const senderId = msg.senderId || msg.sender_id || '';
  const content = msg.content || '';
  const isAgent = (msg.senderType || msg.sender_type) === 'agent' || senderId.startsWith('agent-');
  const isMe = senderId === lanMyId();
  const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  let name = msg.senderName;
  if (!name) name = isAgent ? '🤖 ' + senderId.replace(/^agent-/, '').slice(0, 16) : senderId.replace(/^user-/, '');
  const el = document.createElement('div');
  el.className = 'msg-row ' + (isMe ? 'me' : (isAgent ? 'ai' : 'other'));
  if (msg.msgId) el.dataset.msgid = msg.msgId;
  // LAN 推理过程：支持直接 reasoning（实时广播）或 metadata（历史回读；双键兼容）
  let _lanThinkText = msg.reasoning || '';
  if (!_lanThinkText && msg.metadata) {
    try { const _md = typeof msg.metadata === 'string' ? JSON.parse(msg.metadata || '{}') : msg.metadata; _lanThinkText = _md.reasoning || _md.reasoning_content || ''; } catch (e) {}
  }
  const _lanThink = _lanThinkText ? '<div class="msg-think" style="cursor:pointer;font-size:12px;color:#8b949e;font-style:italic;padding-bottom:6px;border-bottom:1px solid #30363d;margin-bottom:6px;max-height:3em;overflow:hidden;white-space:pre-wrap" onclick="var m=this.style.maxHeight;this.style.maxHeight=(m===' + "'none'" + '?' + "'3em'" + ':' + "'none'" + ');this.style.overflow=(m===' + "'none'" + '?' + "'hidden'" + ':' + "'visible'" + ')">' + esc(_lanThinkText) + '</div>' : '';
  const bubble = isAgent ? '<div class="msg-content">' + markdownToHtml(content) + '</div>' : '<div class="msg-content">' + esc(content) + '</div>';
  const avatar = isAgent ? '🤖' : (isMe ? '🙂' : '👤');
  // v2.1.4: 智能体消息显示「命。+ 模型」徽。
  const senderLine = isAgent ? _agentNameLine(senderId) : '<div class="msg-sender" style="font-size:10px;color:var(--text3);margin-bottom:2px">' + esc(name) + '</div>';
  el.innerHTML = '<div class="msg-avatar ' + (isAgent ? 'ai' : 'human') + '">' + avatar + '</div>' +
    '<div style="max-width:72%">' + senderLine +
    '<div class="msg-bubble">' + _lanThink + bubble + '</div><div class="msg-meta">' + time + '</div></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

// 智能体打字气泡（LAN 智能体交互框。
function lanStreamingStart(msg) {
  const container = document.getElementById('lanAgentMessages');
  if (!container) return;
  const empty = container.querySelector('.empty'); if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'msg-row ai';
  const name = (msg.senderName || (msg.from || '').replace(/^agent:/, '')).toString();
  const senderLine = _agentNameLine(msg.senderId || msg.from || '');
  el.innerHTML = '<div class="msg-avatar ai">🤖</div><div style="max-width:72%">' + senderLine +
    '<div class="msg-bubble"><div class="msg-think" style="display:none;font-size:12px;color:#8b949e;font-style:italic;padding-bottom:6px;border-bottom:1px solid #30363d;margin-bottom:6px"></div><div class="msg-content"><span class="typing-dot">' + t('chat.thinking') + '</span></div></div></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  lanStreaming[msg.msgId] = { el, content: '', think: '', thinkEl: el.querySelector('.msg-think'), containerId: 'lanAgentMessages', _dead: false, senderId: msg.senderId || msg.from || '' };
}
function lanStreamingChunk(msg) {
  const s = lanStreaming[msg.msgId];
  if (!s) return;
  s.content += msg.chunk || '';
  streamScheduleRender(s);
}
function lanStreamingThink(msg) {
  const s = lanStreaming[msg.msgId];
  if (!s || !s.thinkEl) return;
  s.think = (s.think || '') + (msg.think || '');
  streamScheduleThink(s);
}
function lanStreamingEnd(msg) {
  const s = lanStreaming[msg.msgId];
  if (s) {
    if (s.el && s.el.parentNode) s.el.parentNode.removeChild(s.el);
    delete lanStreaming[msg.msgId];
  }
}

// WS 局域网消息路由
function handleLanMessage(msg) {
  const type = msg.type;
  if (type === 'message.new') {
    const chatId = msg.chatId;
    if (!lanCurrentGroup) return;
    if (chatId === lanCurrentGroup.humanChatId) {
      lanAppendMessage(msg, document.getElementById('lanHumanMessages'));
    } else if (chatId === lanCurrentGroup.agentChatId) {
      // 清除。agent 残留的打字气泡（流式 bubbleId 与终。msgId 不同，按 senderId 匹配），避免重复
      if (msg.senderId) {
        for (const k in lanStreaming) {
          const s = lanStreaming[k];
          if (s && s.senderId === msg.senderId) {
            if (s.el && s.el.parentNode) s.el.parentNode.removeChild(s.el);
            delete lanStreaming[k];
          }
        }
      }
      lanAppendMessage(msg, document.getElementById('lanAgentMessages'));
    }
  } else if (type === 'agent.streaming.start') {
    if (lanCurrentGroup && msg.chatId === lanCurrentGroup.agentChatId) lanStreamingStart(msg);
  } else if (type === 'agent.streaming.think') {
    lanStreamingThink(msg);
  } else if (type === 'agent.streaming.chunk') {
    lanStreamingChunk(msg);
  } else if (type === 'agent.streaming.end') {
    lanStreamingEnd(msg);
  } else if (type === 'lan.agent.note') {
    if (lanCurrentGroup && msg.chatId === lanCurrentGroup.agentChatId) {
      const c = document.getElementById('lanAgentMessages');
      if (c) { const empty = c.querySelector('.empty'); if (empty) empty.remove(); c.insertAdjacentHTML('beforeend', '<div style="text-align:center;font-size:11px;color:var(--text3);margin:4px 0">ℹ️ ' + esc(msg.message || '') + '</div>'); c.scrollTop = c.scrollHeight; }
    }
  } else if (type === 'lan.friend.request') {
    toast(t('social.lanFriendRequest', {name: (msg.from && msg.from.displayName) || ''}));
    loadRequests().catch(()=>{});   // 刷新主界面好友请求列。+ 红点
    if (lanTab === 'friends') lanRefresh();
  } else if (type === 'lan.friend.accepted') {
    toast(t('social.friendAccepted'));
    loadFriends().catch(()=>{});     // 刷新主界面好友列。
    loadRequests().catch(()=>{});   // 刷新主界面请求列。
    if (lanTab === 'friends') lanRefresh();
  } else if (type === 'lan.group.invited') {
    toast(t('social.groupInvited', {name: msg.name || ''}));
    if (lanTab === 'groups') lanRefresh();
  } else if (type === 'lan.group.created') {
    if (lanTab === 'groups') lanRefresh();
  } else if (type === 'error') {
    if (lanCurrentGroup && msg.chatId === lanCurrentGroup.agentChatId) {
      toast('⚠' + (msg.message || t('social.orchestrateFail')));
      const c = document.getElementById('lanAgentMessages');
      if (c) { const empty = c.querySelector('.empty'); if (empty) empty.remove(); c.insertAdjacentHTML('beforeend', '<div style="text-align:center;font-size:11px;color:var(--red);margin:4px 0">。' + esc(msg.message || t('social.orchestrateFailShort')) + '</div>'); c.scrollTop = c.scrollHeight; }
    }
  }
}

// ── 右侧栏：任务监控（Cron 定时任务）──
// ── 实时任务拆解进度渲染 ──
var _taskDecompState = {}; // msgId -> { steps: [], status, total }
function handleTaskProgress(msg) {
  if (!msg.msgId) return;
  var panel = document.getElementById('taskDecompPanel');
  if (!panel) return;
  
  var state = _taskDecompState[msg.msgId] || { steps: [], status: 'planning', total: 0 };
  
  switch (msg.phase) {
    case 'planning':
      panel.style.display = 'block';
      state.status = 'planning';
      state.total = 0;
      document.getElementById('taskDecompTitle').textContent = '\u{1F4CB} ' + (msg.message || '正在分析任务...');
      document.getElementById('taskDecompSteps').innerHTML = '<div style="color:var(--text3)">\u23F3 ' + esc(msg.message || '正在分析任务...') + '</div>';
      document.getElementById('taskDecompSummary').textContent = '';
      break;
    
    case 'plan_ready':
      panel.style.display = 'block';
      state.status = 'executing';
      state.total = msg.total || 0;
      state.steps = (msg.steps || []).map(function(s) {
        return { id: s.id, name: s.name, status: 'pending' };
      });
      document.getElementById('taskDecompTitle').textContent = '\u{1F4CB} ' + esc(msg.message || ('任务已拆分为 ' + state.total + ' 个步骤'));
      renderTaskDecompSteps(msg.msgId);
      break;
    
    case 'step_start':
      state.status = 'executing';
      for (var i = 0; i < state.steps.length; i++) {
        if (state.steps[i].id === msg.stepId) {
          state.steps[i].status = 'running';
          break;
        }
      }
      renderTaskDecompSteps(msg.msgId);
      break;
    
    case 'step_done':
      for (var i = 0; i < state.steps.length; i++) {
        if (state.steps[i].id === msg.stepId) {
          state.steps[i].status = (msg.success === false) ? 'failed' : 'done';
          break;
        }
      }
      renderTaskDecompSteps(msg.msgId);
      break;
    
    case 'completed':
      state.status = 'completed';
      var finalStatus = (msg.success === false) ? 'failed' : 'done';
      for (var i = 0; i < state.steps.length; i++) {
        if (state.steps[i].status === 'running') state.steps[i].status = finalStatus;
      }
      renderTaskDecompSteps(msg.msgId);
      var dur = msg.duration ? (msg.duration / 1000).toFixed(1) + 's' : '';
      document.getElementById('taskDecompSummary').textContent = 
        (msg.success ? '\u2705 全部完成' : '\u26A0\uFE0F 部分失败') + (dur ? ' · 耗时 ' + dur : '');
      (function(mid) {
        setTimeout(function() {
          if (_taskDecompState[mid] && _taskDecompState[mid].status === 'completed') {
            var p = document.getElementById('taskDecompPanel');
            if (p) p.style.display = 'none';
            delete _taskDecompState[mid];
          }
        }, 10000);
      })(msg.msgId);
      break;
    
    case 'failed':
      state.status = 'failed';
      renderTaskDecompSteps(msg.msgId);
      document.getElementById('taskDecompSummary').textContent = '\u274C ' + esc(msg.message || '任务失败');
      break;
  }
  
  _taskDecompState[msg.msgId] = state;
}

function renderTaskDecompSteps(msgId) {
  var state = _taskDecompState[msgId];
  if (!state) return;
  var el = document.getElementById('taskDecompSteps');
  if (!el) return;
  
  var icons = { pending: '\u23F3', running: '\u{1F504}', done: '\u2705', failed: '\u274C' };
  var colors = { pending: 'var(--text3)', running: 'var(--accent)', done: 'var(--green)', failed: 'var(--red)' };
  
  if (state.status === 'planning' || state.steps.length === 0) {
    el.innerHTML = '<div style="color:var(--text3)">\u23F3 正在分析任务...</div>';
    return;
  }
  
  var html = state.steps.map(function(s, i) {
    var icon = icons[s.status] || '\u23F3';
    var color = colors[s.status] || 'var(--text3)';
    var anim = s.status === 'running' ? ' style="animation:blink 1s infinite"' : '';
    return '<div' + anim + ' style="color:' + color + '">' + icon + ' 步骤 ' + (i + 1) + '/' + state.total + ': ' + esc(s.name) + '</div>';
  }).join('');
  
  el.innerHTML = html;
}

async function loadTaskMonitor() {
  const el = document.getElementById('taskMonitorList');
  if (!el) return;
  try {
    const d = await api('/api/cron');
    const jobs = d.jobs || [];
    if (!jobs.length) {
      el.innerHTML = '<span style="color:var(--text3)">' + t('task.empty') + '</span>';
      return;
    }
    el.innerHTML = jobs.map(j => {
      const name = esc(j.name || j.id || t('common.unnamed'));
      const expr = esc(String(j.schedule?.expr || j.schedule || '-'));
      const enabled = j.enabled !== false;
      const pill = enabled ? '<span class="status-pill pill-on">' + t('task.running') + '</span>' : '<span class="status-pill pill-off">' + t('task.paused') + '</span>';
      const next = j.nextRun ? new Date(j.nextRun).toLocaleString() : '-';
      const lastRun = j.lastRun ? new Date(j.lastRun).toLocaleString() : '-';
      const runCount = j.runCount || 0;
      const jid = esc(j.id);
      const runBtn = enabled
        ? '<button class="run" onclick="runTaskMonitor(\'' + jid + '\')">' + t('task.run') + '</button><button onclick="toggleTaskMonitor(\'' + jid + '\',false)">' + t('task.pause') + '</button>'
        : '<button class="run" onclick="runTaskMonitor(\'' + jid + '\')">' + t('task.run') + '</button><button style="color:var(--green)" onclick="toggleTaskMonitor(\'' + jid + '\',true)">' + t('task.enable') + '</button>';
      return '<div class="task-card">' +
        '<div class="task-name">' + name + ' ' + pill + '</div>' +
        '<div class="task-meta">' + t('task.expr') + '<code>' + expr + '</code><br>' + t('task.nextRun') + esc(next) + '<br>' + t('task.lastRun') + esc(lastRun) + ' · ' + t('task.runCount', {n: runCount}) + '</div>' +
        '<div class="task-actions">' + runBtn +
          '<button class="del" onclick="removeTaskMonitor(\'' + jid + '\')">' + t('common.delete') + '</button>' +
        '</div></div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<span style="color:var(--red)">。' + esc(e.message || t('err.loadFail')) + '</span>';
  }
}
async function runTaskMonitor(id) {
  try {
    const d = await api('/api/cron/' + encodeURIComponent(id) + '/run', 'POST');
    if (d.ok) { toast(t('task.triggered')); loadTaskMonitor(); }
    else toast('⚠' + t('err.runFail'));
  } catch(e) { toast('⚠' + e.message); }
}
async function toggleTaskMonitor(id, enabled) {
  try {
    const d = await api('/api/cron/' + encodeURIComponent(id), 'PATCH', { enabled });
    if (d.ok) { toast(enabled ? t('task.enabled') : t('task.paused')); loadTaskMonitor(); }
    else toast('⚠' + t('err.operationFail'));
  } catch(e) { toast('⚠' + e.message); }
}
async function removeTaskMonitor(id) {
  if (!confirm(t('admin.confirmDeleteCron'))) return;
  try {
    const d = await api('/api/cron/' + encodeURIComponent(id), 'DELETE');
    if (d.ok) { toast(t('common.deleted')); loadTaskMonitor(); }
    else toast('⚠' + t('err.deleteFail'));
  } catch(e) { toast('⚠' + e.message); }
}

// ── 右侧栏：目标任务（GoalTracker）──
const RIGHT_GOAL_EMOJI = { pending: '⏳', in_progress: '🔄', done: '✅', cancelled: '❌' };
function rightGoalLabel(st) {
  var m = { pending: t('right.goalPending'), in_progress: t('right.goalProgress'), done: t('right.goalDone'), cancelled: t('right.goalCancelled') };
  return m[st] || st;
}
const RIGHT_GOAL_COLOR = { pending: 'var(--text3)', in_progress: 'var(--accent)', done: 'var(--green)', cancelled: 'var(--text3)' };
async function loadRightGoals() {
  const el = document.getElementById('rightGoalsList');
  if (!el) return;
  try {
    const project = currentChat ? ('project-' + currentChat) : 'default';
    const d = await api('/api/goals?project=' + encodeURIComponent(project));
    if (!d.ok) { el.innerHTML = '<span style="color:var(--red)">。' + esc(_errMsg(d, t('err.loadFail'))) + '</span>'; return; }
    const goals = d.goals || [];
    if (!goals.length) {
      el.innerHTML = '<span style="color:var(--text3)">' + t('right.noGoals') + '</span>';
      return;
    }
    const done = goals.filter(g => g.status === 'done').length;
    const total = goals.length;
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    el.innerHTML = goals.map(g => {
      const st = g.status || 'pending';
      const emoji = RIGHT_GOAL_EMOJI[st] || '🔊';
      const label = rightGoalLabel(st);
      const color = RIGHT_GOAL_COLOR[st] || 'var(--text3)';
      const style = st === 'done' ? 'text-decoration:line-through;color:var(--text3)' : (st === 'cancelled' ? 'color:var(--text3)' : '');
      const gid = esc(g.id);
      let acts = '';
      if (st === 'pending') acts += '<a onclick="setRightGoalStatus(\'' + gid + '\',\'in_progress\')" title="' + t('admin.goalStart') + '" style="cursor:pointer;font-size:16px">▶️</a> ';
      if (st !== 'done' && st !== 'cancelled') acts += '<a onclick="setRightGoalStatus(\'' + gid + '\',\'done\')" title="' + t('admin.goalDone') + '" style="cursor:pointer;font-size:16px">。/a> ';
      if (st === 'done' || st === 'cancelled') acts += '<a onclick="setRightGoalStatus(\'' + gid + '\',\'pending\')" title="' + t('admin.goalRestore') + '" style="cursor:pointer;font-size:16px">↩️</a> ';
      acts += '<a onclick="askAIAboutGoal(\'' + gid + '\',\'' + esc(g.title).replace(/'/g, "\\'") + '\')" title="' + t('admin.aiAskTitle') + '" style="cursor:pointer;font-size:16px">。/a> ';
      acts += '<a onclick="deleteRightGoal(\'' + gid + '\')" title="' + t('common.delete') + '" style="cursor:pointer;font-size:16px">🗑。/a>';
      const criteria = g.acceptanceCriteria ? '<div style="font-size:10px;color:var(--text3);margin-top:3px">' + esc(g.acceptanceCriteria) + '</div>' : '';
      const barColor = st === 'done' ? 'var(--green)' : 'var(--accent)';
      const barWidth = st === 'done' ? 100 : (st === 'in_progress' ? 50 : 0);
      return '<div class="goal-item">' +
        '<div class="goal-head"><span class="g-status">' + emoji + '</span>' +
        '<b style="' + style + '">' + esc(g.title) + '</b>' +
        '<span style="margin-left:auto;font-size:11px;color:' + color + '">' + label + '</span></div>' +
        '<div class="goal-bar"><i style="width:' + barWidth + '%;background:' + barColor + '"></i></div>' +
        '<div class="goal-foot"><span>' + t('right.progress', {n: barWidth}) + '</span>' +
        '<span style="float:right">' + acts + '</span></div>' +
        criteria + '</div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<span style="color:var(--red)">。' + esc(e.message || t('err.networkError')) + '</span>';
  }
}
async function addRightGoal() {
  const title = prompt(t('right.goalNamePh'));
  if (!title) return;
  const desc = prompt(t('right.goalDescPh'));
  try {
    const project = currentChat ? ('project-' + currentChat) : 'default';
    const d = await api('/api/goals', 'POST', { title: title.trim(), acceptanceCriteria: desc || '', project: project });
    if (d.ok) { toast(t('admin.goalAdded')); loadRightGoals(); }
    else toast('⚠' + _errMsg(d, t('err.addFail')));
  } catch(e) { toast('⚠' + e.message); }
}
async function setRightGoalStatus(id, status) {
  try {
    const d = await api('/api/goals/' + encodeURIComponent(id), 'PATCH', { status });
    if (d.ok) loadRightGoals();
    else toast('⚠' + _errMsg(d, t('err.operationFail')));
  } catch(e) { toast('⚠' + e.message); }
}
async function deleteRightGoal(id) {
  if (!confirm(t('right.confirmDeleteGoal'))) return;
  try {
    const d = await api('/api/goals/' + encodeURIComponent(id), 'DELETE');
    if (d.ok) { toast(t('common.deleted')); loadRightGoals(); }
    else toast('⚠' + _errMsg(d, t('err.deleteFail')));
  } catch(e) { toast('⚠' + e.message); }
}

// ── 运行日志面板 ──
async function loadLogBody() {
  var el = document.getElementById('logBody');
  if (!el) return;
  try {
    var d = await api('/api/logs?limit=100');
    var logs = d.logs || d || [];
    if (!Array.isArray(logs)) logs = [];
    el.innerHTML = logs.map(function(l) {
      var level = (l.level || 'info').toLowerCase();
      var color = level === 'error' ? 'var(--red)' : level === 'warn' ? 'var(--yellow)' : 'var(--green)';
      var time = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '';
      return '<div class="log-line"><span style="color:' + color + '">[' + level.toUpperCase() + ']</span> <span style="color:var(--text3)">' + time + '</span> ' + esc(l.message || l.msg || '') + '</div>';
    }).join('');
    el.scrollTop = el.scrollHeight;
  } catch(e) {
    el.innerHTML = '<div class="log-line"><span style="color:var(--red)">。' + esc(e.message || '') + '</span></div>';
  }
}
var _autoLogTimer = null;
function toggleAutoLog() {
  if (_autoLogTimer) {
    clearInterval(_autoLogTimer);
    _autoLogTimer = null;
    toast('自动刷新已关闭');
  } else {
    loadLogBody();
    _autoLogTimer = setInterval(loadLogBody, 3000);
    toast('自动刷新已开。· 3s');
  }
}
function clearLogBody() {
  var el = document.getElementById('logBody');
  if (el) el.innerHTML = '<div class="log-line"><span class="info">日志已清。/span></div>';
}

// ── 子任务面板（右侧。SubAgents）──
function loadSubAgents(){
  fetch('/api/subagents').then(function(r){return r.json()}).then(function(d){
    var el=document.getElementById('subAgentList');
    if(!el) return;
    if(!d.ok||!d.tasks||!d.tasks.length){ el.innerHTML='<span style="color:var(--text3)">' + (typeof t==='function'?t('common.noData','暂无数据'):'暂无子任务') + '</span>'; return; }
    var esc=function(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
    el.innerHTML=d.tasks.map(function(t){
      var st=t.status==='completed'?'✅':t.status==='failed'?'❌':t.status==='timeout'?'⏱':(t.status==='running'?'🔄':'❓');
      var stc=t.status==='completed'?'#2e7d32':(t.status==='failed'||t.status==='timeout')?'#c62828':'#1565c0';
      return '<div style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">'+
        '<div style="font-weight:600;font-size:12px">'+st+' '+esc((t.taskName||'').slice(0,30))+'</div>'+
        '<div style="font-size:11px;color:var(--text3);margin:2px 0">目标: '+esc((t.objective||'').slice(0,100))+'</div>'+
        '<div style="font-size:11px;color:'+stc+'">状。 '+t.status+(t.model?' · '+esc(t.model):'')+'</div>'+
        (t.result?'<div style="font-size:11px;color:var(--text3);margin-top:4px;word-break:break-all">'+esc(t.result.slice(0,300))+'</div>':'')+
        (t.error?'<div style="font-size:11px;color:#c62828;margin-top:2px">'+esc(t.error)+'</div>':'')+
        '</div>';
    }).join('');
  }).catch(function(){});
}
setInterval(loadSubAgents, 15000);
