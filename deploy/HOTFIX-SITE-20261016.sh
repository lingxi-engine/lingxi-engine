#!/usr/bin/env bash
# ============================================================
#  灵犀官网 紧急热修 (P0)  2026-10-16
#  用法：在腾讯云控制台 VNC/网页终端里粘贴整段，回车。
#  幂等：可重复执行；每次都会先备份。
# ============================================================
set -u
TS=$(date +%Y%m%d-%H%M%S)

# ---------- 0. 自动定位站点目录 ----------
SITE=""
for d in /opt/lingxi-site /var/www/lingxi-engine /usr/share/nginx/html /var/www/html; do
  [ -f "$d/register.html" ] && SITE="$d" && break
done
if [ -z "$SITE" ]; then
  SITE=$(nginx -T 2>/dev/null | grep -oP 'root\s+\K[^;]+' | grep -v -m1 . )
fi
if [ -z "$SITE" ] || [ ! -f "$SITE/register.html" ]; then
  echo "!! 找不到站点目录，请手动指定： SITE=/opt/lingxi-site bash $0"
  exit 1
fi
echo "== 站点目录: $SITE"

# ---------- 1. 备份 ----------
for f in register.html login.html download.html sw.js manifest.json; do
  [ -f "$SITE/$f" ] && cp -a "$SITE/$f" "$SITE/$f.bak-$TS" && echo "   备份 $f -> $f.bak-$TS"
done

# ---------- 2. 注册/登录 落地页 /app/ -> /chat/  (P0 注册即死) ----------
for f in register.html login.html; do
  [ -f "$SITE/$f" ] || continue
  if grep -q "location.href = '/app/'" "$SITE/$f"; then
    sed -i "s|location.href = '/app/';|location.href = '/chat/';|g" "$SITE/$f"
    echo "   [OK] $f 落地页 -> /chat/"
  else
    echo "   [--] $f 未发现 /app/ 跳转（可能已修）"
  fi
done

# ---------- 3. download.html 空链接 -> 真实包 (P0 下载点了没反应) ----------
if [ -f "$SITE/download.html" ]; then
  sed -i 's|<a href="#" class="download-btn">|<a href="/public/lingxi-engine.tar.gz" class="download-btn">|g' "$SITE/download.html"
  sed -i 's|~45MB|2.3MB|g' "$SITE/download.html"
  echo "   [OK] download.html 按钮已指向 /public/lingxi-engine.tar.gz"
fi

# ---------- 4. sw.js 重写 (P0 PWA 装不上：清单里 3 个文件 404) ----------
cat > "$SITE/sw.js" <<'SWEOF'
const CACHE_NAME = 'lingxi-engine-20261016';
const OFFLINE_URLS = ['/', '/chat/', '/css/style.css', '/js/app.js', '/icon.svg'];
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => Promise.all(OFFLINE_URLS.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k =>
    Promise.all(k.filter(x => x !== CACHE_NAME).map(x => caches.delete(x)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET' || r.url.includes('/api/')) return;
  e.respondWith(
    fetch(r).then(resp => {
      const c = resp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(r, c)).catch(() => {});
      return resp;
    }).catch(() => caches.match(r))
  );
});
SWEOF
echo "   [OK] sw.js 已重建（清单改为真实存在的路径 + add 逐个兜底）"

# ---------- 5. manifest.json 重写 (P0 图标全是 404) ----------
cat > "$SITE/manifest.json" <<'MFEOF'
{
  "name": "灵犀引擎",
  "short_name": "灵犀引擎",
  "description": "本地优先的多模态 AI 协作工作台",
  "start_url": "/chat/",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait",
  "background_color": "#0f1117",
  "theme_color": "#0f1117",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }
  ]
}
MFEOF
echo "   [OK] manifest.json 已重建（图标 -> /icon.svg）"

# ---------- 6. 补齐 privacy / terms / robots ----------
echo "   (privacy.html / terms.html / robots.txt 若缺失请从仓库 deploy/site/ 拷入)"

# ---------- 7. 重载 nginx ----------
if nginx -t 2>/dev/null; then
  systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null
  echo "   [OK] nginx reloaded"
else
  echo "   [!!] nginx -t 失败，未 reload（本次改动都是静态文件，通常无关）"
fi

# ---------- 8. 自检 ----------
echo ""
echo "===== 自检 ====="
for u in / /chat/ /register.html /login.html /css/style.css /icon.svg /js/app.js /sw.js /manifest.json /public/lingxi-engine.tar.gz; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1$u")
  echo "   $code  $u"
done
echo "== 完成，时间戳 $TS"
