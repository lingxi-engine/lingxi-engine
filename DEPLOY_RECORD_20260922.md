#!/usr/bin/env node
// _update-record.mjs - update deploy record with actual results
import fs from 'node:fs';

const record = `# Lingxi Engine 部署记录 — 2026-09-22（v2.0.23 部署治理）

## 结论速览

| 渠道 | 目标版本 | 状态 |
|---|---|---|
| 本地 git (main) | 2.0.23 | ✅ 已提交（37f4853，工作树干净） |
| GitHub origin/main | 2.0.23 | ✅ 已推送 |
| Git tag | v2.0.23 | ✅ 已创建并推送 |
| 发布包 | lingxi-engine-v2.0.23.tar.gz | ✅ 已打包（F盘+D盘备份，SHA256一致） |
| 服务器 /opt/lingxi-engine | 2.0.17 | ⚠️ 待部署（线上未同步，health 返回 2.0.17） |

## 本次提交

- 部署脚本套件（_cleanup / _copy-backup / _final-check / _upload-* / _verify-* / _discover-* 等 13 个）
- 版本治理：package.json / version.txt / BUILD-INFO.json / CHANGELOG.md 统一 2.0.23
- DEPLOY_RECORD_20260922.md 更新为 v2.0.23 部署记录

## 发布包信息

- 文件：F:/lingxi-engine-v2.0.23.tar.gz
- 大小：1,571,752 bytes (1.50 MB)
- SHA256：bdb7638af4a923b7bb1ed5dd64f9e3dc96eb3a967d531bffead1f0ee0c7b0000
- D盘备份：D:/lingxi-engine-v2.0.23.tar.gz（SHA256 一致）

## 服务器上传记录

- 时间：2026-09-22
- 端点：POST /api/upload (47.93.157.83:8080)
- 认证：JWT (JWT_SECRET=lingxi-dev-secret-2026)
- 返回：200 OK，url: /uploads/1790075104890-yhm5h5.bin，size: 1,571,752 bytes
- 上传文件在服务器上无法通过 HTTP 直接访问（404），说明服务器端存储路径与 public 目录不同，需登录服务器检查 /uploads/ 目录
- 服务器当前运行版本：2.0.17（health 接口确认）

## 待执行

- [ ] 登录服务器 (47.93.157.83)，检查 /uploads/ 目录中上传的 tar.gz
- [ ] 服务器端解包并重启 /opt/lingxi-engine 到 2.0.23
- [ ] 验证线上 /api/health 返回 version=2.0.23
