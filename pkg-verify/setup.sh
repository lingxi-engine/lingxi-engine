#!/usr/bin/env bash
set -e

echo ""
echo "═══════════════════════════════════════"
echo "  灵犀引擎 一键安装"
echo "═══════════════════════════════════════"
echo ""

# ── 检查 Node.js ──
if ! command -v node &> /dev/null; then
  echo "[X] 未检测到 Node.js，请先安装 Node.js 18+"
  echo "    下载地址：https://nodejs.org"
  exit 1
fi
echo "[✓] Node.js $(node -v)"

if ! command -v npm &> /dev/null; then
  echo "[X] 未检测到 npm"
  exit 1
fi
echo "[✓] npm $(npm -v)"

echo ""
echo "── 安装依赖 ──"
npm install
echo "[✓] 依赖安装完成"

# ── 创建 .env ──
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "[✓] 已从 .env.example 创建 .env"
    echo "    请编辑 .env 填写你的 API Key"
    echo ""
    echo "    至少需要配置一个 AI Provider："
    echo "      - NVIDIA_API_KEY（推荐，免费申请：https://build.nvidia.com）"
    echo "      - 或 OPENAI_API_KEY"
    echo "      - 或本地运行 Ollama"
  else
    echo "[!] 未找到 .env.example，请手动创建 .env"
  fi
else
  echo "[✓] .env 已存在"
fi

# ── 创建数据目录 ──
mkdir -p data uploads
echo "[✓] 数据目录已创建"

echo ""
echo "═══════════════════════════════════════"
echo "  安装完成！"
echo "═══════════════════════════════════════"
echo ""
echo "  启动：npm start"
echo "  开发：npm run dev"
echo "  访问：http://localhost:3456"
echo ""
echo "  首次使用请编辑 .env 配置 API Key"
echo ""