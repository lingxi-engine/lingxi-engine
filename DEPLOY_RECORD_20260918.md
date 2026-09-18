# Lingxi Engine 部署记录 — 2026-09-18（四地同步核查：git / GitHub / F盘 / 官网打包）

## 结论速览

| 渠道 | 目标版本 | 执行前 | 执行后 |
|---|---|---|---|
| 本地 git (main) | 17748bf | 1b915e1 + 22 个未跟踪文件 | ✅ 干净，与 origin 同步 |
| GitHub origin/main | 17748bf | 1b915e1 | ✅ push 成功，CI run 35308010624 **success**（3 job 全绿） |
| dwork (D:\lingxi-engine-oss) | 17748bf | 3980b45（落后 101 提交） | ✅ fast-forward 同步，0/0 |
| F 盘 bundle | 全分支+tags | 最新 bundle 停在 09-14 (7ba39fb) | ✅ 新增 `lingxi-engine-git-20260918-final-17748bf.bundle`（verify okay, complete history） |
| F 盘发布包 | v2.0.20 | F 盘最新 tar 停在 v2.0.18 | ✅ 新增 `lingxi-engine-v2.0.20-20260918-fixed.tar.gz`（MD5 048f51…） |
| 官网下载包 | v2.0.20 | 🔴 09-15 上传的 v2.0.20 包内 package.json 带 BOM（EF BB BF），装完 tsx 即炸 | ✅ 重新打包上传，BOM 清除，MD5 三处一致（public 具名 + 通用名 + F 盘） |

## 一、发现并修复的关键问题

1. **官网 v2.0.20 tarball 被 BOM 污染**：09-15 发布时仓库 package.json 尚带 UTF-8 BOM（09-17 CI 才修），导致线上"最新版"下载包解压后 `Error parsing package.json`。已用修复后的 main（17748bf 树）重打 → pack v6.8 全断言通过（1 WARN 为 pay-route 自动探测的已知局限，人工核对通过）→ 上传替换。
   - 旧包备份：`/var/www/lingxi/public/*.bak-20260918-bom-poisoned`
   - 新包 MD5 `048f5143c7a874a71a04e9fa1e620f2d`，线上解压首字节 `7b 0a`（干净 `{`），hub.ts 含 failover 13 处命中
2. **install.sh 横幅版本 2.0.17 → 2.0.20**（仅显示用途，TARBALL_URL 走通用名不受影响；bash -n 语法通过；旧文件备份 .bak-20260918-v2017-banner）
3. **public/version.txt 2.0.17 → 2.0.20**（无代码读取，纯元数据；已备份）

## 二、git 整理

- 提交 `17748bf`：跟踪 CI 修复报告 + 15 个诊断技能 JSON；.gitignore 增加本地杂物（fo_main.txt / tsc_main.txt / query_db.* / patch_backend.cjs / boot 测试数据目录等）
- 推送 origin/main（1b915e1..17748bf）与 dwork main（3980b45..17748bf）
- 敏感扫描：新增技能文件无 IP/token/secret 命中；.env 未被跟踪

## 三、遗留说明（有意不动）

- **线上引擎进程仍是 2.0.17**（/opt/lingxi-engine，PM2 lingxi，uptime 6.2 天）——引擎进程升级 = 服务重启，属独立变更，未在本次"备份+官网包"范围内
- **master 分支**（9f6fbfc）与 main 分叉 137/211，历史线保留不动，已入 bundle
- `_creditfix/` 未跟踪目录为 09-14 历史补丁暂存，保留原样

## 四、验证快照（2026-09-18）

- CI run 35308010624 @ 17748bf: success（TS type check / hygiene+BOM gate / Python regression 全绿）
- 官网 download.html 全部指向 v2.0.20，APK v1.0.1 在位
- F 盘 bundle verify: 4 refs（main/master + 2 tags），complete history, okay
