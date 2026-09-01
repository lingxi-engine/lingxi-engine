#!/bin/bash
# 灵犀引擎 阿里云 ECS 一键部署脚本（CentOS 7）
# 在阿里云 ECS 控制台 Workbench 里以 root 用户运行
# 一行一行复制粘贴

set -e
echo "========================================="
echo "  灵犀引擎 一键部署到阿里云 ECS"
echo "  服务器: your-server-ip (CentOS 7.9)"
echo "========================================="
echo ""

# ── 1. 确认 Node.js 已安装 ──
echo "[1/9] 检查 Node.js..."
node --version
npm --version
echo "✅ Node.js 已就绪"

# ── 2. 创建目录 ──
echo ""
echo "[2/9] 创建项目目录..."
mkdir -p /opt/lingxi-engine
cd /opt/lingxi-engine

# ── 3. 从本地上传 ──
echo ""
echo "[3/9] ⚠️ 请将项目文件上传到 /opt/lingxi-engine/"
echo "    上传方式见下方说明"
echo ""
echo "    === 上传方式 ==="
echo "    方式A（推荐）: 在 Workbench 顶部菜单 → 文件上传"
echo "    上传 project-hub 目录下的所有文件"
echo ""
echo "    方式B（命令行）:"
echo "    cd /opt/lingxi-engine"
echo "    # 然后用 rz 命令上传"
echo "    yum install -y lrzsz"
echo "    rz"
echo ""

# ── 4. 安装必要工具 ──
echo "[4/9] 安装必要工具..."
yum install -y wget curl git

# ── 5. 安装 PM2（进程管理） ──
echo ""
echo "[5/9] 安装 PM2..."
npm install -g pm2
echo "✅ PM2 $(pm2 --version)"

# ── 6. 安装项目依赖 ──
echo ""
echo "[6/9] 安装项目依赖..."
cd /opt/lingxi-engine
if [ -f "package.json" ]; then
    npm install
    echo "✅ 依赖安装完成"
else
    echo "❌ 未找到 package.json，请先上传项目文件!"
    echo "   上传完成后，运行: cd /opt/lingxi-engine && npm install"
fi

# ── 7. 配置 .env ──
echo ""
echo "[7/9] 配置环境变量..."
if [ -f ".env.example" ] && [ ! -f ".env" ]; then
    cp .env.example .env
    echo "📝 已创建 .env 文件"
    echo ""
    echo "   请编辑 .env 填入 API Key:"
    echo "   编辑命令: nano /opt/lingxi-engine/.env"
    echo "   至少填一个:"
    echo "     NVIDIA_API_KEY=***    (推荐，免费: https://build.nvidia.com)"
    echo "     OPENAI_API_KEY=***    (付费: https://platform.openai.com)"
    echo "   保存: Ctrl+X → Y → Enter"
fi

# ── 8. 配置防火墙 ──
echo ""
echo "[8/9] 配置防火墙..."
systemctl start firewalld 2>/dev/null || true
systemctl enable firewalld 2>/dev/null || true
firewall-cmd --add-port=3456/tcp --permanent 2>/dev/null || true
firewall-cmd --reload 2>/dev/null || true
echo "✅ 防火墙 3456 端口已开放"

# ── 9. 启动服务 ──
echo ""
echo "[9/9] 启动服务..."
cd /opt/lingxi-engine
pm2 delete lingxi 2>/dev/null || true
pm2 start "npx tsx index.ts" --name lingxi
pm2 save

echo ""
echo "========================================="
echo "  ✅ 部署完成!"
echo "========================================="
echo ""
echo "  访问地址: http://your-server-ip:3456"
echo ""
echo "  PM2 命令:"
echo "    pm2 status         # 查看状态"
echo "    pm2 logs lingxi    # 查看日志"
echo "    pm2 restart lingxi # 重启"
echo "    pm2 stop lingxi    # 停止"
echo ""
echo "  ⚠️ 别忘了去阿里云控制台添加安全组规则:"
echo "     安全组 ID: your-security-group-id"
echo "     添加: 入方向 TCP 3456/3456 0.0.0.0/0"
echo "========================================="