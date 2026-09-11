// 灵犀引擎 Service Worker - PWA 离线支持 (v2.0.13)
const CACHE_NAME = 'lingxi-v18'; // v18: LAN 推理过程持久化(气泡常驻+历史回读)，强制刷新旧缓存
const STATIC_ASSETS = ['/', '/index.html', '/install.html', '/manifest.json', '/css/style.css', '/css/mobile.css', '/js/app.js', '/js/i18n.js', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // 只缓存 GET 请求
  if (event.request.method !== 'GET') return;

  // API 请求、WebSocket 升级、跨域 CDN 不走缓存
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      // 网络优先 + 缓存兜底（保证拿到最新前端资源，离线时回退缓存）
      return fetch(event.request).then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached || caches.match('/index.html'));
    })
  );
});

// 推送通知
self.addEventListener('push', (event) => {
  let data = { title: '灵犀引擎', body: '新消息' };
  try { data = event.data.json(); } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'lingxi-message',
      renotify: true,
    })
  );
});

// 点击通知打开应用
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow('/'));
});