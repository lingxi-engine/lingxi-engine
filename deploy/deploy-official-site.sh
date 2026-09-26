#!/usr/bin/env bash
# ============================================================
# 灵犀引擎 · 正式官网部署脚本 v2（腾讯云香港）
#   用法：sudo bash deploy-official-site.sh
#   变化：默认 80/443（不再是 8088），域名 + HTTPS 一并搞定
#   前提：DNS 已解析到本机公网 IP
# ============================================================
set -euo pipefail

# ---------- 参数（部署前改这里，或用环境变量覆盖）----------
SITE_DIR="${SITE_DIR:-/var/www/lingxi-site}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/conf.d/lingxi-site.conf}"
DOMAIN="${DOMAIN:-}"              # 必填！例：yourdomain.com
USE_HTTPS="${USE_HTTPS:-yes}"      # yes = 申请 Let's Encrypt
ADMIN_EMAIL="${ADMIN_EMAIL:-}"     # 证书通知邮箱（可留空）
SITE_PORT="${SITE_PORT:-80}"       # 腾讯香港默认 80 空闲

SRC_DIR="$(cd "$(dirname "$0")" && pwd)/site"

# ---------- 0. 前置检查 ----------
if [ "$(id -u)" != "0" ]; then
  echo "[x] 需要 root：sudo bash deploy-official-site.sh"; exit 1
fi
if [ -z "$DOMAIN" ]; then
  echo "[x] 未设置 DOMAIN。执行时带上：DOMAIN=yourdomain.com sudo -E bash deploy-official-site.sh"
  exit 1
fi
if [ ! -d "$SRC_DIR" ]; then
  echo "[x] 找不到站点文件目录：$SRC_DIR"; exit 1
fi
if [ ! -f "$SRC_DIR/index.html" ]; then
  echo "[x] 缺少 $SRC_DIR/index.html"; exit 1
fi

# ---------- 1. 依赖 ----------
if ! command -v nginx >/dev/null 2>&1; then
  echo "[i] 安装 nginx ..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq nginx
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q nginx
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q nginx
  else
    echo "[x] 无法自动安装 nginx，请手动安装"; exit 1
  fi
fi

# ---------- 2. 端口占用检查（不覆盖别人的服务！）----------
echo "[i] 检查端口 $SITE_PORT 占用 ..."
if command -v ss >/dev/null 2>&1; then
  OCCUPIED=$(ss -ltnp 2>/dev/null | grep -E "[:.]$SITE_PORT\s" || true)
  if [ -n "$OCCUPIED" ]; then
    echo "[!] 端口 $SITE_PORT 已被占用："
    echo "$OCCUPIED"
    echo "[x] 为避免砸掉现有服务，终止。请先确认占用方，或改用 SITE_PORT=8088。"
    exit 1
  fi
fi
echo "[ok] 端口 $SITE_PORT 空闲"

# ---------- 3. 备份 ----------
if [ -d "$SITE_DIR" ] && [ -n "$(ls -A "$SITE_DIR" 2>/dev/null)" ]; then
  BACKUP_DIR="/var/www/_backup_$(date +%Y%m%d_%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  cp -a "$SITE_DIR/." "$BACKUP_DIR/" 2>/dev/null || true
  echo "[ok] 已备份 → $BACKUP_DIR"
else
  echo "[i] 无旧站点，跳过备份"
fi

# ---------- 4. 放文件 ----------
mkdir -p "$SITE_DIR/js"
cp -f "$SRC_DIR/index.html"       "$SITE_DIR/index.html"
cp -f "$SRC_DIR/js/official-i18n.js" "$SITE_DIR/js/official-i18n.js"
cp -f "$SRC_DIR/robots.txt"      "$SITE_DIR/robots.txt"
[ -f "$SRC_DIR/official-v2.html" ] && cp -f "$SRC_DIR/official-v2.html" "$SITE_DIR/official-v2.html"
for OPT in terms.html privacy.html; do
  [ -f "$SRC_DIR/$OPT" ] && cp -f "$SRC_DIR/$OPT" "$SITE_DIR/$OPT" && echo "[ok] $OPT" || echo "[i] 暂无 $OPT（收款前必须补）"
done
chown -R www-data:www-data "$SITE_DIR" 2>/dev/null || true
echo "[ok] 文件已放置 → $SITE_DIR"

# ---------- 5. nginx 配置 ----------
cat > "$NGINX_CONF" <<EOF
# 灵犀引擎官网 · 生成于 $(date '+%Y-%m-%d %H:%M:%S') · 腾讯云香港
server {
    listen $SITE_PORT;
    listen [::]:$SITE_PORT;
    server_name $DOMAIN;

    root $SITE_DIR;
    index index.html;

    charset utf-8;
    server_tokens off;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/css application/javascript text/html application/json image/svg+xml;
    gzip_min_length 1024;

    location / {
        try_files \$uri \$uri/ =404;
    }

    # 首页与词典不缓存，改版即时生效
    location = /index.html          { add_header Cache-Control "no-cache"; }
    location = /js/official-i18n.js { add_header Cache-Control "no-cache"; }

    # 禁止暴露目录与隐藏文件
    location ~ /\.            { deny all; }
    location ~ /\.(git|env)  { deny all; }

    access_log /var/log/nginx/lingxi-site.access.log;
    error_log  /var/log/nginx/lingxi-site.error.log;
}
EOF
echo "[ok] nginx 配置 → $NGINX_CONF"

# ---------- 6. 校验并重载 ----------
if nginx -t 2>&1 | tail -3; then
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  echo "[ok] nginx 已重载"
else
  echo "[x] nginx 配置有误，未重载；请检查 $NGINX_CONF"; exit 1
fi

# ---------- 7. 自检 ----------
sleep 1
CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$SITE_PORT/" -H "Host: $DOMAIN" || echo 000)
echo "[自检] http://127.0.0.1:$SITE_PORT/ (Host: $DOMAIN) → HTTP $CODE"

# ---------- 8. HTTPS ----------
if [ "$USE_HTTPS" = "yes" ]; then
  echo ""
  echo ">>> 申请 HTTPS 证书（需 DNS 已生效、80 端口对外可达）"
  if ! command -v certbot >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 && apt-get install -y -qq certbot python3-certbot-nginx \
      || dnf install -y -q certbot python3-certbot-nginx
  fi
  if [ -n "$ADMIN_EMAIL" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL"
  else
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
  fi
  echo "[ok] HTTPS: https://$DOMAIN/"
else
  echo "[i] 跳过 HTTPS"
fi

echo ""
echo "=============================================="
echo " 官网部署完成"
echo "   http://$DOMAIN/  |  https://$DOMAIN/"
echo "=============================================="
echo "⚠️ 收款前必做：服务协议 + 隐私政策（terms.html / privacy.html）"
