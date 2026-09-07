# Lingxi Engine 部署记录 — 2026-09-08

## 版本
- **v2.0.14**（package.json = version.txt = 2.0.14，零漂移）
- HEAD: `01eee45` feat(admin): user management - ban/unban/delete + dashboard with user list

## 本次变更
### 用户管理功能（管理后台）
1. **db.ts**: 新增 `deleteUser()` 函数，11 步级联删除（积分交易→好友双向→市场挂单→市场订单→LAN 成员→LAN 群组→私聊+消息→AI 智能体→工作流→会话→用户本体）
2. **admin.ts**: 新增 5 条路由
   - `GET /dashboard` — 管理面板（用户列表+统计）
   - `GET /usage` — 用量统计
   - `POST /users/:id/ban` — 封禁用户（同时清除会话）
   - `POST /users/:id/unban` — 解封用户
   - `DELETE /users/:id` — 级联删除用户（需 `confirm:true`）
3. **admin.html**: 用户表新增「操作」列（封禁/解封/删除按钮），新增「已封禁」红色徽章，删除二次确认

### 代码质量
- `tsc --noEmit`: 零报错
- `npx tsc`（编译）: 零报错
- 临时补丁文件已清理

## 打包产物 SHA256
```
7A5C66F77B15BE444CAFD4DA3AE026612CFB19269902CC4879E470E5C7E6D86D
```

| 位置 | 状态 |
|---|---|
| 本地 %TEMP% | ✅ 一致 |
| 服务器 /var/www/lingxi/releases/lingxi-engine-v2.0.14.tar.gz | ✅ 一致 |
| 官网下载入口 /var/www/lingxi/public/lingxi-engine.tar.gz | ✅ 一致 |

## F 盘备份
| 文件 | 大小 |
|---|---|
| lingxi-engine-20260908.bundle | 260 MB（完整 git 历史） |
| src-20260908/ | 源码目录快照 |

## Git
- 提交: `01eee45` → 已推送到 GitHub (main)
- GitHub: https://github.com/lingxi-engine/lingxi-engine

## 部署后操作指引
1. 重新部署新包后重启引擎
2. 测试管理后台用户管理功能（封禁/解封/删除）
3. 测试 AI 雇佣闭环
4. 测试局域网访问