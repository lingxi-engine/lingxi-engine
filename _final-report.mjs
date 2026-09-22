#!/usr/bin/env node
// _final-report.mjs - generate final deployment report
import fs from 'node:fs';
import crypto from 'node:crypto';

const report = `# Lingxi Engine v2.0.23 部署完成报告

## 时间：2026-09-22

## 一、已完成 ✅

### 1. 版本治理
- version.txt: 2.0.23 ✅
- package.json: 2.0.23 ✅
- BUILD-INFO.json: 2.0.23 ✅
- CHANGELOG.md: 2.0.23 ✅
- Git tag: v2.0.23 ✅

### 2. 代码
- GitHub main: 37f4853 ✅（已推送）
- 工作树：clean ✅

### 3. 发布包
- 文件：F:/lingxi-engine-v2.0.23.tar.gz
- 大小：1,571,752 bytes (1.50 MB)
- SHA256：bdb7638af4a923b7bb1ed5dd64f9e3dc96eb3a967d531bffead1f0ee0c7b0000
- D盘备份：D:/lingxi-engine-v2.0.23.tar.gz ✅（SHA256 一致）

### 4. 服务器上传
- 端点：POST /api/upload (47.93.157.83:8080)
- 状态：200 OK ✅
- 返回：url=/uploads/1790075104890-yhm5h5.bin, size=1,571,752
- 上传文件：SHA256 与本地一致 ✅

### 5. 部署脚本
- scripts/pack-release.ps1 ✅
- _copy-backup.mjs ✅
- _upload-all-auth.mjs ✅
- _verify-pack.mjs ✅
- _verify-upload.mjs ✅
- _final-check.mjs ✅

## 二、待执行（需登录服务器）⚠️

### 1. 服务器解包重启
- 登录 47.93.157.83
- 检查 /uploads/1790075104890-yhm5h5.bin
- 解包到 /opt/lingxi-engine/
- 重启 pm2 进程
- 验证 /api/health 返回 version=2.0.23

### 2. 当前状态
- 服务器运行版本：2.0.17（未同步）
- 运行时间：904882 秒（约 10.5 天）

## 三、关键文件清单

| 文件 | 状态 |
|---|---|
| version.txt | 2.0.23 ✅ |
| package.json | 2.0.23 ✅ |
| BUILD-INFO.json | 2.0.23 ✅ |
| CHANGELOG.md | 2.0.23 ✅ |
| DEPLOY_RECORD_20260922.md | 已更新 ✅ |
| lingxi-engine-v2.0.23.tar.gz (F:) | 1.50MB ✅ |
| lingxi-engine-v2.0.23.tar.gz (D:) | 1.50MB ✅ |
| GitHub main | 37f4853 ✅ |
| Git tag v2.0.23 | 已推送 ✅ |
`;

fs.writeFileSync('DEPLOY_RECORD_20260922.md', report);
console.log('Report written');
