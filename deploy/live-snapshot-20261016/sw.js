const CACHE_NAME = 'lingxi-engine-v2.0.32';
const OFFLINE_URLS = ['/', '/chat/', '/index.html', '/js/app.js', '/css/styles.css', '/web/icons/icon-192.png', '/web/icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(OFFLINE_URLS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== CACHE_NAME).map(x => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.url.includes('/api/')) { e.respondWith(fetch(r)); return; }
  e.respondWith(fetch(r).then(resp => { const c = resp.clone(); caches.open(CACHE_NAME).then(cache => cache.put(r, c)); return resp; }).catch(() => caches.match(r)));
});
