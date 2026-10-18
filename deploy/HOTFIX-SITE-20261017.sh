#!/usr/bin/env bash
# ============================================================
#  灵犀官网 紧急热修 v2  (2026-10-17)
#  在腾讯云控制台 VNC / 网页终端 直接粘贴执行。
#  幂等：可重复执行；每次先备份。
#
#  修复清单：
#   P0  register.html / login.html 落地页 /app/ -> /chat/   (注册即死)
#   P0  download.html 空链 href="#" -> 真实包               (下载点了没反应)
#   P0  sw.js 清单 3 个 404 路径 -> 真实路径 + add 逐个兜底 (PWA 装不上)
#   P0  manifest.json 图标 404 png -> /icon.svg
#   P1  nginx 补 /m/ 转发到 Node                            (手机端路由 404)
#   P1  补 privacy.html / terms.html / robots.txt
#   P2  首页补 注册/登录 入口
# ============================================================
set -u
TS=$(date +%Y%m%d-%H%M%S)
echo "===== 灵犀官网热修 v2  $TS ====="

# ---------- 0. 自动定位站点目录 ----------
SITE=""
for d in /opt/lingxi-site /var/www/lingxi-engine /usr/share/nginx/html /var/www/html /home/openclaw-deploy/site /root/site; do
  [ -f "$d/register.html" ] && SITE="$d" && break
done
if [ -z "$SITE" ]; then
  SITE=$(nginx -T 2>/dev/null | grep -oP 'root\s+\K[^;]+' | grep -v -m1 . || true)
fi
if [ -z "$SITE" ] || [ ! -f "$SITE/register.html" ]; then
  echo "!! 自动定位失败，请手动指定： SITE=/你的/站点目录 bash $0"
  echo "---- 候选目录内容参考 ----"
  ls -ld /opt/* /var/www/* /usr/share/nginx/html /home/*/site* 2>/dev/null
  exit 1
fi
echo "== 站点目录: $SITE"
cd "$SITE" || exit 1

# ---------- 1. 备份 ----------
for f in register.html login.html download.html sw.js manifest.json index.html nginx.conf; do
  [ -f "$SITE/$f" ] && cp -a "$SITE/$f" "$SITE/$f.bak-$TS" && echo "   备份 $f"
done

# ---------- 2. P0 注册/登录落地页 ----------
for f in register.html login.html; do
  [ -f "$SITE/$f" ] || continue
  if grep -q "location.href = '/app/'" "$SITE/$f"; then
    sed -i "s|location.href = '/app/';|location.href = '/chat/';|g" "$SITE/$f"
    echo "   [OK] $f 落地页 -> /chat/"
  else
    echo "   [--] $f 无 /app/ 跳转（已修或版本不同）"
  fi
done

# ---------- 3. P0 download.html 空链 ----------
if [ -f "$SITE/download.html" ]; then
  sed -i 's|<a href="#" class="download-btn">|<a href="/public/lingxi-engine.tar.gz" class="download-btn">|g' "$SITE/download.html"
  sed -i 's|~45MB|2.3MB|g' "$SITE/download.html"
  echo "   [OK] download.html 按钮 -> /public/lingxi-engine.tar.gz"
fi

# ---------- 4. P0 sw.js 重建 ----------
cat > "$SITE/sw.js" <<'SWEOF'
const CACHE_NAME = 'lingxi-engine-20261017';
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
echo "   [OK] sw.js 已重建"

