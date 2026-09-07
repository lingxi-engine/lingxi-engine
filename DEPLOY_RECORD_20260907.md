# Lingxi Engine 部署记录 — 2026-09-07（最终版）

## 版本
- **v2.0.14**（package.json = version.txt = 2.0.14，零漂移）
- HEAD: `6d4b23f` fix(pack): data-platform 目录加入打包排除（修复发布包混入运行时数据库缺陷）

## 提交链（本次部署包含）
0. `6d4b23f` fix(pack): data-platform 打包排除修复（本轮新增）
0. `3857775` chore(git): 停止跟踪运行时实验数据
1. `60d0be6` feat(subagent): 子代理系统修复 + 测试基建 + 打包脚本恢复 (v2.0.14)
2. `22ee2b8` chore(deploy): v2.0.14 部署记录 + .gitignore 补齐
3. `46008bf` fix(security): platform-server.ts 补回 MESH_TOKEN 弱值守卫
4. `551db86` fix(security): mobile/index.ts 补回 verify-email 路由 + admin invite-code 端点
5. `b668c85` docs: v2.0.14 发布收尾记录
6. `d37b20a` fix(deps+executor): 依赖安全修复 + executor 超时兜底

## 依赖安全修复（npm audit 6→2）
| 包 | 动作 | 结果 |
|---|---|---|
| qs | 6.15.3 → 6.16.0（override） | ✅ 已修复 |
| body-parser | npm audit fix | ✅ 已修复 |
| uuid | → 14.0.2（v4 API 兼容，仅 2 处直接引用） | ✅ 已修复 |
| image-size | → 2.0.2（override） | ⚠️ 上游无修复版（GHSA-w3rx-r6r6-pgpr 影响全部版本），风险接受：仅 PPT 生成场景可触发 DoS，非 RCE |

## 打包产物（最终 SHA256 — v2 含 version.txt 修复）
```
5ADA4D064B2CF4F6063CF6470CC8ACF9771FC4E3E40082EE2DA78B79A77F630F
```
| 位置 | 状态 |
|---|---|
| 本地 %TEMP% | ✅ 一致 |
| 服务器 /var/www/lingxi/releases/lingxi-engine-v2.0.14.tar.gz | ✅ 一致 |
| 官网下载入口 /var/www/lingxi/public/lingxi-engine.tar.gz | ✅ 一致（HTTP 200） |
| F:\lingxi-engine-v2.0.14-20260907-final.tar.gz | ✅ 一致 |
| F:\lingxi-engine-git-v15.bundle（完整 git 历史） | 1,176,846 bytes |

## 垃圾归档
- 13 个 backup_*/release*/src/index.ts 废弃副本 → F:\_archive_20260907\（共约 227MB）
- 根目录 5 个旧 tar.gz 已删除
- tsc 干扰源彻底清除，**tsc --noEmit 真正零报错**

## 防火墙（局域网放行）
- ✅ TCP 3456 入站放行（灵犀引擎）
- ✅ UDP 3457 入站放行（灵犀发现）
- 之前局域网设备无法访问的问题已解决

## 验证结果
- tsc --noEmit：零报错
- vitest：28/28 全绿（registry 13 + executor-tool 15）
- site_inner 同步：6 项差异全部同步完成
- 打包验证：顶层 lingxi-engine/ ✅、无 .env 泄漏 ✅、关键文件齐全 ✅
- CI：3 jobs（Python 回归 152 断言 / TS 类型检查 / 垃圾文件检查）

## 部署后操作指引
1. 服务器部署新包后重启引擎（加载 v2.0.14 全部修复）
2. 重点测试：AI 雇佣闭环（扣钱→雇佣成功→my-hires 可见）
3. 局域网：其他设备访问 http://192.168.1.6:3456（防火墙已放行）
4. 子代理：复杂任务应自动拆分派发，失败任务 10 分钟内自动消失

## 未完成项（如实记录）
- dwork 远程（D:\lingxi-engine-oss）：无关历史独立仓库，未同步，需人工评估
- image-size 上游无修复版，风险接受（仅 PPT 场景 DoS，非 RCE）