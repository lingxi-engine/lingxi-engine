#!/usr/bin/env bash
# ============================================================
#  LingXi Engine Official Site - Unlock + Deploy (one-shot)
#  Paste into: Tencent Cloud console -> instance -> Login (web terminal)
#
#  WHY THIS SCRIPT EXISTS:
#    43.161.216.80 -> ports 22/80/443/8080/8443 are ALL unreachable
#    from public internet (verified: 5 ports False, while the SAME
#    egress successfully reaches the Indonesia host 163.7.5.23:22).
#    But inside the VM, sshd is active(running) and listening on
#    0.0.0.0:22, and sshd-session logs show inbound connections.
#    => the block is at the Tencent Cloud Lighthouse firewall layer.
#
#  This script:
#    1) explicitly opens 22/80/443 (ufw + nftables + iptables)
#    2) installs nginx and deploys the static site
#    3) issues a Let's Encrypt certificate and forces HTTPS
#  IDEMPOTENT - safe to re-run.
# ============================================================
set -uo pipefail

DOMAIN="lingxi-engine.com"
SITE_DIR="/opt/lingxi-site"
LOG="/var/log/lingxi-deploy.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

log "===== LingXi site unlock+deploy START ====="

# ---------- 0. root ----------
if [ "$(id -u)" -ne 0 ]; then
  log "FATAL: not root"
  exit 1
fi
log "OK: root"

# ---------- 1. port precheck ----------
log ""
log ">>> [1/7] port precheck"
BUSY=""
for p in 80 443; do
  if ss -tlnp 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    BUSY="$BUSY $p"
  fi
done
if [ -n "$BUSY" ]; then
  log "FATAL: ports busy:$BUSY"
  ss -tlnp 2>/dev/null | grep -E "[:.](80|443)\$" | sed 's/^/     /'
  exit 2
fi
log "OK: 80/443 free"

# ---------- 2. open firewall ----------
log ""
log ">>> [2/7] opening 22/80/443"
export DEBIAN_FRONTEND=noninteractive

if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp  >/dev/null 2>&1
  ufw allow 80/tcp  >/dev/null 2>&1
  ufw allow 443/tcp >/dev/null 2>&1
  ufw --force enable >/dev/null 2>&1
  log "  ufw: $(ufw status | head -1)"
else
  log "  ufw: not installed"
fi

if command -v nft >/dev/null 2>&1; then
  nft add table inet lingxi_fw 2>/dev/null
  nft add chain inet lingxi_fw input '{ type filter hook input priority 0; policy accept; }' 2>/dev/null
  nft add rule inet lingxi_fw input tcp dport 22 accept 2>/dev/null
  nft add rule inet lingxi_fw input tcp dport 80 accept 2>/dev/null
  nft add rule inet lingxi_fw input tcp dport 443 accept 2>/dev/null
  log "  nft: rules added"
fi

if command -v iptables >/dev/null 2>&1; then
  for p in 22 80 443; do
    iptables -I INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null
  done
  iptables -P INPUT ACCEPT 2>/dev/null
  log "  iptables INPUT policy: $(iptables -S INPUT 2>/dev/null | head -1)"
fi

if ! systemctl is-active --quiet ssh; then
  log "  ssh not active, restarting"
  systemctl restart ssh 2>/dev/null
fi
log "  ssh: $(systemctl is-active ssh 2>/dev/null)"

# ---------- 3. install packages ----------
log ""
log ">>> [3/7] installing nginx / certbot / curl"
NEED=""
for c in nginx certbot curl; do
  command -v "$c" >/dev/null 2>&1 || NEED="$NEED $c"
done
if [ -n "$NEED" ]; then
  apt-get update -qq 2>&1 | tail -2 | sed 's/^/     /'
  apt-get install -y -qq $NEED 2>&1 | tail -4 | sed 's/^/     /'
else
  log "  already installed, skip"
fi
systemctl enable --now nginx >/dev/null 2>&1
log "  nginx: $(systemctl is-active nginx 2>/dev/null)"

