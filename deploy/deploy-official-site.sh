#!/usr/bin/env bash
# ============================================================
# 灵犀引擎 · 正式官网一键部署脚本
#   用法：sudo bash deploy-official-site.sh
#   作用：部署 official-v2.html + 多语言词典，可选绑域名 + HTTPS
#   安全：纯静态站点，不暴露任何 /api/*
# ============================================================
set -euo pipefail

# ---------- 可调参数（一般不用改）----------
SITE_DIR="/var/www/lingxi-site"
NGINX_CONF="/etc/nginx/conf.d/lingxi-site.conf"
SITE_PORT="8088"          # 80 已被服务器上其他项目占用，默认走 8088
DOMAIN=""                 # 填你的域名，如 lingxi.ai；留空则只按 IP 访问
USE_HTTPS="no"            # yes = 自动申请 Let's Encrypt 证书

# ---------- 0. 权限与依赖 ----------
if [ "$(id -u)" != "0" ]; then
  echo "[x] 需要 root：sudo bash deploy-official-site.sh"
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "[i] 安装 nginx ..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq nginx
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q nginx
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q nginx
  else
    echo "[x] 无法自动安装 nginx，请手动装好再重跑"; exit 1
  fi
fi

# ---------- 1. 备份现有站点 ----------
BACKUP_DIR="/var/www/_backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"
if [ -d "$SITE_DIR" ] && [ -n "$(ls -A "$SITE_DIR" 2>/dev/null)" ]; then
  cp -a "$SITE_DIR/." "$BACKUP_DIR/" 2>/dev/null || true
  echo "[ok] 已备份 → $BACKUP_DIR"
else
  echo "[i] 无旧站点，跳过备份"
fi

# ---------- 2. 放置文件 ----------
# 源文件由本脚本同目录的 site/ 提供（见 README_DEPLOY_SITE.md）
SRC_DIR="$(cd "$(dirname "$0")" && pwd)/site"

mkdir -p "$SITE_DIR"

put() {
  if [ -f "$SRC_DIR/$1" ]; then
    mkdir -p "$(dirname "$SITE_DIR/$1")"
    cp -f "$SRC_DIR/$1" "$SITE_DIR/$1"
    echo "[ok] $1"
  else
    echo "[!] 缺文件：$1"
  fi
}

put "index.html"          # 由 official-v2.html 改名而来
put "js/official-i18n.js"
put "style.css"           # 页面内联样式之外的补充（有就放，没有会跳过）
put "robots.txt"
put "favicon.ico"

# 官网入口名统一成 index.html
if [ -f "$SRC_DIR/official-v2.html" ]; then
  cp -f "$SRC_DIR/official-v2.html" "$SITE_DIR/index.html"
  cp -f "$SRC_DIR/official-v2.html" "$SITE_DIR/official-v2.html"
  echo "[ok] index.html"
fi

# ---------- 3. 生成 nginx 配置 ----------
SERVER_NAME="_"
[ -n "$DOMAIN" ] && SERVER_NAME="$DOMAIN _"

cat > "$NGINX_CONF" <<EOF
# 灵犀引擎官网 · 自动生成于 $(date '+%Y-%m-%d %H:%M:%S')
server {
    listen $SITE_PORT;
    listen [::]:$SITE_PORT;
    server_name $SERVER_NAME;

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

    # 首页与词典给短缓存，改版即时生效
    location = /index.html {
        add_header Cache-Control "no-cache";
    }
    location = /official-v2.html {
        add_header Cache-Control "no-cache";
    }
    location = /js/official-i18n.js {
        add_header Cache-Control "no-cache";
    }

    # 禁止暴露目录与隐藏文件
    location ~ /\. { deny all; }
    location ~ /\.(git|env) { deny all; }

    access_log /var/log/nginx/lingxi-site.access.log;
    error_log  /var/log/nginx/lingxi-site.error.log;
}
EOF

echo "[ok] nginx 配置已写入 $NGINX_CONF"

# ---------- 4. 校验并重载 ----------
if nginx -t 2>&1 | tail -3; then
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  echo "[ok] nginx 已重载"
else
  echo "[x] nginx 配置有误，未重载；请检查 $NGINX_CONF"
  exit 1
fi

# ---------- 5. 自检 ----------
sleep 1
CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$SITE_PORT/" || echo 000)
echo "[自检] http://127.0.0.1:$SITE_PORT/ → HTTP $CODE"
if [ "$CODE" = "200" ]; then
  echo ""
  echo "=============================================="
  echo " ✅ 官网部署成功"
  echo "    访问：http://$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo 'SERVER_IP'):$SITE_PORT/"
  [ -n "$DOMAIN" ] && echo "    域名：http://$DOMAIN:$SITE_PORT/"
  echo "=============================================="
else
  echo "[x] 自检未通过，请查：tail -20 /var/log/nginx/lingxi-site.error.log"
fi

# ---------- 6. 可选：HTTPS ----------
if [ "$USE_HTTPS" = "yes" ] && [ -n "$DOMAIN" ]; then
  echo ""
  echo ">>> 申请 HTTPS 证书"
  command -v certbot >/dev/null 2>&1 || {
    if command -v apt-get >/dev/null 2>&1; then apt-get install -y -qq certbot python3-certbot-nginx;
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q certbot python3-certbot-nginx; fi
  }
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email
  echo "[ok] HTTPS 已配置：https://$DOMAIN/"
fi
