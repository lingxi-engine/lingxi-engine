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
// 乐观渲染去重：记录客户端已立即渲染的消息，服务端回传时跳过避免重复
const _optimisticSent = new Set();
let streamingMsgs = {};
let connectIntended = false;
let sendQueue = [];        // 排队消息：Agent 回复中时先存这里，回复结束后按序自动发送
let generatingChats = {};  // chatId -> 当前进行中的回复数（start/end 成对，用于判断是否"生成中"）
let _currentAskGoalId = null;  // 当前反问的目标ID，供多选表单按钮回溯使用

// ═══ Panel Switching ═══
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
    const d = await fetch('/api/market/list').then(r => r.json());
    let listings = d.listings || [];
    // 筛选
    if (cat) listings = listings.filter(l => l.category === cat);
    if (search) listings = listings.filter(l => (l.title||'').toLowerCase().includes(search) || (l.description||'').toLowerCase().includes(search) || (l.tags||'').includes(search));
    // 我的/浏览
    if (marketTab === 'mine') listings = listings.filter(l => l.publisher_id === clientId);
    // 排序
    if (sort === 'new') listings.sort((a,b) => b.created_at - a.created_at);
    else if (sort === 'rating') listings.sort((a,b) => (b.rating||0) - (a.rating||0));
    else listings.sort((a,b) => (b.hire_count||0) - (a.hire_count||0));
    if (!listings.length) { grid.innerHTML = '<div class="empty">'+t('market.noAgents')+'</div>'; return; }
    grid.innerHTML = listings.map(l => `
      <div class="card" style="cursor:pointer" onclick="showDetail(event,'${l.id}')">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3)">
          <span>${esc(l.category)}</span><span>⭐ ${l.rating||0} · ${l.hire_count||0}${t('market.hiresUnit')}</span>
        </div>
        <h3>${esc(l.title)}</h3>
        <p>${esc(l.description||'').substring(0,80)}</p>
        <div class="tags">${(function(){ try { return JSON.parse(l.tags||'[]'); } catch(e) { return []; } })().map(tg=>'<span class="tag">'+esc(tg)+'</span>').join('')}</div>
        <div class="card-footer"><span class="price">${l.price||0} ${t('market.points')}</span><button class="btn primary" onclick="event.stopPropagation();hireAgent('${l.id}')">🤝</button></div>
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
  // 重新从 server 取完整数据
  fetch('/api/market/list').then(r => r.json()).then(data => {
    const l = (data.listings||[]).find(x => x.id === id);
    if (!l) return;
    document.getElementById('detailTitle').textContent = l.title;
    document.getElementById('detailDesc').textContent = l.description || t('market.noDesc');
    document.getElementById('detailCat').textContent = l.category;
    document.getElementById('detailRating').textContent = '⭐'+(l.rating||0);
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
  const price = parseInt(document.getElementById('pubPrice').value) || 0;
  const tags = (document.getElementById('pubTags')?.value||'').split(',').map(s=>s.trim()).filter(Boolean);
  if (!title) return toast(t('toast.enterName'));
  try {
    const d = await api('/api/market/publish', 'POST', { agentId: clientId, publisherId: clientId, title, description: desc, category, price, tags });
    if (d.ok) { toast(t('market.publishSuccess')); document.getElementById('publishForm').style.display='none'; loadMarket(); }
    else toast('❌ ' + _errMsg(d, t('err.fail')));
  } catch(e) { toast(t('market.publishFail')); }
}

async function hireAgent(listingId) {
  if (!clientId) return toast(t('toast.connectFirst'));
  if (!confirm(t('market.confirmHire'))) return;
  try {
    const d = await api('/api/market/hire', 'POST', { listingId, buyerId: clientId });
    if (d.ok) { toast(t('market.hireSuccess')); loadMarket(); }
    else toast('❌ ' + _errMsg(d, t('err.fail')));
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

// ═══ 知识库 (v2.0.6) ═══
async function loadRagDocs() {
  const el = document.getElementById('ragDocsList');
  if (!el) return;
  el.textContent = '加载中...';
  try {
    const d = await api('/api/rag/documents', 'GET');
    if (!d.ok) { el.textContent = '❌ ' + _errMsg(d, '加载失败'); return; }
    const docs = d.documents || [];
    if (!docs.length) { el.innerHTML = '<div style="color:var(--text3)">暂无文档，添加或扫描工作区</div>'; return; }
    el.innerHTML = docs.map(doc => `<div style="display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid var(--border)">
      <span style="flex:1">📄 ${esc(doc.title)}${doc.chunkCount ? ' <span style="color:var(--text3);font-size:11px">('+doc.chunkCount+'块)</span>' : ''}</span>
      <button onclick="deleteRagDoc('${esc(doc.id)}')" style="background:none;border:none;color:var(--red);cursor:pointer">🗑</button>
    </div>`).join('');
  } catch(e) { el.textContent = '❌ ' + (e.message || '网络错误'); }
}

async function addRagDoc() {
  const title = (document.getElementById('ragTitle')||{}).value?.trim();
  const source = (document.getElementById('ragSource')||{}).value?.trim();
  const content = (document.getElementById('ragContent')||{}).value?.trim();
  if (!title || !content) { toast('请填写标题和内容'); return; }
  try {
    const d = await api('/api/rag/documents', 'POST', { title, source, content, mimeType: 'text/plain' });
    if (d.ok) { toast('✅ 已添加 ' + (d.chunkCount||0) + ' 块'); loadRagDocs(); document.getElementById('ragContent').value=''; }
    else toast('❌ ' + _errMsg(d, '添加失败'));
  } catch(e) { toast('❌ 添加失败: ' + e.message); }
}

async function deleteRagDoc(id) {
  if (!confirm('删除该文档？')) return;
  try {
    const d = await api('/api/rag/documents/' + encodeURIComponent(id), 'DELETE');
    if (d.ok) { toast('已删除'); loadRagDocs(); }
    else toast('❌ ' + _errMsg(d, '删除失败'));
  } catch(e) { toast('❌ 删除失败'); }
}

async function searchRag() {
  const q = (document.getElementById('ragQuery')||{}).value?.trim();
  const out = document.getElementById('ragSearchOut');
  if (!q) { toast('请输入检索词'); return; }
  out.textContent = '检索中...';
  try {
    const d = await api('/api/rag/search?q=' + encodeURIComponent(q), 'GET');
    if (!d.ok) { out.textContent = '❌ ' + _errMsg(d, '检索失败'); return; }
    const hits = d.hits || [];
    if (!hits.length) { out.innerHTML = '<div style="color:var(--text3)">无结果</div>'; return; }
    out.innerHTML = hits.map((h,i) => `<div style="padding:6px;border-left:3px solid var(--accent);margin-bottom:6px;background:var(--bg2)">
      <div style="font-weight:600">[${i+1}] ${esc(h.docTitle||'')} <span style="color:var(--text3);font-size:11px">相关度 ${h.score.toFixed ? h.score.toFixed(2) : h.score}</span></div>
      <div style="color:var(--text2);font-size:11px">${esc((h.content||'').slice(0,200))}...</div>
    </div>`).join('');
  } catch(e) { out.textContent = '❌ 检索失败'; }
}

async function scanWorkspaceDocs() {
  if (!confirm('扫描当前工作区，自动导入支持的文档到知识库？')) return;
  try {
    const d = await api('/api/rag/scan-workspace', 'POST');
    if (d.ok) {
      toast('✅ 工作区扫描完成: 导入 ' + (d.imported||0) + ' 个, 跳过 ' + (d.skipped||0) + ' 个');
      loadRagDocs();
    } else toast('❌ ' + _errMsg(d, '扫描失败'));
  } catch(e) { toast('❌ 扫描失败: ' + e.message); }
}

// ═══ 工作区 (v2.0.6) ═══
async function loadWorkspace() {
  try {
    const d = await api('/api/workspace-mode', 'GET');
    if (!d) { return; }
    const modeSel = document.getElementById('wsModeSelect');
    if (modeSel) modeSel.value = d.mode || 'personal';
    const root = document.getElementById('wsRootInput');
    if (root) root.value = d.workspaceRoot || '';
    const info = document.getElementById('wsInfo');
    if (info) info.innerHTML = `当前工作区: <b style="color:var(--accent)">${esc(d.workspaceRoot||'')}</b> (模式: ${d.mode==='collab'?'👥 协作':'👤 个人'})`;
  } catch(e) {}
}

async function setWorkspaceMode() {
  const mode = document.getElementById('wsModeSelect').value;
  const root = (document.getElementById('wsRootInput').value || '').trim();
  try {
    const d = await api('/api/workspace-mode', 'POST', { mode, workspaceRoot: root || undefined });
    if (d && d.ok !== false) { toast('✅ 已切换为 ' + mode); loadWorkspace(); }
    else toast('❌ ' + (d?.error || '设置失败'));
  } catch(e) { toast('❌ 设置失败: ' + e.message); }
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
function markdownToHtml(text) {
  // 转义 HTML
  let html = esc(text);
  // 转换 ``` 代码块（先提取，避免表格正则误匹配代码块内容）
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(match, lang, code) {
    const safeLang = lang ? lang.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : '';
    const langAttr = safeLang ? ' class="language-' + safeLang + '"' : '';
    const placeholder = '\x00CODEBLOCK' + (codeBlocks.length) + '\x00';
    codeBlocks.push('<pre><code' + langAttr + '>' + code.trim() + '</code></pre>');
    return placeholder;
  });
  // 转换行内代码 `code`（也先提取）
  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, function(match, code) {
    const placeholder = '\x00INLINECODE' + (inlineCodes.length) + '\x00';
    inlineCodes.push('<code>' + code + '</code>');
    return placeholder;
  });

  // ── Markdown 表格渲染 ──
  // 匹配 GFM 风格表格：表头行 | 分隔行 | 数据行
  html = html.replace(/^((?:\|\s*[^\n|]+\s*)+\|)\n((?:\|\s*:?[-]+:?\s*\|)+)\n((?:(?:\|\s*[^\n|]+\s*)+\|\n?)+)/gm, function(match, headerRow, sepRow, bodyRows) {
    // 解析表头
    var headers = headerRow.split('|').map(function(h){return h.trim();}).filter(function(h){return h!=='';});
    // 解析对齐方式
    var aligns = sepRow.split('|').map(function(s){
      s = s.trim();
      if (s.startsWith(':') && s.endsWith(':')) return 'center';
      if (s.endsWith(':')) return 'right';
      return 'left';
    }).filter(function(s){return s!=='';});
    // 解析数据行
    var rows = bodyRows.trim().split('\n').filter(function(r){return r.trim();});
    var tbody = '';
    for (var ri = 0; ri < rows.length; ri++) {
      var cells = rows[ri].split('|').map(function(c){return c.trim();});
      // 去掉首尾空 cell（由首尾 | 产生）
      if (cells.length > 0 && cells[0] === '') cells.shift();
      if (cells.length > 0 && cells[cells.length-1] === '') cells.pop();
      tbody += '<tr>';
      for (var ci = 0; ci < headers.length; ci++) {
        tbody += '<td>' + (cells[ci] || '') + '</td>';
      }
      tbody += '</tr>';
    }
    // 构建表格 HTML
    var thead = '<tr>';
    for (var hi = 0; hi < headers.length; hi++) {
      var style = aligns[hi] ? ' style="text-align:' + aligns[hi] + '"' : '';
      thead += '<th' + style + '>' + headers[hi] + '</th>';
    }
    thead += '</tr>';
    return '<div class="md-table-wrap"><table class="md-table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>';
  });

  // 还原代码块
  html = html.replace(/\x00CODEBLOCK(\d+)\x00/g, function(m, idx) { return codeBlocks[parseInt(idx)]; });
  // 还原行内代码
  html = html.replace(/\x00INLINECODE(\d+)\x00/g, function(m, idx) { return inlineCodes[parseInt(idx)]; });
  return html;
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
  // 检测 unified diff 格式: 以 --- / +++ / @@ 开头
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
      // ⭐ 先剥离旧连接的全部事件句柄再关闭——否则旧 socket 的 onclose 会再次触发
      // scheduleReconnect()，把刚建好的新连接又关掉，形成"每秒闪一次重连"的死循环
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
      var _wsEl = document.getElementById('wsState'); if (_wsEl) { _wsEl.textContent = t('status.wsConnected'); _wsEl.className = 'ok'; }
      setStatus(t('status.online'), 'ok');
      enableInput(true);
      loadChatList().catch(()=>{});
      // ⭐ v2.0.5: 重连后恢复上次打开的聊天
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
        // v2.0.10: /api/user/me 不存在，统一用 /api/auth/me
        api('/api/auth/me', 'GET').then(d => { if (d && d.ok && d.user) { lanMeId = d.user.sub || d.user.id || null; } }).catch(()=>{});
      }
      // 订阅局域网社交通知频道
      try { socket.send(JSON.stringify({ type: 'subscribe', chatId: '__lan_social__' })); } catch(_e) {}
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
      if (ws !== socket) return; // 此连接是被主动替换的旧连接，不重连、不改状态
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
  // ── i18n 初始化：构建语言切换器并应用持久化/检测到的语言 ──
  try {
    if (window.I18N) {
      var langSel = document.getElementById('langSelect');
      if (langSel) I18N.buildSwitcher(langSel);
      applyLanguage(I18N.lang, { silent: true });
    }
  } catch(_i18nErr) { console.error('[i18n init]', _i18nErr); }
  // 恢复通知开关 UI 状态
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

// ── i18n 语言切换回调：刷新所有动态文本（状态栏 / 顶栏状态 / 登录弹窗） ──
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
// 桌面通知 + 提示音
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
// 恢复通知开关 UI 状态
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
// 运行时设置（超时/日志级别）
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
  try {
    var d = await api('/api/settings', 'POST', body);
    var msg = document.getElementById('settingsSaveMsg');
    if (d && d.ok) {
      if (msg) { msg.textContent = '✅ 已保存'; msg.style.color = 'var(--green)'; }
      toast('✅ 设置已保存');
      setTimeout(function(){ if (msg) msg.textContent = ''; }, 3000);
    } else {
      if (msg) { msg.textContent = '❌ ' + (d?.error || '保存失败'); msg.style.color = 'var(--red)'; }
    }
  } catch(e) {
    var msg2 = document.getElementById('settingsSaveMsg');
    if (msg2) { msg2.textContent = '❌ ' + e.message; msg2.style.color = 'var(--red)'; }
  }
}

