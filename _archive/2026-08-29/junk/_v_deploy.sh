#!/bin/bash
# 灵犀引擎 云服务器一键部署脚本
# 用法: bash deploy.sh
# 服务器要求: Ubuntu 20.04+ / Debian 11+ / CentOS Stream 8/9+（glibc >= 2.28；CentOS 7 不支持）

set -e

echo "========================================="
echo "  灵犀引擎 云服务器一键部署"
echo "========================================="
echo ""

# ── 0. 包管理器与权限检测 ──
echo "[0/8] 检测包管理器..."
PKG=""
if command -v apt-get &> /dev/null; then
    PKG="apt"
elif command -v dnf &> /dev/null; then
    PKG="dnf"
elif command -v yum &> /dev/null; then
    PKG="yum"
fi
echo "✅ 包管理器: ${PKG:-未识别}"

# ── macOS 检测（Homebrew 路线）──
OS_NAME="$(uname -s)"
IS_MAC=false
if [ "$OS_NAME" = "Darwin" ]; then
    IS_MAC=true
    PKG="brew"
    echo "🍎 检测到 macOS，走 Homebrew 路线"
fi

SUDO=""
if [ "$IS_MAC" = true ]; then
    SUDO=""
elif [ "$(id -u)" -ne 0 ] && command -v sudo &> /dev/null; then
    SUDO="sudo"
fi

# ── 1. 环境检测（Node.js 按发行版分支安装） ──
echo ""
echo "[1/8] 检测环境..."
if ! command -v node &> /dev/null; then
    echo "❌ 未检测到 Node.js，开始安装..."
    case "$PKG" in
        apt)
            curl -fsSL https://deb.nodesource.com/setup_20.x | ${SUDO:+$SUDO -E} bash -
            $SUDO apt-get install -y nodejs
            ;;
        dnf|yum)
            curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
            $SUDO $PKG install -y nodejs
            ;;
        brew)
            if ! command -v brew &> /dev/null; then
                echo "🍺 未检测到 Homebrew，先安装..."
                /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            fi
            brew install node@20
            brew link --overwrite node@20 2>/dev/null || true
            ;;
        *)
            echo "❌ 未识别的包管理器，请手动安装 Node.js 20+（https://nodejs.org）后重试"
            exit 1
            ;;
    esac
fi
echo "✅ Node.js $(node --version)"

if ! command -v npm &> /dev/null; then
    case "$PKG" in
        apt)      $SUDO apt-get install -y npm ;;
        dnf|yum)  $SUDO $PKG install -y npm ;;
        brew)     echo "✅ macOS 下 npm 随 Node 一起安装" ;;
        *)        echo "❌ 未检测到 npm，请手动安装"; exit 1 ;;
    esac
fi
echo "✅ npm $(npm --version)"

# ── 2. 安装 PM2（进程管理） ──
echo ""
echo "[2/8] 安装 PM2..."
if ! command -v pm2 &> /dev/null; then
    $SUDO npm install -g pm2
else
    echo "✅ PM2 已安装"
fi

# ── 3. puppeteer 系统依赖（可选，浏览器工具用；失败不影响核心功能） ──
echo ""
echo "[3/8] 安装 puppeteer 系统依赖..."
case "$PKG" in
    apt)
        $SUDO apt-get install -y libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2 \
            2>/dev/null || echo "⚠️  部分依赖安装失败，浏览器工具可能不可用（不影响核心功能）"
        ;;
    dnf|yum)
        $SUDO $PKG install -y nss atk at-spi2-atk cups-libs libdrm libxkbcommon \
            libXcomposite libXdamage libXfixes libXrandr mesa-libgbm alsa-lib \
            2>/dev/null || echo "⚠️  部分依赖安装失败，浏览器工具可能不可用（不影响核心功能）"
        ;;
    brew)
        echo "ℹ️  macOS 一般自带浏览器依赖，跳过"
        ;;
    *)
        echo "⚠️  跳过（未识别的包管理器）"
        ;;
esac
echo "✅ puppeteer 系统依赖处理完成"

# ── 4. 防火墙 ──
echo ""
echo "[4/8] 配置防火墙..."
if command -v ufw &> /dev/null; then
    $SUDO ufw allow 3456/tcp
    $SUDO ufw allow 22/tcp
    echo "✅ UFW 已开放 3456 端口"
