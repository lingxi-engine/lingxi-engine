# Lingxi Engine 部署记录 — 2026-09-07

## 版本
- **v2.0.14**（package.json = version.txt = 2.0.14，零漂移）

## 本次提交内容（60d0be6）
1. 子代理系统修复：失败/超时任务保留期 24h→10min，清理间隔 1h→5min
2. general-assistant 技能白名单加入 delegate_task/request_agent_help/collab_task
3. index.ts 接线 setSubAgentManager()，工具调用真正落到管理器
4. 修复 2 个历史测试失败（超时兜底 + ai_errors 错误分类）
5. 新增 vitest 基建：vitest.config.ts + src/tests/（28 用例全绿）
6. 恢复被误删的 scripts/pack-release.ps1（v6.4，版本号更新至 2.0.14）
7. 收录 8 个新技能文件
8. .gitignore 补齐 backup-*/release//release-v2//src/index.ts 排除规则

## 打包产物
| 产物 | 位置 | SHA256 |
|---|---|---|
| tar.gz | 本地 %TEMP% | 8E8D87D59B96F6F46A53A254E5817B0654CE28E18E14612C637D2A9E45BB5F6A |
| tar.gz | 服务器 /var/www/lingxi/releases/lingxi-engine-v2.0.14.tar.gz | 8E8D87D5...BB5F6A（一致 ✅） |
| tar.gz | 官网下载入口 /var/www/lingxi/public/lingxi-engine.tar.gz | 8E8D87D5...BB5F6A（一致 ✅） |
| git bundle | F:\lingxi-engine-git-v15.bundle | 1,171,937 bytes |
| tar.gz 备份 | F:\lingxi-engine-v2.0.14-20260907-final.tar.gz | 1,150,905 bytes（SHA 一致 ✅） |

## 服务器操作
- 上传至 /var/www/lingxi/releases/（版本化归档）
- 官网下载入口 public/lingxi-engine.tar.gz 已替换为新包（旧包备份为 .bak-20260907）
- HTTP 验证：http://47.93.157.83:8080/public/lingxi-engine.tar.gz → 200 OK, application/gzip
- install.ps1 默认下载地址无需改动

## 验证结果
- tsc --noEmit：主源码零报错（release/ 垃圾目录残留报错已通过 .gitignore+清理解决）
- vitest：28/28 全绿（registry 13 + executor-tool 15）
- 打包结构验证：顶层 lingxi-engine/ ✅、无 .env 泄漏 ✅、关键文件齐全 ✅
- 本地/服务器/F盘三方 SHA256 完全一致

## 未完成项（如实记录）
- dwork 远程（D:\lingxi-engine-oss）为无关历史的独立仓库（64 commits，旧 OSS 布局），本次未同步。若需同步需人工评估合并策略。

## 下一步
用户将重新部署并测试：注册登录、AI 雇佣（修复后需重启引擎加载新代码）、局域网访问（防火墙放行 3456/3457 待执行）