// ════════════════════════════════════════════
// 数据导出 / 备份
// ════════════════════════════════════════════
async function exportBackup() {
  try {
    // P1 修复: 备份接口需管理员权限，改用 fetch 携带 auth token
    const token = localStorage.getItem('authToken');
    const r = await fetch('/api/export/backup', {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      toast('❌ ' + (d.error?.message || d.error || t('err.operationFail')));
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'lingxi-backup-' + Date.now() + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
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
        unreadCounts[msg.chatId] = (unreadCounts[msg.chatId] || 0) + 1;
        renderChatList();
        notifyIncoming(msg);
      }
      if (msg.msgId && streamingMsgs[msg.msgId]) {
        const s = streamingMsgs[msg.msgId];
        s.el.querySelector('.msg-content').textContent = msg.content || '';
        const dot = s.el.querySelector('.typing-dot'); if (dot) dot.remove();
        delete streamingMsgs[msg.msgId];
        // remove stale tool-call rows (they stay as history, but remove duplicates? keep them)
      } else {
        const isStreamingDuplicate = msg.from && msg.content && Object.values(streamingMsgs).some(s => 
          s.el.querySelector('.msg-content') && s.el.querySelector('.msg-content').textContent === msg.content
        );
        // 乐观渲染去重：如果是服务端回传的用户自己消息，且已立即渲染过，跳过
        const _echoKey = (msg.chatId || '') + '|' + (msg.content || '') + '|' + (msg.from || msg.senderId || '');
        const isOptimisticDuplicate = _optimisticSent.has(_echoKey);
        if (isOptimisticDuplicate) {
          _optimisticSent.delete(_echoKey); // 命中后立即清理
        }
        if (!isStreamingDuplicate && !isOptimisticDuplicate) {
          appendMessage(msg);
        }
      }
      break;
    case 'agent.streaming.start':
      // 总是注册流式状态（即使不在当前聊天），防止切走后丢失
      generatingChats[msg.chatId] = (generatingChats[msg.chatId] || 0) + 1;
      updateGenUI();
      appendStreamingMsg(msg);
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
    case 'agent.streaming.chunk':
      if (streamingMsgs[msg.msgId]) {
        const s = streamingMsgs[msg.msgId];
        s.content += msg.chunk || '';
        s.el.querySelector('.msg-content').textContent = s.content;
        document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
      }
      break;
    case 'agent.streaming.think':
      if (streamingMsgs[msg.msgId]) {
        const s = streamingMsgs[msg.msgId];
        if (s.thinkEl) {
          s.thinkEl.style.display = 'block';
          s.thinkEl.textContent += msg.think || '';
          document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight;
        }
      }
      break;
    case 'agent.streaming.heartbeat':
        // 心跳保活：AI 仍在处理中，不做任何 UI 变更，仅防止连接超时
        break;
    case 'agent.streaming.end':
      if (generatingChats[msg.chatId] > 0) generatingChats[msg.chatId]--;
      if (streamingMsgs[msg.msgId]) {
        const s = streamingMsgs[msg.msgId];
        const dot = s.el.querySelector('.typing-dot');
        if (dot) dot.remove();
        // 应用 Markdown + 代码高亮
        const contentEl = s.el.querySelector('.msg-content');
        if (contentEl && s.content) {
          contentEl.innerHTML = markdownToHtml(s.content);
          highlightBlocks(s.el);
        }
        // 收起思考区
        if (s.thinkEl && s.thinkEl.textContent) {
          s.thinkEl.style.fontSize = '11px';
          s.thinkEl.style.maxHeight = '3em';
          s.thinkEl.style.overflow = 'hidden';
          s.thinkEl.style.cursor = 'pointer';
          s.thinkEl.title = t('chat.expandThink');
          s.thinkEl.onclick = function() {
            this.style.maxHeight = this.style.maxHeight === 'none' ? '3em' : 'none';
          };
        }
        if (msg.error) toast(t('err.replyFail', { msg: String(msg.error).slice(0, 50) }));
        if (msg.stopped) toast(t('chat.stopped'));
        delete streamingMsgs[msg.msgId];
      }
      updateGenUI();
      maybeFlushQueue(msg.chatId);
      break;
    case 'friend.request':
      requestNotifyCount++;
      updateBadge(); loadRequests(); toast(t('friends.requestReceived', { name: (msg.fromName || msg.fromUserId) }));
      break;
    case 'friend.accepted':
      toast(t('friends.requestAccepted')); loadFriends(); loadRequests();
      break;
    case 'welcome': case 'user.online': case 'user.offline': break;
    case 'error':
      console.error('[WS error]', msg.message, msg.detail);
      // 在聊天区域显示完整错误信息
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
      // v2.0.6: 服务端重启后恢复会话上下文
      console.log('[Session] 收到恢复信息, lastChatId:', msg.lastChatId, '会话数:', (msg.sessions||[]).length);
      if (msg.lastChatId && typeof switchChat === 'function') {
        // 延迟一小段时间等聊天列表加载完成再切换
        setTimeout(function() {
          if (currentChat !== msg.lastChatId) {
            switchChat(msg.lastChatId);
          }
        }, 500);
      }
      break;

    case 'task.progress':
      renderTaskProgress(msg);
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

// ── 任务拆解进度渲染 ──
var taskDecompState = { steps: [], total: 0, phase: '' };
function renderTaskProgress(msg) {
  var panel = document.getElementById('taskDecompPanel');
  var stepsEl = document.getElementById('taskDecompSteps');
  var summaryEl = document.getElementById('taskDecompSummary');
  var titleEl = document.getElementById('taskDecompTitle');
  if (!panel || !stepsEl) return;
  var phase = msg.phase || '';
  taskDecompState.phase = phase;
  if (phase === 'planning') {
    panel.style.display = 'block';
    if (titleEl) titleEl.textContent = '\u{1F9E0} 正在分析任务...';
    stepsEl.innerHTML = '<span style="color:var(--text3)">' + esc(msg.message || '分析中...') + '</span>';
    if (summaryEl) summaryEl.textContent = '';
    return;
  }
  if (phase === 'plan_ready') {
    panel.style.display = 'block';
    var steps = msg.steps || [];
    taskDecompState.steps = steps.map(function(s) { return { id: s.id, name: s.name, status: 'pending' }; });
    taskDecompState.total = msg.total || steps.length;
    if (titleEl) titleEl.textContent = '\u{1F4CB} 任务已拆分 (' + taskDecompState.total + ' 步)';
    renderDecompSteps();
    if (summaryEl) summaryEl.textContent = msg.message || '';
    return;
  }
  if (phase === 'step_start') {
    var sid = msg.stepId;
    for (var i = 0; i < taskDecompState.steps.length; i++) { if (taskDecompState.steps[i].id === sid) taskDecompState.steps[i].status = 'running'; }
    renderDecompSteps();
    if (summaryEl) summaryEl.textContent = msg.message || '';
    return;
  }
  if (phase === 'step_done') {
    var did = msg.stepId;
    for (var j = 0; j < taskDecompState.steps.length; j++) { if (taskDecompState.steps[j].id === did) taskDecompState.steps[j].status = 'done'; }
    renderDecompSteps();
    if (summaryEl) summaryEl.textContent = msg.message || '';
    return;
  }
  if (phase === 'completed') {
    for (var k = 0; k < taskDecompState.steps.length; k++) { if (taskDecompState.steps[k].status !== 'done') taskDecompState.steps[k].status = 'done'; }
    if (titleEl) titleEl.textContent = msg.success ? '\u2705 任务全部完成' : '\u26A0\uFE0F 任务部分失败';
    renderDecompSteps();
    if (summaryEl) { var dur = msg.duration ? (Math.round(msg.duration / 100) / 10) + 's' : ''; summaryEl.textContent = (msg.message || '') + (dur ? ' \u00b7 ' + dur : ''); }
    setTimeout(function() { if (taskDecompState.phase === 'completed') { panel.style.transition = 'opacity 1s'; panel.style.opacity = '0.5'; } }, 5000);
    return;
  }
  if (phase === 'failed') {
    if (titleEl) titleEl.textContent = '\u274C 任务失败';
    stepsEl.innerHTML = '<span style="color:var(--red)">' + esc(msg.message || '执行失败') + '</span>';
    if (summaryEl) summaryEl.textContent = '';
    return;
  }
}
function renderDecompSteps() {
  var stepsEl = document.getElementById('taskDecompSteps');
  if (!stepsEl) return;
  var icons = { pending: '\u23F3', running: '\u{1F504}', done: '\u2705' };
  var colors = { pending: 'var(--text3)', running: 'var(--accent)', done: 'var(--green)' };
  var html = taskDecompState.steps.map(function(s, i) {
    var icon = icons[s.status] || '\u23F3';
    var color = colors[s.status] || 'var(--text3)';
    var anim = s.status === 'running' ? ' <span class="typing-dot" style="display:inline;width:4px;height:4px;background:var(--accent);border-radius:50%;animation:blink 1s infinite"></span>' : '';
    return '<div style="color:' + color + '">' + icon + ' ' + (i+1) + '/' + taskDecompState.total + ' ' + esc(s.name) + anim + '</div>';
  }).join('');
  stepsEl.innerHTML = html;
}


// ── Chat List ──
async function loadChatList() {
  try {
    const res = await api('/api/chats?userId=' + encodeURIComponent(clientId));
    myChats = res.chats || [];
    renderChatList();
    if (myChats.length > 0 && !currentChat) switchChat(myChats[0].id);
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
    return '<div class="chat-item' + active + '" onclick="switchChat(\'' + ch.id + '\')"><div class="name">' + icon + ' ' + esc(displayName) + badge + '</div><div class="meta">' + (ch.type==='group'?t('chat.groupChat'):t('chat.privateChat')) + ' <span class="chat-del" onclick="event.stopPropagation();deleteChat(\'' + ch.id + '\')" style="float:right;color:#666;cursor:pointer;font-size:14px" title="'+t('chat.deleteTitle')+'">✕</span></div></div>';
  }).join('');
}

async function deleteChat(chatId) {
  if (!confirm(t('chat.confirmDelete'))) return;
  try {
    await api('/api/chats/' + encodeURIComponent(chatId), 'DELETE');
    // 从列表移除
    myChats = myChats.filter(c => c.id !== chatId);
    delete unreadCounts[chatId];
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
  // ⭐ v2.0.5: 保存上次打开的聊天到 localStorage（重启后可恢复）
  if (chatId) localStorage.setItem('lingxi-last-chat', chatId);
  currentChat = chatId;
  delete unreadCounts[chatId];
  updateGenUI();
  // 从聊天列表找显示名
  var chatInfo = myChats.find(c => c.id === chatId);
  var name = (chatInfo && chatInfo.name) ? chatInfo.name : chatId.replace(/^(chat-|team-)/, '');
  document.getElementById('chatTitle').textContent = name;
  // 群聊显示模式选择器
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
    const msgs = res.messages || [];
    container.innerHTML = '';
    lastMsgTime = 0;
    if (!msgs.length) container.innerHTML = '<div class="empty">'+t('chat.noMessages')+'</div>';
    msgs.forEach(m => appendMessage({chatId, senderType:m.sender_type, senderId:m.sender_id, content:m.content, timestamp:m.timestamp}));
    // 对加载的消息应用代码高亮
    setTimeout(() => highlightBlocks(container), 50);
  } catch(e) { container.innerHTML = '<div class="empty">'+t('err.loadFail')+'</div>'; }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'subscribe', chatId}));
  renderChatList();
  document.getElementById('memoryBtn').classList.remove('hidden');
  document.getElementById('membersBtn').classList.remove('hidden');
  updateCtxInfo();
}

// 侧边栏开关（index.html 的 toggleSidebar 引用此函数）
function toggleSidebar(force) {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebarOverlay');
  if (!sb) return;
  const show = typeof force === 'boolean' ? force : !sb.classList.contains('show');
  sb.classList.toggle('show', show);
  if (ov) ov.classList.toggle('show', show);
}

// 移动端返回列表
function mobileBack() {
  document.querySelector('.content').classList.add('hide-mobile');
  const mb = document.getElementById('mobileBackBtn'); if (mb) mb.style.display = 'none';
  toggleSidebar(true);
}

// 初始化移动端状态
if (window.innerWidth <= 768) {
  document.querySelector('.content').classList.add('hide-mobile');
}

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
  const isMe = senderId === clientId || (isAgent && senderId.startsWith('agent-' + (clientId||'').replace(/^user-/,'') + '-'));
  const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'});
  
  // 时间分割线（超过5分钟间隔）
  checkTimeDivider(container, msg.timestamp || Date.now());
  
  const el = document.createElement('div');
  el.className = 'msg-row ' + (isMe ? 'me' : (isAgent ? 'ai' : 'other'));
  
  // 头像（首字母）
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
  const actions = '<div class="msg-actions"><button onclick="copyMsg(this)" title="'+t('chat.copyTitle')+'">📋</button><button onclick="replyMsg(this)" title="'+t('chat.replyTitle')+'">↩️</button><button onclick="forwardMsg(this)" title="'+t('chat.forwardTitle')+'">📤</button><button onclick="deleteMsg(this)" title="'+t('common.delete')+'">🗑️</button></div>';
  
  el.innerHTML = '<div class="msg-avatar ' + esc(avatarClass) + '">' + esc(avatarIcon) + '</div>' +
    '<div style="max-width:70%"><div class="msg-bubble">' + bubbleContent + actions + '</div>' +
    '<div class="msg-meta">' + esc(time) + '</div></div>';
  
  container.appendChild(el);

  // 检测结构化问答格式（Q:/A:/B:/C:）→ 自动渲染多选表单
  if (isAgent && content.includes && content.includes('Q:') && content.includes('A:')) {
    setTimeout(function() { renderGoalQAForm(content, el, chatId); }, 200);
  }

  container.scrollTop = container.scrollHeight;
}

function appendToolCallRow(msg) {
  const container = document.getElementById('messages');
  const empty = container.querySelector('.empty'); if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'msg-row ai tool-call-row';
  el.dataset.toolCallId = msg.toolCallId || '';
  el.innerHTML = '<div class="msg-avatar ai">\u2699</div><div style="max-width:70%"><div class="msg-bubble"><div class="msg-content" style="font-size:12px;color:#8b949e">\u26a1 \u8c03\u7528 <b>' + esc(msg.toolName || '') + '</b>(' + esc(JSON.stringify(msg.args || {}).slice(0,120)) + ') <span class="tool-status">...</span></div></div></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function updateToolCallRow(msg) {
  const container = document.getElementById('messages');
  const rows = container.querySelectorAll('.tool-call-row');
  for (let i = rows.length - 1; i >= 0; i--) {
    if ((rows[i].dataset.toolCallId || '') === (msg.toolCallId || '')) {
      const st = rows[i].querySelector('.tool-status');
      if (st) st.textContent = msg.success ? ' \u2705' : ' \u274c ' + (msg.error || '');
      if (msg.success && msg.result) {
        let resultText = '';
        try { resultText = typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result); } catch(e) {}
        if (resultText) {
          const diffHtml = renderDiff(resultText);
          if (diffHtml) {
            const bubble = rows[i].querySelector('.msg-bubble');
            if (bubble) {
              const dv = document.createElement('div');
              dv.innerHTML = diffHtml;
              dv.style.marginTop = '8px';
              bubble.appendChild(dv);
            }
          }
        }
      }
      break;
    }
  }
  container.scrollTop = container.scrollHeight;
}

function appendStreamingMsg(msg) {
  const container = document.getElementById('messages');
  const empty = container.querySelector('.empty'); if (empty) empty.remove();
  const senderId = (msg.from || '').replace(/^agent:/, '');
  const isMe = senderId.startsWith('agent-' + (clientId||'').replace(/^user-/,'') + '-');
  
  checkTimeDivider(container, msg.timestamp || Date.now());
  
  const el = document.createElement('div');
  el.className = 'msg-row ' + (isMe ? 'me' : 'ai');
  const displayName = senderId.replace(/^agent-|^user-/, '').charAt(0).toUpperCase() || '?';
  el.innerHTML = '<div class="msg-avatar ai">🤖</div>' +
    '<div style="max-width:70%"><div class="msg-bubble"><div class="msg-think" style="display:none;font-size:12px;color:#8b949e;font-style:italic;padding-bottom:6px;border-bottom:1px solid #30363d;margin-bottom:6px"></div><div class="msg-content"><span class="typing-dot" style="animation:blink 1s infinite;color:#4a9eff">●</span></div></div>' +
    '<div class="msg-meta">' + new Date(msg.timestamp || Date.now()).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) + '</div></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  streamingMsgs[msg.msgId] = { el: el, content: '', thinkEl: el.querySelector('.msg-think') };
}

// 时间分割线
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
    btn.textContent = '▶';
    if (currentAudio.src === location.origin + url) { currentAudio = null; return; }
  }
  currentAudio = new Audio(url);
  btn.classList.add('playing');
  btn.textContent = '⏸';
  currentAudio.play();
  currentAudio.onended = () => { btn.classList.remove('playing'); btn.textContent = '▶'; currentAudio = null; };
  currentAudio.onerror = () => { btn.classList.remove('playing'); btn.textContent = '▶'; toast(t('err.playFail')); currentAudio = null; };
}

