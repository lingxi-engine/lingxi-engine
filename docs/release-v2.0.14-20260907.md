# v2.0.14 发布收尾记录（2026-09-07 19:07）

## 一条龙执行结果

| 环节 | 状态 | 证据 |
|---|---|---|
| Git 提交 | ✅ 6 commits | 60d0be6 → 551db86，工作树干净 |
| GitHub 推送 | ✅ | `main -> main` 同步到 551db86 |
| F盘备份 | ✅ | `F:\lingxi-engine-v2.0.14-20260907-1930.tar.gz` (1,153,476 B) |
| 打包 | ✅ | pack-release.ps1 12 项校验全过 |
| 官网上传 | ✅ | 外网 200，MD5 b997ab559a55d1b4c767c05a8cd628ac 双端一致 |
| 官网页面更新 | ✅ | download.html / sw.js(v15) / CHANGELOG.md / version.txt 全部 2.0.14 |

## 打包校验拦下的"失窃"安全修复（全部从 git 历史捞回）

1. `de3c714` index.ts — MESH_TOKEN_WEAK 弱值检测（e949751 原版恢复）
2. `46008bf` src/platform-server.ts — 同款守卫（fb913cd 原版恢复）
3. `551db86` src/mobile/index.ts — verify-email 路由 + admin invite-codes 端点（fb913cd 原版恢复，timingSafeEqual 鉴权 + getDB() 修正）

## 官网最终状态（外网实测）

- 下载页: http://47.93.157.83:8080/download.html → v2.0.14
- 直链: /public/lingxi-engine-v2.0.14.tar.gz（200，1,153,476 B）
- 通用名: /public/lingxi-engine.tar.gz → 同一文件（install.ps1 引用的就是这个）
- sw.js: CACHE_NAME 'lingxi-v15' 强制 PWA 刷新
- CHANGELOG.md: v2.0.14 条目置顶
- version.txt: 2.0.14 + built 时间戳

## 遗留事项（知情，未处理）

1. OSS 镜像仓库（D:\lingxi-engine-oss）与主仓库是不相干历史线，合并需单独任务处理 54 冲突
2. GitHub dependabot 报 6 个依赖漏洞（2 high 3 moderate 1 low），待评估
3. 本地引擎未重启——子代理修复、雇佣修复、3 处安全守卫均需重启加载新代码后才生效

## 重新部署验收清单

1. `GET /api/health` → version 字段应为 2.0.14
2. AI 雇佣闭环 → 扣款 + 雇佣成功 + my-hires 可查
3. 右侧面板失败任务 → 10 分钟内自动消失
4. 复杂任务 → 日志出现 delegate_task 调用
5. 生产模式（DEV_MODE=false）→ MESH_TOKEN 弱值时拒绝启动（新守卫）