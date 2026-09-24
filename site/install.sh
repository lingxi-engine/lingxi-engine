#!/bin/bash
# ============================================================
#  灵犀引擎 macOS / Linux 桌面端一键安装脚本
#
#  一行命令安装:
#    curl -fsSL ${LINGXI_BASE_URL:-http://47.93.157.83:8080}/public/install.sh | bash
#
#  功能:
#    - 自动识别 macOS (Apple Silicon / Intel) 与 Linux
#    - macOS: 自动安装 Homebrew + Node.js 20 + LaunchAgent 自启
#    - Linux: 自动通过 NodeSource 安装 Node.js 20
#    - Linux 桌面集成: 应用菜单入口 + CLI + systemd 用户服务自启
#      (无 systemd 时自动降级为 XDG autostart)
#    - 保留已有 .env / data / uploads 配置与数据
#    - 兼容两种 tarball 结构（顶层目录 / 扁平根目录）
#    - 安装后健康检查
#
#  子命令:
#    (无参数)          安装
#    --no-autostart    安装但不配置开机自启
#    --uninstall       卸载（含 LaunchAgent / systemd / 桌面入口清理）
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
    echo "  ❌ 请用 bash 执行: curl -fsSL ${LINGXI_BASE_URL:-http://47.93.157.83:8080}/public/install.sh | bash" >&2
    exit 1
fi

# 版本号从 version.txt 动态读取（与仓库/git tag 单一源头，杜绝显示漂移）
VERSION="unknown"
BASE_URL="${LINGXI_BASE_URL:-http://47.93.157.83:8080}"
TARBALL_URL="$BASE_URL/public/lingxi-engine.tar.gz"
INSTALL_DIR="$HOME/lingxi-engine"
PORT=3456
PLIST_LABEL="com.lingxi.engine"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
SERVICE_NAME="lingxi-engine"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
AUTOSTART_DIR="$HOME/.config/autostart"

# sudo 包装: 非 root 且有 sudo 时使用
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo &>/dev/null; then
    SUDO="sudo"
fi

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

# put_file <path>  (内容从 stdin 读入) —— 支持 dry-run
put_file() {
    if [ "$DRY_RUN" = "1" ]; then
        echo "  [dry-run] 写入 $1"
        cat > /dev/null
    else
        mkdir -p "$(dirname "$1")"
        cat > "$1"
    fi
}

# 升级场景：旧安装目录里已有 version.txt，先读出来让 banner 显示真实版本
if [ "$VERSION" = "unknown" ] && [ -f "$INSTALL_DIR/version.txt" ]; then
    VERSION="$(head -n1 "$INSTALL_DIR/version.txt" | tr -d '\r')"