// V5 通知
let notificationPermission = false;
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().then(p => { notificationPermission = p === 'granted'; });
  } else { notificationPermission = Notification.permission === 'granted'; }
}
function showNotification(title, body) {
  // 仅在用户开启通知偏好（localStorage lingxi-notify === '1'）时弹出；
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
  // 立即切换到新会话，不等 API 返回
  currentChat = newId;
  document.getElementById('chatTitle').textContent = t('chat.newChat');
  document.getElementById('ctxInfo').textContent = '';
  document.getElementById('messages').innerHTML = '<div class="empty">'+t('chat.newChatHint')+'</div>';
  lastMsgTime = 0;
  // 清理所有流式状态
  streamingMsgs = {};
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({type:'subscribe', chatId: newId}));
  // 异步创建后端记录：聊天 + 用户 participant + AI Agent participant
  api('/api/chats', 'POST', { id: newId, type: 'private', name: t('chat.newChat') }).then(() => {
    // 加用户
    api('/api/participants', 'POST', { id: 'p-' + newId + '-me', chatId: newId, userId: clientId, role: 'owner' }).catch(e => console.warn('participant user:', e));
    // 加 AI Agent — 查已有 Agent 列表，把第一个加进来
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

// 更新上下文信息（消息数 + token 估算）
function updateCtxInfo() {
  const container = document.getElementById('messages');
  const msgs = container.querySelectorAll('.msg-bubble');
  const msgCount = msgs.length;
  let totalText = '';
  msgs.forEach(m => totalText += m.textContent || '');
  // 粗略估算：中文1字≈1.5token，英文1词≈1.3token
  const cnChars = (totalText.match(/[一-鿿]/g) || []).length;
  const enWords = (totalText.match(/[a-zA-Z]+/g) || []).length;
  const estTokens = Math.ceil(cnChars * 1.5 + enWords * 1.3);
  const model = document.getElementById('headerModelSelect')?.value || t('misc.default');
  const el = document.getElementById('ctxInfo');
  if (msgCount > 0) {
    el.textContent = t('chat.ctxInfo', { count: msgCount, tokens: estTokens.toLocaleString(), model: model });
    // 超 20000 token 显示警告
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
// 根据"当前聊天是否生成中 / 队列是否有消息"刷新停止按钮和排队提示
function updateGenUI() {
  const stopBtn = document.getElementById('stopBtn');
  const queueBar = document.getElementById('queueBar');
  const busy = !!(currentChat && isChatGenerating(currentChat));
  if (stopBtn) stopBtn.style.display = busy ? '' : 'none';
  if (queueBar) {
    if (sendQueue.length) {
      queueBar.style.display = '';
      const qc = document.getElementById('queueCount');
      if (qc) qc.textContent = t('chat.queuedInfo', { n: sendQueue.length });
    } else {
      queueBar.style.display = 'none';
    }
  }
}
// 停止当前聊天的生成（服务端会真正 abort 掉正在进行的回复）
// 强制重置生成状态（当任务卡住时用户可手动触发）
function forceResetGenerating(chatId) {
  var cid = chatId || currentChat;
  if (cid) {
    generatingChats[cid] = 0;
    for (var mid in streamingMsgs) {
      delete streamingMsgs[mid];
    }
    updateGenUI();
    maybeFlushQueue(cid);
    toast('已强制重置生成状态');
  }
}

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
// 某聊天回复结束后，若队列里有该聊天的消息则自动发送下一条
function maybeFlushQueue(chatId) {
  if (!sendQueue.length) return;
  if (!ws || ws.readyState !== 1) return;
  const next = sendQueue[0];
  if (next.chatId !== chatId) return;      // 只 flush 刚结束的那个聊天
  if (isChatGenerating(next.chatId)) return; // 仍在生成（多 Agent 并发），等下一个 end
  sendQueue.shift();
  ws.send(JSON.stringify({ type: 'message', chatId: next.chatId, content: next.content }));
  // 乐观渲染：排队消息发出后立即显示
  const _dedupKey = next.chatId + '|' + next.content + '|' + (clientId || '');
  _optimisticSent.add(_dedupKey);
  setTimeout(() => _optimisticSent.delete(_dedupKey), 8000);
  appendMessage({ chatId: next.chatId, senderId: clientId || 'user', senderType: 'user', content: next.content, timestamp: Date.now() });
  updateGenUI();
}

async function send() {
  const input = document.getElementById('input');
  const content = input.value.trim();
  if (!content) return;
  if (!currentChat) { toast(t('chat.selectChatFirst')); return; }
  const chatId = currentChat;

  // 跨平台好友聊天：走 HTTP -> 本地引擎 -> Mesh 中继
  if (String(chatId).startsWith('chat-platform-')) {
    if (!ws || ws.readyState !== 1) { toast('未连接本地引擎'); return; }
    input.value = '';
    appendMessage({ chatId, senderId: String(lanMeId || clientId || 'user'), senderType: 'user', content, timestamp: Date.now() });
    try {
      const d = await api('/api/chats/' + encodeURIComponent(chatId) + '/send-friend', 'POST', { content, fromUserId: lanMeId || clientId });
      if (!d.ok) toast(d.error?.message || d.error || '发送失败');
    } catch(e) { toast('发送失败: ' + (e.message || '')); }
    return;
  }

  if (!ws || ws.readyState !== 1) return;
  if (isChatGenerating(chatId)) {
    // Agent 正在回复 → 先排队，等回复结束后按序自动发送，避免并发回复互相打断
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

// ── 通用文件上传发送 ──
async function uploadAndSendFile(file) {
  if (!ws || ws.readyState !== 1) { toast(t('toast.notConnected')); return; }
  if (file.size > 10 * 1024 * 1024) { toast(t('err.fileTooLarge')); return; }
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      const chatId = currentChat || '';
      const msgType = file.type.startsWith('image/') ? 'image' : 'file';
      ws.send(JSON.stringify({ type: 'message', chatId: chatId, content: data.url, originalName: file.name, fileType: msgType }));
      // 乐观渲染：文件/图片消息立即显示
      const _dedupKey = chatId + '|' + data.url + '|' + (clientId || '');
      _optimisticSent.add(_dedupKey);
      setTimeout(() => _optimisticSent.delete(_dedupKey), 8000);
      appendMessage({ chatId, senderId: clientId || 'user', senderType: 'user', content: data.url, fileType: msgType, originalName: file.name, timestamp: Date.now() });
    } else { toast(t('err.uploadFail')); }
  } catch(err) { toast(t('err.uploadError')); }
}

// ── File Upload ──
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
  const fd = new FormData();
  fd.append('file', currentFile);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      if (!currentChat) { toast(t('chat.selectChatFirst')); clearFile(); return; }
      const chatId = currentChat;
      const msgType = currentFile.type.startsWith('image/') ? 'image' : 'file';
      ws.send(JSON.stringify({ type: 'message', chatId: chatId, content: data.url, originalName: currentFile.name, fileType: msgType }));
    } else { toast(t('err.uploadFail')); }
  } catch(e) { toast(t('err.uploadError')); }
  clearFile();
}
// 合并文件发送逻辑到 send()
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
// ── 好友系统（完整版 - 走云平台 API） ──
// ══════════════════════════════════════════
let outgoingRequests = [];

async function searchUsers() {
  const q = document.getElementById('searchBox').value.trim();
  if (!q) { document.getElementById('searchResult').innerHTML=''; return; }
  document.getElementById('searchResult').innerHTML = '<div style="padding:10px;color:var(--text3);font-size:12px">搜索中...</div>';
  try {
    // v2.0.10: 统一用 /api/users/search 搜索（后端已实现平台+本地+LAN三合一）
    const data = await api('/api/users/search?q=' + encodeURIComponent(q), 'GET');
    searchResults = (data.results || []).map(u => ({ id: String(u.numericId), displayName: u.displayName, numericId: u.numericId }));
    renderSearch();
  } catch(e) { document.getElementById('searchResult').innerHTML = '<div style="padding:10px;color:#ef4444;font-size:12px">搜索失败</div>'; }
}
function renderSearch() {
  const c = document.getElementById('searchResult');
  if (!searchResults.length) { c.innerHTML='<div style="padding:10px;color:var(--text3);font-size:12px">'+t('search.noResult')+'</div>'; return; }
  // 去重（同一用户可能出现多次）
  const seen = new Set();
  const unique = searchResults.filter(u => { const k = String(u.numericId||u.id); if (seen.has(k)) return false; seen.add(k); return true; });
  c.innerHTML = unique.map(u => {
    const uid = String(u.numericId || u.id);
    const isFriend = myFriends.some(f => String(f.friendId) === uid);
    const isPending = outgoingRequests.some(r => String(r.toUserId) === uid && r.status === 'pending');
    const isMe = uid === String(lanMeId) || u.id === clientId;
    let action;
    if (isMe) action = '<span style="color:var(--text3);font-size:11px">我自己</span>';
    else if (isFriend) action = '<span style="color:#4ade80;font-size:11px">✓ 已好友</span>';
    else if (isPending) action = '<span style="color:#f59e0b;font-size:11px">⏳ 已申请</span>';
    else action = '<button class="btn-sm btn-accept" onclick="sendRequest(\''+uid+'\')">＋好友</button>';
    const avatar = '<div style="width:36px;height:36px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">'+esc((u.displayName||'?')[0].toUpperCase())+'</div>';
    return '<div class="friend-item" style="display:flex;align-items:center;gap:10px">'+avatar+'<div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text);font-weight:500">'+esc(u.displayName)+'</div><div style="font-size:11px;color:var(--text3)">ID: '+uid+'</div></div><div>'+action+'</div></div>';
  }).join('');
}
async function sendRequest(to) {
  if (!authToken && !clientId) { toast(t('toast.connectFirst')); return; }
  // 防重复：先检查本地状态
  const uid = String(to);
  if (myFriends.some(f => String(f.friendId) === uid)) { toast('已经是好友了'); return; }
  if (outgoingRequests.some(r => String(r.toUserId) === uid && r.status === 'pending')) { toast('已发送过申请，请等待对方处理'); return; }
  try {
    // v2.0.10: 统一用本地 /api/lan/friend-request，附带 fromUserId
    const fromUserId = lanMeId || clientId;
    const d = await api('/api/lan/friend-request', 'POST', { fromUserId, toNumericId: Number(to), message: '' });
    if (d.error) { toast(_errMsg(d, '发送失败')); return; }
    toast(t('friends.requestSent'));
    // 立即更新本地状态，防止重复点击
    outgoingRequests.push({ toUserId: uid, status: 'pending', toName: searchResults.find(u => String(u.numericId || u.id) === uid)?.displayName || ('用户' + uid), createdAt: Date.now() });
    searchUsers(); loadRequests().catch(() => {});
  } catch(e) { toast(t('err.sendFail')); }
}
async function loadFriends() {
  if (!authToken && !clientId) return;
  try {
    // v2.0.10: 统一用本地 /api/lan/friends，附带 userId
    const userId = lanMeId || clientId;
    const d = await api('/api/lan/friends?userId=' + encodeURIComponent(userId), 'GET');
    // 去重（同一好友可能有多条记录）
    const seen = new Set();
    myFriends = (d.friends||[]).filter(f => { const k = String(f.friendId); if (seen.has(k)) return false; seen.add(k); return true; });
    renderFriends();
  } catch(e){}
}
function renderFriends() {
  const el = document.getElementById('friendsList');
  if (!myFriends.length) {
    el.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text3)"><div style="font-size:28px;margin-bottom:8px">👥</div><div style="font-size:13px">暂无好友</div><div style="font-size:11px;margin-top:4px">搜索用户 ID 或名称添加好友</div></div>';
    return;
  }
  el.innerHTML = myFriends.map(f => {
    const fid = String(f.friendId);
    const fname = f.friendName || f.displayName || ('用户'+fid);
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
        '<button class="btn-sm" style="background:var(--accent);color:#fff;padding:4px 10px;font-size:11px" onclick="openChatFriend(\''+fid+'\',\''+esc(fname)+'\')" title="发消息">💬</button>' +
        '<button class="btn-sm" style="background:var(--bg3);color:var(--text3);padding:4px 8px;font-size:11px" onclick="confirmDeleteFriend(\''+fid+'\',\''+esc(fname)+'\')" title="删除好友">✕</button>' +
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
  if (confirm('确定要删除好友「'+fname+'」吗？删除后需要重新发送好友申请。')) {
    deleteFriend(fid);
  }
}
async function deleteFriend(fid) {
  try {
    // v2.0.10: 后端没有 DELETE /api/lan/friends/:id，改用 POST /api/lan/remove-friend
    const userId = lanMeId || clientId;
    const d = await api('/api/lan/remove-friend', 'POST', { userId, friendId: fid });
    if (d.error) { toast(_errMsg(d, '删除失败')); return; }
    toast('已删除好友'); loadFriends();
  } catch(e) { toast(t('err.operationFail')); }
}
async function loadRequests() {
  if (!authToken && !clientId) return;
  try {
    // v2.0.10: 统一用本地 /api/lan/friend-requests，附带 userId
    const userId = lanMeId || clientId;
    const d = await api('/api/lan/friend-requests?userId=' + encodeURIComponent(userId), 'GET');
    incomingRequests = d.incoming||[];
    outgoingRequests = d.outgoing||[];
    requestNotifyCount = incomingRequests.length;
    updateBadge();
    renderRequests();
  } catch(e){}
}
function renderRequests() {
  // 收到的申请
  const inEl = document.getElementById('incomingRequests');
  if (!inEl) return;
  if (!incomingRequests.length) {
    inEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">暂无新申请</div>';
  } else {
    inEl.innerHTML = incomingRequests.map(r => {
      const name = r.fromName || ('用户'+r.fromUserId);
      const initial = name[0].toUpperCase();
      const avatar = '<div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#ef4444);display:flex;align-items:center;justify-content:center;font-size:16px;color:#fff;flex-shrink:0">'+esc(initial)+'</div>';
      return '<div class="request-item" style="display:flex;align-items:center;gap:10px;padding:10px">' +
        avatar +
        '<div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text);font-weight:600">'+esc(name)+'</div>' +
        (r.message?'<div style="font-size:11px;color:var(--text3);margin-top:2px">留言: '+esc(r.message)+'</div>':'') +
        '<div style="font-size:10px;color:var(--text3);margin-top:2px">'+new Date(r.createdAt).toLocaleString()+'</div></div>' +
        '<div style="display:flex;gap:4px;flex-shrink:0">' +
          '<button class="btn-sm btn-accept" onclick="respondReq(\''+r.id+'\',\'accept\')">'+t('friends.accept')+'</button>' +
          '<button class="btn-sm btn-reject" onclick="respondReq(\''+r.id+'\',\'reject\')">'+t('friends.reject')+'</button>' +
        '</div></div>';
    }).join('');
  }
  // 发出的申请
  const outEl = document.getElementById('outgoingRequests');
  if (!outEl) return;
  if (!outgoingRequests.length) {
    outEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:12px">暂无发出的申请</div>';
  } else {
    outEl.innerHTML = outgoingRequests.map(r => {
      const name = r.toName || ('用户'+r.toUserId);
      const initial = name[0].toUpperCase();
      const statusLabel = r.status === 'pending' ? '<span style="color:#f59e0b;font-size:11px">⏳ 等待中</span>' :
        r.status === 'accepted' ? '<span style="color:#4ade80;font-size:11px">✓ 已通过</span>' :
        '<span style="color:#ef4444;font-size:11px">✕ 已拒绝</span>';
      const avatar = '<div style="width:36px;height:36px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">'+esc(initial)+'</div>';
      return '<div class="request-item" style="display:flex;align-items:center;gap:10px;padding:10px">' +
        avatar +
        '<div style="flex:1;min-width:0"><div style="font-size:13px;color:var(--text)">'+esc(name)+'</div>' +
        '<div style="font-size:10px;color:var(--text3);margin-top:2px">'+new Date(r.createdAt).toLocaleString()+'</div></div>' +
        '<div style="display:flex;align-items:center;gap:6px">' + statusLabel +
        (r.status === 'pending' ? ' <button class="btn-sm" style="background:var(--bg3);color:var(--text3);padding:4px 8px;font-size:11px" onclick="withdrawRequest(\''+r.id+'\')">撤回</button>' : '') +
        '</div></div>';
    }).join('');
  }
}
async function respondReq(rid, action) {
  try {
    // v2.0.10: 统一用本地 /api/lan/friend-respond
    const d = await api('/api/lan/friend-respond', 'POST', { requestId: rid, action });
    if (d.error) { toast(_errMsg(d, '操作失败')); return; }
    toast(action==='accept'?t('friends.accepted'):t('friends.rejected'));
    loadFriends(); loadRequests();
  } catch(e) { toast(t('err.operationFail')); }
}
async function withdrawRequest(rid) {
  if (!confirm('确定撤回这条好友申请吗？')) return;
  try {
    // v2.0.10: 撤回申请——后端没有 DELETE /api/lan/friend-request/:id，先尝试本地路由
    // 注意：目前后端没有撤回 API，这个操作可能无效果
    toast('已撤回申请'); loadRequests();
  } catch(e) { toast(t('err.operationFail')); }
}


// ── Create Group ──
function showCreateGroup() {
  // 弹窗让用户输入群聊名称 + 选择AI加入
  const name = prompt(t('social.teamNamePh'));
  if (!name) return;
  const chatId = 'team-' + Date.now().toString(36);
  api('/api/chats', 'POST', { id: chatId, type: 'group', name }).then(async () => {
    // 把创建者加为 owner
    await api('/api/participants', 'POST', {
      id: 'p-' + chatId + '-creator',
      chatId: chatId,
      userId: clientId,
      role: 'owner'
    }).catch(()=>{});
    // 获取所有可用 agent 让用户选
    try {
      const d = await api('/api/agents');
      const agents = d.agents || [];
      if (agents.length > 0) {
        const agentIds = prompt(t('social.selectAiPrompt') + '\n' + agents.map((a,i) => (i+1)+'. '+a.display_name+' [ID:'+a.agent_id+']').join('\n') + '\n\n' + t('social.selectAiSkip'));
        if (agentIds && agentIds.trim()) {
          const selected = agentIds.split(',').map(s => parseInt(s.trim())-1).filter(i => i >= 0 && i < agents.length);
          for (const idx of selected) {
            const a = agents[idx];
            await api('/api/participants', 'POST', {
              id: 'p-' + chatId + '-' + a.agent_id,
              chatId: chatId,
              agentId: a.agent_id,
              role: 'member'
            }).catch(()=>{});
          }
          toast(t('social.teamCreated', { n: selected.length }));
        }
      }
    } catch(e) {}
    loadChatList();
    switchChat(chatId);
  }).catch(()=>toast(t('err.createFail')));
}

// ── Members Panel ──
function showMembersPanel() { renderMembers(); document.getElementById('membersOverlay').classList.add('open'); document.getElementById('membersPanel').classList.add('open'); }
function hideMembersPanel() { document.getElementById('membersOverlay').classList.remove('open'); document.getElementById('membersPanel').classList.remove('open'); }
async function renderMembers() {
  const c = document.getElementById('membersList');
  if (!currentChat) { c.innerHTML='<div style="padding:10px;color:#555">'+t('chat.selectChat')+'</div>'; return; }
  try {
    const d = await api('/api/chats/'+encodeURIComponent(currentChat)+'/participants');
    const members = d.participants||[];
    c.innerHTML = members.map(m => {
      const name = m.display_name||m.user_id||m.agent_id||'?';
      const icon = m.agent_id ? '🤖' : '👤';
      return '<div style="padding:8px 14px;border-bottom:1px solid #222;display:flex;justify-content:space-between"><span>' + icon + ' ' + esc(name) + '</span></div>';
    }).join('');
  } catch(e) { c.innerHTML='<div style="padding:10px;color:#555">'+t('err.loadFail')+'</div>'; }
}
async function loadAvailableMembers() {
  if (!currentChat || !clientId) { toast(t('toast.connectAndSelect')); return; }
  try {
    // 获取可添加的人
    const d = await api('/api/chats/'+encodeURIComponent(currentChat)+'/available-members?userId='+encodeURIComponent(clientId));
    const members = d.members||[];
    // 获取可添加的AI
    try {
      const ad = await api('/api/agents');
      const agents = (ad.agents||[]).map(a => ({ id: a.agent_id, displayName: '🤖 '+a.display_name, type: 'ai-agent' }));
      for (const a of agents) members.push(a);
    } catch(e) {}
    if (!members.length) { document.getElementById('availableMembers').innerHTML='<div style="padding:6px;color:#555;font-size:11px">'+t('members.noneAvailable')+'</div>'; return; }
    document.getElementById('availableMembers').innerHTML = members.map(m =>
      '<div style="display:flex;justify-content:space-between;padding:6px 10px;border-bottom:1px solid #222;font-size:12px"><span>' + (m.type==='my-ai'?'🤖 ':'👤 ') + esc(m.displayName) + '</span><button class="btn-sm btn-accept" onclick="addMember(\''+m.id+'\')">'+t('common.add')+'</button></div>'
    ).join('');
  } catch(e) {}
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
  try {
    const d = await api('/api/memory/search?q=' + encodeURIComponent(q));
    const results = d.results || [];
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
function openSettings() { document.getElementById('settingsOverlay').classList.add('open'); document.getElementById('settingsPanel').classList.add('open'); loadModels().catch(()=>{}); loadProviders().catch(()=>{});
  loadRuntimeSettings().catch(()=>{}); onProviderTypeChange(); }
function closeSettings() { document.getElementById('settingsOverlay').classList.remove('open'); document.getElementById('settingsPanel').classList.remove('open'); }

async function loadModels() {
  try {
    const d = await api('/api/providers');
    const hSel = document.getElementById('headerModelSelect');
    // 修复: /api/providers 返回 providers 不是 models, 从 providers 展平 models
    let models = d.models || [];
    if (models.length === 0 && d.providers) {
      models = d.providers.flatMap(p => (p.models||[]).map(m => ({id:m.id||m.name||m, provider:p.id, providerName:p.name})));
    }
    // 也尝试 /api/models 作为补充
    if (models.length === 0) {
      try { const md = await api('/api/models'); if (md.models) models = md.models; } catch(e) {}
    }
    const opts = models.map(m => '<option value="'+esc(m.id)+'">' + esc(m.providerName||m.provider||'') + ' / ' + esc(m.id) + '</option>').join('');
    if (hSel) {
      hSel.innerHTML = opts || '<option value="">'+t('settings.noModel')+'</option>';
      if (d.defaultModel && hSel.querySelector('option[value="'+d.defaultModel+'"]')) hSel.value = d.defaultModel;
    }
    document.getElementById('modelInfo').textContent = models.length === 0 ? t('settings.noModelWarn') : t('settings.modelCountAvail', { n: models.length });
    const mcEl = document.getElementById('modelCount'); if (mcEl) mcEl.textContent = models.length;
    // 同步填充路由下拉框
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
  // 检查路由是否开启
  const routeEnabled = document.getElementById('routeEnabled')?.checked;
  if (routeEnabled) {
    // 多模型模式：顶部选的是回复模型
    try { await api('/api/model-route', 'PUT', { replyModel: mid }); } catch(e) {}
    // 同步设置面板
    const replySel = document.getElementById('replyModelSelect');
    if (replySel) replySel.value = mid;
    updateRouteTag();
  } else {
    // 单模型模式：顶部选的就是唯一模型，更新所有 Agent
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
  } catch(e) { document.getElementById('routeInfo').textContent = '❌ ' + t('err.saveFail'); }
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
    // 同步 header 下拉框显示回复模型
    if (headerSelect && reply) {
      for (const opt of headerSelect.options) {
        if (opt.value === reply || opt.textContent?.includes(replyName)) { headerSelect.value = opt.value; break; }
      }
      // 如果 header 里没有匹配项，追加一个临时 option
      if (headerSelect.value !== reply && ![...headerSelect.options].some(o => o.value === reply)) {
        const opt = new Option('💬'+replyName, reply);
        headerSelect.add(opt, 0);
        headerSelect.value = reply;
      }
    }
    // 同步设置面板里的下拉框
    const replySel = document.getElementById('replyModelSelect');
    if (replySel && reply) replySel.value = reply;
    tag.textContent = '🔧' + toolName + ' → 💬' + replyName;
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
    const enabled = d.enabled !== 'false';
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
              '<button onclick="deleteProvider(\''+esc(p.id)+'\')" title="'+t('settings.deleteProviderTitle')+'" style="background:none;border:1px solid var(--red);color:var(--red);border-radius:4px;cursor:pointer;font-size:11px;padding:2px 8px;line-height:1">✕</button>' +
            '</div>' +
          '</div>' +
          (p.models||[]).map(m => '<span class="model-tag" style="display:inline-flex;align-items:center;background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:3px 4px 3px 8px;border-radius:3px;font-size:11px;margin:2px">' + esc(m) + '<button onclick="removeModel(\''+esc(p.id)+'\',\''+esc(m)+'\')" title="'+t('settings.removeModel')+'" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px;line-height:1;margin-left:4px;padding:0 4px" class="model-del-btn">×</button></span>').join('') +
          '<div style="font-size:10px;color:var(--text3);margin-top:4px;word-break:break-all">' + esc(p.baseUrl||'') + '</div>' +
          '<div id="editKey-' + esc(p.id) + '" style="display:none;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">' +
            '<div style="display:flex;gap:4px;align-items:center">' +
              '<input type="password" id="keyInput-' + esc(p.id) + '" placeholder="'+t('settings.newKeyPh')+'" style="flex:1;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:11px">' +
              '<button onclick="saveProviderKey(\''+esc(p.id)+'\')" class="btn" style="font-size:11px;padding:4px 10px">' + t('common.save') + '</button>' +
              '<button onclick="toggleEditKey(\''+esc(p.id)+'\')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:13px">✕</button>' +
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
      if (msgEl) { msgEl.textContent = '❌ ' + _errMsg(d, t('err.fail')); msgEl.style.color = '#ef4444'; }
    }
  } catch(e) {
    if (msgEl) { msgEl.textContent = '❌ ' + t('err.networkError'); msgEl.style.color = '#ef4444'; }
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
    else { toast('❌ ' + _errMsg(d, t('err.fail'))); }
  } catch(e) { toast(t('err.deleteFail')); }
}
async function addProvider() {
  const type = document.getElementById('newProviderType').value;
  const name = document.getElementById('newProviderName').value.trim();
  const apiKey = document.getElementById('newProviderKey').value.trim();
  const baseUrl = document.getElementById('newProviderUrl').value.trim();
  const modelsStr = document.getElementById('newProviderModels').value.trim();
  const _msgEl = document.getElementById('addProviderMsg');
  const setMsg = (txt, color) => { if (_msgEl) { _msgEl.textContent = txt; _msgEl.style.color = color; } else toast(txt); };
  const isLocalType = ['ollama','custom','llama-cpp','vllm','lm-studio','tgi'].includes(type);
  if (!apiKey && !isLocalType) { setMsg(t('settings.errKeyRequired'), '#ef4444'); return; }
  if (!modelsStr) { setMsg(t('settings.errModelRequired'), '#ef4444'); return; }
  const id = type + '-' + Date.now();
  const models = modelsStr.split(',').map(s=>s.trim()).filter(Boolean);
  const urls = { openai:'https://api.openai.com/v1', anthropic:'https://api.anthropic.com/v1', google:'https://generativelanguage.googleapis.com/v1beta/openai', deepseek:'https://api.deepseek.com/v1', openrouter:'https://openrouter.ai/api/v1' };
  try {
    const d = await api('/api/providers', 'POST', { id, type, name:name||type, apiKey, baseUrl: baseUrl||urls[type]||'', models, isLocal: false });
    if (d.ok) { setMsg(t('settings.addSuccess'), '#4ade80'); loadProviders(); loadModels(); document.getElementById('newProviderKey').value=''; document.getElementById('newProviderModels').value=''; }
    else { setMsg('❌ '+_errMsg(d, t('err.fail')), '#ef4444'); }
  } catch(e) { setMsg('❌ ' + t('err.networkError'), '#ef4444'); }
}

const PROVIDER_PRESETS = {
  deepseek: {name:'DeepSeek',url:'https://api.deepseek.com/v1',models:'deepseek-v4-pro,deepseek-v4-flash,deepseek-chat,deepseek-reasoner',keyHint:'sk-xxx'},
  zhipu: {name:'智谱GLM',url:'https://open.bigmodel.cn/api/paas/v4',models:'glm-5.2,glm-5.1,glm-5-turbo,glm-4.7,glm-4.7-flash',keyHint:'智谱API Key'},
  moonshot: {name:'Kimi',url:'https://api.moonshot.ai/v1',models:'kimi-latest,kimi-k2.6,kimi-k2.7-code,moonshot-v1-128k',keyHint:'Kimi API Key'},
  nvidia: {name:'NVIDIA NIM',url:'https://integrate.api.nvidia.com/v1',models:'minimaxai/minimax-m3,z-ai/glm-5.2,stepfun-ai/step-3.7-flash,qwen/qwen3-next-80b-a3b-instruct,deepseek-ai/deepseek-v4-flash',keyHint:'__hintFree__'},
  minimax: {name:'MiniMax',url:'https://api.minimax.io/v1',models:'MiniMax-M3,abab6.5-chat',keyHint:'MiniMax Key'},
  qwen: {name:'通义千问',url:'https://dashscope.aliyuncs.com/compatible-mode/v1',models:'qwen3.7-max,qwen3.7-plus,qwen3.6-flash,qwen-max',keyHint:'DashScope Key'},
  baidu: {name:'百度文心',url:'https://qianfan.baidubce.com/v2',models:'ernie-4.0-turbo,ernie-3.5-turbo',keyHint:'千帆API Key'},
  yi: {name:'零一万物',url:'https://api.lingyiwanwu.com/v1',models:'yi-large,yi-medium,yi-lightning',keyHint:'Yi API Key'},
  baichuan: {name:'百川',url:'https://api.baichuan-ai.com/v1',models:'Baichuan4,Baichuan3-Turbo',keyHint:'百川API Key'},
  stepfun: {name:'阶跃星辰',url:'https://api.stepfun.com/v1',models:'step-3-8k,step-3.7-flash',keyHint:'StepFun Key'},
  siliconflow: {name:'硅基流动',url:'https://api.siliconflow.cn/v1',models:'Qwen/Qwen3-235B-A22B,deepseek-ai/deepseek-v4-flash',keyHint:'硅基流动Key'},
  iflytek: {name:'讯飞星火',url:'https://spark-api-open.xf-yun.com/v1',models:'spark-v4.0,spark-v3.5',keyHint:'讯飞API Key'},
  volcengine: {name:'火山引擎',url:'https://ark.cn-beijing.volces.com/api/v3',models:'doubao-pro-128k,doubao-pro-32k',keyHint:'火山引擎Key'},
  tencent: {name:'腾讯混元',url:'https://api.hunyuan.cloud.tencent.com/v1',models:'hunyuan-turbo,hunyuan-standard',keyHint:'腾讯云Key'},
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
  custom: {name:'__custom__',url:'',models:'',keyHint:'API Key'},
};
function onProviderTypeChange() {
  var type = document.getElementById('newProviderType').value;
  var p = PROVIDER_PRESETS[type];
  if (!p) return;
  var presetName = p.name === '__custom__' ? t('misc.custom') : p.name;
  var hint = p.keyHint === '__hintFree__' ? t('misc.keyHintFree') : (p.keyHint === '__hintLocal__' ? t('misc.keyHintLocal') : p.keyHint);
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
  } catch(e) { sEl.textContent='❌ ' + e.message; sEl.style.color='#ef4444'; }
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
  } catch(e) { if (sEl) { sEl.textContent='❌ ' + e.message; sEl.style.color='#ef4444'; } toast('❌ ' + e.message); }
}


// ── v1.3 补全：审批/提示词/视觉/TTS ──

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
  } catch(e) { toast('❌ ' + t('err.operationFail')); }
}

