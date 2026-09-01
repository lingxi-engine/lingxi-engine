#!/bin/bash
set -e

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     🐿️  灵犀引擎 安装程序           ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# 检查 Node.js
if ! command -v node &>/dev/null; then
    echo "  ❌ 未检测到 Node.js"
    echo "  安装方法:"
    echo "    Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install nodejs -y"
    echo "    CentOS/RHEL:   curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install nodejs -y"
    echo "    macOS:         brew install node"
    exit 1
fi
echo "  ✅ Node.js $(node -v)"

# 安装目录
INSTALL_DIR="${HOME}/lingxi-engine"
if [ -d "$INSTALL_DIR" ]; then
    echo "  ⚠️  目录已存在: $INSTALL_DIR"
    read -p "  是否覆盖安装? (y/n): " OVERWRITE
    [ "$OVERWRITE" != "y" ] && exit 0
    rm -rf "$INSTALL_DIR"
fi

# 下载（始终指向最新版符号链接）
echo "  📦 正在下载灵犀引擎（最新版）..."
curl -fsSL -o /tmp/lingxi-engine.tar.gz \
    "${LINGXI_BASE_URL:-http://localhost:8080}/public/lingxi-engine.tar.gz"

# 解压
echo "  📂 正在解压..."
tar -xzf /tmp/lingxi-engine.tar.gz -C "$HOME/"
rm /tmp/lingxi-engine.tar.gz

# 安装依赖
cd "$INSTALL_DIR"
echo "  📥 安装依赖（需要几分钟）..."
npm install --silent
npm install puppeteer --silent 2>/dev/null || echo "  ⚠️  puppeteer 安装失败（浏览器工具不可用，不影响核心功能）"

# 创建 .env
if [ ! -f .env ]; then
    cat > .env << 'ENVEOF'
# 灵犀引擎配置文件
# 至少配置一个 API Key
OPENAI_API_KEY=sk-your-key-here
# DEEPSEEK_API_KEY=sk-your-key-here
# ANTHROPIC_API_KEY=sk-your-key-here
PORT=3456
ENVEOF
fi

echo ""
echo "  ═══════════════════════════════════════"
echo "    ✅ 安装完成！"
echo ""
echo "    引擎目录: $INSTALL_DIR"
echo "    启动命令: cd lingxi-engine && npx tsx index.ts"
echo "    浏览器打开: http://localhost:3456"
echo ""
echo "    ⚠️  重要：编辑 $INSTALL_DIR/.env 填入你的 API Key"
echo "  ═══════════════════════════════════════"
echo ""

read -p "  是否现在启动? (y/n): " STARTUP
if [ "$STARTUP" = "y" ]; then
    echo "  🚀 启动中..."
    npx tsx index.ts
fi
