# 部署记录 — 灵犀引擎 v2.0.12（2026-08-25）

## 一、产物清单（SHA256）

| 产物 | 大小 | SHA256 |
|---|---|---|
| lingxi-engine-2.0.12-20260824-203851.tar.gz | 833,992 B (0.80 MB) | `820f6472f4004ed1010844890d5b224a7a7758a7eaa0cac95f04c63863fceb31` |
| lingxi-python-engine-2.0.12-20260824-203851.tar.gz | 60,403 B (0.06 MB) | `2760b8880a8ba998277f85305753ef0ee7ca8dbb6b17a378a2b59f21d1e85785` |

## 二、上传位置（已校验一致）

- **目标服务器**：`47.93.157.83`（阿里云，root@，密钥 `~/.ssh/lingxi_deploy`）
- **远程目录**：`/opt/lingxi-release/`
  - `/opt/lingxi-release/lingxi-engine-2.0.12-20260824-203851.tar.gz`
  - `/opt/lingxi-release/lingxi-python-engine-2.0.12-20260824-203851.tar.gz`
- **校验方式**：远程 `sha256sum` 与本地 `Get-FileHash` 逐一比对，**完全一致**；文件字节数一致。
- **本地源位置**：`C:\Users\Administrator\lingxi-engine\` 同名单文件

## 三、包内完整性验证

- 解压后 `web/js/app.js` = 260,659 B（与源一致）
- 新功能代码在位：`_agentNameLine()`（名字+模型徽章）、`availMemberCb`（多选勾选）、`batchAddMembers()`（批量添加）
- `web/index.html` 引用 `js/app.js?v=20260825c`（最新缓存版本号）
- 包内无 node_modules / .env / data（main.db）泄漏

## 四、服务器部署步骤

```bash
# 1. 进入发布目录
cd /opt/lingxi-release
# 2. 备份现有部署（可选）
cp -r /opt/lingxi-engine /opt/lingxi-engine-bak-$(date +%Y%m%d%H%M)
# 3. 解压主引擎到新目录
mkdir -p /opt/lingxi-engine-v2.0.12 && tar -xzf lingxi-engine-2.0.12-20260824-203851.tar.gz -C /opt/lingxi-engine-v2.0.12
# 4. 迁移配置与数据（保留旧 .env 和 data）
cp /opt/lingxi-engine/.env /opt/lingxi-engine-v2.0.12/.env
cp -r /opt/lingxi-engine/data /opt/lingxi-engine-v2.0.12/data
# 5. 安装依赖
cd /opt/lingxi-engine-v2.0.12 && npm install
# 6. 切换并重启
pm2 delete lingxi 2>/dev/null; pm2 start "npx tsx index.ts" --name lingxi --cwd /opt/lingxi-engine-v2.0.12 && pm2 save
# 7. 验证
curl -s http://127.0.0.1:3456/api/agents | head -c 200
```

## 五、本地部署步骤（Windows/内网机器）

```powershell
# 1. 解压
tar -xzf lingxi-engine-2.0.12-20260824-203851.tar.gz -C C:\lingxi-deploy
# 2. 装依赖
cd C:\lingxi-deploy && npm install
# 3. 配置
Copy-Item .env.example .env   # 填入模型 API Key
# 4. 启动（默认 3456，被占用自动顺延）
npm start
```

## 六、本版本修复/新增内容

1. **多选勾选添加成员**：建群后自动弹多选面板（checkbox + 全选/清空 + 批量添加），彻底移除手输序号
2. **消息显示命名+模型**：所有 AI 消息气泡显示「🤖 名字 + 模型徽章」（主聊天 + LAN 群 + 流式打字）
3. 改名端到端测试通过；chat_mode 接口确认（GET/POST /api/chats/:id/mode）
4. 前端缓存版本号 bump 至 `v20260825c`

## 七、服务器部署执行记录（2026-08-25 04:40 UTC+8 完成）

- **部署目录**：`/opt/lingxi-engine-v2.0.12`（新实例，PM2 name=lingxi, id=8, status=online）
- **切换动作**：旧实例 `pm2 delete lingxi` → 新目录 `pm2 start 'npx tsx index.ts' --name lingxi` → `pm2 save` 持久化
- **备份**：
  - `/opt/lingxi-engine-bak-20260825044031.tar.gz`（旧代码，排除 node_modules/data）
  - `/opt/lingxi-engine-data-bak-20260825044031.tar.gz`（旧数据）
- **配置迁移**：`.env` 从旧部署复制；`data/` 目录整体迁移（2.5M）
- **依赖**：npm install 完成（177 packages，5s）
- **线上验证（全部通过）**：
  - `GET /` → HTTP 200（95,247 bytes）
  - `GET /api/agents` → `{"ok":true,"agents":[...]}` 智能体数据正常
  - `GET /js/app.js?v=20260825c` → `_agentNameLine` 命中 5 处（新功能在位）
  - index.html 引用 `js/app.js?v=20260825c`
  - 端口 3456 由新实例（pid 1005690）监听
- **回滚方式**：
  ```bash
  pm2 delete lingxi
  cd /opt/lingxi-engine && pm2 start "npx tsx index.ts" --name lingxi
  # 如需恢复旧代码：tar -xzf /opt/lingxi-engine-bak-20260825044031.tar.gz -C /opt/
  ```