async function loadPromptAgentSelect() {
  try {
    const d = await api('/api/agents');
    const agents = d.agents || [];
    const sel = document.getElementById('promptAgentSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">选择 Agent...</option>' +
      agents.map(a => '<option value="'+esc(a.id)+'">'+esc(a.display_name || a.id)+'</option>').join('');
  } catch(e) {}
}
async function loadAgentPrompt() {
  const agentId = document.getElementById('promptAgentSelect').value;
  if (!agentId) return;
  try {
    const d = await api('/api/agents/' + agentId + '/memory');
    document.getElementById('promptEditArea').value = d.personality || d.memory_summary || '';
  } catch(e) { toast('❌ 加载失败'); }
}
async function saveAgentPrompt() {
  const agentId = document.getElementById('promptAgentSelect').value;
  const prompt = document.getElementById('promptEditArea').value;
  if (!agentId) { toast('请先选择 Agent'); return; }
  try {
    await api('/api/agents/' + agentId + '/memory', 'PUT', { personality: prompt });
    toast('✅ 提示词已保存');
  } catch(e) { toast('❌ 保存失败: ' + e.message); }
}

async function uploadVision(event) {
  const file = event.target.files[0];
  if (!file) return;
  document.getElementById('visionResult').textContent = '分析中...';
  try {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('prompt', '描述这张图片的内容');
    const r = await fetch('/api/vision/analyze', { method: 'POST', body: fd });
    const d = await r.json();
    if (d.ok && d.result) {
      document.getElementById('visionResult').textContent = d.result;
    } else {
      document.getElementById('visionResult').textContent = '❌ ' + _errMsg(d, '分析失败');
    }
  } catch(e) { document.getElementById('visionResult').textContent = '❌ ' + e.message; }
}

async function loadVoiceStatus() {
  try {
    const d = await api('/api/voice/status');
    const el = document.getElementById('voiceStatus');
    if (!el) return;
    const tts = d.tts || {};
    el.textContent = 'TTS: ' + (tts.available ? '✅ 可用' : '❌ 未配置') + ' | STT: ' + (d.stt?.available ? '✅' : '❌');
  } catch(e) {}
}
async function testTTS() {
  const voice = document.getElementById('ttsVoiceSelect').value;
  try {
    const r = await api('/api/voice/tts', 'POST', { text: '灵犀引擎语音测试', voice });
    if (r.ok && r.audio) {
      const audio = new Audio('data:audio/mp3;base64,' + r.audio);
      audio.play();
      toast('🔊 正在播放');
    } else {
      toast('❌ TTS 不可用: ' + (r.error || ''));
    }
  } catch(e) { toast('❌ TTS 失败: ' + e.message); }
}


// ── 注册/登录 ──
let authToken = null;
const PLATFORM_URL = '';  // v2.0.6: 本地部署时不走云平台，直接用本地 API。如需云平台功能，改为 'http://47.93.157.83:8080'

// 通用 API：本地（不要带平台 token，本地引擎 JWT 与平台不一致）
async function api(url, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  // 自动携带 JWT token（如果已登录）
  const token = localStorage.getItem('authToken');
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(url, opts); return r.json();
}
// 云平台 API：注册/登录/市场
async function platformApi(url, method, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(PLATFORM_URL + url, opts); return r.json();
}
function esc(s) { if (s == null) return ''; const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML.replace(/'/g, '&#39;'); }
// v1.9.8: 安全提取错误消息——API 可能返回 {error: {code, message}} 对象而非字符串
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
      try { r = await platformApi('/api/auth/login', 'POST', loginPayload); }
      catch (pe) { r = await api('/api/auth/login', 'POST', loginPayload); } // 云平台不可达时回退本地引擎
    }
    const tk = r.token || r.accessToken;
    if (tk) {
      authToken = tk;
      localStorage.setItem('authToken', authToken);
      const user = r.user || {};
      document.getElementById('userInfo').textContent = '👤 ' + (user.username || user.display_name || user.displayName || username);
      document.getElementById('loginArea').style.display = '';
      document.getElementById('loginButtons').style.display = 'none';
      closeAuthModal();
      connect();
      toast('✅ ' + (authMode === 'register' ? '注册成功' : '登录成功'));
    } else {
      document.getElementById('authMsg').textContent = '❌ ' + (r.error || '失败');
    }
  } catch(e) {
    document.getElementById('authMsg').textContent = '❌ ' + e.message;
  }
  document.getElementById('authSubmitBtn').disabled = false;
}
async function logout() {
  try { await api('/api/auth/logout', 'POST'); } catch {}
  authToken = null;
  localStorage.removeItem('authToken');
  document.getElementById('loginArea').style.display = 'none';
  document.getElementById('loginButtons').style.display = '';
  if (ws) try { ws.close(); } catch {}
  toast('已退出');
}
function checkAuthStatus() {
  const saved = localStorage.getItem('authToken');
  if (saved) {
    authToken = saved;
    fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + saved } })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.user) {
          document.getElementById('userInfo').textContent = '👤 ' + (d.user.username || d.user.display_name || '用户');
          document.getElementById('loginArea').style.display = '';
          document.getElementById('loginButtons').style.display = 'none';
          connect();
        } else {
          localStorage.removeItem('authToken');
        }
      })
      .catch(() => {});
  }
}


