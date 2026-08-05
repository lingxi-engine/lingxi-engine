#!/bin/bash
# 灵犀引擎 云服务器一键部署脚本
# 用法: bash deploy.sh
# 服务器要求: Ubuntu 20.04+ / Debian 11+ / CentOS 8+

set -e

echo "========================================="
echo "  灵犀引擎 云服务器一键部署"
echo "========================================="
echo ""

# ── 1. 环境检测 ──
echo "[1/6] 检测环境..."
if ! command -v node &> /dev/null; then
    echo "❌ 未检测到 Node.js，开始安装..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "✅ Node.js $(node --version)"
fi

if ! command -v npm &> /dev/null; then
    echo "❌ 未检测到 npm，安装..."
    sudo apt-get install -y npm
else
    echo "✅ npm $(npm --version)"
fi

# ── 2. 安装 PM2（进程管理） ──
echo ""
echo "[2/6] 安装 PM2..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
else
    echo "✅ PM2 已安装"
fi

# ── 3. 防火墙 ──
echo ""
echo "[3/6] 配置防火墙..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 3456/tcp
    sudo ufw allow 22/tcp
    echo "✅ UFW 已开放 3456 端口"
elif command -v firewall-cmd &> /dev/null; then
    sudo firewall-cmd --add-port=3456/tcp --permanent
    sudo firewall-cmd --reload
    echo "✅ firewall-cmd 已开放 3456 端口"
else
    echo "⚠️ 未检测到防火墙工具，请手动开放 3456 端口"
fi

# ── 4. 创建服务目录 ──
echo ""
echo "[4/6] 创建服务目录..."
INSTALL_DIR="/opt/lingxi-engine"
sudo mkdir -p "$INSTALL_DIR"
sudo chown $USER:$USER "$INSTALL_DIR"

# ── 5. 配置 .env ──
echo ""
echo "[5/6] 配置环境变量..."
if [ ! -f "$INSTALL_DIR/.env" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env" 2>/dev/null || true
    echo "📝 已创建 .env 文件，请编辑填入 API Key:"
    echo "   nano $INSTALL_DIR/.env"
    echo ""
    echo "   至少需要填一个:"
    echo "   - NVIDIA_API_KEY     (推荐，免费: https://build.nvidia.com)"
    echo "   - OPENAI_API_KEY     (付费: https://platform.openai.com)"
fi

# ── 6. 安装依赖 ──
echo ""
echo "[6/6] 安装依赖..."
cd "$INSTALL_DIR"
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "✅ 依赖已安装"
fi

echo ""
echo "========================================="
echo "  ✅ 部署完成"
echo "========================================="
echo ""
echo "下一步:"
echo "  1. 编辑配置: nano $INSTALL_DIR/.env"
echo "  2. 启动服务: cd $INSTALL_DIR && pm2 start 'npx tsx index.ts' --name lingxi"
echo "  3. 查看状态: pm2 status"
echo "  4. 查看日志: pm2 logs lingxi"
echo "  5. 访问: http://<服务器IP>:3456"
echo ""
echo "PM2 常用命令:"
echo "  pm2 restart lingxi    # 重启"
echo "  pm2 stop lingxi       # 停止"
echo "  pm2 delete lingxi     # 删除"
echo "  pm2 save              # 保存配置"
echo "  pm2 startup           # 开机自启"
echo ""