fi

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
    say "  --fix-app       修复 dmg 版应用被 Gatekeeper 拦截 (仅 macOS)"
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
    if [ "$(uname -s)" = "Linux" ]; then
        systemctl --user disable --now "${SERVICE_NAME}.service" 2>/dev/null || true
        rm -f "$HOME/.config/systemd/user/${SERVICE_NAME}.service"
        systemctl --user daemon-reload 2>/dev/null || true
        rm -f "${DESKTOP_DIR}/lingxi-engine.desktop"
        rm -f "${AUTOSTART_DIR}/lingxi-engine-autostart.desktop"
        rm -f "$HOME/.local/share/icons/hicolor/scalable/apps/lingxi-engine.svg"
        rm -f "${BIN_DIR}/lingxi" "${BIN_DIR}/lingxi-open.sh" "${BIN_DIR}/lingxi-start-headless.sh"
        ok "已移除 systemd 服务 / 桌面入口 / 自启项"
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
        die "检测到 Windows 下的 Git Bash。Windows 请用 PowerShell 一键安装: irm ${LINGXI_BASE_URL:-http://47.93.157.83:8080}/install.ps1 | iex"
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
        run /bin/sh -c "curl -fsSL https://deb.nodesource.com/setup_20.x | ${SUDO:+$SUDO -E} bash - && $SUDO apt-get install -y nodejs"
    elif command -v dnf &>/dev/null; then
        run /bin/sh -c "curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - && $SUDO dnf install -y nodejs"
    elif command -v yum &>/dev/null; then
        run /bin/sh -c "curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash - && $SUDO yum install -y nodejs"
    elif command -v zypper &>/dev/null; then
        run $SUDO zypper install -y nodejs20 || run $SUDO zypper install -y nodejs18 || run $SUDO zypper install -y nodejs
    elif command -v pacman &>/dev/null; then
        run $SUDO pacman -S --noconfirm --needed nodejs npm
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
EXTRACT_TMP="/tmp/lingxi-extract-$$"
if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] curl $TARBALL_URL -> /tmp 并解压到 $INSTALL_DIR"
else
    curl -fsSL -o /tmp/lingxi-engine.tar.gz "$TARBALL_URL"
    mkdir -p "$EXTRACT_TMP"
    tar -xzf /tmp/lingxi-engine.tar.gz -C "$EXTRACT_TMP"
    rm -f /tmp/lingxi-engine.tar.gz
    # 兼容两种 tarball 结构：顶层 lingxi-engine/ 目录 或 扁平 ./
    if [ -f "$EXTRACT_TMP/package.json" ]; then
        SRC="$EXTRACT_TMP"
    elif [ -f "$EXTRACT_TMP/lingxi-engine/package.json" ]; then
        SRC="$EXTRACT_TMP/lingxi-engine"
    else
        rm -rf "$EXTRACT_TMP"
        die "tarball 结构异常：未找到 package.json"
    fi
    mkdir -p "$INSTALL_DIR"
    cp -R "$SRC/." "$INSTALL_DIR/"
    rm -rf "$EXTRACT_TMP"
fi
if [ "$DRY_RUN" = "0" ] && [ ! -f "$INSTALL_DIR/package.json" ]; then
    die "解压后未找到 package.json，安装中止"
fi

# 还原用户数据
for keep in .env data uploads; do
    if [ -e "/tmp/lingxi-keep-$keep" ]; then
        run cp -R "/tmp/lingxi-keep-$keep" "$INSTALL_DIR/"
        run rm -rf "/tmp/lingxi-keep-$keep"
    fi
done
# 从刚部署的代码里读真实版本号（tar.gz 内容才是权威，覆盖任何初始猜测）
if [ -f "$INSTALL_DIR/version.txt" ]; then
    VERSION="$(head -n1 "$INSTALL_DIR/version.txt" | tr -d '\r')"
    ok "部署版本: v$VERSION"
else
    VERSION="unknown"
    warn "部署包内无 version.txt，无法确认版本"
fi
ok "代码部署完成: $INSTALL_DIR"

# ---- 3. .env ----
if [ ! -f "$INSTALL_DIR/.env" ]; then
    SECRET="$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom 2>/dev/null | head -c 64)" || SECRET="$(openssl rand -hex 32)"
    TOKEN="$(LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom 2>/dev/null | head -c 32)" || TOKEN="$(openssl rand -hex 16)"
    put_file "$INSTALL_DIR/.env" << ENVEOF
PORT=$PORT
JWT_SECRET=$SECRET
ADMIN_TOKEN=$TOKEN
# 至少配置一个 API Key（NVIDIA 有免费额度: https://build.nvidia.com）
NVIDIA_API_KEY=
# OPENAI_API_KEY=
# DEEPSEEK_API_KEY=
ENVEOF
    ok "已生成 .env（含随机密钥）"
else
    ok ".env 已存在，保留你的配置"
fi

# ---- 4. 依赖 ----
say "📚 安装依赖（首次需要几分钟）..."
run /bin/sh -c "cd '$INSTALL_DIR' && npm install --no-audit --no-fund --loglevel=error"
ok "依赖安装完成"

# ---- 4.5 Linux 桌面集成：CLI + 桌面入口 + 图标 ----
if [ "$PLATFORM" = "Linux" ]; then
    say "🖥️  配置桌面集成..."
    put_file "${BIN_DIR}/lingxi-open.sh" << EOF
