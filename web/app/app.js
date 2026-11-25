/* 灵犀手机端 · App 控制台
 * 设计原则：
 *  - 手机不跑模型；这里只负责登录、发现、接管
 *  - 只与「当前引擎」同源通信，跨设备由引擎之间完成（无 CORS 坑）
 *  - 三语：简体中文 / 繁體中文 / English
 */
(function () {
  'use strict';

  // ── 中继接管收尾 ────────────────────────────────────────────────
  // 接管自己电脑时，localStorage.authToken 会被换成「那台电脑签发的 token」。
  // 回到设备列表（本页）必须还原成云端 token，否则列表接口全 401。
  try {
    var _hubToken = localStorage.getItem('lingxi-hub-authToken');
    if (_hubToken) {
      localStorage.setItem('authToken', _hubToken);
      localStorage.removeItem('lingxi-hub-authToken');
    }
    localStorage.removeItem('lingxi-relay-base');
    localStorage.removeItem('lingxi-relay-key');
    localStorage.removeItem('lingxi-relay-instance');
  } catch (e) { }

  // ───────────────────────── i18n ─────────────────────────
  var DICT = {
    zh: {
      'app.name': '灵犀',
      'common.cancel': '取消',
      'common.close': '关闭',
      'login.title': '登录你的灵犀',
      'login.sub': '用同一个账号，操控你在云端和电脑上的灵犀',
      'login.email': '邮箱 / 账号',
      'login.password': '密码',
      'login.btn': '登录',
      'login.loading': '登录中…',
      'login.advanced': '连接自建引擎 / 局域网电脑',
      'login.endpoint': '引擎地址',
      'login.ping': '连到这台引擎',
      'login.useCloud': '回到当前引擎',
      'login.note': '手机不运行模型，所有算力都在你的电脑或云端引擎上。',
      'dev.title': '我的灵犀',
      'dev.sub': '{n} 台设备 · {on} 台在线',
      'dev.cloud': '云端',
      'dev.desktop': '电脑',
      'dev.online': '在线',
      'dev.offline': '离线',
      'dev.open': '接管',
      'dev.opening': '正在接管…',
      'dev.add': '连接其它引擎',
      'dev.addTitle': '连接其它引擎',
      'dev.addHint': '填电脑上灵犀的地址，例如 http://192.168.1.10:3456',
      'dev.addBtn': '打开',
      'dev.empty': '还没有发现你的灵犀',
      'dev.emptyHint': '在电脑上打开灵犀并登录同一账号，它就会自动出现在这里。',
      'dev.offlineHint': '离线 · 需要在电脑上打开灵犀并登录同一账号',
      'dev.justNow': '刚刚在线',
      'dev.minutes': '{n} 分钟前在线',
      'dev.hours': '{n} 小时前在线',
      'dev.days': '{n} 天前在线',
      'dev.thisDevice': '当前',
      'dev.needLogin': '这台引擎需要登录一次',
      'help.title': '怎么让电脑出现在这里？',
      'help.step1': '电脑上启动灵犀引擎',
      'help.step2': '用同一个账号登录',
      'help.step3': '保持引擎运行，手机会自动发现',
      'nav.logout': '退出登录',
      'settings.lang': '语言 / Language',
      'err.login': '登录失败：{msg}',
      'err.network': '连不上引擎，检查地址或网络',
      'err.pwd': '请输入邮箱和密码',
      'err.ticket': '接管失败，请刷新后重试',
      'err.logout': '退出失败',
      'toast.lang': '语言已切换',
      'toast.copied': '已复制',
      'toast.ticketFail': '这台设备暂时连不上',
      'logout.confirm': '退出登录？电脑上的任务不会停止。'
    },
    'zh-TW': {
      'app.name': '靈犀',
      'common.cancel': '取消',
      'common.close': '關閉',
      'login.title': '登入你的靈犀',
      'login.sub': '用同一個帳號，操控你在雲端和電腦上的靈犀',
      'login.email': '電子郵件 / 帳號',
      'login.password': '密碼',
      'login.btn': '登入',
      'login.loading': '登入中…',
      'login.advanced': '連接自建引擎 / 區域網路電腦',
      'login.endpoint': '引擎位址',
      'login.ping': '連到這台引擎',
      'login.useCloud': '回到目前引擎',
      'login.note': '手機不執行模型，所有算力都在你的電腦或雲端引擎上。',
      'dev.title': '我的靈犀',
      'dev.sub': '{n} 台裝置 · {on} 台在線',
      'dev.cloud': '雲端',
      'dev.desktop': '電腦',
      'dev.online': '在線',
      'dev.offline': '離線',
      'dev.open': '接管',
      'dev.opening': '正在接管…',
      'dev.add': '連接其它引擎',
      'dev.addTitle': '連接其它引擎',
      'dev.addHint': '填電腦上靈犀的位址，例如 http://192.168.1.10:3456',
      'dev.addBtn': '開啟',
      'dev.empty': '還沒有發現你的靈犀',
      'dev.emptyHint': '在電腦上開啟靈犀並登入同一個帳號，它就會自動出現在這裡。',
      'dev.offlineHint': '離線 · 需要在電腦上開啟靈犀並登入同一個帳號',
      'dev.justNow': '剛剛在線',
      'dev.minutes': '{n} 分鐘前在線',
      'dev.hours': '{n} 小時前在線',
      'dev.days': '{n} 天前在線',
      'dev.thisDevice': '目前',
      'dev.needLogin': '這台引擎需要登入一次',
      'help.title': '怎麼讓電腦出現在這裡？',
      'help.step1': '電腦上啟動靈犀引擎',
      'help.step2': '用同一個帳號登入',
      'help.step3': '保持引擎執行，手機會自動發現',
      'nav.logout': '登出',
      'settings.lang': '語言 / Language',
      'err.login': '登入失敗：{msg}',
      'err.network': '連不上引擎，檢查位址或網路',
      'err.pwd': '請輸入電子郵件和密碼',
      'err.ticket': '接管失敗，請重新整理後再試',
      'err.logout': '登出失敗',
      'toast.lang': '語言已切換',
      'toast.copied': '已複製',
      'toast.ticketFail': '這台裝置暫時連不上',
      'logout.confirm': '要登出嗎？電腦上的任務不會停止。'
    },
    en: {
      'app.name': 'LingXi',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'login.title': 'Sign in to LingXi',
      'login.sub': 'One account controls LingXi on your cloud and your computer',
      'login.email': 'Email / account',
      'login.password': 'Password',
      'login.btn': 'Sign in',
      'login.loading': 'Signing in…',
      'login.advanced': 'Connect a self-hosted engine / LAN PC',
      'login.endpoint': 'Engine address',
      'login.ping': 'Open this engine',
      'login.useCloud': 'Back to this engine',
      'login.note': 'Your phone runs no models. All compute stays on your computer or cloud engine.',
      'dev.title': 'My LingXi',
      'dev.sub': '{n} device(s) · {on} online',
      'dev.cloud': 'Cloud',
      'dev.desktop': 'Computer',
      'dev.online': 'Online',
      'dev.offline': 'Offline',
      'dev.open': 'Take over',
      'dev.opening': 'Connecting…',
      'dev.add': 'Connect another engine',
      'dev.addTitle': 'Connect another engine',
      'dev.addHint': 'Enter the LingXi address on your computer, e.g. http://192.168.1.10:3456',
      'dev.addBtn': 'Open',
      'dev.empty': 'No LingXi found yet',
      'dev.emptyHint': 'Open LingXi on your computer and sign in with the same account — it will show up here automatically.',
      'dev.offlineHint': 'Offline · open LingXi on that computer and sign in with the same account',
      'dev.justNow': 'online just now',
      'dev.minutes': 'online {n} min ago',
      'dev.hours': 'online {n} h ago',
      'dev.days': 'online {n} d ago',
      'dev.thisDevice': 'This one',
      'dev.needLogin': 'This engine needs a sign-in',
      'help.title': 'How do I get my computer to appear?',
      'help.step1': 'Start the LingXi engine on your computer',
      'help.step2': 'Sign in with the same account',
      'help.step3': 'Keep it running — the phone discovers it automatically',
      'nav.logout': 'Sign out',
      'settings.lang': 'Language / 语言',
      'err.login': 'Sign-in failed: {msg}',
      'err.network': 'Cannot reach the engine. Check the address or network.',
      'err.pwd': 'Enter your email and password',
      'err.ticket': 'Could not take over. Refresh and try again.',
      'err.logout': 'Sign-out failed',
      'toast.lang': 'Language changed',
      'toast.copied': 'Copied',
      'toast.ticketFail': 'That device is unreachable right now',
      'logout.confirm': 'Sign out? Tasks on your computer keep running.'
    }
  };

  var LANGS = [
    { code: 'zh', label: '中文' },
    { code: 'zh-TW', label: '繁體' },
    { code: 'en', label: 'EN' }
  ];

  var STORE = {
    lang: 'lingxi-app-lang',
    endpoint: 'lingxi-app-endpoint',
    user: 'lingxi-app-user'
  };

  function detectLang() {
    try {
      var saved = localStorage.getItem(STORE.lang);
      if (saved && DICT[saved]) return saved;
    } catch (e) { }
    var n = (navigator.language || 'zh').toLowerCase();
    if (n.indexOf('zh') === 0) return (n.indexOf('tw') >= 0 || n.indexOf('hk') >= 0 || n.indexOf('hant') >= 0) ? 'zh-TW' : 'zh';
    return n.indexOf('en') === 0 ? 'en' : 'zh';
  }

  var lang = detectLang();

  function t(key, vars) {
    var d = DICT[lang] || DICT.zh;
    var s = d[key] !== undefined ? d[key] : (DICT.zh[key] !== undefined ? DICT.zh[key] : key);
    if (vars) {
      for (var k in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, k)) s = s.split('{' + k + '}').join(vars[k]);
      }
    }
    return s;
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(function (el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph')));
    });
    document.documentElement.lang = lang === 'zh-TW' ? 'zh-Hant' : lang;
    var meta = LANGS.filter(function (l) { return l.code === lang; })[0];
    if (meta) document.getElementById('langLabel').textContent = meta.label;
    document.title = t('app.name') + ' · LingXi';
  }

  function setLang(next) {
    if (!DICT[next]) return;
    lang = next;
    try { localStorage.setItem(STORE.lang, next); } catch (e) { }
    applyI18n();
    renderDevices();
    toast(t('toast.lang'));
  }

  // ───────────────────────── 基础工具 ─────────────────────────
  var $ = function (id) { return document.getElementById(id); };

  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2200);
  }

  function showLoading(text) {
    $('loadingText').textContent = text || '';
    $('loadingMask').hidden = false;
  }
  function hideLoading() { $('loadingMask').hidden = true; }

  function api(pathname, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(pathname, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) {
          var err = new Error((d && (d.error && (d.error.message || d.error) || d.message)) || ('HTTP ' + r.status));
          err.status = r.status;
          err.payload = d;
          throw err;
        }
        return d;
      });
    });
  }

  function getToken() {
    try { return localStorage.getItem('authToken') || ''; } catch (e) { return ''; }
  }
  function setToken(tk, user) {
    try {
      localStorage.setItem('authToken', tk || '');
      if (user) {
        localStorage.setItem('userId', String(user.id || user.sub || ''));
        localStorage.setItem('displayName', String(user.displayName || user.display_name || user.username || ''));
        localStorage.setItem(STORE.user, JSON.stringify(user));
      }
    } catch (e) { }
  }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(STORE.user) || 'null'); } catch (e) { return null; }
  }
  function clearSession() {
    try {
      ['authToken', 'userId', 'displayName', STORE.user].forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) { }
  }

  function currentEndpoint() {
    try { return localStorage.getItem(STORE.endpoint) || location.origin; } catch (e) { return location.origin; }
  }

  // ───────────────────────── 登录 ─────────────────────────
  var loginBusy = false;

  function doLogin(ev) {
    if (ev) ev.preventDefault();
    if (loginBusy) return;
    var email = $('email').value.trim();
    var password = $('password').value;
    var msg = $('loginMsg');
    msg.textContent = '';
    if (!email || !password) { msg.textContent = t('err.pwd'); return; }

    loginBusy = true;
    $('loginBtn').disabled = true;
    $('loginBtn').textContent = t('login.loading');

    api('/api/auth/login', { method: 'POST', body: { email: email, password: password } })
      .then(function (d) {
        var tk = d.token || d.accessToken;
        if (!tk) throw new Error('no_token');
        setToken(tk, d.user || { displayName: email, id: d.user && d.user.id });
        try { localStorage.setItem(STORE.endpoint, location.origin); } catch (e) { }
        enterHome();
      })
      .catch(function (e) {
        var text = e && e.message && e.message !== 'Failed to fetch' ? e.message : t('err.network');
        msg.textContent = t('err.login', { msg: text });
      })
      .finally(function () {
        loginBusy = false;
        $('loginBtn').disabled = false;
        $('loginBtn').textContent = t('login.btn');
      });
  }

  function switchEndpoint(addr) {
    var raw = String(addr || '').trim();
    if (!raw) return;
    if (!/^https?:\/\//i.test(raw)) raw = 'http://' + raw;
    raw = raw.replace(/\/+$/, '');
    try { localStorage.setItem(STORE.endpoint, raw); } catch (e) { }
    location.href = raw + '/app/';
  }

  // ───────────────────────── 设备列表 ─────────────────────────
  var devices = [];
  var loadingDevices = false;

  function enterHome() {
    $('loginScreen').hidden = true;
    $('homeScreen').hidden = false;
    var u = getUser() || {};
    var name = u.displayName || u.display_name || u.username || u.email || 'LingXi';
    $('userName').textContent = name;
    $('userEmail').textContent = u.email || currentEndpoint().replace(/^https?:\/\//, '');
    $('avatar').textContent = String(name).trim().charAt(0).toUpperCase() || 'L';
    $('endpoint') && ($('endpoint').value = currentEndpoint());
    loadDevices();
  }

  function goLogin() {
    $('homeScreen').hidden = true;
    $('loginScreen').hidden = false;
    try { $('email').value = (getUser() || {}).email || ''; } catch (e) { }
  }

  function timeAgo(ts) {
    var diff = Math.max(0, Date.now() - Number(ts || 0));
    var m = Math.floor(diff / 60000);
    if (m < 1) return t('dev.justNow');
    if (m < 60) return t('dev.minutes', { n: m });
    var h = Math.floor(m / 60);
    if (h < 24) return t('dev.hours', { n: h });
    return t('dev.days', { n: Math.floor(h / 24) });
  }

  function loadDevices() {
    if (loadingDevices) return;
    loadingDevices = true;
    var btn = $('refreshBtn');
    btn.classList.add('spin');
    api('/api/app/instances')
      .then(function (d) {
        devices = (d && d.instances) || [];
        renderDevices();
      })
      .catch(function (e) {
        if (e && e.status === 401) { clearSession(); goLogin(); return; }
        // 旧引擎没有该接口：至少显示当前这台
        devices = [{
          instanceId: 'self',
          name: currentEndpoint().replace(/^https?:\/\//, ''),
          kind: 'cloud',
          endpoint: currentEndpoint(),
          online: true,
          isThisDevice: true,
          platform: '',
          lastSeen: Date.now()
        }];
        renderDevices();
      })
      .finally(function () {
        loadingDevices = false;
        btn.classList.remove('spin');
      });
  }

  function renderDevices() {
    var box = $('devices');
    if (!box) return;
    var online = devices.filter(function (d) { return d.online; }).length;
    $('devSub').textContent = t('dev.sub', { n: devices.length, on: online });
    $('emptyBox').hidden = devices.length !== 0;
    box.innerHTML = '';

    devices.forEach(function (d) {
      var el = document.createElement('div');
      el.className = 'device ' + (d.online ? 'online' : 'offline');

      var icon = d.kind === 'cloud' ? '☁️' : '🖥️';
      var badge = d.kind === 'cloud' ? t('dev.cloud') : t('dev.desktop');
      var name = d.name || d.endpoint || 'LingXi';

      el.innerHTML =
        '<div class="dev-icon">' + icon + '</div>' +
        '<div class="dev-body">' +
          '<div class="dev-name"><span class="trunc"></span>' +
            (d.isThisDevice ? '<span class="badge">' + t('dev.thisDevice') + '</span>' : '<span class="badge">' + badge + '</span>') +
          '</div>' +
          '<div class="dev-meta"><span class="dot ' + (d.online ? 'on' : '') + '"></span>' +
            '<span class="meta-text"></span>' +
          '</div>' +
          (!d.online ? '<div class="dev-hint">' + t('dev.offlineHint') + '</div>' : '') +
        '</div>' +
        '<button class="dev-open">' + (d.online ? t('dev.open') : t('dev.offline')) + '</button>';

      el.querySelector('.dev-name .trunc').textContent = name;
      el.querySelector('.meta-text').textContent = (d.online ? t('dev.online') : timeAgo(d.lastSeen)) +
        (d.platform ? ' · ' + d.platform : '');

      var btn = el.querySelector('.dev-open');
      btn.disabled = !d.online;
      btn.addEventListener('click', function () { openDevice(d, el); });

      box.appendChild(el);
    });
  }

  function openDevice(d, el) {
    if (!d.online) { toast(t('dev.offlineHint')); return; }
    var btn = el.querySelector('.dev-open');
    btn.disabled = true;
    btn.textContent = t('dev.opening');

    // 当前这台：token 就在本机，直接进
    if (d.isThisDevice || d.instanceId === 'self') {
      location.href = '/m/';
      return;
    }

    api('/api/app/ticket', { method: 'POST', body: { instanceId: d.instanceId } })
      .then(function (r) {
        if (!r || !r.connectUrl) throw new Error('no_ticket');
        location.href = r.connectUrl;
      })
      .catch(function (e) {
        var msg = e && e.payload && e.payload.error;
        if (msg === 'instance_offline') toast(t('dev.offlineHint'));
        else toast(t('toast.ticketFail'));
        btn.disabled = false;
        btn.textContent = t('dev.open');
        loadDevices();
      });
  }

  // ───────────────────────── 退出 ─────────────────────────
  function doLogout() {
    if (!confirm(t('logout.confirm'))) return;
    api('/api/auth/logout', { method: 'POST' }).catch(function () { });
    clearSession();
    goLogin();
  }

  // ───────────────────────── 事件绑定 ─────────────────────────
  function bind() {
    $('loginForm').addEventListener('submit', doLogin);
    $('eyeBtn').addEventListener('click', function () {
      var p = $('password');
      p.type = p.type === 'password' ? 'text' : 'password';
    });

    $('advToggle').addEventListener('click', function () {
      var box = $('advBox');
      box.hidden = !box.hidden;
      if (!box.hidden) $('endpoint').value = currentEndpoint();
    });

    $('pingBtn').addEventListener('click', function () {
      var v = $('endpoint').value.trim();
      if (!v) return;
      $('advStatus').className = 'adv-status';
      $('advStatus').textContent = '…';
      switchEndpoint(v);
    });

    $('useCloudBtn').addEventListener('click', function () {
      try { localStorage.removeItem(STORE.endpoint); } catch (e) { }
      $('endpoint').value = location.origin;
      $('advStatus').textContent = location.origin;
    });

    $('logoutBtn').addEventListener('click', doLogout);
    $('refreshBtn').addEventListener('click', loadDevices);

    $('addBtn').addEventListener('click', function () {
      $('addMask').hidden = false;
      $('addStatus').textContent = '';
      $('addEndpoint').value = '';
    });
    $('addConfirm').addEventListener('click', function () {
      var v = $('addEndpoint').value.trim();
      if (!v) return;
      switchEndpoint(v);
    });
    $('addMask').addEventListener('click', function (e) {
      if (e.target === $('addMask')) $('addMask').hidden = true;
    });
    $('addEndpoint').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') $('addConfirm').click();
    });

    // 语言
    $('langBtn').addEventListener('click', function () { $('langMask').hidden = false; });
    $('langMask').addEventListener('click', function (e) {
      if (e.target === $('langMask')) $('langMask').hidden = true;
    });
    document.querySelectorAll('.lang-item').forEach(function (b) {
      b.addEventListener('click', function () {
        $('langMask').hidden = true;
        setLang(b.getAttribute('data-lang'));
      });
    });
    var cancel = document.querySelector('.sheet-cancel');
    if (cancel) cancel.addEventListener('click', function () { $('langMask').hidden = true; });

    // 切回前台自动刷新在线状态
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && !$('homeScreen').hidden) loadDevices();
    });
  }

  // ───────────────────────── 启动 ─────────────────────────
  function boot() {
    applyI18n();
    bind();

    // 打开时若地址栏带 ?engine= 则切换
    try {
      var qs = new URLSearchParams(location.search);
      var eng = qs.get('engine');
      if (eng) { localStorage.setItem(STORE.endpoint, eng.replace(/\/+$/, '')); }
      var ql = qs.get('lang');
      if (ql && DICT[ql]) { lang = ql; localStorage.setItem(STORE.lang, ql); applyI18n(); }
    } catch (e) { }

    if (getToken()) {
      // 校验 token 是否还有效
      api('/api/auth/me')
        .then(function (d) {
          if (d && d.user) {
            var u = getUser() || {};
            u.email = u.email || d.user.email || '';
            u.displayName = u.displayName || d.user.display_name || d.user.displayName || '';
            try { localStorage.setItem(STORE.user, JSON.stringify(u)); } catch (e) { }
          }
          enterHome();
        })
        .catch(function () { clearSession(); goLogin(); });
    } else {
      goLogin();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
