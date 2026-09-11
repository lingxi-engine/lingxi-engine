# 部署记录 2026-09-12（安全加固轮）

## 任务来源
用户指令：①服务器引擎升级 2.0.17（本地进程不动）②处理 2 个 Dependabot high ③服务器引擎不对外开放 ④官网修改防止他人使用。

## 一、依赖漏洞清零（Dependabot 2 high）
- GHSA-w3rx-r6r6-pgpr / GHSA-5p2g-fcmc-qvqq：image-size ICNS/JXL/HEIF 解析器无限循环 DoS，经 pptxgenjs 引入
- 实测：image-size ≤2.0.2（含最新 2.0.2）全部中招，**无修复版本**；pptxgenjs/image-size 在代码库零引用（findstr 全库扫描确认）
- 处置：从 package.json 彻底移除（devDependencies/optionalDependencies/overrides），npm install 刷新 lockfile
- 验证：`npm audit` → **0 vulnerabilities**；tsc 0 错误；vitest 28/28
- 提交：`0c6b484`

## 二、平台服务器（3001）全局访问门槛
- 新增中间件（platform-server.ts:272-283）：除 /api/health 外所有请求（含静态文件）必须携带 MESH_TOKEN 或 PLATFORM_ADMIN_TOKEN，否则 403
- 服务器 .env 补固定 MESH_TOKEN/PLATFORM_ADMIN_TOKEN（64 hex，此前每次重启随机生成→外网裸奔）
- .env.platform 同步 MESH_TOKEN（mesh 进程实际加载 .env.platform，dotenvConfig path 指向）
- 提交：`1e70ea7`
- 验证矩阵：
  - 无 token：/api/user/* /api/hire/* /api/friend/* /静态/admin.html → **全 403**（本机+外网双验）
  - 带 token：/api/hire/market → 200（本地引擎市场功能恢复）
  - mesh WS /mesh 握手带 token 验证（不受 Express 中间件影响，upgrade 不走中间件栈）

## 三、服务器引擎升级 2.0.15 → 2.0.17
- tarball 同步（v2.0.17 包 cdf997e2→新版 b927e92f）src/web/index.ts/package.json 等，保留 .env/data/node_modules
- platform-server.ts 单独 scp（tarball 打包早于鉴权补丁提交）
- **事故**：`npm install --omit=dev` 删除了 tsx（devDependency）→ PM2 lingxi 启动失败 ERR_MODULE_NOT_FOUND
- **修复**：`npm install tsx@4.19.0 --save-dev` 装回，重启恢复
- 验证：`/api/health` → `{"ok":true,"version":"2.0.17","agents":14}`；PM2 lingxi/lingxi-mesh/lingxi-site 全 online
- 备份：/opt/lingxi-engine-backups/20260912-prelock/engine-src-2.0.15.tar.gz + .env.bak + src-old-2015/web-old-2015

## 四、官网改造（server.js 重写）
- 引擎 API：仅保留 /api/admin/*（→3001，管理后台 x-admin-token 鉴权），其余 /api/* 一律 403
- /chat /app /platform → 302 → /download.html（网页版引擎入口下线）
- /ws WebSocket 升级 → socket.destroy()（引擎 WS 不再对外）
- /admin → 302 → admin.html（管理后台入口保留）
- official.html：5 处 /chat → /download.html，文案"网页版/在线体验/打开"→"免费下载/获取安装包/下载"，"无需安装·直接使用"→"本地部署·数据自持"
- 提交：`e03b015`（含 site_inner/server.js 副本，workspace/ 被 .gitignore 忽略故仅 official.html 入库）
- 验证：首页 200（6 处下载链接、0 处 /chat）；/chat /app /platform 全 302；/api/health 403；admin API 带 token 200 无 token 403；外网全链路复验通过

## 五、安装包重建发布
- v6.7 打包脚本（BOM 修复版）：新包 1,176,495 B，md5 b927e92fcc506c54a140e70bd845c2df
- 与旧包差异：package.json/lockfile 去除 pptxgenjs/image-size（漏洞清零版）
- 三处同步：releases/ + public/lingxi-engine-v2.0.17.tar.gz + public/lingxi-engine.tar.gz，md5 三处一致
- version.txt 更新（security release 说明）
- 外网下载实测：200，1,176,495 字节，md5 一致

## 六、备份
- F 盘：lingxi-engine-git-20260912-final-e03b015.bundle（260,719,350 B，verify okay，13 refs，main=e03b015）
- 旧 bundle 382268f 保留（F 盘余 6.0 GB）
- 服务器：/var/www/lingxi/server.js.bak-20260912-prelock + official.html.bak-20260912-prelock

## 七、git 状态
- HEAD = e03b015 = origin/main（已推送）
- 提交链：0c6b484（deps）→ 1e70ea7（platform gate）→ e03b015（site lockdown）
- 工作区真实改动仅 web/official.html（已提交）；其余 M 为 CRLF 假象

## 遗留事项
- GitHub Dependabot 面板仍显示 2 high（旧 lockfile 扫描缓存，等重新扫描自动消）
- 服务器 3001 仍监听 *:3001（IPv6 通配）——外网 403 已实测，如需彻底封端口需 firewalld 规则（用户未要求）
- 本地引擎进程（Windows，03:19 启动）全程未动——用户明确要求
- socat 5000→3001 转发仍在（外网 000 防火墙已挡）