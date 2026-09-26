#!/usr/bin/env bash
# ============================================================
#  灵犀官网 · 加固 + 部署 一体脚本
#  用法: 腾讯云控制台 → 登录(网页终端) → 粘贴执行
#
#  ⚠️ 幂等: 可重复执行。已做过的一步会跳过。
#  ⚠️ 安全: 不改 SSH 端口(避免把你关在门外), 但装 fail2ban。
#  ⚠️ 幂等证书: 首次签发需 80 端口从公网可达。
# ============================================================
set -uo pipefail

DOMAIN="${DOMAIN:-lingxi-engine.com}"
SITE_DIR="/opt/lingxi-site"
LOG="/var/log/lingxi-deploy.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "===== 灵犀官网部署开始 ====="
log "域名: $DOMAIN"
log "目录: $SITE_DIR"

# ---------- 0. 必须 root ----------
if [ "$(id -u)" -ne 0 ]; then
  log "❌ 不是 root。腾讯云默认用户就是 root，直接跑即可。"
  exit 1
fi

# ---------- 1. 端口占用预检（绝不覆盖现有服务）----------
log ""
log ">>> [1/8] 端口占用预检"
BUSY=""
for p in 80 443; do
  if ss -tlnp 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    BUSY="$BUSY $p"
  fi
done
if [ -n "$BUSY" ]; then
  log "❌ 端口已被占用:$BUSY"
  log "   占用详情:"
  ss -tlnp 2>/dev/null | grep -E "[:.](80|443)\$" | tee -a "$LOG" | sed 's/^/     /'
  log ""
  log "   处置建议(选一个):"
  log "   a) 停掉占用服务:  systemctl stop <服务名>"
  log "   b) 官网改用 8088: export PORT=8088  然后重跑本脚本"
  log "   c) 看占用者是谁: 上面 ss 输出里的 users:((...))"
  exit 2
fi
log "✅ 80/443 均空闲"

# ---------- 2. 系统更新 ----------
log ""
log ">>> [2/8] 系统更新（首次约 1-3 分钟）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq 2>&1 | tail -3 | tee -a "$LOG" | sed 's/^/  /'
UP=$(apt-get -s upgrade 2>/dev/null | grep -c '^Inst' || true)
log "  可升级包: $UP 个"

# ---------- 3. 装包 ----------
log ""
log ">>> [3/8] 安装 nginx / certbot / fail2ban / curl"
NEED=""
for c in nginx certbot fail2ban-client curl; do
  command -v "$c" >/dev/null 2>&1 || NEED="$NEED $c"
done
if [ -n "$NEED" ]; then
  apt-get install -y -qq $NEED 2>&1 | tail -5 | tee -a "$LOG" | sed 's/^/  /'
else
  log "  已全部安装，跳过"
fi
systemctl enable --now nginx >/dev/null 2>&1
systemctl enable --now fail2ban >/dev/null 2>&1
log "  nginx    : $(systemctl is-active nginx)"
log "  fail2ban : $(systemctl is-active fail2ban)"

# ---------- 4. 站点文件 ----------
log ""
log ">>> [4/8] 部署站点文件"
mkdir -p "$SITE_DIR"/{js}
cp -f /dev/null "$SITE_DIR/.keep" 2>/dev/null || true

# 站点内容由后续 step 从本地上传, 这里先确保目录存在
if [ -f /tmp/lingxi-site.tar.gz ]; then
  log "  发现 /tmp/lingxi-site.tar.gz, 解包"
  tar -xzf /tmp/lingxi-site.tar.gz -C "$SITE_DIR" --strip-components=0 2>&1 | sed 's/^/     /'
  log "✅ 站点文件已就位"
else
  log "⚠️  未找到 /tmp/lingxi-site.tar.gz"
  log "   目录已建好, 请先把站点包上传到 /tmp/ 再重跑本脚本"
  log "   站点包位置(本地): C:\\Users\\Administrator\\lingxi-engine\\deploy\\site\\"