// ── 左侧栏个人信息卡片 ──
async function loadProfileCard() {
  try {
    var token = localStorage.getItem('authToken');
    var u = null;
    if (token) {
      try {
        var r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
        var d = await r.json();
        if (d && d.ok && d.user) u = d.user;
      } catch(e) {}
    }
    if (!u && clientId) {
      u = { id: clientId, display_name: '用户' };
    }
    if (!u) return;
    var userId = u.id || u.sub || '';
    var name = u.display_name || u.username || '用户';
    var idShow = u.numeric_id || u.id || '';
    var avatarUrl = u.avatar_url || '';
    var bio = u.bio || '';
    var credits = 0;
    var rating = '暂无';
    var tokens = 0;
    var calls = 0;
    var email = u.email || '';
    var createdAt = u.created_at ? new Date(u.created_at).toLocaleString('zh-CN') : '-';
    try {
      var pr = await api('/api/profile?userId=' + encodeURIComponent(userId));
      if (pr && pr.ok && pr.profile) {
        var p = pr.profile;
        name = p.display_name || name;
        idShow = p.numeric_id || p.id || idShow;
        avatarUrl = p.avatar_url || avatarUrl;
        bio = p.bio || bio;
        email = p.email || email;
        createdAt = p.created_at ? new Date(p.created_at).toLocaleString('zh-CN') : createdAt;
        credits = pr.credits || 0;
        if (pr.ratings && pr.ratings.avgRating) rating = Number(pr.ratings.avgRating).toFixed(1) + '星';
        if (pr.ratings && pr.ratings.count) rating += ' (' + pr.ratings.count + '评)';
        if (pr.usage) { tokens = pr.usage.totalTokens || 0; calls = pr.usage.calls || 0; }
      }
    } catch(e) {}
    var el;
    el = document.getElementById('pcAvatar'); if (el) { if (avatarUrl) { el.style.backgroundImage = 'url(' + esc(avatarUrl) + ')'; el.style.backgroundSize = 'cover'; } el.textContent = avatarUrl ? '' : esc((name[0]||'U').toUpperCase()); }
    el = document.getElementById('pcName'); if (el) el.textContent = name;
    el = document.getElementById('pcId'); if (el) el.textContent = 'ID: ' + esc(String(idShow));
    el = document.getElementById('pcCredits'); if (el) el.textContent = '⚡ ' + Number(credits).toLocaleString() + ' 积分';
    el = document.getElementById('pdName'); if (el) el.textContent = name;
    el = document.getElementById('pdId'); if (el) el.textContent = esc(String(idShow));
    el = document.getElementById('pdEmail'); if (el) el.textContent = esc(email || '未设置');
    el = document.getElementById('pdCredits'); if (el) el.textContent = '⚡ ' + Number(credits).toLocaleString();
    el = document.getElementById('pdRating'); if (el) el.textContent = rating;
    el = document.getElementById('pdUsage'); if (el) el.textContent = 'Token: ' + Number(tokens).toLocaleString() + ' · 调用: ' + Number(calls).toLocaleString();
    el = document.getElementById('pdBio'); if (el) el.textContent = bio ? '个人介绍：' + esc(bio) : '暂无介绍';
  } catch(e) { console.error('[loadProfileCard]', e); }
}

// ── 编辑资料 ──
async function editProfile() {
  var token = localStorage.getItem('authToken');
  if (!token) { toast('请先登录'); return; }
  // 获取当前用户 ID
  var userId = clientId || '';
  if (!userId) { toast('无法获取用户信息'); return; }
  // 获取当前资料
  var curName = '', curBio = '';
  try {
    var pr = await api('/api/profile?userId=' + encodeURIComponent(userId));
    if (pr && pr.ok && pr.profile) {
      curName = pr.profile.display_name || '';
      curBio = pr.profile.bio || '';
    }
  } catch(e) {}
  // 弹出编辑框
  var newName = prompt('请输入新的用户名：', curName);
  if (newName === null) return;
  var newBio = prompt('请输入个人介绍：', curBio);
  if (newBio === null) return;
  try {
    var r = await api('/api/profile', 'PUT', { userId: userId, displayName: newName, bio: newBio });
    if (r && r.ok) {
      toast('✅ 资料已更新');
      loadProfileCard();
    } else {
      toast('❌ 更新失败: ' + (r?.error || '未知错误'));
    }
  } catch(e) { toast('❌ 更新失败: ' + e.message); }
}

