#!/bin/bash
# ============================================================
#  灵犀引擎 macOS / Linux 桌面端一键安装脚本
#
#  一行命令安装:
#    curl -fsSL http://47.93.157.83:8080/public/install.sh | bash
#
#  功能:
#    - 自动识别 macOS (Apple Silicon / Intel) 与 Linux
#    - macOS: 自动安装 Homebrew + Node.js 20
#    - Linux: 自动通过 NodeSource 安装 Node.js 20
#    - 保留已有 .env / data / uploads 配置与数据
#    - macOS 自动配置 LaunchAgent 开机自启
#    - 安装后健康检查
#
#  子命令:
#    (无参数)          安装
#    --no-autostart    安装但不配置开机自启
#    --uninstall       卸载（含 LaunchAgent 清理）
#    --fix-app         修复 dmg 版 .app 的 Gatekeeper 拦截
#    --dry-run         演练模式，只打印动作不执行
# ============================================================
set -euo pipefail

# 若被 sh 调用，重新以 bash 执行
if [ -z "${BASH_VERSION:-}" ]; then
    # curl | sh 场景: stdin 是管道，$0 不可靠，直接提示用 bash
    if [ -f "$0" ] && [ "$0" != "sh" ] && [ "$0" != "bash" ]; then
        exec bash "$0" "$@"
    fi
    echo "  ❌ 请用 bash 执行: curl -fsSL http://47.93.157.83:8080/public/install.sh | bash" >&2
    exit 1
fi

VERSION="2.0.13"
BASE_URL="http://47.93.157.83:8080"
TARBALL_URL="$BASE_URL/public/lingxi-engine.tar.gz"
INSTALL_DIR="$HOME/lingxi-engine"
PORT=3456
PLIST_LABEL="com.lingxi.engine"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

# ---- 交互检测: curl|bash 时 stdin 是管道，禁止 read ----
if [ -t 0 ]; then INTERACTIVE=1; else INTERACTIVE=0; fi

DRY_RUN=0
AUTOSTART=1
ACTION="install"
for arg in "$@"; do
    case "$arg" in
        --dry-run)      DRY_RUN=1 ;;
        --no-autostart) AUTOSTART=0 ;;
        --uninstall)    ACTION="uninstall" ;;
        --fix-app)      ACTION="fix-app" ;;
        -h|--help)      ACTION="help" ;;
        *) echo "未知参数: $arg (用 --help 查看用法)"; exit 1 ;;
    esac
done

say()  { echo "  $*"; }
ok()   { echo "  ✅ $*"; }
warn() { echo "  ⚠️  $*"; }
die()  { echo "  ❌ $*" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] $*"; else "$@"; fi; }

banner() {
echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   🐿️  灵犀引擎 v$VERSION 安装程序   ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
}

# ---------------- help ----------------
if [ "$ACTION" = "help" ]; then
    banner
    say "用法: bash install.sh [选项]"
    say ""
    say "  (无参数)        安装灵犀引擎"
    say "  --no-autostart  不配置开机自启"
    say "  --uninstall     卸载"
    say "  --fix-app       修复 dmg 版应用被 Gatekeeper 拦截"
    say "  --dry-run       演练模式"
    exit 0
fi

# ---------------- uninstall ----------------
if [ "$ACTION" = "uninstall" ]; then
    banner
    if [ "$(uname -s)" = "Darwin" ]; then
        run launchctl unload "$PLIST_PATH" 2>/dev/null || true
        run rm -f "$PLIST_PATH"
        ok "已移除 LaunchAgent 自启"
    fi
    if [ -d "$INSTALL_DIR" ]; then
        if [ "$INTERACTIVE" = "1" ]; then
            read -p "  确认删除 $INSTALL_DIR ? (y/n): " yn
            [ "${yn:-n}" = "y" ] || { say "已取消"; exit 0; }
        fi
        run rm -rf "$INSTALL_DIR"
        ok "已删除 $INSTALL_DIR"
    fi
    ok "卸载完成，浏览器收藏夹里的 http://localhost:$PORT 可自行删除"
    exit 0
fi

# ---------------- fix-app (Gatekeeper) ----------------
if [ "$ACTION" = "fix-app" ]; then
    [ "$(uname -s)" = "Darwin" ] || die "此命令仅用于 macOS"
    APP="/Applications/灵犀引擎.app"
    [ -d "$APP" ] || APP="/Applications/lingxi-desktop.app"
    [ -d "$APP" ] || die "未找到已安装的 .app，请先把 dmg 里的灵犀引擎拖入「应用程序」"
    run xattr -cr "$APP"
    ok "已清除隔离属性: $APP"
    say "现在可以正常打开应用了（右键 → 打开 也可以）"
    exit 0