fi

ls -la "$SITE_DIR" 2>/dev/null | sed 's/^/  /'

# ---------- 5. nginx 配置 ----------
log ""
log ">>> [5/8] 写 nginx 配置"
cat > /etc/nginx/conf.d/lingxi-site.conf <<NGINXEOF
# 灵犀官网 $DOMAIN
# 由 deploy/deploy-site-one-shot.sh 自动生成, $(date '+%F %T')

server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

    # 证书申请与续期走这个 location, 别删
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type "text/plain";
        allow all;
    }

    location / {
        root $SITE_DIR;
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }

    # 静态资源缓存
    location ~* \.(css|js|svg|png|jpg|webp|woff2?)$ {
        root $SITE_DIR;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
    }

    access_log /var/log/nginx/lingxi-access.log;
    error_log  /var/log/nginx/lingxi-error.log;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN www.$DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 14400m;

    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        root $SITE_DIR;
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }

    location ~* \.(css|js|svg|png|jpg|webp|woff2?)$ {
        root $SITE_DIR;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
    }

    access_log /var/log/nginx/lingxi-access.log;
    error_log  /var/log/nginx/lingxi-error.log;
}
NGINXEOF
log "  已写 /etc/nginx/conf.d/lingxi-site.conf"

# 首次部署先只有 80, 证书还没有 -> 先不启用 443 段
# 做法: 生成一个只含 80 的临时配置, 签发证书后再换回来
cat > /etc/nginx/conf.d/lingxi-site.conf <<'TEMPEOF'
server {
    listen 80;
    listen [::]:80;
    server_name lingxi-engine.com www.lingxi-engine.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; default_type "text/plain"; allow all; }
    location / { root /opt/lingxi-site; index index.html; try_files $uri $uri/ /index.html; }
    access_log /var/log/nginx/lingxi-access.log;
    error_log  /var/log/nginx/lingxi-error.log;
}
TEMPEOF

if nginx -t 2>&1 | tee -a "$LOG" | sed 's/^/  /' | grep -q "syntax is ok"; then
  log "✅ nginx 配置语法 OK"
else
  log "❌ nginx 配置有错, 回滚到默认站点"
  rm -f /etc/nginx/conf.d/lingxi-site.conf
  nginx -t 2>&1 | sed 's/^/  /'
fi
systemctl reload nginx 2>/dev/null || systemctl restart nginx
log "  nginx 已加载"

# ---------- 6. fail2ban 强化 ----------
log ""
log ">>> [6/8] 配置 fail2ban（拦暴力破解）"
cat > /etc/fail2ban/jail.local <<'JEOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
banaction = ufw

[sshd]
enabled  = true
port     = 22
logpath  = /var/log/auth.log
maxretry = 4
bantime  = 1h
JEOF
systemctl restart fail2ban 2>/dev/null
log "  fail2ban: $(fail2ban-client status sshd 2>/dev/null | grep -i 'currently banned' || echo '已启动')"

# ---------- 7. HTTPS ----------
log ""
log ">>> [7/8] 申请 HTTPS 证书（Let's Encrypt, free）"
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  log "  ✅ 证书已存在, 跳过签发"
else
  # 前提: 80 端口必须公网可达
  if ! curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "http://$DOMAIN/.well-known/acme-challenge/test" 2>/dev/null | grep -qE '^(200|404)$'; then
    log "  ⚠️ http://$DOMAIN 本机自测不通"
    log "     这很正常——自测走的是公网回环, 可能不通。"
    log "     继续尝试签发, certbot 走的是外部验证。"
  fi
  certbot certonly --webroot -w /var/www/html -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email \
    --keep-until-expiring 2>&1 | tail -15 | tee -a "$LOG" | sed 's/^/  /'

  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    log "✅ 证书签发成功！换回完整配置(含 443)"
    cat > /etc/nginx/conf.d/lingxi-site.conf <<FULLEOF
