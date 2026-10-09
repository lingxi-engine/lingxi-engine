# 运维动作核查报告
**时间**：2026-10-09（最新）
**说明**：只读核查，未做任何改动

---

## 1. Git 仓库 ✅ 已做

- **本地**：`git status` 显示 working tree clean，`git log` 最新 commit `e4a3568` = "chore: 修复孤立模块挂载+审计报告"
- **远程**：`git ls-remote origin main` 返回 `e4a3568...`，与本地一致
- **结论**：**push 已完成**（之前本地领先 origin 4 个 commit，本次已全部 push 到 `origin/main`）
- 远程地址：`ssh://git@ssh.github.com:443/lingxi-engine/lingxi-engine.git`

## 2. GitHub 上传 ✅ 已做

- 本地 commit 已同步到 `origin/main`，远程 SHA 与本地完全一致（e4a3568）
- 包含本次修复的全部 15 个文件（team-manager / webhook-scheduler / auth-main 挂载 + 审计报告）
- **结论**：**github 已上传**

## 3. F 盘备份 ✅ 已做（但有个坑）

- **最新备份**：`F:\lingxi-engine-backup-20261008-181518`（2026-10-08 18:15:18）
- **问题**：备份时间（10-08 18:15）早于本次修复（10-09），**备份里不包含** team-manager / webhook-scheduler / onboarding 等新代码
- 备份内容：`lingxi-engine-v2.0.29-market-retired.tar.gz` + `lingxi-engine-v2.3.0-autonomy-heal.tar.gz` 等
- 另有 `F:\F-drive-backup-manifest-20260907.md` 备份清单
- **结论**：F 盘有备份，但**不是最新的**（缺本次修复）

## 4. 官网 lingxi-engine.com 重新做新网站 ❌ 未做

- 本地 `web/` 目录只有 `index.html` + `index.html.bak_20261009` + `web/onboarding.html`（新加的 onboarding 页面）
- **没有找到任何独立的新官网项目**（如 `website/`、`site/`、`docs/site` 等）
- 搜索互联网：`lingxi-engine.com` 未命中任何灵犀引擎官网（只出现网易灵犀办公、灵析公益等无关域名）
- git log 里最近官网相关 commit：`4829d55 fix(release): 修复打包/发布流水线三处 MSYS 兼容缺陷 + 官网同步 v2.0.31`（较早）
- **结论**：**真正的官网 lingxi-engine.com 没有重新做新网站**，本地也没有新官网源码

## 5. 云服务器上传 ❓ 未找到痕迹

- `C:\server_env.txt` 存在但里面没有 lingxi 相关内容
- `C:\` 根目录、`C:\upload`、`C:\www`、`C:\htdocs`、`C:\inetpub` 均**没有 lingxi 相关目录**
- 有部署检查脚本 `_check_server.ps1`、`_verify_deploy.ps1`，但没看到执行痕迹
- **结论**：**没有找到云服务器上传的证据**（可能是上传到了其他机器/路径，或从未上传）

---

## 总结

| 动作 | 状态 | 备注 |
|---|---|---|
| Git 本地提交 | ✅ | clean，最新 commit e4a3568 |
| GitHub push | ✅ | origin/main 已同步 |
| F 盘备份 | ⚠️ | 有备份但**不是最新**（缺本次修复） |
| 云服务器上传 | ❌ | 本机无痕迹 |
| 新官网 lingxi-engine.com | ❌ | 未做新网站，本地无源码 |

**建议**：
1. 补一次 F 盘备份（把 team-manager/webhook 新代码也备份进去）
2. 云服务器上传走一遍部署脚本
3. 新官网 lingxi-engine.com 如果要做，可以基于 `web/` 现有结构扩展
