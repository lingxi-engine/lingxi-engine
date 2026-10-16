#!/usr/bin/env bash
# ============================================================
#  灵犀官网 :: 修复 SSH 部署账号
#  在【服务器控制台】以 ubuntu 用户执行（VNC / TAT 网页终端）
#  用法：bash FIX-SSH-KEY-20261016.sh
#  幂等：可反复执行，已存在的会跳过
# ============================================================
set -uo pipefail

KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPDwEbMrFe0c4vtTME5bBagXfGbDPGoZJFFsgFpOlLPT openclaw-deploy'

echo "==== 1) 现状体检 ===="
echo "host=$(hostname)  ip=$(hostname -I)"
echo "--- 可登录账号 ---"
getent passwd | awk -F: '$7 ~ /(bash|sh|zsh)$/ {print "  "$1"  home="$6}'
echo "--- 站点目录 ---"
ls -ld /opt/lingxi-site 2>/dev/null || echo "  /opt/lingxi-site 不存在"
echo "--- nginx 站点配置 ---"
sudo grep -rEh '^[[:space:]]*(server_name|root)[[:space:]]' /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | head -20
echo "--- sshd 监听 / 生效配置 ---"
sudo ss -tlnp 2>/dev/null | grep -E ':22\b' || echo "  22 未监听！"
sudo sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|pubkeyauthentication|authorizedkeysfile|allowusers|allowgroups) '

echo
echo "==== 2) 创建部署账号 openclaw-deploy ===="
if id openclaw-deploy >/dev/null 2>&1; then
  echo "  已存在，跳过创建"
else
  sudo useradd -m -s /bin/bash openclaw-deploy && echo "  已创建（无密码，仅公钥登录）"
fi
sudo usermod -aG sudo openclaw-deploy 2>/dev/null && echo "  已加入 sudo 组"

echo
echo "==== 3) 安装公钥（幂等，ubuntu / root 也装上做备份通道） ===="
for U in openclaw-deploy ubuntu root; do
  H=$(getent passwd "$U" 2>/dev/null | cut -d: -f6 || true)
  if [ -z "${H:-}" ] || [ ! -d "$H" ]; then echo "  跳过 $U（无家目录）"; continue; fi
  sudo mkdir -p "$H/.ssh"
  sudo touch "$H/.ssh/authorized_keys"
  if sudo grep -qF "$KEY" "$H/.ssh/authorized_keys" 2>/dev/null; then
    echo "  $U: 公钥已存在，跳过"
  else
    echo "$KEY" | sudo tee -a "$H/.ssh/authorized_keys" >/dev/null
    echo "  $U: 公钥已写入"
  fi
  sudo chmod 700 "$H/.ssh"
  sudo chmod 600 "$H/.ssh/authorized_keys"
  sudo chown -R "$U":"$U" "$H/.ssh"
done

echo
echo "==== 4) 免密 sudo（部署要写站点目录 / 重载 nginx） ===="
echo 'openclaw-deploy ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/openclaw-deploy >/dev/null
sudo chmod 440 /etc/sudoers.d/openclaw-deploy
sudo visudo -cf /etc/sudoers.d/openclaw-deploy

echo
echo "==== 5) 主机防火墙放行 22 ===="
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 22/tcp >/dev/null 2>&1
  sudo ufw status 2>/dev/null | head -4
else
  echo "  ufw 未安装（Ubuntu 24.04 正常）"
fi
sudo iptables -C INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null \
  || sudo iptables -I INPUT -p tcp --dport 22 -j ACCEPT 2>/dev/null
sudo iptables -S INPUT 2>/dev/null | head -4

echo
echo "==== 6) 自检 ===="
for U in openclaw-deploy ubuntu root; do
  H=$(getent passwd "$U" 2>/dev/null | cut -d: -f6 || true)
  [ -n "${H:-}" ] && printf '  %-18s 公钥条数: %s\n' "$U" "$(sudo grep -c 'ssh-ed25519' "$H/.ssh/authorized_keys" 2>/dev/null || echo 0)"
done
echo
echo ">>> 脚本完成。别忘了【腾讯云控制台 → 轻量应用服务器 → 防火墙 → 放行 TCP:22】这一步！"
echo "DONE"