# ---------- 4. site files ----------
log ""
log ">>> [4/7] deploying site files"
mkdir -p "$SITE_DIR/js"

if [ -f /tmp/lingxi-site.tar.gz ]; then
  log "  found /tmp/lingxi-site.tar.gz"
  tar -xzf /tmp/lingxi-site.tar.gz -C "$SITE_DIR" 2>&1 | sed 's/^/     /'
  log "OK: site files in place"
elif [ -n "${LINGXI_SITE_B64:-}" ]; then
  log "  decoding inline base64"
  echo "$LINGXI_SITE_B64" | base64 -d > /tmp/site.tar.gz
  tar -xzf /tmp/site.tar.gz -C "$SITE_DIR" 2>&1 | sed 's/^/     /'
  log "OK: site files in place (base64)"
else
  log "FATAL: no site package found"
  exit 3
fi

chmod -R 755 "$SITE_DIR" 2>/dev/null
ls -la "$SITE_DIR" 2>/dev/null | sed 's/^/  /'

# ---------- 5. nginx config (http first) ----------
log ""
log ">>> [5/7] writing nginx config (http only first)"
cat > /etc/nginx/conf.d/lingxi-site.conf <<NGINXEOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;

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

    location ~* \.(css|js|svg|png|jpg|webp|woff2?)$ {
        root $SITE_DIR;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
    }

    access_log /var/log/nginx/lingxi-access.log;
    error_log  /var/log/nginx/lingxi-error.log;
}
NGINXEOF

rm -f /etc/nginx/sites-enabled/default 2>/dev/null

if nginx -t 2>&1 | grep -q "syntax is ok"; then
  log "OK: nginx config valid"
else
  log "FATAL: nginx config error"
  nginx -t 2>&1 | sed 's/^/     /'
  exit 4
fi

systemctl reload nginx 2>/dev/null
log "  nginx reloaded"

# ---------- 6. HTTPS ----------
log ""
log ">>> [6/7] requesting HTTPS certificate"
if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  log "  certificate already exists, skip"
else
  systemctl stop nginx 2>/dev/null; sleep 1
  certbot certonly --standalone --non-interactive --agree-tos \
    --email admin@$DOMAIN -d "$DOMAIN" -d "www.$DOMAIN" 2>&1 | tail -8 | sed 's/^/     /'
  systemctl start nginx 2>/dev/null
  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    log "OK: certificate issued"
  else
    log "WARN: certificate failed, staying on HTTP (re-run to retry)"
  fi
fi

if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  cat > /etc/nginx/conf.d/lingxi-site.conf <<NGINXEOF2
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; default_type "text/plain"; allow all; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOMAIN www.$DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 14400m;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

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
NGINXEOF2
  if nginx -t 2>&1 | grep -q "syntax is ok"; then
    systemctl reload nginx 2>/dev/null
    log "OK: switched to HTTPS"
  else
    log "ERROR: https config invalid, keeping HTTP"
    systemctl reload nginx 2>/dev/null
  fi
fi

# ---------- 7. self-check ----------
log ""
log ">>> [7/7] self-check"
log "  site files : $(find $SITE_DIR -type f 2>/dev/null | wc -l)"
log "  nginx      : $(systemctl is-active nginx 2>/dev/null)"
log "  cert       : $([ -f /etc/letsencrypt/live/lingxi-engine.com/fullchain.pem ] && echo valid || echo none)"
log "  index.html : $([ -s $SITE_DIR/index.html ] && echo present || echo MISSING)"
log "  i18n.js    : $([ -s $SITE_DIR/js/official-i18n.js ] && echo present || echo MISSING)"
log "  terms      : $([ -s $SITE_DIR/terms.html ] && echo present || echo MISSING)"
log "  privacy    : $([ -s $SITE_DIR/privacy.html ] && echo present || echo MISSING)"
log ""
log "===== DONE ====="
log "Open: https://lingxi-engine.com"
log "If unreachable, check Tencent Lighthouse FIREWALL (not security group) for 22/80/443."