server {
    listen 80;
    listen [::]:80;
    server_name lingxi-engine.com www.lingxi-engine.com;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; default_type "text/plain"; allow all; }
    location { return 301 https://$host$request_uri; }
    access_log /var/log/nginx/lingxi-access.log;
    error_log  /var/log/nginx/lingxi-error.log;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name lingxi-engine.com www.lingxi-engine.com;
    ssl_certificate     /etc/letsencrypt/live/lingxi-engine.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lingxi-engine.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 14400m;
    add_header Strict-Transport-Security "max-age=31536000" always;
    location / { root /opt/lingxi-site; index index.html; try_files $uri $uri/ /index.html; }
    location ~* \.(css|js|svg|png|jpg|webp|woff2?)$ { root /opt/lingxi-site; expires 7d; add_header Cache-Control "public, max-age=604800"; }
    access_log /var/log/nginx/lingxi-access.log;
    error_log  /var/log/nginx/lingxi-error.log;
}
FULLEOF
    if nginx -t 2>&1 | grep -q "syntax is ok"; then
      systemctl reload nginx
      log "✅ 443 已启用, 80 自动 301 跳 HTTPS"
    else
      log "❌ 完整配置语法错, 保持 80"
    fi
  else
    log "⚠️ 证书未签发成功。网站仍可通过 http 访问。"
    log "   常见原因: 80 端口公网不可达 / DNS 未生效 / 频率超限"
  fi
fi

# certbot 自动续期
systemctl enable certbot.timer >/dev/null 2>&1
log "  certbot 自动续期定时器: $(systemctl is-enabled certbot.timer 2>/dev/null)"

# ---------- 8. 自检 ----------
log ""
log ">>> [8/8] 部署自检"
PASS=0; FAIL=0
chk() { if eval "$2" >/dev/null 2>&1; then echo "  ✅ $1"; PASS=$((PASS+1)); else echo "  ❌ $1"; FAIL=$((FAIL+1)); fi; }

chk "nginx 运行中"        "systemctl is-active --quiet nginx"
chk "站点文件存在"        "test -f $SITE_DIR/index.html"
chk "服务协议存在"        "test -f $SITE_DIR/terms.html"
chk "隐私政策存在"        "test -f $SITE_DIR/privacy.html"
chk "robots.txt 存在"    "test -f $SITE_DIR/robots.txt"
chk "i18n 词典存在"       "test -f $SITE_DIR/js/official-i18n.js"
chk "本机 80 有监听"      "ss -tln | grep -q ':80 '"
chk "本机 443 有监听"     "ss -tln | grep -q ':443 '"
chk "fail2ban 运行中"     "systemctl is-active --quiet fail2ban"
chk "证书存在"            "test -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem"

echo ""
echo "  ---- 本机 curl 自测 ----"
echo "  http 127.0.0.1 : $(curl -s -o /dev/null -w '%{http_code}' -H 'Host: $DOMAIN' http://127.0.0.1/ 2>/dev/null || echo FAIL)"
echo "  https 127.0.0.1: $(curl -sk -o /dev/null -w '%{http_code}' -H 'Host: $DOMAIN' https://127.0.0.1/ 2>/dev/null || echo FAIL)"

echo ""
echo "  ---- 公网自测 ----"
echo "  http  domain : $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://$DOMAIN/ 2>/dev/null || echo TIMEOUT)"
echo "  https domain : $(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 https://$DOMAIN/ 2>&1 | sed 's/curl:.*/[timeout]/' || echo TIMEOUT)"

echo ""
echo "################################################"
log "自检: $PASS 通过 / $FAIL 失败"
log "日志: $LOG"
echo "################################################"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "🎉 部署完成！浏览器打开:  https://$DOMAIN"
else
  echo "⚠️  部分项目失败, 看上面 ❌ 行和 $LOG"
fi