fi

# ================= install =================
banner

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Darwin)
        PLATFORM="macOS"
        [ "$ARCH" = "arm64" ] && CHIP="Apple Silicon (M 系列)" || CHIP="Intel"
        ;;
    Linux)
        PLATFORM="Linux"
        CHIP="$ARCH"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        die "检测到 Windows 下的 Git Bash。Windows 请用 PowerShell 一键安装: irm http://47.93.157.83:8080/install.ps1 | iex"
        ;;
    *)
        die "不支持的系统: $OS"
        ;;
esac
ok "平台: $PLATFORM · $CHIP"

# ---- 1. Node.js ----
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

ensure_node_mac() {
    if ! command -v brew &>/dev/null; then
        say "🍺 未检测到 Homebrew，开始安装（可能需要输入密码）..."
        if [ "$DRY_RUN" = "1" ]; then
            echo "  [dry-run] /bin/bash -c Homebrew-install.sh"
        else
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            # Apple Silicon 与 Intel 的默认前缀不同，统一补 PATH
            if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)";
            elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
        fi
    fi
    BREW_VER="$(brew --version 2>/dev/null | awk 'NR==1{print $2}')" || true
    ok "Homebrew ${BREW_VER:-已就绪}"
    if ! brew list --formula node@20 &>/dev/null; then
        say "📦 通过 Homebrew 安装 Node.js 20 ..."
        run brew install node@20
    fi
    NODE_OPT_BIN="$(brew --prefix 2>/dev/null)/opt/node@20/bin"
    case ":$PATH:" in
        *":$NODE_OPT_BIN:"*) ;;
        /opt/node@20/bin*) ;;
        *) export PATH="$NODE_OPT_BIN:$PATH" ;;
    esac
    # 写入 shell 配置，保证新终端也能用
    local rc="$HOME/.zshrc"
    [ "$(basename "${SHELL:-/bin/bash}")" = "bash" ] && rc="$HOME/.bash_profile"
    if [ -n "${NODE_OPT_BIN:-}" ] && [ "${NODE_OPT_BIN:-}" != "/opt/node@20/bin" ] && ! grep -qs "node@20" "$rc"; then
        run /bin/sh -c "echo 'export PATH=\"$NODE_OPT_BIN:\$PATH\"' >> '$rc'"
        say "已将 Node 写入 $rc（新终端生效）"
    fi
}

ensure_node_linux() {
    if command -v apt-get &>/dev/null; then
        run /bin/sh -c "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"
    elif command -v dnf &>/dev/null; then
        run /bin/sh -c "curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs"
    elif command -v yum &>/dev/null; then
        run /bin/sh -c "curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs"
    else
        die "未识别的包管理器，请手动安装 Node.js 20+ 后重试"
    fi
}

if command -v node &>/dev/null && [ "$(node_major)" -ge 18 ]; then
    ok "Node.js $(node --version)"
else
    say "未检测到 Node.js 18+，开始安装..."
    case "$PLATFORM" in
        macOS) ensure_node_mac ;;
        Linux) ensure_node_linux ;;
    esac
    command -v node &>/dev/null || die "Node.js 安装失败，请手动安装: https://nodejs.org"
    [ "$(node_major)" -ge 18 ] || die "Node.js 版本过低 ($(node --version))，需要 18+"
    ok "Node.js $(node --version)"
fi

# ---- 2. 下载与解压（保留 .env / data / uploads）----
if [ -d "$INSTALL_DIR" ]; then
    say "检测到已有安装: $INSTALL_DIR"
    if [ "$INTERACTIVE" = "1" ]; then
        read -p "  覆盖升级? (Y/n): " yn
        [ "${yn:-Y}" = "Y" ] || { say "已取消"; exit 0; }
    fi
    TS="$(date +%Y%m%d-%H%M%S)"
    say "📦 备份旧目录 -> $INSTALL_DIR.bak-$TS"
    run mv "$INSTALL_DIR" "$INSTALL_DIR.bak-$TS"
    # 抢救用户数据
    for keep in .env data uploads; do
        if [ -e "$INSTALL_DIR.bak-$TS/$keep" ]; then
            run cp -R "$INSTALL_DIR.bak-$TS/$keep" "/tmp/lingxi-keep-$keep"
        fi
    done
fi

