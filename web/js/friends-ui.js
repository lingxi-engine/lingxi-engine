/* ═══════════════════════════════════════════════════════════
   灵犀引擎 · 通讯录（QQ/微信风格好友面板） v1.0 — 20261118
   自包含模块 window.LxFriends：
     open / close / openRequestDialog / confirm / setBadge / syncFromState
   复用 app.js 的全局 api/platformApi/loadFriends/loadRequests/sendRequest 等，
   不改动后端；旧 friendPanel 保留为回退。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── 多语言（zh/zh-TW/en 全量，其余语言关键项+en 回退） ── */
  var D = {
    zh: {
      title: '通讯录', newFriends: '新的朋友', addFriend: '添加朋友',
      myId: '我的 ID', copy: '复制', copied: '已复制到剪贴板',
      friendsSec: '好友', noFriends: '还没有好友', noFriendsHint: '搜索 ID 或昵称，添加你的第一个朋友',
      goAdd: '去添加', searchPh: '搜索 ID / 昵称', searching: '搜索中…',
      noResult: '没有找到匹配的用户', searchHint: '输入对方的 ID 或昵称开始搜索',
      add: '添加', isFriend: '已是好友', pending: '等待验证', me: '我',
      reqTitle: '发送好友申请', verifyMsg: '验证消息（可选）', verifyPh: '说点什么，让对方记得你～',
      send: '发送申请', cancel: '取消', sentToast: '申请已发送，等待对方接受',
      received: '收到的', sentOut: '发出的', noIncoming: '暂无新的好友申请', noOutgoing: '暂无发出的申请',
      accept: '接受', reject: '拒绝', withdraw: '撤回',
      stPending: '等待验证', stAccepted: '已接受', stRejected: '已拒绝',
      rejTitle: '拒绝好友申请', rejMsg: '确定拒绝 {name} 的好友申请吗？',
      delTitle: '删除好友', delMsg: '确定删除好友「{name}」吗？聊天记录会保留。',
      wdMsg: '确定撤回这条好友申请吗？',
      del: '删除', chat: '发消息', msgLabel: '验证消息', idLabel: 'ID',
      loadFail: '加载失败，请稍后重试', clickChat: '点击发起聊天',
      chip1: '你好，我是{me}', chip2: '交个朋友吧～', chip3: '我们在一个群里聊过'
    },
    'zh-TW': {
      title: '通訊錄', newFriends: '新的朋友', addFriend: '新增朋友',
      myId: '我的 ID', copy: '複製', copied: '已複製到剪貼簿',
      friendsSec: '好友', noFriends: '還沒有好友', noFriendsHint: '搜尋 ID 或暱稱，新增你的第一個朋友',
      goAdd: '去新增', searchPh: '搜尋 ID / 暱稱', searching: '搜尋中…',
      noResult: '沒有找到符合的使用者', searchHint: '輸入對方的 ID 或暱稱開始搜尋',
      add: '新增', isFriend: '已是好友', pending: '等待驗證', me: '我',
      reqTitle: '傳送好友申請', verifyMsg: '驗證訊息（可選）', verifyPh: '說點什麼，讓對方記得你～',
      send: '傳送申請', cancel: '取消', sentToast: '申請已傳送，等待對方接受',
      received: '收到的', sentOut: '傳出的', noIncoming: '暫無新的好友申請', noOutgoing: '暫無傳出的申請',
      accept: '接受', reject: '拒絕', withdraw: '撤回',
      stPending: '等待驗證', stAccepted: '已接受', stRejected: '已拒絕',
      rejTitle: '拒絕好友申請', rejMsg: '確定拒絕 {name} 的好友申請嗎？',
      delTitle: '刪除好友', delMsg: '確定刪除好友「{name}」嗎？聊天記錄會保留。',
      wdMsg: '確定撤回這條好友申請嗎？',
      del: '刪除', chat: '傳訊息', msgLabel: '驗證訊息', idLabel: 'ID',
      loadFail: '載入失敗，請稍後重試', clickChat: '點擊發起聊天',
      chip1: '你好，我是{me}', chip2: '交個朋友吧～', chip3: '我們在一个群裡聊過'
    },
    en: {
      title: 'Contacts', newFriends: 'New Friends', addFriend: 'Add Friend',
      myId: 'My ID', copy: 'Copy', copied: 'Copied to clipboard',
      friendsSec: 'Friends', noFriends: 'No friends yet', noFriendsHint: 'Search by ID or nickname to add your first friend',
      goAdd: 'Add now', searchPh: 'Search ID / nickname', searching: 'Searching…',
      noResult: 'No matching users found', searchHint: 'Type an ID or nickname to search',
      add: 'Add', isFriend: 'Friends', pending: 'Pending', me: 'Me',
      reqTitle: 'Friend Request', verifyMsg: 'Message (optional)', verifyPh: 'Say hi so they remember you~',
      send: 'Send Request', cancel: 'Cancel', sentToast: 'Request sent, waiting for acceptance',
      received: 'Received', sentOut: 'Sent', noIncoming: 'No new friend requests', noOutgoing: 'No sent requests',
      accept: 'Accept', reject: 'Decline', withdraw: 'Withdraw',
      stPending: 'Pending', stAccepted: 'Accepted', stRejected: 'Declined',
      rejTitle: 'Decline Request', rejMsg: 'Decline the friend request from {name}?',
      delTitle: 'Remove Friend', delMsg: 'Remove "{name}" from friends? Chat history is kept.',
      wdMsg: 'Withdraw this friend request?',
      del: 'Remove', chat: 'Message', msgLabel: 'Message', idLabel: 'ID',
      loadFail: 'Failed to load, please retry', clickChat: 'Click to chat',
      chip1: "Hi, I'm {me}", chip2: "Let's be friends~", chip3: 'We met in a group chat'
    },
    ja: { title: '連絡先', newFriends: '新しい友達', addFriend: '友達を追加', accept: '承認', reject: '拒否', send: '申請を送信', cancel: 'キャンセル', searchPh: 'ID / ニックネームで検索', noFriends: 'まだ友達がいません', friendsSec: '友達' },
    ko: { title: '연락처', newFriends: '새로운 친구', addFriend: '친구 추가', accept: '수락', reject: '거절', send: '요청 보내기', cancel: '취소', searchPh: 'ID / 닉네임 검색', noFriends: '아직 친구가 없습니다', friendsSec: '친구' },
    vi: { title: 'Danh bạ', newFriends: 'Bạn mới', addFriend: 'Thêm bạn', accept: 'Đồng ý', reject: 'Từ chối', send: 'Gửi yêu cầu', cancel: 'Hủy', searchPh: 'Tìm ID / biệt danh', noFriends: 'Chưa có bạn bè', friendsSec: 'Bạn bè' },
    th: { title: 'รายชื่อ', newFriends: 'เพื่อนใหม่', addFriend: 'เพิ่มเพื่อน', accept: 'ยอมรับ', reject: 'ปฏิเสธ', send: 'ส่งคำขอ', cancel: 'ยกเลิก', searchPh: 'ค้นหา ID / ชื่อเล่น', noFriends: 'ยังไม่มีเพื่อน', friendsSec: 'เพื่อน' }
  };
  function lang() { try { return (window.I18N && I18N.lang) || 'zh'; } catch (e) { return 'zh'; } }
  function ft(k, p) {
    var d = D[lang()] || {}; var s = d[k] || D.en[k] || D.zh[k] || k;
    if (p) for (var key in p) s = s.split('{' + key + '}').join(p[key]);
    return s;
  }
  function E(s) {
    if (window.esc) return esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function toast(m) { if (window.toast) window.toast(m); } // S5: 调 window.toast；此前递归调用自身导致栈溢出

  /* ── 渐变头像（按 ID 哈希取色） ── */
  var PAL = [['#6366f1', '#8b5cf6'], ['#0ea5e9', '#22d3ee'], ['#f59e0b', '#f97316'], ['#10b981', '#34d399'], ['#ec4899', '#f472b6'], ['#8b5cf6', '#d946ef'], ['#14b8a6', '#06b6d4'], ['#f43f5e', '#fb7185']];
  function hash(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function av(id, name, size) {
    var c = PAL[hash(id) % PAL.length];
    var ch = E(((name || '?').trim()[0] || '?').toUpperCase());
    return '<div class="lx-av" style="width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.42) + 'px;background:linear-gradient(135deg,' + c[0] + ',' + c[1] + ')">' + ch + '</div>';
  }

  /* ── 状态 ── */
  var isOpen = false, view = 'main', reqTab = 'in', badge = 0;
  var myInfo = null, lastResults = [], searchTimer = null, built = false;
  var root = null, drawer = null, body = null, headTitle = null, backBtn = null, modalRoot = null;

  function g(name) { return window[name]; }
  // app.js 顶层 let 绑定在全局词法环境，window 取不到（同名 id 元素还会污染 window）→ 间接 eval 读取
  function lex(n) { try { return (0, eval)(n); } catch (e) { return undefined; } }
  function state() {
    return {
      friends: lex('myFriends') || [],
      incoming: lex('incomingRequests') || [],
      outgoing: lex('outgoingRequests') || []
    };
  }
  function myId() {
    if (myInfo && myInfo.id) return String(myInfo.id);
    try { if (g('lanMyId')) return String(lanMyId()); } catch (e) {}
    return String(lex('lanMeId') || lex('clientId') || '');
  }
  function myName() { return (myInfo && myInfo.name) || ft('me'); }

  /* ── DOM 构建 ── */
  function build() {
    if (built) return;
    built = true;
    root = document.createElement('div');
    root.innerHTML =
      '<div class="lx-backdrop" id="lxBackdrop"></div>' +
      '<div class="lx-drawer" id="lxDrawer" role="dialog" aria-label="Contacts">' +
      '  <div class="lx-head">' +
      '    <button class="lx-back" id="lxBack" style="visibility:hidden">←</button>' +
      '    <h3 id="lxTitle"></h3>' +
      '    <button class="lx-close" id="lxClose">✕</button>' +
      '  </div>' +
      '  <div class="lx-body" id="lxBody"></div>' +
      '</div>' +
      '<div class="lx-modal-backdrop" id="lxModal"></div>';
    document.body.appendChild(root);
    drawer = root.querySelector('#lxDrawer');
    body = root.querySelector('#lxBody');
    headTitle = root.querySelector('#lxTitle');
    backBtn = root.querySelector('#lxBack');
    modalRoot = root.querySelector('#lxModal');
    root.querySelector('#lxBackdrop').addEventListener('click', close);
    root.querySelector('#lxClose').addEventListener('click', close);
    backBtn.addEventListener('click', function () { view = 'main'; render(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (modalRoot.classList.contains('show')) closeModal(); else if (isOpen) close(); }
    });
  }

  /* ── 渲染 ── */
  function render() {
    if (!built) return;
    backBtn.style.visibility = view === 'main' ? 'hidden' : 'visible';
    headTitle.textContent = view === 'main' ? ft('title') : view === 'add' ? ft('addFriend') : ft('newFriends');
    if (view === 'main') renderMain();
    else if (view === 'add') renderAdd();
    else renderRequests();
  }

  function renderMain() {
    var s = state();
    var html = '';
    html += '<div class="lx-me">' + av(myId(), myName(), 46) +
      '<div class="lx-me-info"><div class="lx-me-name">' + E(myName()) + '</div>' +
      '<div class="lx-me-id">' + ft('myId') + ': ' + E(myId()) + ' <button class="lx-copy" data-act="copy">' + ft('copy') + '</button></div></div></div>';
    html += '<button class="lx-entry" data-act="requests"><span class="lx-ico green">👋</span>' + ft('newFriends') +
      ' <span class="lx-badge' + (badge ? '' : ' hide') + '" id="lxBadge">' + badge + '</span><span class="lx-arrow">›</span></button>';
    html += '<button class="lx-entry" data-act="add"><span class="lx-ico blue">➕</span>' + ft('addFriend') + '<span class="lx-arrow">›</span></button>';
    html += '<div class="lx-sec">' + ft('friendsSec') + ' · ' + s.friends.length + '</div>';
    if (!s.friends.length) {
      html += '<div class="lx-empty"><div class="lx-empty-ico">🌱</div><div class="lx-empty-txt">' + ft('noFriends') + '</div><div class="lx-empty-sub">' + ft('noFriendsHint') + '</div><button data-act="add">' + ft('goAdd') + '</button></div>';
    } else {
      html += s.friends.map(function (f) {
        var fid = String(f.friendId);
        var fname = f.friendName || f.displayName || (ft('me') + fid);
        return '<div class="lx-row" data-chat="' + E(fid) + '" data-name="' + E(fname) + '" title="' + E(ft('clickChat')) + '">' +
          av(fid, fname, 42) +
          '<div class="lx-row-info"><div class="lx-row-name">' + E(fname) + '</div><div class="lx-row-sub">' + ft('idLabel') + ': ' + E(fid) + '</div></div>' +
          '<button class="lx-row-del" data-del="' + E(fid) + '" data-name="' + E(fname) + '" title="' + E(ft('del')) + '">✕</button></div>';
      }).join('');
    }
    body.innerHTML = html;
  }

  function renderAdd() {
    var html = '<div class="lx-search"><span class="lx-search-ico">🔍</span><input id="lxSearchInput" placeholder="' + E(ft('searchPh')) + '" autocomplete="off"></div>';
    html += '<div id="lxSearchOut"></div>';
    body.innerHTML = html;
    var inp = body.querySelector('#lxSearchInput');
    inp.addEventListener('input', function () {
      clearTimeout(searchTimer);
      var q = inp.value.trim();
      searchTimer = setTimeout(function () { doSearch(q); }, 300);
    });
    inp.focus();
    paintSearch(ft('searchHint'), 'hint');
  }

  function paintSearch(content, kind) {
    var out = body && body.querySelector('#lxSearchOut');
    if (!out) return;
    if (kind === 'hint') out.innerHTML = '<div class="lx-empty"><div class="lx-empty-ico">🪪</div><div class="lx-empty-sub">' + E(content) + '</div></div>';
    else if (kind === 'loading') out.innerHTML = '<div class="lx-empty"><div class="lx-empty-sub">' + E(content) + '</div></div>';
    else if (kind === 'empty') out.innerHTML = '<div class="lx-empty"><div class="lx-empty-ico">🔎</div><div class="lx-empty-txt">' + E(content) + '</div></div>';
    else out.innerHTML = content;
  }

  function doSearch(q) {
    if (!q) { paintSearch(ft('searchHint'), 'hint'); return; }
    paintSearch(ft('searching'), 'loading');
    var url = '/api/lan/search?q=' + encodeURIComponent(q);
    var p;
    try {
      if (lex('authToken') && g('platformApi')) {
        p = platformApi(url, 'GET').then(function (d) {
          if (!d || d.ok === false) return api(url, 'GET');
          return d;
        });
      } else p = api(url, 'GET');
    } catch (e) { paintSearch(ft('loadFail'), 'empty'); return; }
    p.then(function (d) {
      var seen = {};
      lastResults = ((d && d.results) || []).filter(function (u) {
        // S6：去重键 instanceId+userId（跨引擎 numericId 同号是常态，仅按数字去重会误合并不同人）
        var k = String(u.instanceId || '') + ':' + String(u.userId || u.numericId); if (seen[k]) return false; seen[k] = true; return true;
      });
      if (!lastResults.length) { paintSearch(ft('noResult'), 'empty'); return; }
      var s = state();
      var html = lastResults.map(function (u) {
        var uid = String(u.numericId);
        var name = u.displayName || (ft('me') + uid);
        var isMe = uid === myId();
        var realId = String(u.userId || '');
        var isFriend = s.friends.some(function (f) { var fid = String(f.friendId); return fid === uid || (realId && fid === realId); });
        var isPending = s.outgoing.some(function (r) { var tid = String(r.toUserId); return (tid === uid || tid === 'remote-' + uid || (realId && tid === realId)) && r.status === 'pending'; });
        var act;
        if (isMe) act = '<span class="lx-status accepted">' + ft('me') + '</span>';
        else if (isFriend) act = '<span class="lx-status accepted">' + ft('isFriend') + '</span>';
        else if (isPending) act = '<span class="lx-status pending">' + ft('pending') + '</span>';
        else act = '<button class="lx-btn pri" data-add="' + E(uid) + '" data-inst="' + E(u.instanceId || '') + '" data-name="' + E(name) + '">' + ft('add') + '</button>';
        return '<div class="lx-row" style="cursor:default">' + av(uid, name, 42) +
          '<div class="lx-row-info"><div class="lx-row-name">' + E(name) + '</div><div class="lx-row-sub">' + ft('idLabel') + ': ' + E(uid) + '</div></div>' + act + '</div>';
      }).join('');
      paintSearch(html, 'html');
    }).catch(function () { paintSearch(ft('loadFail'), 'empty'); });
  }

  function renderRequests() {
    var s = state();
    var html = '<div class="lx-seg"><button data-rt="in" class="' + (reqTab === 'in' ? 'on' : '') + '">' + ft('received') +
      (badge ? ' <span class="lx-badge">' + badge + '</span>' : '') + '</button><button data-rt="out" class="' + (reqTab === 'out' ? 'on' : '') + '">' + ft('sentOut') + '</button></div>';
    if (reqTab === 'in') {
      var pend = s.incoming.filter(function (r) { return r.status === 'pending'; });
      if (!pend.length) html += '<div class="lx-empty"><div class="lx-empty-ico">📭</div><div class="lx-empty-sub">' + ft('noIncoming') + '</div></div>';
      else html += pend.map(function (r) {
        var name = r.fromName || (ft('me') + r.fromUserId);
        return '<div class="lx-req">' + av(r.fromUserId, name, 42) +
          '<div class="lx-req-info"><div class="lx-req-name">' + E(name) + '</div>' +
          (r.message ? '<div class="lx-req-msg">' + E(r.message) + '</div>' : '') +
          '<div class="lx-req-time">' + new Date(r.createdAt).toLocaleString() + '</div></div>' +
          '<div class="lx-req-actions"><button class="lx-btn ok" data-acc="' + E(r.id) + '">' + ft('accept') + '</button>' +
          '<button class="lx-btn no" data-rej="' + E(r.id) + '" data-name="' + E(name) + '">' + ft('reject') + '</button></div></div>';
      }).join('');
    } else {
      if (!s.outgoing.length) html += '<div class="lx-empty"><div class="lx-empty-ico">📮</div><div class="lx-empty-sub">' + ft('noOutgoing') + '</div></div>';
      else html += s.outgoing.map(function (r) {
        var name = r.toName || (ft('me') + r.toUserId);
        var st = r.status === 'pending' ? 'pending' : r.status === 'accepted' ? 'accepted' : 'rejected';
        var stTxt = st === 'pending' ? ft('stPending') : st === 'accepted' ? ft('stAccepted') : ft('stRejected');
        return '<div class="lx-req">' + av(r.toUserId, name, 42) +
          '<div class="lx-req-info"><div class="lx-req-name">' + E(name) + '</div><div class="lx-req-time">' + new Date(r.createdAt).toLocaleString() + '</div></div>' +
          '<div class="lx-req-actions" style="flex-direction:row;align-items:center"><span class="lx-status ' + st + '">' + stTxt + '</span>' +
          (r.status === 'pending' ? '<button class="lx-btn no" data-wd="' + E(r.id) + '">' + ft('withdraw') + '</button>' : '') + '</div></div>';
      }).join('');
    }
    body.innerHTML = html;
  }

  /* ── 事件委托 ── */
  function onBodyClick(e) {
    var t = e.target;
    var act = t.closest('[data-act]');
    if (act) {
      var a = act.getAttribute('data-act');
      if (a === 'copy') copyId();
      else if (a === 'requests') { view = 'requests'; reqTab = 'in'; render(); }
      else if (a === 'add') { view = 'add'; render(); }
      return;
    }
    var rt = t.closest('[data-rt]');
    if (rt) { reqTab = rt.getAttribute('data-rt'); render(); return; }
    var add = t.closest('[data-add]');
    if (add) { openRequestDialog(add.getAttribute('data-add'), add.getAttribute('data-name'), add.getAttribute('data-inst') || ''); return; }
    var acc = t.closest('[data-acc]');
    if (acc) { if (g('respondReq')) respondReq(acc.getAttribute('data-acc'), 'accept'); return; }
    var rej = t.closest('[data-rej]');
    if (rej) {
      confirmDlg({ title: ft('rejTitle'), message: ft('rejMsg', { name: rej.getAttribute('data-name') }), okText: ft('reject'), danger: true }).then(function (ok) {
        if (ok && g('respondReq')) respondReq(rej.getAttribute('data-rej'), 'reject');
      });
      return;
    }
    var wd = t.closest('[data-wd]');
    if (wd) { if (g('withdrawRequest')) withdrawRequest(wd.getAttribute('data-wd')); return; }
    var del = t.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      confirmDlg({ title: ft('delTitle'), message: ft('delMsg', { name: del.getAttribute('data-name') }), okText: ft('del'), danger: true }).then(function (ok) {
        if (ok && g('deleteFriend')) deleteFriend(del.getAttribute('data-del'));
      });
      return;
    }
    var row = t.closest('[data-chat]');
    if (row && g('openChatFriend')) { openChatFriend(row.getAttribute('data-chat'), row.getAttribute('data-name')); }
  }

  function copyId() {
    var id = myId();
    function done() { toast('📋 ' + ft('copied')); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(id).then(done, function () { fallbackCopy(id); done(); });
    else { fallbackCopy(id); done(); }
  }
  function fallbackCopy(txt) {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  /* ── 模态：好友申请 dialog ── */
  function openRequestDialog(uid, name, inst) {
    build();
    uid = String(uid);
    name = name || lookupName(uid);
    var chips = [ft('chip1', { me: myName() }), ft('chip2'), ft('chip3')];
    modalRoot.innerHTML =
      '<div class="lx-modal">' +
      '  <div class="lx-modal-card">' + av(uid, name, 54) +
      '    <div><div class="lx-modal-name">' + E(name) + '</div><div class="lx-modal-id">' + ft('idLabel') + ': ' + E(uid) + '</div></div></div>' +
      '  <label>' + ft('verifyMsg') + '</label>' +
      '  <textarea id="lxReqMsg" maxlength="200" placeholder="' + E(ft('verifyPh')) + '"></textarea>' +
      '  <div class="lx-count"><span id="lxReqCount">0</span>/200</div>' +
      '  <div class="lx-chips">' + chips.map(function (c, i) { return '<button data-chip="' + i + '">' + E(c) + '</button>'; }).join('') + '</div>' +
      '  <div class="lx-modal-actions"><button class="lx-btn ghost" id="lxReqCancel">' + ft('cancel') + '</button>' +
      '  <button class="lx-btn pri" id="lxReqSend">' + ft('send') + '</button></div>' +
      '</div>';
    modalRoot.classList.add('show');
    var ta = modalRoot.querySelector('#lxReqMsg');
    var cnt = modalRoot.querySelector('#lxReqCount');
    ta.addEventListener('input', function () { cnt.textContent = ta.value.length; });
    modalRoot.querySelectorAll('[data-chip]').forEach(function (b) {
      b.addEventListener('click', function () { ta.value = chips[Number(b.getAttribute('data-chip'))]; cnt.textContent = ta.value.length; ta.focus(); });
    });
    modalRoot.querySelector('#lxReqCancel').addEventListener('click', closeModal);
    modalRoot.querySelector('#lxReqSend').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      var msg = ta.value.trim().slice(0, 200);
      closeModal();
      if (g('sendRequest')) {
        Promise.resolve(sendRequest(uid, msg, inst || '')).then(function (ok) {
          if (ok === false) return; // S5: 失败不再误报「已发送」（sendRequest 现返回成功标志）
          toast('✅ ' + ft('sentToast'));
          refresh();
        }).catch(function () { /* S5: 兜底异常，错误提示已由 sendRequest 内部给出 */ });
      }
    });
    setTimeout(function () { ta.focus(); }, 120);
  }
  function lookupName(uid) {
    var s = state();
    var f = s.friends.filter(function (x) { return String(x.friendId) === uid; })[0];
    if (f) return f.friendName || f.displayName || '';
    var r = lastResults.filter(function (x) { return String(x.numericId) === uid; })[0];
    if (r) return r.displayName || '';
    var o = s.outgoing.filter(function (x) { return String(x.toUserId) === uid; })[0];
    if (o && o.toName) return o.toName;
    return ft('me') + uid;
  }

  /* ── 模态：通用确认 ── */
  function confirmDlg(opts) {
    build();
    return new Promise(function (resolve) {
      modalRoot.innerHTML =
        '<div class="lx-modal">' +
        (opts.title ? '<div class="lx-confirm-title">' + E(opts.title) + '</div>' : '') +
        '<div class="lx-confirm-msg">' + E(opts.message) + '</div>' +
        '<div class="lx-modal-actions"><button class="lx-btn ghost" id="lxCfNo">' + ft('cancel') + '</button>' +
        '<button class="lx-btn ' + (opts.danger ? 'danger' : 'pri') + '" id="lxCfOk">' + E(opts.okText || ft('accept')) + '</button></div></div>';
      modalRoot.classList.add('show');
      modalRoot.querySelector('#lxCfNo').addEventListener('click', function () { closeModal(); resolve(false); });
      modalRoot.querySelector('#lxCfOk').addEventListener('click', function () { closeModal(); resolve(true); });
    });
  }
  function closeModal() { modalRoot.classList.remove('show'); }

  /* ── 开关 & 同步 ── */
  function open() {
    build();
    isOpen = true; view = 'main';
    root.querySelector('#lxBackdrop').classList.add('show');
    drawer.classList.add('show');
    if (!body._lxHooked) { body.addEventListener('click', onBodyClick); body._lxHooked = true; }
    loadMyInfo();
    refresh();
  }
  function close() {
    isOpen = false;
    if (!built) return;
    root.querySelector('#lxBackdrop').classList.remove('show');
    drawer.classList.remove('show');
  }
  function loadMyInfo() {
    if (myInfo) return;
    try {
      if (lex('authToken') && g('platformApi')) {
        platformApi('/api/user/me', 'GET').then(function (d) {
          if (d && d.ok && d.user) {
            myInfo = { id: d.user.numericId || d.user.id, name: d.user.displayName || d.user.nickname || d.user.email || '' };
            if (isOpen && view === 'main') render();
          }
        }).catch(function () {});
      }
    } catch (e) {}
  }
  function refresh() {
    var tasks = [];
    if (g('loadFriends')) tasks.push(Promise.resolve(loadFriends()).catch(function () {}));
    if (g('loadRequests')) tasks.push(Promise.resolve(loadRequests()).catch(function () {}));
    Promise.all(tasks).then(function () { syncFromState(); });
  }
  function syncFromState() {
    var s = state();
    badge = s.incoming.filter(function (r) { return r.status === 'pending'; }).length;
    if (isOpen) render();
  }
  function setBadge(n) { badge = n || 0; if (isOpen) render(); }

  /* ── 语言切换时重渲染 ── */
  if (window.applyLanguage) {
    var _origApply = window.applyLanguage;
    window.applyLanguage = function (l) { var r = _origApply.apply(this, arguments); if (isOpen) render(); return r; };
  }

  window.LxFriends = {
    confirmDelete: function (fid, fname) { return confirmDlg({ title: ft('delTitle'), message: ft('delMsg', { name: fname }), okText: ft('del'), danger: true }).then(function (ok) { if (ok && g('deleteFriend')) deleteFriend(fid); }); },
    open: open, close: close,
    openRequestDialog: openRequestDialog,
    confirm: confirmDlg,
    setBadge: setBadge,
    syncFromState: syncFromState,
    rerender: function () { if (isOpen) render(); }
  };
})();