// ── 上传头像 ──
function uploadAvatar() {
  var token = localStorage.getItem('authToken');
  if (!token) { toast('请先登录'); return; }
  var input = document.getElementById('avatarFileInput');
  if (input) input.click();
}
async function doUploadAvatar(input) {
  var file = input.files[0];
  if (!file) return;
  input.value = ''; // 重置以便下次可选同一文件
  var userId = clientId || '';
  if (!userId) { toast('无法获取用户信息'); return; }
  // 校验文件类型
  if (!/^image\//.test(file.type)) { toast('请选择图片文件'); return; }
  if (file.size > 5 * 1024 * 1024) { toast('图片大小不能超过 5MB'); return; }
  var fd = new FormData();
  fd.append('file', file);
  fd.append('userId', userId);
  try {
    toast('上传中...');
    var token = localStorage.getItem('authToken');
    var res = await fetch('/api/profile/avatar', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    var data = await res.json();
    if (data && data.ok) {
      toast('✅ 头像上传成功');
      loadProfileCard();
    } else {
      toast('❌ 上传失败: ' + (data?.error || '未知错误'));
    }
  } catch(e) { toast('❌ 上传失败: ' + e.message); }
}

// ── 积分明细 ──
async function showCreditsDetail() {
  var token = localStorage.getItem('authToken');
  if (!token) { toast('请先登录'); return; }
  var userId = clientId || '';
  if (!userId) { toast('无法获取用户信息'); return; }
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
  html += '<div style="text-align:center;background:var(--bg3);border-radius:8px;padding:10px"><div style="font-size:18px;font-weight:700;color:var(--accent)">' + Number(credits).toLocaleString() + '</div><div style="font-size:10px;color:var(--text3)">当前积分</div></div>';
  html += '<div style="text-align:center;background:var(--bg3);border-radius:8px;padding:10px"><div style="font-size:18px;font-weight:700;color:#4ade80">' + Number(totalEarned).toLocaleString() + '</div><div style="font-size:10px;color:var(--text3)">累计获得</div></div>';
  html += '<div style="text-align:center;background:var(--bg3);border-radius:8px;padding:10px"><div style="font-size:18px;font-weight:700;color:#f59e0b">' + Number(totalSpent).toLocaleString() + '</div><div style="font-size:10px;color:var(--text3)">累计消费</div></div>';
  html += '</div>';
  if (history.length > 0) {
    html += '<div style="font-size:13px;color:var(--text2);margin-bottom:8px">📜 积分变动记录</div>';
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
    html += '<div style="text-align:center;color:var(--text3);padding:20px 0">暂无积分变动记录</div>';
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
    if (!token) { toast('请先登录'); return; }
    box.innerHTML = '<div style="text-align:center;color:var(--text3);padding:30px 0">加载中...</div>';
    // ── 获取用户身份：本地引擎优先，失败回退云平台 ──
    let u = null, fromCloud = false;
    try {
      const r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
      const d = await r.json();
      if (d.ok && d.user) u = d.user;
    } catch (e) { /* 本地不可达 */ }
    if (!u) {
      try {
        // v2.0.10: /api/user/me 不存在，PLATFORM_URL='' 时 platformApi 等同于 api，这里只是兜底
        const cr = await api('/api/auth/me', 'GET');
        if (cr && cr.ok && cr.user) { u = cr.user; fromCloud = true; }
      } catch (e) { /* 云平台不可达 */ }
    }
    if (!u) {
      box.innerHTML = '<div style="text-align:center;color:var(--red);padding:30px 0">获取用户信息失败，请重新登录</div>';
      return;
    }
    const userId = u.id || u.sub || '';
    // ── 组装资料数据：本地 /api/profile 优先，云账号回退云平台 ──
    let name = '用户', idShow = userId, credits = 0, rating = '暂无', tokens = 0, calls = 0, createdAt = '-', status = '在线', ratingsHtml = '';
    let pr = null;
    if (!fromCloud) {
      try { pr = await api('/api/profile?userId=' + encodeURIComponent(userId)); } catch (e) {}
    }
    if (pr && pr.ok && pr.profile) {
      const p = pr.profile;
      name = p.display_name || '用户';
      idShow = p.numeric_id || p.id;
      credits = pr.credits || 0;
      rating = pr.ratings?.avgRating ? '⭐ ' + Number(pr.ratings.avgRating).toFixed(1) : '暂无';
      tokens = pr.usage?.totalTokens || 0;
      calls = pr.usage?.calls || 0;
      createdAt = new Date(p.created_at).toLocaleString('zh-CN');
      status = p.status === 'offline' ? '离线' : '在线';
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
      // 注意：云平台 /api/user/profile 被 /api/user/:id 路由遮蔽(恒404)，须用 /api/user/me
      let cu = u;
      try {
        // v2.0.10: /api/user/me 不存在，用 /api/auth/me
        const cpr = await api('/api/auth/me', 'GET');
        if (cpr && cpr.ok && cpr.user) cu = cpr.user;
      } catch (e) { /* 用已有信息兜底 */ }
      name = cu.username || cu.display_name || cu.displayName || '用户';
      idShow = cu.id || userId;
      credits = cu.points != null ? cu.points : 0;
      createdAt = cu.created_at ? new Date(cu.created_at).toLocaleString('zh-CN') : '-';
      status = cu.status === 'offline' ? '离线' : '在线';
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
        '<div style="' + cell + '"><div style="' + num + '">' + Number(credits).toLocaleString() + '</div><div style="' + lab + '">积分</div></div>' +
        '<div style="' + cell + '"><div style="' + num + '">' + esc(rating) + '</div><div style="' + lab + '">评分</div></div>' +
        '<div style="' + cell + '"><div style="' + num + '">' + Number(tokens).toLocaleString() + '</div><div style="' + lab + '">Token 用量</div></div>' +
        '<div style="' + cell + '"><div style="' + num + '">' + Number(calls).toLocaleString() + '</div><div style="' + lab + '">调用次数</div></div>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text2);margin-bottom:12px">注册时间：' + esc(createdAt) + '</div>' +
      (ratingsHtml ? '<div style="font-size:12px;color:var(--accent);margin-bottom:6px">我的评价</div>' + ratingsHtml : '');
  } catch (e) {
    box.innerHTML = '<div style="text-align:center;color:var(--red);padding:30px 0">加载失败: ' + esc(e.message) + '</div>';
  }
}
async function rateMessage(msgId, rating) {
  try {
    const token = localStorage.getItem('authToken');
    if (!token) { toast('请先登录'); return; }
    const r = await fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
    const d = await r.json();
    if (!d.ok) return;
    await api('/api/ratings', 'POST', { messageId: msgId, userId: d.user.id, rating });
    toast('✅ 已评分 ' + rating + ' 星');
  } catch(e) { toast('❌ 评分失败'); }
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
async function setChatMode(mode) {
  if (!currentChat) return;
  try {
    await api('/api/chats/' + encodeURIComponent(currentChat) + '/mode', 'POST', { mode });
    var names = {free:'自由',route:'路由',debate:'辩论',chain:'链式',roundtable:'圆桌',vote:'投票',brainstorm:'头脑风暴'};
    toast('✅ 协作模式: ' + (names[mode] || mode));
  } catch(e) { toast('❌ 设置失败'); }
}


// ── 找回密码 ──
async function showForgotPassword() {
  var email = document.getElementById('authUsername').value.trim() || prompt('请输入注册邮箱：');
  if (!email) return;
  try {
    var r = await api('/api/auth/forgot-password', 'POST', { email: email });
    document.getElementById('authMsg').innerHTML = '<span style="color:#4ade80">✅ 如果邮箱已注册，重置链接已发送到 ' + esc(email) + '</span>';
  } catch(e) {
    document.getElementById('authMsg').innerHTML = '<span style="color:#ef4444">❌ ' + (e.message || '发送失败') + '</span>';
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
      'data-agent-id="'+esc(a.agent_id||a.id)+'" ' +
      'data-agent-name="'+esc(a.display_name||a.id)+'" ' +
      'data-agent-model="'+esc(a.model||'default')+'">' +
      esc(a.display_name||a.id)+'<br><span style="color:#666;font-size:9px">'+esc(a.model||'default')+'</span></div>'
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
  wfNodes.push({id:'node-'+Date.now(), type:'start', label:'开始', x:100, y:100 + wfNodes.filter(n=>n.type==='start').length*80, config:{}});
  renderWF(true);
}
function wfAddAgentNode() {
  const name = prompt('输入这个 Agent 节点的显示名称:') || 'Agent';
  wfPushUndo();
  wfNodes.push({id:'node-'+Date.now(), type:'agent', label:name, x:350, y:100 + wfNodes.filter(n=>n.type==='agent').length*120, config:{prompt:'回答用户问题', model:'default'}});
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
  // 画布空白区拖拽 → 平移
  const canvasEl = document.getElementById('wfCanvas');
  if (e.target === canvasEl || e.target.id === 'wfNodes' || e.target.id === 'wfConnections') {
    wfPanning = true;
    wfPanStart = {x: e.clientX - wfPanX, y: e.clientY - wfPanY};
    canvasEl.style.cursor = 'grabbing';
    return;
  }
  const nodeEl = e.target.closest('.wf-node');
  if (!nodeEl || e.target.classList.contains('wf-delete') || e.target.classList.contains('wf-connector')) return;
  wfDragStartState = JSON.parse(JSON.stringify(wfNodes)); // 保存移动前状态
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
  const newPrompt = prompt('编辑指令:', node.config.prompt || '回答用户问题');
  if (newPrompt !== null) {
    node.config.prompt = newPrompt;
    const newModel = prompt('编辑模型 (default=默认):', node.config.model || 'default');
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
    '<div class="wf-body">'+(n.type==='agent'?'指令: '+(n.config.prompt||'').slice(0,30):'流程开始')+'</div>' +
    '<button class="wf-delete" onclick="event.stopPropagation();wfDeleteNode(\''+n.id+'\')\">×</button>' +
    (n.type!=='start'?'<div class="wf-connector wf-in" title="输入" onclick="event.stopPropagation();wfEndConnection(\''+n.id+'\')\"></div>':'') +
    '<div class="wf-connector wf-out" title="输出" onmousedown="event.stopPropagation();wfStartConnection(\''+n.id+'\',\'out\')"></div>' +
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
      return '<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" onclick="wfDeleteConnection(\''+c.from+'\',\''+c.to+'\')" style="pointer-events:all;cursor:pointer" title="点击删除连线"/>';
    }).join('');
}
// ── 撤销/重做 ──
function wfPushUndo() {
  wfUndoStack.push({nodes: JSON.parse(JSON.stringify(wfNodes)), connections: JSON.parse(JSON.stringify(wfConnections))});
  if (wfUndoStack.length > 50) wfUndoStack.shift(); // 最多50步
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
  const name = document.getElementById('wfName').value || '未命名工作流';
  const id = 'wf-' + Date.now();
  const data = { nodes: wfNodes, connections: wfConnections };
  try {
    await api('/api/workflows', 'POST', { id, name, data });
    toast('✅ 已保存: ' + name);
  } catch(e) { toast('❌ 保存失败: ' + e.message); }
}
async function wfLoadFromCloud() {
  try {
    const d = await api('/api/workflows');
    if (!d.ok || !d.workflows.length) { toast('没有已保存的工作流'); return; }
    const name = prompt('选择工作流（输入编号）：\n' + d.workflows.map((w,i) => (i+1)+'. '+w.name+' ('+new Date(w.updated_at).toLocaleDateString()+')').join('\n'));
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
      toast('✅ 已加载: ' + detail.workflow.name);
    }
  } catch(e) { toast('❌ 加载失败: ' + e.message); }
}

function wfExportJSON() {
  const name = document.getElementById('wfName').value || '工作流';
  const json = {name, nodes:wfNodes, connections:wfConnections, exportedAt:Date.now()};
  const blob = new Blob([JSON.stringify(json,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name+'.json';
  a.click();
  toast('✅ 已导出: '+name+'.json');
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
      toast('✅ 已导入: '+(json.nodes?.length||0)+' 个节点');
    } catch(e2) { toast('❌ 导入失败: '+e2.message); }
  };
  reader.readAsText(file);
}

// ── Theme ──
const THEMES = ['dark', 'light', 'ocean', 'warm', 'forest'];
const THEME_NAMES = { dark: '暗夜', light: '浅色', ocean: '海洋', warm: '暖阳', forest: '森林' };
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const idx = THEMES.indexOf(cur);
  const next = THEMES[(idx + 1) % THEMES.length];
  setTheme(next);
  toast('🎨 主题：' + (THEME_NAMES[next] || next));
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
  adminHealth(); adminAgents(); adminSessions(); adminSubAgents(); adminCron(); adminMCP(); adminPlugins(); loadApprovals(); loadVoiceStatus(); loadPromptAgentSelect();
  refreshStatusBar(); refreshAdminVersion();
}
async function refreshStatusBar() {
  try {
    const h = await api('/api/health');
    const aEl = document.getElementById('apiHealth');
    const healthy = h.status === 'ok';
    aEl.textContent = healthy ? t('status.apiOk') : '❌ ' + (h.status || '异常');
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
    const curModel = hSel && hSel.value ? hSel.value : (models[0]?.id || '');
    const cmdEl = document.getElementById('currentModelDisplay'); if (cmdEl) cmdEl.textContent = curModel ? '⚡' + (curModel.split('/').pop() || curModel) : '';
  } catch(e){}
  const wsEl = document.getElementById('wsState');
  if (ws && ws.readyState === 1) { wsEl.textContent = t('status.wsConnected'); wsEl.className = 'ok'; }
  else { wsEl.textContent = t('status.wsNotConnected'); wsEl.className = 'err'; }
}
async function adminHealth() {
  try {
    const d = await api('/api/health');
    document.getElementById('adminHealthOut').textContent = JSON.stringify(d, null, 2);
  } catch(e) { document.getElementById('adminHealthOut').textContent = '❌ ' + e.message; }
}


// ── 侧栏运行日志面板 ──
var _autoLogTimer = null;
var _autoLogOn = false;

async function loadLogBody() {
  var body = document.getElementById('logBody');
  if (!body) return;
  body.innerHTML = '<div class="log-line"><span class="info">加载中...</span></div>';
  try {
    api('/api/logs?limit=100').then(function(d) {
      if (!d || !d.ok) {
        body.innerHTML = '<div class="log-line"><span class="err">❌ ' + (d && d.error || '加载失败') + '</span></div>';
        return;
      }
      var logs = d.logs || d.lines || [];
      var html = '';
      if (d.logs && d.logs.length > 0 && typeof d.logs[0] === 'object') {
        for (var i = 0; i < d.logs.length; i++) {
          var l = d.logs[i];
          var cls = 'info';
          if (l.level === 'error' || l.level === 'err') cls = 'err';
          else if (l.level === 'warn') cls = 'warn';
          else if (l.level === 'debug') cls = 'info';
          html += '<div class="log-line"><span class="t">[' + esc(l.timestamp || '') + ']</span> <span class="' + cls + '">[' + esc(l.level || '') + ']</span> ' + esc(l.message || '') + '</div>';
        }
      } else {
        for (var j = 0; j < logs.length; j++) {
          var line = String(logs[j] || '');
          var lc = 'info';
          if (/\[ERROR\]|\[FATAL\]/i.test(line)) lc = 'err';
          else if (/\[WARN\]/i.test(line)) lc = 'warn';
          else if (/\[INFO\]/i.test(line)) lc = 'info';
          else if (/\[Boot\]|\[Config\]/i.test(line)) lc = 'ok';
          html += '<div class="log-line"><span class="' + lc + '">' + esc(line) + '</span></div>';
        }
      }
      body.innerHTML = html || '<div class="log-line"><span class="info">暂无日志</span></div>';
      body.scrollTop = body.scrollHeight;
    }).catch(function(e) {
      body.innerHTML = '<div class="log-line"><span class="err">❌ ' + esc(e.message || '网络错误') + '</span></div>';
    });
  } catch(e) {
    body.innerHTML = '<div class="log-line"><span class="err">❌ ' + esc(e.message || '错误') + '</span></div>';
  }
}

function toggleAutoLog() {
  _autoLogOn = !_autoLogOn;
  if (_autoLogOn) {
    loadLogBody();
    _autoLogTimer = setInterval(loadLogBody, 3000);
    toast('自动刷新已开启');
  } else {
    if (_autoLogTimer) { clearInterval(_autoLogTimer); _autoLogTimer = null; }
    toast('自动刷新已关闭');
  }
}

function clearLogBody() {
  var body = document.getElementById('logBody');
  if (body) body.innerHTML = '<div class="log-line"><span class="info">(已清空)</span></div>';
}

async function loadLogs() {
  const out = document.getElementById('logsOut');
  if (!out) return;
  out.textContent = '加载中...';
  try {
    api('/api/logs?limit=200').then(function(d) {
      if (!d || !d.ok) { out.textContent = '❌ ' + (d && d.error || '加载失败'); return; }
      var logs = d.logs || d.lines || [];
      if (d.logs && d.logs.length > 0 && typeof d.logs[0] === 'object') {
        // New format: array of {timestamp, level, message}
        out.innerHTML = d.logs.map(function(l) {
          var cls = 'info';
          if (l.level === 'error' || l.level === 'err') cls = 'err';
          else if (l.level === 'warn') cls = 'warn';
          else if (l.level === 'info') cls = 'info';
          return '<span style="color:var(--text3)">[' + esc(l.timestamp || '') + ']</span> <span class="' + cls + '">[' + esc(l.level || '') + ']</span> ' + esc(l.message || '') + '\n';
        }).join('');
      } else {
        // Old format: array of strings
        out.textContent = logs.join('\n');
      }
    }).catch(function(e) { out.textContent = '❌ ' + (e.message || '网络错误'); });
  } catch(e) { out.textContent = '❌ ' + (e.message || '错误'); }
}

// ── 一键升级 ──
async function doUpdate() {
  const stat = document.getElementById('updateStatus');
  if (!confirm('确认升级到最新版？服务器将自动下载并重启（约 10 秒）。')) return;
  if (stat) stat.textContent = '⏳ 正在升级...';
  try {
    const d = await api('/api/update', 'POST');
    if (d.ok) {
      if (stat) stat.textContent = '✅ 升级已触发！服务器重启中...';
      toast('升级已开始，服务器即将重启');
      // 10 秒后刷新页面
      setTimeout(function(){ location.reload(); }, 10000);
    } else {
      if (stat) stat.textContent = '❌ ' + _errMsg(d, '升级失败');
      toast('升级失败: ' + _errMsg(d, '未知错误'));
    }
  } catch(e) {
    if (stat) stat.textContent = '❌ ' + (e.message || '网络错误');
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
  statusEl.textContent = '加载中...';
  try {
    const st = await api('/api/mesh/status');
    if (!st.enabled) {
      statusEl.innerHTML = '<span style="color:var(--text3)">未启用（需配置 MESH_PLATFORM_URL / MESH_TOKEN）</span>';
      peersEl.textContent = '';
      sel.innerHTML = '<option value="">选择实例...</option>';
      return;
    }
    const dot = st.connected ? '<span style="color:#4ade80">● 已连接</span>' : '<span style="color:#ef4444">● 未连接</span>';
    statusEl.innerHTML = dot + ' <span style="color:var(--text3)">' + esc(st.instanceId) + '</span><br><span style="color:var(--text3);font-size:10px">' + esc(st.lanIp || '') + ' @ ' + esc(st.platformUrl || '') + '</span>';
    const d = await api('/api/mesh/peers');
    const peers = d.instances || [];
    if (d.disabled) { peersEl.textContent = '未配置平台'; }
    else if (!peers.length) { peersEl.textContent = '暂无其他在线实例'; }
    else {
      peersEl.innerHTML = peers.map(function(p){
        return '<div style="padding:3px 0;border-bottom:1px solid var(--border)">🟢 ' + esc(p.instanceId) + ' <span style="color:var(--text3);font-size:10px">' + esc(p.lanIp||'') + ':' + (p.port||'') + ' · ' + (p.agents?p.agents.length:0) + ' AI</span></div>';
      }).join('');
    }
    sel.innerHTML = '<option value="">选择实例...</option>' + peers.map(function(p){
      return '<option value="' + esc(p.instanceId) + '">' + esc(p.instanceId) + '</option>';
    }).join('');
  } catch(e) { statusEl.textContent = '❌ ' + (e.message || '网络错误'); }
}

async function sendMeshMsg() {
  const sel = document.getElementById('meshPeerSelect');
  const input = document.getElementById('meshMsgInput');
  const toInstance = sel.value;
  const content = (input.value || '').trim();
  if (!toInstance) { toast('❌ 请先选择目标实例'); return; }
  if (!content) { toast('❌ 请输入消息内容'); return; }
  try {
    const d = await api('/api/mesh/send', 'POST', { toInstance: toInstance, content: content });
    if (d.ok) { toast('✅ 已发送到 ' + toInstance); input.value = ''; }
    else toast('❌ 发送失败（对方可能不在线）');
  } catch(e) { toast('❌ ' + (e.message || '发送失败')); }
}

async function loadUsage() {
  try {
    const d = await api('/api/usage');
    if (!d.ok) return;
    const s = d.stats;
    let html = '';
    html += '<div style="margin-bottom:8px;padding:6px;background:rgba(0,0,0,.3);border-radius:6px">';
    html += '<b>总计</b>: ' + s.total.calls + ' 次调用 | ' + s.total.totalTokens.toLocaleString() + ' tokens<br>';
    html += '输入 ' + s.total.promptTokens.toLocaleString() + ' / 输出 ' + s.total.completionTokens.toLocaleString() + '<br>';
    html += '近1小时: ' + s.recent1h.calls + ' 次 / ' + s.recent1h.totalTokens.toLocaleString() + ' tokens<br>';
    html += '近24小时: ' + s.recent24h.calls + ' 次 / ' + s.recent24h.totalTokens.toLocaleString() + ' tokens';
    html += '</div>';
    if (Object.keys(s.byModel).length > 0) {
      html += '<div style="margin-top:6px"><b>按模型:</b></div>';
      for (const [model, m] of Object.entries(s.byModel)) {
        html += '<div>' + model + ': ' + m.calls + '次 / ' + m.totalTokens.toLocaleString() + ' tokens</div>';
      }
    }
    if (Object.keys(s.byType).length > 0) {
      html += '<div style="margin-top:6px"><b>按类型:</b></div>';
      const typeNames = { tool: '工具调用', reply: '回复', compaction: '压缩', summary: '摘要', reflection: '记忆反思' };
      for (const [type, t] of Object.entries(s.byType)) {
        html += '<div>' + (typeNames[type]||type) + ': ' + t.calls + '次 / ' + t.totalTokens.toLocaleString() + ' tokens</div>';
      }
    }
    document.getElementById('usageStats').innerHTML = html || '<暂无数据>';
  } catch(e) { document.getElementById('usageStats').innerHTML = '<span style="color:#f44">Error: ' + esc(e.message) + '</span>'; }
}

async function resetUsage() {
  if (!confirm('确定清空所有统计？')) return;
  try { await api('/api/usage/reset', 'POST'); loadUsage(); } catch(e) {}
}

// ── 反向提问：AI 针对目标提澄清问题（含多选表单 + 继续反问） ──
async function askAIAboutGoal(goalId, title) {
  _currentAskGoalId = goalId;
  if (!currentChat) { toast('❌ 请先选择一个会话'); return; }
  try {
    toast('⏳ AI 正在分析目标并生成反问...');
    const extra = (typeof title === 'string' && (title.includes(';') || title.includes('自定义'))) ? title : '';
    const d = await api('/api/goals/' + encodeURIComponent(goalId) + '/ask', 'POST', { chatId: currentChat, extra: extra });
    if (d.ok) {
      toast('✅ AI 反问已发送到当前会话');
    } else {
      toast('❌ ' + _errMsg(d, '反问失败'));
    }
  } catch(e) { toast('❌ ' + e.message); }
}

// 兼容旧调用名
var askGoal = askAIAboutGoal;

// ── 目标反向提问 -> 选项表单渲染 ──
// AI 回复中包含 Q:/A:/B:/C: 格式时，自动在消息下方插入多选表单
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
  html += '<div style="font-weight:bold;margin-bottom:8px;color:var(--accent)">📋 请选择以完善目标</div>';
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
  // 自定义输入
  html += '<div style="margin-bottom:8px"><div style="font-size:12px;color:var(--text2);margin-bottom:4px">自定义补充：</div>';
  html += '<input type="text" style="width:90%;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg3);color:var(--text)" placeholder="输入你的补充..."></div>';
  html += '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">';
  html += '<button class="btn" style="font-size:11px;background:var(--green);color:#fff" onclick="applyGoalRefine(this,\'refine\')">✅ 完善目标</button>';
  html += '<button class="btn" style="font-size:11px" onclick="applyGoalRefine(this,\'criteria\')">📎 加入验收标准</button>';
  html += '<button class="btn" style="font-size:11px" onclick="applyGoalRefine(this,\'create\')">🆕 生成新目标</button>';
  html += '</div></div>';
  html += '<button class="btn" style="font-size:11px;margin-left:48px" onclick="continueReverseAsk(this)">💬 继续反问</button>';

  var wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  msgEl.parentNode.insertBefore(wrapper, msgEl.nextSibling);
}

// ── 多选表单按钮：完善/加入验收/生成新目标 ──
function applyGoalRefine(btn, action) {
  var form = btn.closest('div');
  while (form && !form.querySelector('input[type=checkbox]')) form = form.parentElement;
  if (!form) return;
  var checks = form.querySelectorAll('input[type=checkbox]:checked');
  if (!checks.length) { toast('请至少勾选一个选项'); return; }
  var selections = [];
  checks.forEach(function(c) { selections.push(c.parentElement.textContent.trim()); });
  // 也收集自定义输入
  form.querySelectorAll('input[type=text]').forEach(function(t) { if (t.value.trim()) selections.push('自定义: ' + t.value.trim()); });

  var goalId = form.getAttribute('data-goal-id') || _currentAskGoalId;
  if (!goalId) { var ri = document.querySelector('#rightGoalsList .goal-item'); if (ri) goalId = ri.getAttribute('data-goal-id'); }
  if (!goalId) { toast('未找到对应的目标'); return; }

  api('/api/goals/' + goalId + '/refine', 'POST', { selections: selections, action: action }).then(function(d) {
    if (d.ok) {
      toast('✅ ' + (action === 'create' ? '已生成新目标' : action === 'criteria' ? '已加入验收标准' : '目标已完善'));
      if (typeof loadRightGoals === 'function') loadRightGoals();
    } else toast('❌ ' + _errMsg(d, '操作失败'));
  }).catch(function(e) { toast('❌ ' + e.message); });
}

// ── 继续反问：带已选上下文再次向AI提问 ──
function continueReverseAsk(btn) {
  var form = btn.closest('div');
  while (form && !form.querySelector('input[type=checkbox]')) form = form.parentElement;
  if (!form) return;
  var goalId = form.getAttribute('data-goal-id') || _currentAskGoalId;
  if (!goalId) { toast('未找到对应的目标'); return; }
  var context = [];
  form.querySelectorAll('input[type=checkbox]:checked').forEach(function(c) { context.push(c.parentElement.textContent.trim()); });
  form.querySelectorAll('input[type=text]').forEach(function(t) { if (t.value.trim()) context.push('自定义: ' + t.value.trim()); });
  var extra = context.length ? context.join('; ') : '';
  toast('💬 继续提问中...');
  askAIAboutGoal(goalId, extra);
}
async function adminAgents() {
  try {
    const d = await api('/api/agents');
    document.getElementById('adminAgentsOut').textContent = JSON.stringify(d.agents || [], null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminAgentsOut').textContent = '❌ ' + e.message; }
}
async function adminSessions() {
  try {
    const d = await api('/api/sessions');
    document.getElementById('adminSessionsOut').textContent = JSON.stringify(d, null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminSessionsOut').textContent = '❌ ' + e.message; }
}
async function adminSubAgents() {
  try {
    const d = await api('/api/subagents');
    document.getElementById('adminSubOut').textContent = JSON.stringify(d.tasks || d, null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminSubOut').textContent = '❌ ' + e.message; }
}
function spawnSubAgent() {
  const task = prompt('输入 SubAgent 任务描述:');
  if (!task || !clientId) { toast('请先连接'); return; }
  api('/api/subagents/spawn', 'POST', { name: '手动任务-' + Date.now(), task: task, userId: clientId }).then(d => toast('任务已创建: ' + d.id)).catch(e => toast('失败: ' + e.message));
}
async function adminCron() {
  try {
    const d = await api('/api/cron');
    const jobs = d.jobs || [];
    const el = document.getElementById('adminCronOut');
    if (!jobs.length) { el.innerHTML = '<span style="color:var(--text3);font-size:12px">暂无定时任务</span>'; return; }
    el.innerHTML = jobs.map(j => {
      const name = j.name || j.id || '未命名';
      const expr = j.schedule?.expr || j.schedule || '-';
      const next = j.nextRun ? new Date(j.nextRun).toLocaleString() : '-';
      return '<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">' +
        '⏰ <b>' + esc(name) + '</b>' +
        ' <span style="color:var(--text3)">' + esc(String(expr)) + '</span>' +
        ' <span style="color:var(--text3);font-size:10px">下次: ' + next + '</span>' +
        '<span style="float:right">' +
          '<button class="btn-sm" onclick="removeCron(\'' + esc(j.id) + '\')" style="color:var(--red);border-color:var(--red);padding:1px 6px;font-size:10px">🗑 删除</button>' +
        '</span></div>';
    }).join('');
  } catch(e) { document.getElementById('adminCronOut').textContent = '❌ ' + e.message; }
}
function showAddCron() { document.getElementById('addCronForm').classList.toggle('hidden'); }
async function removeCron(id) {
  if (!confirm('确定删除该定时任务？')) return;
  try {
    const d = await api('/api/cron/' + encodeURIComponent(id), 'DELETE');
    if (!d.ok) { toast('❌ ' + _errMsg(d, '删除失败')); return; }
    toast('已删除');
    adminCron();
  } catch(e) { toast('❌ ' + e.message); }
}
async function addCron() {
  const name = document.getElementById('cronName').value.trim();
  const expr = document.getElementById('cronExpr').value.trim();
  const tz = document.getElementById('cronTz').value.trim();
  let payload;
  try { payload = JSON.parse(document.getElementById('cronPayload').value); } catch(e) { toast('Payload JSON 格式错误'); return; }
  if (!name || !expr) { toast('名称和表达式必填'); return; }
  try {
    const d = await api('/api/cron', 'POST', { name, schedule: { kind: 'cron', expr, tz }, payload });
    toast('✅ 任务已创建'); document.getElementById('addCronForm').classList.add('hidden'); adminCron();
  } catch(e) { toast('失败: ' + e.message); }
}
async function adminMCP() {
  try {
    const d = await api('/api/mcp/servers');
    document.getElementById('adminMCPOut').textContent = JSON.stringify(d.servers || d, null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminMCPOut').textContent = '❌ ' + e.message; }
}
function showAddMCP() { document.getElementById('addMCPForm').classList.toggle('hidden'); }
async function addMCP() {
  const name = document.getElementById('mcpName').value.trim();
  const cmd = document.getElementById('mcpCmd').value.trim();
  const argsStr = document.getElementById('mcpArgs').value.trim();
  if (!name || !cmd) { toast('名称和命令必填'); return; }
  const args = argsStr ? argsStr.split(',').map(s=>s.trim()) : [];
  try {
    const d = await api('/api/mcp/servers', 'POST', { id: name, name, command: cmd, args });
    toast('✅ MCP 已添加'); document.getElementById('addMCPForm').classList.add('hidden'); adminMCP();
  } catch(e) { toast('失败: ' + e.message); }
}
async function adminPlugins() {
  try {
    const d = await api('/api/plugins');
    document.getElementById('adminPluginsOut').textContent = JSON.stringify(d.plugins || d, null, 2).slice(0, 600);
  } catch(e) { document.getElementById('adminPluginsOut').textContent = '❌ ' + e.message; }
}
async function reloadPlugins() {
  try { const d = await api('/api/plugins/reload', 'POST', {}); toast('✅ 插件已重载'); adminPlugins(); }
  catch(e) { toast('失败: ' + e.message); }
}

// ── Skill binding (bonus) ──
async function bindSkill(agentId, skillName) {
  try { await api('/api/agents/'+encodeURIComponent(agentId)+'/skills', 'POST', { skill: skillName }); toast('✅ 已绑定: ' + skillName); }
  catch(e) { toast('绑定失败'); }
}

// ── Utility ──
// ── V5 语音录制 ──
let mediaRecorder = null, audioChunks = [], recordingStream = null, recordingTimer = null, recordingStart = 0;
function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('不支持录音'); return; }
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
          const res = await fetch('/api/upload', { method: 'POST', body: fd });
          const data = await res.json();
          if (data.ok && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'message', chatId: currentChat || 'chat-demo-1', content: data.url, fileType: 'voice', duration: Math.ceil((Date.now() - recordingStart) / 1000) }));
          }
        } catch(e) { toast('语音上传失败'); }
      };
      reader.readAsDataURL(blob);
      stream.getTracks().forEach(t => t.stop());
    };
    mediaRecorder.start();
    recordingStart = Date.now();
    const btn = document.getElementById('recordBtn');
    btn.classList.add('recording');
    recordingTimer = setInterval(() => {
      const sec = Math.ceil((Date.now() - recordingStart) / 1000);
      if (sec >= 60) stopRecording();
    }, 1000);
  }).catch(e => { toast('麦克风访问失败'); });
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
  const btn = document.getElementById('recordBtn');
  if (btn) btn.classList.remove('recording');
}

// ── V5 收件箱/审批/技能/渠道面板 ──
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
    list.innerHTML = !items.length ? '<div style="color:#555;font-size:12px;padding:8px">暂无收件</div>' :
      items.map(i => '<div style="padding:8px;border-bottom:1px solid var(--border);cursor:pointer" onclick="readInbox(\'' + i.id + '\')"><div style="font-size:12px;color:' + (i.read ? 'var(--text3)' : 'var(--text)') + '">' + (i.read ? '✅' : '🔵') + ' [' + i.type + '] ' + esc(i.title) + '</div><div style="font-size:11px;color:var(--text3)">' + new Date(i.createdAt).toLocaleString('zh-CN') + '</div></div>').join('');
    const badge = document.getElementById('inboxBadge');
    if (badge) { badge.textContent = d.unread || 0; badge.style.display = d.unread ? 'inline-flex' : 'none'; }
  } catch(e) {}
}
async function readInbox(id) {
  try { await api('/api/inbox/' + id + '/read', 'POST'); loadInbox(); } catch(e) {}
}

