/* 灵犀手机端 · 中继请求改写
 * ============================================================
 * 手机接管「自己电脑 / 云服务器上的灵犀」时，如果那台机器在 NAT 后面
 * （endpoint 是 http://192.168.x.x:3456），手机在外网根本连不上它。
 *
 * 做法：手机界面仍然由云端（Hub）提供，但每一个 /api/ 请求和每一条
 * WebSocket 都改道走 /api/app/relay/x/<instanceId>/...，
 * 由 Hub 通过「电脑主动外连的那条长连接」反向送达。
 *
 * 这个脚本只在存在 lingxi-relay-base 时才生效；
 * 普通局域网直连、云端本机使用时完全不受影响（一行都不改）。
 *
 * v2 追加：
 *   - 自动补 Authorization（中继模式下界面用的是「那台电脑签发的 token」，
 *     页面里有些请求忘了带，会导致整页显示未登录）
 *   - XHR 同步补头
 */
(function () {
  'use strict';

  var base = '';
  var key = '';
  try {
    base = localStorage.getItem('lingxi-relay-base') || '';
    key = localStorage.getItem('lingxi-relay-key') || '';
  } catch (e) { /* 隐私模式 */ }
  if (!base || !key) return;

  function withKey(url) {
    var i = url.indexOf('?');
    var path = i >= 0 ? url.slice(0, i) : url;
    var q = i >= 0 ? url.slice(i + 1) : '';
    var parts = q ? q.split('&').filter(function (p) { return p && !/^rt(=|$)/.test(p); }) : [];
    parts.push('rt=' + encodeURIComponent(key));
    return base + path + '?' + parts.join('&');
  }

  function token() {
    try { return localStorage.getItem('authToken') || ''; } catch (e) { return ''; }
  }

  // 给请求补上 Authorization（已存在就不动）
  function withAuth(init) {
    var t = token();
    if (!t) return init;
    var opts = init ? Object.assign({}, init) : {};
    var h = opts.headers;
    var has = false;
    try {
      if (h && typeof h === 'object' && !(h instanceof Headers)) {
        Object.keys(h).forEach(function (k) { if (k.toLowerCase() === 'authorization') has = true; });
        if (!has) { h = Object.assign({}, h); h.Authorization = 'Bearer ' + t; opts.headers = h; }
      } else if (typeof Headers !== 'undefined' && h instanceof Headers) {
        if (!h.has('Authorization')) { h = new Headers(h); h.set('Authorization', 'Bearer ' + t); opts.headers = h; }
      } else if (!h) {
        opts.headers = { Authorization: 'Bearer ' + t };
      }
    } catch (e) { /* 保底：不动 */ }
    return opts;
  }

  window.__LINGXI_RELAY__ = { base: base, key: key };

  // ① fetch：改写同源 /api/ 开头、且还没带前缀的请求，并补 Authorization
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string' && input.indexOf('/api/') === 0 && input.indexOf(base) !== 0) {
          return origFetch.call(this, withKey(input), withAuth(init));
        }
      } catch (e) { /* 落回原逻辑 */ }
      return origFetch.apply(this, arguments);
    };
  }

  // ② XMLHttpRequest：兜底（某些上传/下载走 XHR）
  var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XP && XP.open) {
    var origOpen = XP.open;
    XP.open = function (method, url) {
      try {
        if (typeof url === 'string' && url.indexOf('/api/') === 0 && url.indexOf(base) !== 0) {
          arguments[1] = withKey(url);
          this.__lingxiRelay = true;
        }
      } catch (e) { /* 忽略 */ }
      return origOpen.apply(this, arguments);
    };
    if (XP.setRequestHeader) {
      var origSet = XP.setRequestHeader;
      XP.setRequestHeader = function (name, value) {
        try {
          if (this.__lingxiRelay && String(name).toLowerCase() === 'authorization') this.__lingxiAuthed = true;
        } catch (e) { /* 忽略 */ }
        return origSet.apply(this, arguments);
      };
    }
    if (XP.send) {
      var origSend = XP.send;
      XP.send = function () {
        try {
          var t = token();
          if (this.__lingxiRelay && t && !this.__lingxiAuthed) origSet.call(this, 'Authorization', 'Bearer ' + t);
        } catch (e) { /* 忽略 */ }
        return origSend.apply(this, arguments);
      };
    }
  }

  // ③ WebSocket：聊天消息、流式回复全靠它
  var OrigWS = window.WebSocket;
  if (typeof OrigWS === 'function') {
    var RelayWS = function (url, protocols) {
      var real = url;
      try {
        if (typeof url === 'string') {
          var bare = url.replace(/^wss?:\/\/[^/]+/i, '');
          if (bare.indexOf('/ws') === 0) {
            var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
            real = proto + location.host + withKey(bare);
          }
        }
      } catch (e) { /* 忽略 */ }
      return protocols === undefined ? new OrigWS(real) : new OrigWS(real, protocols);
    };
    RelayWS.prototype = OrigWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
      try { RelayWS[k] = OrigWS[k]; } catch (e) { /* 忽略 */ }
    });
    window.WebSocket = RelayWS;
  }

  // ④ 页面里显示一条细提示，避免用户以为卡住了
  document.addEventListener('DOMContentLoaded', function () {
    try {
      var bar = document.createElement('div');
      bar.textContent = '正在操控你自己的灵犀（中继模式）';
      bar.setAttribute('data-lingxi-relay-bar', '1');
      bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:6px;z-index:99999;'
        + 'font:12px/1.6 -apple-system,sans-serif;color:#fff;background:rgba(0,0,0,.55);'
        + 'padding:2px 10px;border-radius:10px;pointer-events:none;opacity:.85';
      document.body.appendChild(bar);
      setTimeout(function () { try { bar.remove(); } catch (e) {} }, 4000);
    } catch (e) { /* 忽略 */ }
  });
})();
