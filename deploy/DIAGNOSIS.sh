#!/usr/bin/env bash
# ============================================================
# 灵犀官网 · 服务器端诊断脚本
# 用法: 腾讯云控制台 → 登录 → 粘贴执行
# 目的: 定位"安全组规则正确但公网连不上"的真凶
# ============================================================
set -uo pipefail

echo "################################################"
echo "#  灵犀官网 服务器诊断  $(date '+%F %T %Z')"
echo "################################################"

echo ""
echo "===== [1] 基础信息 ====="
echo "hostname : $(hostname)"
echo "uptime   : $(uptime -p 2>/dev/null || uptime)"
echo "kernel   : $(uname -r)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "os       : $PRETTY_NAME"; fi
echo "time     : $(date)"
echo "publicip : $(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || echo '(取不到)')"
echo "eips     : $(curl -s --max-time 5 http://ifconfig.me 2>/dev/null || echo '(取不到)')"

echo ""
echo "===== [2] 网卡与路由 ====="
ip -4 addr show | sed 's/^/  /'
echo "  --- route ---"
ip route show | sed 's/^/  /'

echo ""
echo "===== [3] 监听端口 ====="
if command -v ss >/dev/null 2>&1; then
  ss -tulnp 2>/dev/null | sed 's/^/  /'
elif command -v netstat >/dev/null 2>&1; then
  netstat -tulnp 2>/dev/null | sed 's/^/  /'
else
  echo "  (ss / netstat 都没有)"
fi

echo ""
echo "===== [4] 防火墙（主机层）====="
for f in ufw firewalld nft iptables; do
  case "$f" in
    ufw)
      if command -v ufw >/dev/null 2>&1; then
        echo "  --- ufw ---"; ufw status verbose 2>&1 | sed 's/^/  /'
      fi ;;
    firewalld)
      echo "  --- firewalld ---"
      if command -v firewall-cmd >/dev/null 2>&1; then
        firewall-cmd --list-all 2>&1 | sed 's/^/  /'
      else
        echo "  (未安装)"
      fi ;;
    nft)
      if command -v nft >/dev/null 2>&1; then
        echo "  --- nftables ---"; nft list ruleset 2>&1 | head -40 | sed 's/^/  /'
      fi ;;
    iptables)
      echo "  --- iptables INPUT ---"
      if command -v iptables >/dev/null 2>&1; then
        iptables -L INPUT -n -v 2>&1 | head -30 | sed 's/^/  /'
      fi ;;
  esac
done
echo "  --- 云厂商安全代理/加固 ---"
systemctl list-units --type=service --state=running 2>/dev/null \
  | grep -Ei 'qcloud|tencent|yunjing|cloud|hids|sec|aegis' | sed 's/^/  /' || echo "  (无)"

echo ""
echo "===== [5] SSH 有效配置（关键：实际生效值）====="
if command -v sshd >/dev/null 2>&1; then
  echo "  配置文件: $(ls -1 /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | tr '\n' ' ')"
  echo "  --- 生效值 ---"
  sshd -T 2>/dev/null | grep -Ei '^(port|listenaddress|permitrootlogin|passwordauthentication|pubkeyauthentication|maxauthtries|allowusers|allowgroups)' | sed 's/^/  /'
  echo "  --- socket 激活状态（重要）---"
  systemctl is-enabled ssh.socket 2>/dev/null | sed 's/^/  ssh.socket enabled: /'
  systemctl is-active  ssh.socket 2>/dev/null | sed 's/^/  ssh.socket active : /'
  echo "  ⚠️  若 ssh.socket = enabled，改 sshd_config 的 Port 不会生效！"
else
  echo "  (无 sshd)"
fi

echo ""
echo "===== [6] 资源 ====="
free -h 2>/dev/null | sed 's/^/  /'
df -h / 2>/dev/null | sed 's/^/  /'
echo "  --- swap ---"
swapon --show 2>/dev/null | sed 's/^/  /' || echo "  (无 swap)"
echo "  --- 磁盘 inode ---"
df -i / 2>/dev/null | sed 's/^/  /'

echo ""
echo "===== [7] 已装 Web 服务 ====="
for svc in nginx apache2 caddy; do
  printf "  %-10s " "$svc"
  systemctl is-active "$svc" 2>/dev/null || echo "inactive"
done
command -v nginx >/dev/null 2>&1 && nginx -v 2>&1 | sed 's/^/  /'

echo ""
echo "===== [8] 磁盘上的部署包 ====="
for d in /opt/lingxi-site /var/www/lingxi /opt/lingxi-engine /root/lingxi-site; do
  if [ -d "$d" ]; then
    echo "  ✅ $d  ($(du -sh "$d" 2>/dev/null | cut -f1))"
    ls -la "$d" 2>/dev/null | head -12 | sed 's/^/     /'
  else
    echo "  ⬜ $d (不存在)"
  fi
done

echo ""
echo "===== [9] DNS 校验 ====="
echo "  期望 lingxi-engine.com -> 43.161.216.80"
echo "  实际: $(getent hosts lingxi-engine.com 2>/dev/null || echo '(解析失败)')"
echo "  权威: $(command -v dig >/dev/null 2>&1 && dig +short lingxi-engine.com 2>/dev/null | tr '\n' ' ' || echo '(无 dig)')"

echo ""
echo "===== [10] 自我入站测试（本机回环，验证服务本身是否正常）====="
for p in 22 80 443; do
  if timeout 3 bash -c "cat < /dev/null > /dev/tcp/127.0.0.1/$p" 2>/dev/null; then
    echo "  ✅ 127.0.0.1:$p 有服务"
  else
    echo "  ⬜ 127.0.0.1:$p 无服务"
  fi
done

echo ""
echo "===== [11] 最近 SSH 登录记录 ====="
last -n 15 2>/dev/null | sed 's/^/  /' || echo "  (无 last)"
echo "  --- 失败登录 ---"
lastb -n 15 2>/dev/null | sed 's/^/  /' || echo "  (无 lastb)"

echo ""
echo "===== [12] 崩溃/异常 OOM ====="
journalctl -p err -n 20 --no-pager 2>/dev/null | sed 's/^/  /' || echo "  (读不到 journal)"

echo ""
echo "################################################"
echo "#  诊断结束。把【全部输出】截图发回即可。"
echo "################################################"