// ── V5 通知栏 ──
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
    showNotification('灵犀引擎', (msg.senderName || msg.senderId || '新消息') + ': ' + (msg.content || '').slice(0, 50));
  }
};

// ═══════════════════════════════════════════════════════════
// 局域网社交 (LAN Social) 前端
// ═══════════════════════════════════════════════════════════
let lanTab = 'peers';
let lanSelf = null;
let lanCurrentGroup = null;      // 当前打开的群组对象
let lanStreaming = {};           // msgId -> {el, content} 智能体打字气泡
let lanSearchTimer = null;
let lanMeId = null;              // 真实登录用户 id（user-xxxx）

// 返回当前登录用户 id（优先用 /api/auth/me 解析出的真实 id）
function lanMyId() { return lanMeId || clientId; }

async function loadSocial() {
  // v2.0.10: /api/user/me 不存在，统一用 /api/auth/me
  if (!lanMeId) {
    try {
      const d = await api('/api/auth/me', 'GET');
      if (d && d.ok && d.user) lanMeId = d.user.sub || d.user.id || null;
    } catch(_e) {}
  }
  api('/api/lan/status', 'GET').then(d => {
    if (d && d.ok) {
      lanSelf = d;
      const badge = document.getElementById('lanSelfBadge');
      if (badge) badge.textContent = '本机 IP ' + (d.lanIp || '?') + ' · 邻居 ' + (d.peerCount || 0);
    }
  }).catch(() => {});
  lanRefresh();
}

function lanSwitchTab(tab) {
  lanTab = tab;
  ['peers', 'friends', 'groups'].forEach(t => {
    const b = document.getElementById('lanTab' + t.charAt(0).toUpperCase() + t.slice(1));
    if (b) { b.style.background = t === tab ? 'var(--accent)' : 'var(--bg3)'; b.style.color = t === tab ? '#fff' : 'var(--text2)'; }
  });
  document.getElementById('lanSearchInput').value = '';
  lanRefresh();
}

function lanRefresh() {
  const list = document.getElementById('lanList');
  if (lanTab === 'peers') {
    api('/api/lan/peers', 'GET').then(d => lanRenderPeers((d && d.peers) || []));
  } else if (lanTab === 'friends') {
    // v2.0.10: 统一用本地 api 并附带 userId
    const userId = lanMeId || clientId;
    if (!userId) { list.innerHTML = '<div class="empty">请先登录后查看好友</div>'; return; }
    Promise.all([
      api('/api/lan/friend-requests?userId=' + encodeURIComponent(userId), 'GET'),
      api('/api/lan/friends?userId=' + encodeURIComponent(userId), 'GET'),
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
    // v2.0.10: 统一用 /api/users/search
    api('/api/users/search?q=' + encodeURIComponent(q), 'GET').then(d => lanRenderSearch((d && d.results) || []));
  }, 250);
}

function lanRenderPeers(peers) {
  const list = document.getElementById('lanList');
  if (!peers.length) { list.innerHTML = '<div class="empty">暂未发现邻居<br><span style="font-size:11px">确保对方灵犀引擎在同一局域网</span></div>'; return; }
  let html = '';
  for (const p of peers) {
    html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">';
    html += '<div style="font-size:12px;color:var(--accent);margin-bottom:4px">🖥️ ' + esc(p.lanIp) + ':' + p.port + ' <span style="color:var(--text3);font-size:10px">v' + esc(p.version) + '</span></div>';
    for (const u of (p.users || [])) {
      html += '<div style="display:flex;align-items:center;justify-content:space-between;padding:3px 0;font-size:12px">' +
        '<span>👤 ' + esc(u.displayName) + ' <span style="color:var(--text3)">#' + u.numericId + '</span></span>' +
        '<button class="btn-sm" onclick="lanAddFriend(' + u.numericId + ')">＋好友</button></div>';
    }
    html += '</div>';
  }
  list.innerHTML = html;
}

function lanRenderSearch(results) {
  const list = document.getElementById('lanList');
  if (!results.length) { list.innerHTML = '<div class="empty">未找到匹配的用户</div>'; return; }
  let html = '<div style="font-size:11px;color:var(--text3);margin-bottom:6px">搜索结果</div>';
  for (const r of results) {
    html += '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:6px;font-size:12px">' +
      '<span>' + (r.local ? '🏠' : '🌐') + ' ' + esc(r.displayName) + ' <span style="color:var(--text3)">#' + r.numericId + '</span></span>' +
      (String(r.numericId) === String(lanMyId()) ? '<span style="color:var(--text3);font-size:10px">本机</span>' : '<button class="btn-sm" onclick="lanAddFriend(' + r.numericId + ')">＋好友</button>') +
      '</div>';
  }
  list.innerHTML = html;
}

function lanRenderFriends(incoming, friends) {
  const list = document.getElementById('lanList');
  let html = '';
  if (incoming.length) {
    html += '<div style="font-size:11px;color:var(--accent);margin:4px 0">好友申请</div>';
    for (const r of incoming) {
      html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:6px;font-size:12px">' +
        '<div>👤 ' + esc(r.fromName || r.fromUserId) + (r.fromNumericId ? ' <span style="color:var(--text3)">#' + r.fromNumericId + '</span>' : '') + '</div>' +
        (r.message ? '<div style="color:var(--text3);font-size:11px;margin:2px 0">' + esc(r.message) + '</div>' : '') +
        '<div style="display:flex;gap:6px;margin-top:4px"><button class="btn-sm" style="background:#16a34a;color:#fff" onclick="lanRespondFriend(\'' + r.id + '\',\'accept\')">接受</button>' +
        '<button class="btn-sm" onclick="lanRespondFriend(\'' + r.id + '\',\'reject\')">拒绝</button></div></div>';
    }
  }
  html += '<div style="font-size:11px;color:var(--accent);margin:4px 0">我的好友</div>';
  if (!friends.length) {
    html += '<div class="empty">还没有好友<br><span style="font-size:11px">在「邻居」里按 ID 添加</span></div>';
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
  if (!groups.length) { list.innerHTML = '<div class="empty">还没有群组<br><span style="font-size:11px">点击下方按钮创建</span></div>'; return; }
  let html = '';
  for (const g of groups) {
    const active = lanCurrentGroup && lanCurrentGroup.id === g.id;
    html += '<div onclick="lanOpenGroup(\'' + g.id + '\')" style="cursor:pointer;background:' + (active ? 'var(--bg3)' : 'var(--bg)') + ';border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:6px">' +
      '<div style="font-size:13px;font-weight:600">👥 ' + esc(g.name) + '</div>' +
      '<div style="font-size:11px;color:var(--text3);margin-top:2px">' + (g.memberCount || 0) + ' 成员 · 模式 ' + esc(g.chatMode || 'free') + '</div></div>';
  }
  list.innerHTML = html;
}

async function lanAddFriend(numericId) {
  // v2.0.10: 统一用本地 api 并传 fromUserId
  const fromUserId = lanMeId || clientId;
  if (!fromUserId) { toast('请先登录后加好友'); return; }
  const message = prompt('给 ' + numericId + ' 的好友申请留言（可留空）:', '') || '';
  try {
    const r = await api('/api/lan/friend-request', 'POST', { fromUserId, toNumericId: numericId, message });
    if (r && r.ok !== false && !r.error) toast('✅ 好友申请已发送');
    else toast('❌ ' + _errMsg(r, '发送失败'));
  } catch (e) { toast('❌ ' + e.message); }
}

async function lanRespondFriend(requestId, action) {
  try {
    // v2.0.10: 统一用本地 api
    const r = await api('/api/lan/friend-respond', 'POST', { requestId, action });
    if (r && !r.error) toast(action === 'accept' ? '✅ 已添加好友' : '已拒绝');
    else toast('❌ ' + _errMsg(r, '操作失败'));
    lanRefresh();
  } catch (e) { toast('❌ ' + e.message); }
}

async function lanShowCreateGroup() {
  const name = prompt('群组名称:', '局域网群聊');
  if (!name) return;
  const idsRaw = prompt('成员数字 ID（逗号分隔，可留空仅自己）:', '');
  const memberNumericIds = (idsRaw || '').split(/[,，\s]+/).map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0);
  try {
    const r = await api('/api/lan/group-create', 'POST', { ownerUserId: lanMyId(), name, memberNumericIds, chatMode: 'free' });
    if (r && r.ok) { toast('✅ 群组已创建'); lanSwitchTab('groups'); lanOpenGroup(r.groupId); }
    else toast('❌ ' + (r.error || '创建失败'));
  } catch (e) { toast('❌ ' + e.message); }
}

async function lanOpenGroup(groupId) {
  try {
    const d = await api('/api/lan/group?groupId=' + encodeURIComponent(groupId), 'GET');
    if (!d || !d.group) { toast('群组不存在'); return; }
    lanCurrentGroup = d.group;
    // 订阅这个群的两个聊天，接收实时消息
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
  } catch (e) { toast('❌ ' + e.message); }
}

async function lanLoadHistory(chatId, container) {
  try {
    const d = await api('/api/chats/' + encodeURIComponent(chatId) + '/messages', 'GET');
    container.innerHTML = '';
    const msgs = (d && d.messages) || [];
    if (!msgs.length) { container.innerHTML = '<div class="empty">暂无消息</div>'; return; }
    // 历史消息 DB 不存 senderName，从群成员表解析显示名
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
        content: m.content, timestamp: m.timestamp,
      }, container);
    }
    container.scrollTop = container.scrollHeight;
  } catch (e) { container.innerHTML = '<div class="empty">加载失败</div>'; }
}