say "📥 下载灵犀引擎 v$VERSION ..."
run curl -fsSL -o /tmp/lingxi-engine.tar.gz "$TARBALL_URL"
say "📂 解压到 $HOME/ ..."
run tar -xzf /tmp/lingxi-engine.tar.gz -C "$HOME/"
run rm -f /tmp/lingxi-engine.tar.gz
if [ -f "$INSTALL_DIR/package.json" ]; then
    : # 结构正确
elif [ "$DRY_RUN" = "1" ]; then
    warn "[dry-run] 跳过 tarball 结构校验"
else
    die "解压后未找到 package.json，tarball 结构异常"
fi

# 还原用户数据
for keep in .env data uploads; do
    if [ -e "/tmp/lingxi-keep-$keep" ]; then
        run cp -R "/tmp/lingxi-keep-$keep" "$INSTALL_DIR/"
        run rm -rf "/tmp/lingxi-keep-$keep"
    fi
done
ok "代码部署完成: $INSTALL_DIR"

# ---- 3. .env ----
if [ ! -f "$INSTALL_DIR/.env" ]; then
    SECRET="$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 64 || :)"
    TOKEN="$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 32 || :)"
    run /bin/sh -c "cat > '$INSTALL_DIR/.env' << ENVEOF
PORT=$PORT
JWT_SECRET=$SECRET
ADMIN_TOKEN=$TOKEN
# 至少配置一个 API Key（NVIDIA 有免费额度: https://build.nvidia.com）
NVIDIA_API_KEY=
# OPENAI_API_KEY=
# DEEPSEEK_API_KEY=
ENVEOF"
    ok "已生成 .env（含随机密钥）"
else
    ok ".env 已存在，保留你的配置"
fi

# ---- 4. 依赖 ----
say "📚 安装依赖（首次需要几分钟）..."
run /bin/sh -c "cd '$INSTALL_DIR' && npm install --no-audit --no-fund --loglevel=error"
ok "依赖安装完成"

# ---- 5. 启动 ----
if curl -fsS "http://localhost:$PORT/api/health" &>/dev/null; then
    ok "引擎已在运行，跳过启动"
else
    if [ "$PLATFORM" = "macOS" ] && [ "$AUTOSTART" = "1" ]; then
        say "🔧 配置 LaunchAgent 开机自启..."
        run mkdir -p "$HOME/Library/LaunchAgents"
        run /bin/sh -c "cat > '$PLIST_PATH' << PLISTEOF
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
    <key>Label</key><string>$PLIST_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cd \$HOME/lingxi-engine &amp;&amp; exec npx tsx index.ts</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/lingxi-engine.log</string>
    <key>StandardErrorPath</key><string>/tmp/lingxi-engine.log</string>
</dict>
</plist>
PLISTEOF"
        run launchctl unload "$PLIST_PATH" 2>/dev/null || true
        run launchctl load "$PLIST_PATH"
        ok "LaunchAgent 已加载（开机自启 + 崩溃自动拉起）"
    else
        say "🚀 后台启动引擎..."
        run /bin/sh -c "cd '$INSTALL_DIR' && nohup npx tsx index.ts > /tmp/lingxi-engine.log 2>&1 &"
        ok "已后台启动，日志: /tmp/lingxi-engine.log"
    fi
fi

# ---- 6. 健康检查 ----
say "🩺 健康检查中..."
HEALTH_OK=0
if [ "$DRY_RUN" = "1" ]; then
    say "[dry-run] 跳过健康检查等待"
    HEALTH_OK=1
else
    for i in $(seq 1 30); do
        if curl -fsS "http://localhost:$PORT/api/health" &>/dev/null; then HEALTH_OK=1; break; fi
        sleep 1
    done
fi

echo ""
if [ "$HEALTH_OK" = "1" ]; then
    echo "  ═══════════════════════════════════════"
    echo "    🎉 安装完成，引擎运行中！"
    echo ""
    echo "    打开使用: http://localhost:$PORT"
    echo "    引擎目录: $INSTALL_DIR"
    echo "    运行日志: /tmp/lingxi-engine.log"
    echo ""
    echo "    首次使用请编辑 $INSTALL_DIR/.env 填入 API Key"
    echo "  ═══════════════════════════════════════"
    if [ "$PLATFORM" = "macOS" ] && [ "$DRY_RUN" = "0" ]; then
        open "http://localhost:$PORT" 2>/dev/null || true
    fi
else
    echo "  ⚠️  引擎未在 30s 内就绪，查看日志排查:"
    echo "      tail -50 /tmp/lingxi-engine.log"
    echo "  常见原因: .env 未填 API Key / 端口被占用"
    exit 1
fi
echo ""