#!/bin/bash
# 灵犀引擎 v2.0.12-204404 远程部署脚本（在服务器执行）
set -e

STAMP=$(date +%Y%m%d%H%M%S)
NEW_VER="v2.0.12-204404"
PKG="/opt/lingxi-release/lingxi-engine-2.0.12-20260824-204404.tar.gz"
OLD_DIR="/opt/lingxi-engine"
NEW_DIR="/opt/lingxi-engine-${NEW_VER}"

echo "== [1/6] 备份现有部署 =="
if [ -d "$OLD_DIR" ]; then
  tar -czf "/opt/lingxi-engine-bak-${STAMP}.tar.gz" --exclude=node_modules --exclude=data -C /opt lingxi-engine
  echo "代码备份: /opt/lingxi-engine-bak-${STAMP}.tar.gz"
fi
if [ -d "$OLD_DIR/data" ]; then
  tar -czf "/opt/lingxi-engine-data-bak-${STAMP}.tar.gz" -C "$OLD_DIR" data
  echo "数据备份: /opt/lingxi-engine-data-bak-${STAMP}.tar.gz"
fi

echo "== [2/6] 解压新包 =="
mkdir -p "$NEW_DIR"
tar -xzf "$PKG" -C "$NEW_DIR"
echo "解压到: $NEW_DIR"

echo "== [3/6] 迁移配置与数据 =="
if [ -f "$OLD_DIR/.env" ]; then cp "$OLD_DIR/.env" "$NEW_DIR/.env" && echo ".env 已迁移"; fi
if [ -d "$OLD_DIR/data" ]; then cp -r "$OLD_DIR/data" "$NEW_DIR/data" && echo "data 已迁移 ($(du -sh $NEW_DIR/data | cut -f1))"; fi

echo "== [4/6] 安装依赖 =="
cd "$NEW_DIR"
npm install --production 2>&1 | tail -2

echo "== [5/6] 切换 PM2 =="
pm2 delete lingxi 2>/dev/null || true
pm2 start "npx tsx index.ts" --name lingxi --cwd "$NEW_DIR"
pm2 save

echo "== [6/6] 验证 =="
sleep 3
pm2 list | grep lingxi
echo "--- HTTP 首页 ---"
curl -s -o /dev/null -w "HTTP %{http_code}, %{size_download} bytes\n" http://127.0.0.1:3456/
echo "--- /api/agents ---"
curl -s http://127.0.0.1:3456/api/agents | head -c 200
echo ""
echo "--- app.js 新功能 ---"
curl -s "http://127.0.0.1:3456/js/app.js?v=20260825c" | grep -c "_agentNameLine"
echo "--- index.html 版本号 ---"
curl -s http://127.0.0.1:3456/ | grep -o "app.js?v=[0-9a-z]*"
echo ""
echo "部署完成 ✅ 新目录: $NEW_DIR"