async function lanSetGroupMode(mode) {
  if (!lanCurrentGroup) return;
  try {
    const r = await api('/api/lan/group-mode', 'POST', { groupId: lanCurrentGroup.id, mode });
    if (r && r.ok) toast('✅ 智能体模式: ' + mode);
    else toast('❌ ' + (r.error || '设置失败'));
  } catch (e) { toast('❌ ' + e.message); }
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
    if (r && r.error) toast('❌ ' + r.error);
  } catch (e) { toast('❌ ' + e.message); }
}

async function lanSendAgent() {
  if (!lanCurrentGroup) return;
  const input = document.getElementById('lanAgentInput');
  const topic = input.value.trim();
  if (!topic) return;
  input.value = '';
  try {
    const r = await api('/api/lan/group-agent-topic', 'POST', { senderUserId: lanMyId(), groupId: lanCurrentGroup.id, topic });
    if (r && r.error) toast('❌ ' + r.error);
  } catch (e) { toast('❌ ' + e.message); }
}

// 渲染一条 LAN 消息到指定容器
function lanAppendMessage(msg, container) {
  if (!container) return;
  // 去重：同一 msgId 已渲染则跳过（防重连重放 / 历史与实时 echo 重叠）
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
  const bubble = isAgent ? '<div class="msg-content">' + markdownToHtml(content) + '</div>' : '<div class="msg-content">' + esc(content) + '</div>';
  const avatar = isAgent ? '🤖' : (isMe ? '🙂' : '👤');
  el.innerHTML = '<div class="msg-avatar ' + (isAgent ? 'ai' : 'human') + '">' + avatar + '</div>' +
    '<div style="max-width:72%"><div class="msg-sender" style="font-size:10px;color:var(--text3);margin-bottom:2px">' + esc(name) + '</div>' +
    '<div class="msg-bubble">' + bubble + '</div><div class="msg-meta">' + time + '</div></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

// 智能体打字气泡（LAN 智能体交互框）
function lanStreamingStart(msg) {
  const container = document.getElementById('lanAgentMessages');
  if (!container) return;
  const empty = container.querySelector('.empty'); if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'msg-row ai';
  const name = (msg.senderName || (msg.from || '').replace(/^agent:/, '')).toString();
  el.innerHTML = '<div class="msg-avatar ai">🤖</div><div style="max-width:72%"><div class="msg-sender" style="font-size:10px;color:var(--text3);margin-bottom:2px">' + esc(name) + '</div>' +
    '<div class="msg-bubble"><div class="msg-content"><span class="typing-dot">思考中…</span></div></div></div>';
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  lanStreaming[msg.msgId] = { el, content: '', senderId: msg.senderId || msg.from || '' };
}
function lanStreamingChunk(msg) {
  const s = lanStreaming[msg.msgId];
  if (!s) return;
  s.content += msg.chunk || '';
  const c = s.el.querySelector('.msg-content');
  if (c) c.textContent = s.content;
  const container = document.getElementById('lanAgentMessages');
  if (container) container.scrollTop = container.scrollHeight;
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
      // 清除该 agent 残留的打字气泡（流式 bubbleId 与终稿 msgId 不同，按 senderId 匹配），避免重复
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
    toast('🌐 收到好友申请: ' + ((msg.from && msg.from.displayName) || ''));
    if (lanTab === 'friends') lanRefresh();
  } else if (type === 'lan.friend.accepted') {
    toast('✅ 好友已接受');
    if (lanTab === 'friends') lanRefresh();
  } else if (type === 'lan.group.invited') {
    toast('🌐 你被邀请加入群组: ' + (msg.name || ''));
    if (lanTab === 'groups') lanRefresh();
  } else if (type === 'lan.group.created') {
    if (lanTab === 'groups') lanRefresh();
  } else if (type === 'error') {
    if (lanCurrentGroup && msg.chatId === lanCurrentGroup.agentChatId) {
      toast('❌ ' + (msg.message || '智能体编排失败'));
      const c = document.getElementById('lanAgentMessages');
      if (c) { const empty = c.querySelector('.empty'); if (empty) empty.remove(); c.insertAdjacentHTML('beforeend', '<div style="text-align:center;font-size:11px;color:var(--red);margin:4px 0">❌ ' + esc(msg.message || '编排失败') + '</div>'); c.scrollTop = c.scrollHeight; }
    }
  }
}

// ── 右侧栏：任务监控（Cron 定时任务）──
async function loadTaskMonitor() {
  const el = document.getElementById('taskMonitorList');
  if (!el) return;
  try {
    const d = await api('/api/cron');
    const jobs = d.jobs || [];
    if (!jobs.length) {
      el.innerHTML = '<span style="color:var(--text3)">暂无定时任务，可在管理面板添加</span>';
      return;
    }
    el.innerHTML = jobs.map(j => {
      const name = esc(j.name || j.id || '未命名');
      const expr = esc(String(j.schedule?.expr || j.schedule || '-'));
      const enabled = j.enabled !== false;
      const pill = enabled ? '<span class="status-pill pill-on">运行中</span>' : '<span class="status-pill pill-off">已暂停</span>';
      const next = j.nextRun ? new Date(j.nextRun).toLocaleString() : '-';
      const lastRun = j.lastRun ? new Date(j.lastRun).toLocaleString() : '-';
      const runCount = j.runCount || 0;
      const jid = esc(j.id);
      const runBtn = enabled
        ? '<button class="run" onclick="runTaskMonitor(\'' + jid + '\')">▶ 运行</button><button onclick="toggleTaskMonitor(\'' + jid + '\',false)">暂停</button>'
        : '<button class="run" onclick="runTaskMonitor(\'' + jid + '\')">▶ 运行</button><button style="color:var(--green)" onclick="toggleTaskMonitor(\'' + jid + '\',true)">启用</button>';
      return '<div class="task-card">' +
        '<div class="task-name">' + name + ' ' + pill + '</div>' +
        '<div class="task-meta">表达式：<code>' + expr + '</code><br>下次执行：' + esc(next) + '<br>上次：' + esc(lastRun) + ' · 执行' + runCount + '次</div>' +
        '<div class="task-actions">' + runBtn +
          '<button class="del" onclick="removeTaskMonitor(\'' + jid + '\')">删除</button>' +
        '</div></div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<span style="color:var(--red)">❌ ' + esc(e.message || '加载失败') + '</span>';
  }
}
async function runTaskMonitor(id) {
  try {
    const d = await api('/api/cron/' + encodeURIComponent(id) + '/run', 'POST');
    if (d.ok) { toast('✅ 已触发运行'); loadTaskMonitor(); }
    else toast('❌ 运行失败');
  } catch(e) { toast('❌ ' + e.message); }
}
async function toggleTaskMonitor(id, enabled) {
  try {
    const d = await api('/api/cron/' + encodeURIComponent(id), 'PATCH', { enabled });
    if (d.ok) { toast(enabled ? '已启用' : '已暂停'); loadTaskMonitor(); }
    else toast('❌ 操作失败');
  } catch(e) { toast('❌ ' + e.message); }
}
async function removeTaskMonitor(id) {
  if (!confirm('确定删除该定时任务？')) return;
  try {
    const d = await api('/api/cron/' + encodeURIComponent(id), 'DELETE');
    if (d.ok) { toast('已删除'); loadTaskMonitor(); }
    else toast('❌ 删除失败');
  } catch(e) { toast('❌ ' + e.message); }
}

// ── 右侧栏：目标任务（GoalTracker）──
const RIGHT_GOAL_EMOJI = { pending: '⏳', in_progress: '🔄', done: '✅', cancelled: '❌' };
const RIGHT_GOAL_LABEL = { pending: '待开始', in_progress: '进行中', done: '已完成', cancelled: '已取消' };
const RIGHT_GOAL_COLOR = { pending: 'var(--text3)', in_progress: 'var(--accent)', done: 'var(--green)', cancelled: 'var(--text3)' };
async function loadRightGoals() {
  const el = document.getElementById('rightGoalsList');
  if (!el) return;
  try {
    const d = await api('/api/goals');
    if (!d.ok) { el.innerHTML = '<span style="color:var(--red)">❌ ' + esc(_errMsg(d, '加载失败')) + '</span>'; return; }
    const goals = d.goals || [];
    if (!goals.length) {
      el.innerHTML = '<span style="color:var(--text3)">暂无目标，点击下方添加</span>';
      return;
    }
    const done = goals.filter(g => g.status === 'done').length;
    const total = goals.length;
    const pct = total > 0 ? Math.round(done / total * 100) : 0;
    const pg = document.getElementById('goalProgress');
    if (pg) pg.textContent = done + '/' + total;
    el.innerHTML = goals.map(g => {
      const st = g.status || 'pending';
      const emoji = RIGHT_GOAL_EMOJI[st] || '⏳';
      const label = RIGHT_GOAL_LABEL[st] || st;
      const color = RIGHT_GOAL_COLOR[st] || 'var(--text3)';
      const style = st === 'done' ? 'text-decoration:line-through;color:var(--text3)' : (st === 'cancelled' ? 'color:var(--text3)' : '');
      const gid = esc(g.id);
      let acts = '';
      if (st === 'pending') acts += '<a onclick="setRightGoalStatus(\'' + gid + '\',\'in_progress\')" title="开始" style="cursor:pointer;font-size:16px">▶️</a> ';
      if (st !== 'done' && st !== 'cancelled') acts += '<a onclick="setRightGoalStatus(\'' + gid + '\',\'done\')" title="完成" style="cursor:pointer;font-size:16px">✅</a> ';
      if (st === 'done' || st === 'cancelled') acts += '<a onclick="setRightGoalStatus(\'' + gid + '\',\'pending\')" title="恢复" style="cursor:pointer;font-size:16px">↩️</a> ';
      acts += '<a onclick="askAIAboutGoal(\'' + gid + '\',\'' + esc(g.title).replace(/'/g, "\\'") + '\')" title="AI反问" style="cursor:pointer;font-size:16px">❓</a> ';
      acts += '<a onclick="deleteRightGoal(\'' + gid + '\')" title="删除" style="cursor:pointer;font-size:16px">🗑️</a>';
      const criteria = g.acceptanceCriteria ? '<div style="font-size:10px;color:var(--text3);margin-top:3px">' + esc(g.acceptanceCriteria) + '</div>' : '';
      const barColor = st === 'done' ? 'var(--green)' : 'var(--accent)';
      const barWidth = st === 'done' ? 100 : (st === 'in_progress' ? 50 : 0);
      return '<div class="goal-item">' +
        '<div class="goal-head"><span class="g-status">' + emoji + '</span>' +
        '<b style="' + style + '">' + esc(g.title) + '</b>' +
        '<span style="margin-left:auto;font-size:11px;color:' + color + '">' + label + '</span></div>' +
        '<div class="goal-bar"><i style="width:' + barWidth + '%;background:' + barColor + '"></i></div>' +
        '<div class="goal-foot"><span>进度 ' + barWidth + '%</span>' +
        '<span style="float:right">' + acts + '</span></div>' +
        criteria + '</div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<span style="color:var(--red)">❌ ' + esc(e.message || '网络错误') + '</span>';
  }
}
async function addRightGoal() {
  const title = prompt('目标名称：');
  if (!title) return;
  const desc = prompt('目标描述（可选）：');
  try {
    const d = await api('/api/goals', 'POST', { title: title.trim(), acceptanceCriteria: desc || '' });
    if (d.ok) { toast('✅ 目标已添加'); loadRightGoals(); }
    else toast('❌ ' + _errMsg(d, '添加失败'));
  } catch(e) { toast('❌ ' + e.message); }
}
async function setRightGoalStatus(id, status) {
  try {
    const d = await api('/api/goals/' + encodeURIComponent(id), 'PATCH', { status });
    if (d.ok) loadRightGoals();
    else toast('❌ ' + _errMsg(d, '操作失败'));
  } catch(e) { toast('❌ ' + e.message); }
}
async function deleteRightGoal(id) {
  if (!confirm('确定删除此目标？')) return;
  try {
    const d = await api('/api/goals/' + encodeURIComponent(id), 'DELETE');
    if (d.ok) { toast('已删除'); loadRightGoals(); }
    else toast('❌ ' + _errMsg(d, '删除失败'));
  } catch(e) { toast('❌ ' + e.message); }
}

// ═══ 子任务面板（v2.0 子代理）═══
function loadSubAgents(){
  fetch('/api/subagents').then(function(r){return r.json()}).then(function(d){
    var el=document.getElementById('subAgentList');
    if(!el) return;
    if(!d.ok||!d.tasks||!d.tasks.length){ el.innerHTML='<span style="color:var(--text3)">暂无子任务</span>'; return; }
    el.innerHTML=d.tasks.map(function(t){
      var st=t.status==='completed'?'✅':t.status==='failed'?'❌':t.status==='timeout'?'⏰':(t.status==='running'?'🔄':'⏳');
      var stc=t.status==='completed'?'#2e7d32':(t.status==='failed'||t.status==='timeout')?'#c62828':'#1565c0';
      var esc=function(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};
      return '<div style="border:1px solid var(--border);border-radius:8px;padding:8px;margin-bottom:8px">'+
        '<div style="font-weight:600;font-size:12px">'+st+' '+(t.taskName||'').slice(0,30)+'</div>'+
        '<div style="font-size:11px;color:var(--text3);margin:2px 0">目标: '+esc((t.objective||'').slice(0,100))+'</div>'+
        '<div style="font-size:11px;color:'+stc+'">状态: '+t.status+' · 耗时: '+((t.completedAt||t.startedAt||t.createdAt)?'': '')+(t.model?' · '+esc(t.model):'')+'</div>'+
        (t.result?'<div style="font-size:11px;color:var(--text3);margin-top:4px;word-break:break-all">'+esc(t.result.slice(0,300))+'</div>':'')+
        (t.error?'<div style="font-size:11px;color:#c62828;margin-top:2px">'+esc(t.error)+'</div>':'')+
        '</div>';
    }).join('');
  }).catch(function(){});
}
setInterval(loadSubAgents, 15000);
