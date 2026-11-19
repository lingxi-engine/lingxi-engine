// ── LxAuthRefresh: 401 自动续期 + 坏 token 清理（2026-11-19）──
// 背景：
//   1) access token 有效期 7 天（src/auth/index.ts），后端 /api/auth/refresh 支持滚动续期（30 天会话），
//      但旧前端从不保存/调用 refresh_token → 7 天后每个请求 401，直到手动重登。
//   2) jwt-auth 中间件的本地免登录兜底只在「完全没带 Authorization 头」时生效；
//      localStorage 里躺着过期/旧密钥签的 token 时，连 localhost 都 401（带坏票比不带票更惨）。
// 方案：在 fetch 层统一拦截 401 → 单飞（single-flight）续期 → 用新 token 重放原请求；
//      续期失败/重放仍 401 → 清空 token 并广播 lx-auth-expired（app.js 弹登录框）。
// 仅处理同源 /api/ 与 PLATFORM_URL 请求；登录/注册/refresh/logout 等认证端点本身不拦截。
(function () {
  var ACCESS_KEY = 'authToken';
  var REFRESH_KEY = 'authRefreshToken';
  var RETRY_FLAG = '__lxAuthRetried';
  var refreshing = null;
  var installed = false;

  function getAccess() { try { return localStorage.getItem(ACCESS_KEY) || ''; } catch (e) { return ''; } }
  function getRefresh() { try { return localStorage.getItem(REFRESH_KEY) || ''; } catch (e) { return ''; } }

  function storeTokens(access, refresh) {
    try {
      if (access) localStorage.setItem(ACCESS_KEY, access);
      if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
      else localStorage.removeItem(REFRESH_KEY);
    } catch (e) {}
    try { window.authToken = access || null; } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('lx-auth-refreshed', { detail: { accessToken: access } })); } catch (e) {}
  }

  function clear() {
    try { localStorage.removeItem(ACCESS_KEY); localStorage.removeItem(REFRESH_KEY); } catch (e) {}
    try { window.authToken = null; } catch (e) {}
    try { window.dispatchEvent(new Event('lx-auth-expired')); } catch (e) {}
  }

  function isAuthEndpoint(url) {
    return /\/api\/auth\/(login|login-by-id|register|register-with-email|refresh|logout|forgot-password|reset-password|send-code|verify-email)/.test(url);
  }

  function eligible(url) {
    if (typeof url !== 'string') return false;
    if (isAuthEndpoint(url)) return false;
    if (url.charAt(0) === '/') return true; // 同源相对路径（含 /m/、/api/）
    try {
      var origin = window.location.origin;
      if (origin && url.indexOf(origin + '/') === 0) return true;
      var p = window.PLATFORM_URL;
      if (p && url.indexOf(String(p).replace(/\/+$/, '') + '/') === 0) return true;
    } catch (e) {}
    return false;
  }

  function doRefresh() {
    var rt = getRefresh();
    if (!rt) return Promise.resolve(false);
    return window.__lxOriginalFetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt })
    }).then(function (r) {
      if (!r.ok) return false;
      return r.json().then(function (d) {
        var at = d && (d.accessToken || d.token);
        if (!at) return false;
        // 滚动刷新：后端会撤销旧 refresh token，必须保存新的
        storeTokens(at, (d && (d.refreshToken || d.refresh_token)) || '');
        return true;
      }).catch(function () { return false; });
    }).catch(function () { return false; });
  }

  function refreshOnce() {
    if (!refreshing) {
      refreshing = doRefresh().then(
        function (ok) { refreshing = null; return ok; },
        function () { refreshing = null; return false; }
      );
    }
    return refreshing;
  }

  function withToken(opts, token) {
    var o = {};
    var k;
    if (opts) for (k in opts) o[k] = opts[k];
    var h = {};
    var src = (opts && opts.headers) || {};
    if (typeof src.forEach === 'function' && typeof src.get === 'function') {
      src.forEach(function (v, kk) { h[kk] = v; }); // Headers 实例
    } else {
      for (k in src) h[k] = src[k];
    }
    h['Authorization'] = 'Bearer ' + token;
    o.headers = h;
    o[RETRY_FLAG] = true;
    return o;
  }

  function install() {
    if (installed) return;
    installed = true;
    var orig = window.fetch.bind(window);
    window.__lxOriginalFetch = orig;
    window.fetch = function (input, opts) {
      // Request 对象入参的 body 流已被首次 fetch 消费，无法安全重放 → 不拦截
      if (typeof input !== 'string') return orig(input, opts);
      var p = orig(input, opts);
      if (!eligible(input)) return p;
      return p.then(function (res) {
        if (res.status !== 401) return res;
        if (opts && opts[RETRY_FLAG]) { clear(); return res; } // 续期后仍 401 → 凭证彻底失效
        if (!getAccess() && !getRefresh()) return res; // 游客请求的 401 不处理
        return refreshOnce().then(function (ok) {
          if (!ok) { clear(); return res; }
          return window.fetch(input, withToken(opts, getAccess()));
        });
      });
    };
  }

  window.LxAuthRefresh = {
    install: install,
    storeTokens: storeTokens,
    clear: clear,
    getRefreshToken: getRefresh,
    _isEligible: eligible
  };
})();
