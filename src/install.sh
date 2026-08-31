#!/bin/bash
set -e

echo ""
echo "  鈺斺晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晽"
echo "  鈺?    馃惪锔? 鐏电妧寮曟搸 瀹夎绋嬪簭           鈺?
echo "  鈺氣晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨暆"
echo ""

# 妫€鏌?Node.js
if ! command -v node &>/dev/null; then
    echo "  鉂?鏈娴嬪埌 Node.js"
    echo "  瀹夎鏂规硶:"
    echo "    Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install nodejs -y"
    echo "    CentOS/RHEL:   curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install nodejs -y"
    echo "    macOS:         brew install node"
    exit 1
fi
echo "  鉁?Node.js $(node -v)"

# 瀹夎鐩綍
INSTALL_DIR="${HOME}/lingxi-engine"
if [ -d "$INSTALL_DIR" ]; then
    echo "  鈿狅笍  鐩綍宸插瓨鍦? $INSTALL_DIR"
    read -p "  鏄惁瑕嗙洊瀹夎? (y/n): " OVERWRITE
    [ "$OVERWRITE" != "y" ] && exit 0
    rm -rf "$INSTALL_DIR"
fi

# 涓嬭浇锛堝缁堟寚鍚戞渶鏂扮増绗﹀彿閾炬帴锛?echo "  馃摝 姝ｅ湪涓嬭浇鐏电妧寮曟搸锛堟渶鏂扮増锛?.."
curl -fsSL -o /tmp/lingxi-engine.tar.gz \
    "${LINGXI_BASE_URL:-http://localhost:8080}/public/lingxi-engine.tar.gz"

# 瑙ｅ帇
echo "  馃搨 姝ｅ湪瑙ｅ帇..."
tar -xzf /tmp/lingxi-engine.tar.gz -C "$HOME/"
rm /tmp/lingxi-engine.tar.gz

# 瀹夎渚濊禆
cd "$INSTALL_DIR"
echo "  馃摜 瀹夎渚濊禆锛堥渶瑕佸嚑鍒嗛挓锛?.."
npm install --silent
npm install puppeteer --silent 2>/dev/null || echo "  鈿狅笍  puppeteer 瀹夎澶辫触锛堟祻瑙堝櫒宸ュ叿涓嶅彲鐢紝涓嶅奖鍝嶆牳蹇冨姛鑳斤級"

# 鍒涘缓 .env
if [ ! -f .env ]; then
    cat > .env << 'ENVEOF'
# 鐏电妧寮曟搸閰嶇疆鏂囦欢
# 鑷冲皯閰嶇疆涓€涓?API Key
OPENAI_API_KEY=sk-your-key-here
# DEEPSEEK_API_KEY=sk-your-key-here
# ANTHROPIC_API_KEY=sk-your-key-here
PORT=3456
ENVEOF
fi

echo ""
echo "  鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
echo "    鉁?瀹夎瀹屾垚锛?
echo ""
echo "    寮曟搸鐩綍: $INSTALL_DIR"
echo "    鍚姩鍛戒护: cd lingxi-engine && npx tsx index.ts"
echo "    娴忚鍣ㄦ墦寮€: http://localhost:3456"
echo ""
echo "    鈿狅笍  閲嶈锛氱紪杈?$INSTALL_DIR/.env 濉叆浣犵殑 API Key"
echo "  鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺?
echo ""

read -p "  鏄惁鐜板湪鍚姩? (y/n): " STARTUP
if [ "$STARTUP" = "y" ]; then
    echo "  馃殌 鍚姩涓?.."
    npx tsx index.ts
fi
