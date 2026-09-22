# Lingxi Engine 部署记录 — 2026-09-22（v2.0.23 部署治理）

## 结论速览

| 渠道 | 目标版本 | 状态 |
|---|---|---|
| 本地 git (main) | 2.0.23 | ✅ 已提交（93531a3，工作树干净） |
| GitHub origin/main | 2.0.23 | ✅ 已推送 |
| Git tag | v2.0.23 | ✅ 已创建并推送 |
| 发布包 | lingxi-engine-v2.0.23.tar.gz | ✅ 已打包（F盘+D盘备份） |
| 服务器 /opt/lingxi-engine | 2.0.17 | ⚠️ 待部署（线上未同步） |

## 本次提交

- 部署脚本套件（_do-pack / _copy-backup / _upload-v2 / _verify 等 13 个）
- 版本治理：package.json / version.txt / CHANGELOG.md 统一 2.0.23
- BUILD-INFO.json 更新为 2.0.23

## 发布包信息

- 文件：`F:/lingxi-engine-v2.0.23.tar.gz`
- 大小：1,571,752 bytes (1.50 MB)
- SHA256：`bdb7638af4a923b7bb1ed5dd64f9e3dc96eb3a967d531bffead1f0ee0c7b0000`
- D盘备份：`D:/lingxi-engine-v2.0.23.tar.gz` (1,135,175 bytes — 注意：D盘版本较小，需确认)

## 服务器上传记录

- 时间：2026-09-22
- 端点：POST /api/upload (47.93.157.83:8080)
- 认证：JWT (JWT_SECRET from .env)
- 返回：200 OK，url: /uploads/1790074377735-uuwb4g.bin，size: 1,571,752 bytes
- 服务器当前运行版本：2.0.17（health 接口确认）

## 待执行

- [ ] 服务器端解包并重启 /opt/lingxi-engine 到 2.0.23
- [ ] 验证线上 /api/health 返回 version=2.0.23
- [ ] 确认 D 盘备份完整性（D 盘版本大小与 F 盘不一致）
