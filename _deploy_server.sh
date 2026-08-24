#!/bin/bash
# 灵犀引擎 v2.0.12 服务器部署脚本（阿里云 47.93.157.83）
set -e

STAMP=$(date +%Y%m%d%H%M%S)
echo "=== [1/7] 备份现有部署 ==="
if [ -d /opt/lingxi-engine ]; then
  tar -czf /opt/lingxi-engine-bak-${STAMP}.tar.gz --exclude=node_modules --exclude=data -C /opt lingxi-engine 2>/dev/null
  echo "tar备份完成: /opt/lingxi-engine-bak-${STAMP}.tar.gz"
  # 单独备份数据目录
  if [ -d /opt/lingxi-engine/data ]; then
    tar -czf /opt/lingxi-engine-data-bak-${STAMP}.tar.gz -C /opt/lingxi-engine data 2>/dev/null
    echo "数据备份: /opt/lingxi-engine-data-bak-${STAMP}.tar.gz"
  fi
fi

echo "=== [2/7] 解压新包到 /opt/lingxi-engine-v2.0.12 ==="
rm -rf /opt/lingxi-engine-v2.0.12
mkdir -p /opt/lingxi-engine-v2.0.12
tar -xzf /opt/lingxi-release/lingxi-engine-2.0.12-20260824-203851.tar.gz -C /opt/lingxi-engine-v2.0.12
echo "解压完成，文件数: $(ls /opt/lingxi-engine-v2.0.12 | wc -l)"

echo "=== [3/7] 迁移 .env 配置 ==="
if [ -f /opt/lingxi-engine/.env ]; then
  cp /opt/lingxi-engine/.env /opt/lingxi-engine-v2.0.12/.env
  echo ".env 已迁移"
else
  cp /opt/lingxi-engine-v2.0.12/.env.example /opt/lingxi-engine-v2.0.12/.env
  echo ".env 从 example 创建（原部署无 .env）"
fi

echo "=== [4/7] 迁移数据目录 ==="
if [ -d /opt/lingxi-engine/data ]; then
  cp -r /opt/lingxi-engine/data /opt/lingxi-engine-v2.0.12/data
  echo "data 已迁移: $(du -sh /opt/lingxi-engine-v2.0.12/data | cut -f1)"
else
  mkdir -p /opt/lingxi-engine-v2.0.12/data
  echo "新建空 data 目录"
fi

echo "=== [5/7] 安装依赖 ==="
cd /opt/lingxi-engine-v2.0.12
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund 2>&1 | tail -3
fi
echo "依赖就绪: $(ls node_modules | wc -l) 个包"

echo "=== [6/7] 验证新代码文件 ==="
grep -c "_agentNameLine" /opt/lingxi-engine-v2.0.12/web/js/app.js && echo "app.js 新功能在位"
grep "app.js?v=" /opt/lingxi-engine-v2.0.12/web/index.html

echo "=== [7/7] 完成 ==="
echo "新部署目录: /opt/lingxi-engine-v2.0.12"
echo "备份: /opt/lingxi-engine-bak-${STAMP}.tar.gz (+data备份)"
echo "DEPLOY_STAMP=${STAMP}"