elif command -v firewall-cmd &> /dev/null; then
    $SUDO firewall-cmd --add-port=3456/tcp --permanent
    $SUDO firewall-cmd --reload
    echo "✅ firewall-cmd 已开放 3456 端口"
elif [ "$IS_MAC" = true ]; then
    echo "ℹ️  macOS 默认未启用包过滤防火墙，本地访问无需配置"
else
    echo "⚠️ 未检测到防火墙工具，请手动开放 3456 端口"
fi

# ── 5. 创建服务目录并部署代码 ──
echo ""
echo "[5/8] 部署引擎代码..."
if [ "$IS_MAC" = true ]; then
    INSTALL_DIR="$HOME/lingxi-engine"
else
    INSTALL_DIR="/opt/lingxi-engine"
fi
if [ -f "$INSTALL_DIR/package.json" ]; then
    echo "✅ 检测到已有代码: $INSTALL_DIR（跳过下载）"
else
    $SUDO mkdir -p "$INSTALL_DIR"
    echo "📦 正在下载灵犀引擎最新版..."
    curl -fsSL -o /tmp/lingxi-engine.tar.gz \
        "http://47.93.157.83:8080/public/lingxi-engine.tar.gz"
    echo "📂 正在解压到 $INSTALL_DIR ..."
    if [ "$IS_MAC" = true ]; then
        tar -xzf /tmp/lingxi-engine.tar.gz -C "$INSTALL_DIR" --strip-components=1
    else
        $SUDO tar -xzf /tmp/lingxi-engine.tar.gz -C "$INSTALL_DIR" --strip-components=1
    fi
    rm -f /tmp/lingxi-engine.tar.gz
    if [ ! -f "$INSTALL_DIR/package.json" ]; then
        echo "❌ 解压后未找到 package.json，请检查 tarball 结构（应含 lingxi-engine/ 顶层目录）"
        exit 1
    fi
    echo "✅ 代码部署完成"
fi
if [ "$IS_MAC" = true ]; then
    chown -R $(id -un):$(id -gn) "$INSTALL_DIR" 2>/dev/null || true
else
    $SUDO chown -R $(id -un):$(id -gn) "$INSTALL_DIR"
fi

# ── 6. 配置 .env ──
echo ""
echo "[6/8] 配置环境变量..."
if [ ! -f "$INSTALL_DIR/.env" ]; then
    cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env" 2>/dev/null || true
    echo "📝 已创建 .env 文件，请编辑填入 API Key:"
    echo "   nano $INSTALL_DIR/.env"
    echo ""
    echo "   至少需要填一个:"
    echo "   - NVIDIA_API_KEY     (推荐，免费: https://build.nvidia.com)"
    echo "   - OPENAI_API_KEY     (付费: https://platform.openai.com)"
else
    echo "✅ .env 已存在，跳过"
fi

# ── 7. 安装依赖 ──
echo ""
echo "[7/8] 安装依赖..."
cd "$INSTALL_DIR"
if [ ! -d "node_modules" ]; then
    npm install
else
    echo "✅ 依赖已安装"
fi

# ── 8. 启动服务 ──
echo ""
echo "[8/8] 启动服务..."
if command -v pm2 &> /dev/null; then
    pm2 delete lingxi 2>/dev/null || true
    pm2 start "npx tsx index.ts" --name lingxi --cwd "$INSTALL_DIR"
    pm2 save
    echo "✅ 服务已启动（PM2 托管）"
else
    echo "⚠️  PM2 不可用，使用 nohup 后台启动"
    nohup npx tsx index.ts > "$INSTALL_DIR/engine.log" 2>&1 &
    echo "✅ 后台进程已启动，日志: $INSTALL_DIR/engine.log"
fi

echo ""
echo "========================================="
echo "  ✅ 部署完成"
echo "========================================="
echo ""
echo "验证: curl http://localhost:3456/api/health"
echo "访问: http://<服务器IP>:3456"
echo ""
echo "PM2 常用命令:"
echo "  pm2 status            # 状态"
echo "  pm2 logs lingxi       # 日志"
echo "  pm2 restart lingxi    # 重启"
echo "  pm2 stop lingxi       # 停止"
echo "  pm2 startup           # 开机自启"
echo ""