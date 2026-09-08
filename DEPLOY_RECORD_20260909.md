# Lingxi Engine 部署记录 — 2026-09-09

## 版本
- **v2.0.15**（package.json = version.txt = download.html = 2.0.15，零漂移）
- HEAD: `6ea5879` fix(platform): load .env.platform for platform-server config
- 前序: `eff2bcb` feat(platform): v2.0.15 platform admin backend — 7 admin APIs + platform-admin.html

## 本次变更
### 平台管理后台（云端统一后台）
1. **platform-server.ts**: 7 条管理 API + fail-secure 鉴权 + 静态托管
   - `GET /api/admin/users` — 用户列表 + 全局统计（总用户/总积分/总订单/在线实例）
   - `POST /api/admin/credits/grant` — 发/扣积分
   - `GET /api/admin/orders` — 账单流水
   - `POST /api/admin/users/:id/ban` / `unban` — 封禁/解封
   - `DELETE /api/admin/users/:id` — 级联删除（需 `confirm:true`）
   - `GET /api/admin/instances` — 在线实例列表
   - `GET /admin.html` — 管理页面静态托管
2. **platform-admin.html**: 深色风格管理页（登录框 + 统计卡片 + 用户/账单/实例三个 Tab）
3. **鉴权**: `PLATFORM_ADMIN_TOKEN`（fail-secure：不配则 503 锁死）

### 部署期修复（重要）
- **EADDRINUSE 事故**: platform-server 曾用 `import 'dotenv/config'` 全量加载主引擎 `.env`，误吞 `PORT=3456` 与主引擎端口打架，崩溃循环（PM2 重启计数飙到 81）
- **修复**: 改为 `dotenvConfig({ path: '.env.platform' })`，平台配置独立文件，与主引擎 .env 彻底隔离
- **服务器配置迁移**: `PLATFORM_ADMIN_TOKEN` 从 `.env` 移入 `/opt/lingxi-engine/.env.platform`（chmod 600）

## 部署位置
| 项目 | 状态 |
|---|---|
| 服务器 `/opt/lingxi-engine/src/platform-server.ts` | ✅ 已更新（含 dotenv 修复） |
| 服务器 `/opt/lingxi-engine/src/web/platform-admin.html` | ✅ 已部署 |
| 服务器 `/opt/lingxi-engine/web/platform-admin.html` | ✅ 已部署 |
| PM2 `lingxi-mesh`（端口 3001） | ✅ 已重启，端口正常监听 |
| 官网 `/var/www/lingxi/public/lingxi-engine-v2.0.15.tar.gz` | ✅ 已上传 |
| 官网通用入口 `/var/www/lingxi/public/lingxi-engine.tar.gz` | ✅ 已更新 |
| 官网 download.html | ✅ 5 处版本号 → 2.0.15，旧版本号清零 |
| 服务器 version.txt | ✅ 2.0.13 → 2.0.15 |

## 冒烟测试（服务器实测，7/7 全绿）
```
1. 无 token 访问管理接口    → 401 ✅
2. 错 token 访问管理接口    → 401 ✅
3. 正确 token 用户列表      → 200 {"ok":true,"users":[],"stats":{...}} ✅
4. 账单流水                → 200 ✅
5. 实例列表                → 200 ✅
6. 管理页 localhost:3001   → 200 ✅
7. 管理页经 8080 站点代理   → 200 ✅
```

## 打包产物 SHA256
```
e81be9f69a13ef5bb28add2051176b17ec81538c295ae71ec34767c92aa9f502
```

| 位置 | 状态 |
|---|---|
| 本地 %TEMP% | ✅ 一致 |
| 服务器 /var/www/lingxi/releases/lingxi-engine-v2.0.15.tar.gz | ✅ 一致 |
| 官网下载入口 /var/www/lingxi/public/lingxi-engine.tar.gz | ✅ 一致 |

## 管理后台入口
- 地址: `http://47.93.157.83:8080/admin.html`（或 `https://域名/admin.html`）
- 登录: `PLATFORM_ADMIN_TOKEN`（存于服务器 `/opt/lingxi-engine/.env.platform`，64 位随机 hex）

## Git
- 提交: `6ea5879` → 已推送到 GitHub (main)
- GitHub: https://github.com/lingxi-engine/lingxi-engine

## 部署后操作指引
1. 浏览器打开 `/admin.html`，用 token 登录，检查三个 Tab（用户/账单/实例）
2. 有用户注册后，测试发积分/封禁/解封/删除闭环
3. GitHub Dependabot 报了 2 个 high 级依赖漏洞，抽空处理