# ---------- 5. P0 manifest.json 重建 ----------
cat > "$SITE/manifest.json" <<'MFEOF'
{
  "name": "灵犀引擎",
  "short_name": "灵犀",
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
echo "   [OK] manifest.json 已重建"

# ---------- 6. P1 补 privacy / terms / robots ----------
if [ ! -f "$SITE/privacy.html" ]; then
cat > "$SITE/privacy.html" <<'PREOF'
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>隐私政策 - 灵犀引擎</title>
<link rel="stylesheet" href="/css/style.css">
</head><body><main class="container" style="max-width:760px;margin:0 auto;padding:40px 20px">
<h1>隐私政策</h1>
<p>灵犀引擎采用本地优先架构。你的对话数据默认仅保存在你自己的设备与你自己控制的服务器上，不会上传至任何第三方中间环节。</p>
<p>使用云端模型能力时，仅在你主动发起请求的当次会话中，将必要的最小化上下文发送至你所配置的模型服务提供方。</p>
<h2>联系我们</h2>
<p>如对本政策有疑问，请通过官网聊天入口联系我们。</p>
<p style="opacity:.6">最后更新：2026-10-17</p>
</main></body></html>
PREOF
echo "   [OK] privacy.html 已补"
fi

if [ ! -f "$SITE/terms.html" ]; then
cat > "$SITE/terms.html" <<'TEOF'
<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>服务条款 - 灵犀引擎</title>
<link rel="stylesheet" href="/css/style.css">
</head><body><main class="container" style="max-width:760px;margin:0 auto;padding:40px 20px">
<h1>服务条款</h1>
<p>使用灵犀引擎即表示你同意以下条款：不得将本软件用于任何违反法律法规的用途；不得利用本软件生成、传播违法或侵权内容。</p>
<p>本软件按"现状"提供，不对特定用途的适用性作任何明示或默示的担保。</p>
<p style="opacity:.6">最后更新：2026-10-17</p>
</main></body></html>
TEOF
echo "   [OK] terms.html 已补"
fi

if [ ! -f "$SITE/robots.txt" ]; then
cat > "$SITE/robots.txt" <<'REOF'
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin/
Sitemap: https://www.lingxi-engine.com/sitemap.xml
REOF
echo "   [OK] robots.txt 已补"
fi

# ---------- 7. P1 nginx 补 /m/ 转发 ----------
NGDIR=""
for d in /etc/nginx/sites-enabled /etc/nginx/conf.d; do
  [ -d "$d" ] && NGDIR="$d" && break
done
if [ -n "$NGDIR" ]; then
  CONF="$NGDIR/lingxi-mobile.conf"
  if [ ! -f "$CONF" ]; then
    # 找到 node 监听端口
    NODEPORT=$(ss -tlnp 2>/dev/null | grep -oP 'node\s.*:(\d+)' | grep -oP '\d+$' | head -1)
    [ -z "$NODEPORT" ] && NODEPORT=$(ss -tlnp 2>/dev/null | grep -oP '127\.0\.0\.1:(\d+)' | grep -oP '\d+' | sort -u | tail -1)
    echo "   Node 端口探测: ${NODEPORT:-未探测到}"
    if [ -n "$NODEPORT" ]; then
      cat > "$CONF" <<NGEOF
location /m/ {
    proxy_pass http://127.0.0.1:${NODEPORT}/m/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_read_timeout 86400;
}
NGEOF
      echo "   [OK] 已写 $CONF (-> 127.0.0.1:$NODEPORT)"
    else
      echo "   [!!] 未探测到 Node 端口，跳过 /m/ 转发（可手动补）"
    fi
  else
    echo "   [--] $CONF 已存在，跳过"
  fi
fi

# ---------- 8. reload nginx ----------
if nginx -t 2>/dev/null; then
  systemctl reload nginx 2>/dev/null || service nginx reload 2>/dev/null
  echo "   [OK] nginx reloaded"
else
  echo "   [!!] nginx -t 失败，未 reload（静态文件改动通常不受影响）"
fi

# ---------- 9. 自检 ----------
echo ""
echo "===== 自检 (本机) ====="
for u in / /chat/ /register.html /login.html /download.html /css/style.css /icon.svg /js/app.js /sw.js /manifest.json /privacy.html /terms.html /robots.txt /m/ /public/lingxi-engine.tar.gz; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1$u")
  echo "   $code  $u"
done
echo ""
echo "===== 关键内容复查 ====="
grep -o "location.href = '/[a-z]*/'" "$SITE/register.html" 2>/dev/null | head -1 | sed 's/^/   register: /'
grep -o 'href="/public/lingxi-engine.tar.gz"' "$SITE/download.html" 2>/dev/null | head -1 | sed 's/^/   download: /'
echo "== 完成 $TS =="