#!/usr/bin/env bash
# 灵犀引擎启动器：确保服务在跑，然后打开浏览器
systemctl --user start ${SERVICE_NAME}.service 2>/dev/null || true
for i in \$(seq 1 15); do
    curl -fsS http://localhost:${PORT}/api/health >/dev/null 2>&1 && break
    sleep 1
done
xdg-open http://localhost:${PORT} >/dev/null 2>&1 || \
    echo "请在浏览器打开 http://localhost:${PORT}"
EOF
    if [ "$DRY_RUN" = "0" ]; then
        chmod +x "${BIN_DIR}/lingxi-open.sh"
        ln -sf "${BIN_DIR}/lingxi-open.sh" "${BIN_DIR}/lingxi"
    fi

    # 无头启动器（XDG autostart 用，不弹终端窗口）
    put_file "${BIN_DIR}/lingxi-start-headless.sh" << EOF
#!/usr/bin/env bash
# 灵犀引擎后台启动（单实例：健康检查通过则直接退出）
if curl -fsS http://localhost:${PORT}/api/health >/dev/null 2>&1; then exit 0; fi
cd "$INSTALL_DIR" && nohup npx tsx index.ts >> "$INSTALL_DIR/engine.log" 2>&1 &
EOF
    [ "$DRY_RUN" = "0" ] && chmod +x "${BIN_DIR}/lingxi-start-headless.sh"

    # 桌面图标
    put_file "${ICON_DIR}/lingxi-engine.svg" << 'SVGEOF'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4f8ef7"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="14" fill="url(#g)"/>
  <path d="M36 12 L20 36 h10 L28 52 L46 26 H34 Z" fill="#ffffff" opacity="0.95"/>
</svg>
SVGEOF

    # 应用菜单入口
    put_file "${DESKTOP_DIR}/lingxi-engine.desktop" << EOF
[Desktop Entry]
Type=Application
Name=LingXi Engine
Name[zh_CN]=灵犀引擎
Comment=AI-native IM platform (local engine + cloud inference)
Comment[zh_CN]=灵犀引擎 - AI 原生即时通讯平台
Exec=${BIN_DIR}/lingxi-open.sh
Icon=lingxi-engine
Terminal=false
Categories=Network;InstantMessaging;Development;
StartupWMClass=lingxi
EOF
    [ "$DRY_RUN" = "0" ] && chmod +x "${DESKTOP_DIR}/lingxi-engine.desktop"
    ok "应用菜单入口: ${DESKTOP_DIR}/lingxi-engine.desktop"
    ok "命令行入口: ${BIN_DIR}/lingxi"
fi

# ---- 5. 自启与服务 ----
USE_SYSTEMD=0
if [ "$PLATFORM" = "Linux" ] && command -v systemctl &>/dev/null; then
    _state="$(systemctl --user is-system-running 2>/dev/null || true)"
    if [ "$_state" = "running" ] || [ "$_state" = "degraded" ]; then
        USE_SYSTEMD=1
    fi
fi

if [ "$PLATFORM" = "macOS" ] && [ "$AUTOSTART" = "1" ]; then
    say "🔧 配置 LaunchAgent 开机自启..."
    put_file "$PLIST_PATH" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
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
PLISTEOF
    run launchctl unload "$PLIST_PATH" 2>/dev/null || true
    run launchctl load "$PLIST_PATH"
    ok "LaunchAgent 已加载（开机自启 + 崩溃自动拉起）"
elif [ "$PLATFORM" = "Linux" ] && [ "$USE_SYSTEMD" = "1" ]; then
    say "🔧 配置 systemd 用户服务..."
    put_file "${HOME}/.config/systemd/user/${SERVICE_NAME}.service" << EOF
[Unit]
Description=LingXi Engine (AI-native IM)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/lingxi-engine
ExecStart=/bin/bash -lc 'cd %h/lingxi-engine && exec npx tsx index.ts'
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
    if [ "$AUTOSTART" = "1" ]; then
        run systemctl --user daemon-reload
        run systemctl --user enable --now "${SERVICE_NAME}.service"
        ok "systemd 用户服务已启用（登录自启 + 崩溃自动拉起）"
    else
        run systemctl --user daemon-reload
        ok "systemd 单元已创建（--no-autostart 跳过启用）"
    fi
elif [ "$PLATFORM" = "Linux" ]; then
    warn "systemd 用户会话不可用，降级为 XDG 自启"
    if [ "$AUTOSTART" = "1" ]; then
        put_file "${AUTOSTART_DIR}/lingxi-engine-autostart.desktop" << EOF
[Desktop Entry]
Type=Application
Name=LingXi Engine (background)
Name[zh_CN]=灵犀引擎（后台）
Exec=${BIN_DIR}/lingxi-start-headless.sh
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
        ok "XDG 自启已配置"
    fi
fi

# ---- 6. 启动/重启 ----
# 升级场景: 旧进程还在跑时必须重启, 否则磁盘上是新代码、内存里还是旧代码
WAS_RUNNING=0
if curl -fsS "http://localhost:$PORT/api/health" &>/dev/null; then WAS_RUNNING=1; fi

if [ "$DRY_RUN" = "1" ]; then
    say "[dry-run] 跳过启动"
elif [ "$WAS_RUNNING" = "1" ] && [ "$PLATFORM" = "Linux" ] && [ "$USE_SYSTEMD" = "1" ] && [ "$AUTOSTART" = "1" ] && systemctl --user is-enabled "${SERVICE_NAME}.service" &>/dev/null; then
    systemctl --user restart "${SERVICE_NAME}.service" || true
    ok "检测到引擎在运行，已通过 systemd 重启加载新代码"
elif [ "$WAS_RUNNING" = "1" ]; then
    say "🔄 检测到引擎在运行（非 systemd 管理），重启以加载新代码..."
    if command -v fuser &>/dev/null; then
        run fuser -k "$PORT/tcp" 2>/dev/null || true
    elif command -v lsof &>/dev/null; then
        run sh -c "lsof -ti tcp:$PORT | xargs kill" 2>/dev/null || true
    else
        run pkill -f "tsx index.ts" 2>/dev/null || true
    fi
    sleep 2
    say "🚀 重新启动引擎..."
    run /bin/sh -c "cd '$INSTALL_DIR' && nohup npx tsx index.ts > /tmp/lingxi-engine.log 2>&1 &"
    ok "已后台启动，日志: /tmp/lingxi-engine.log"
elif [ "$PLATFORM" = "Linux" ] && [ "$USE_SYSTEMD" = "1" ] && [ "$AUTOSTART" = "1" ]; then
    systemctl --user restart "${SERVICE_NAME}.service" || true
    say "🚀 已通过 systemd 启动"
else
    say "🚀 后台启动引擎..."
    run /bin/sh -c "cd '$INSTALL_DIR' && nohup npx tsx index.ts > /tmp/lingxi-engine.log 2>&1 &"
    ok "已后台启动，日志: /tmp/lingxi-engine.log"
fi

# ---- 7. 健康检查 ----
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
    if [ "$PLATFORM" = "Linux" ]; then
        echo "    应用菜单: LingXi Engine / 灵犀引擎"
        echo "    命令行  : ${BIN_DIR}/lingxi"
        if [ "$USE_SYSTEMD" = "1" ]; then
            echo "    服务管理: systemctl --user status ${SERVICE_NAME}"
        fi
    fi
    echo ""
    echo "    首次使用请编辑 $INSTALL_DIR/.env 填入 API Key"
    echo "  ═══════════════════════════════════════"
    if [ "$PLATFORM" = "macOS" ]; then
        open "http://localhost:$PORT" 2>/dev/null || true
    fi
else
    echo "  ⚠️  引擎未在 30s 内就绪，查看日志排查:"
    echo "      tail -50 /tmp/lingxi-engine.log"
    if [ "$PLATFORM" = "Linux" ] && [ "$USE_SYSTEMD" = "1" ]; then
        echo "      journalctl --user -u ${SERVICE_NAME} -n 50"
    fi
    echo "  常见原因: .env 未填 API Key / 端口被占用"
    exit 1
fi
echo ""