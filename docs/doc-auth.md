# 模块文档：认证与用户（doc-auth）

> 覆盖：`src/auth/`、`src/middleware/`、`src/routes/auth.ts`、`src/routes/profile.ts`
> 对应代码量：~2,000 行 ｜ 更新：2026-08-29

---

## 1. 模块职责

用户身份全生命周期：注册（邮箱+密码+数字ID）→ 邮箱验证 → 登录（JWT 签发）
→ 请求鉴权 → 密码重置。V7 持久身份系统。

## 2. 核心文件

| 文件 | 职责 |
|------|------|
| `src/auth/index.ts` | 身份核心：register/login/JWT 签发验证/密码重置 |
| `src/auth/platform-bind.ts` | 云平台账号绑定（ouid-N 账号本地建档） |
| `src/middleware/jwt-auth.ts` | JWT 鉴权中间件，注入 `req.user` |
| `src/middleware/admin-auth.ts` | 管理员鉴权 |
| `src/middleware/rate-limit.ts` | apiRateLimit / authRateLimit 限流 |
| `src/routes/auth.ts` | 14 条路由：注册/验证/登录/邀请码等 |
| `src/routes/profile.ts` | 3 条路由：个人资料 |

## 3. 关键机制（改这里之前必读）

### 3.1 JWT 设计

- **Access Token 有效期 7 天**（`JWT_EXPIRES_IN = '7d'`），payload 含
  `sub / numeric_id / sid / roles`
- **JWT_SECRET 必须配置**，没配直接抛错（fail-fast，不是静默默认值）
- **回退密钥机制**：`JWT_SECRET_FALLBACKS`（逗号分隔）用于接受云平台签发的
  token。⚠️ 安全敏感：只在云平台对接时配置，生产环境用完要清空，
  代码里有一次性警告日志

### 3.2 密码与令牌时效

| 项 | 值 |
|----|-----|
| bcrypt rounds | 12 |
| 邮箱验证 token | 24 小时 |
| 密码重置 token | 1 小时 |
| JWT 有效期 | 7 天 |

### 3.3 内网免登录（admin-auto）的信任判断 ⚠️ 高危区

`jwt-auth.ts` 的 `isTrustedLocalSource()`：

- **默认只放行 loopback + RFC1918 内网 IP**
- 反代场景：socket 是本机但带 `X-Forwarded-For` 时，按 XFF 真实客户端 IP 判断，
  **防止公网攻击者经反代被"洗白"成本地免登录**（v5-P0-C 修复）
- `ALLOW_PUBLIC_ADMIN_AUTO=1` 可强制公网免登录——**生产环境严禁开启**
- 无法确定来源 IP 时一律不可信（fail-closed）
- 公网无凭证拒绝日志限频 60s/条，防日志洪水

### 3.4 登录兼容性（历史坑，别"修"掉）

- 登录框只有一个输入框，用户可能输**用户名或邮箱**，两种都要支持
- `/me` 端点要兼容云平台账号（ouid-N）本地建档，返回完整用户信息
- 路由层必须 `await` 异步的 `loginWithEmail`（Bug #1 教训）

## 4. 注册流程（含 Agent 自动创建）

```
POST /register（email + password + display_name + invite_code）
  → auth.register() 建用户 + 数字ID（nextNumericId）
  → agent_binding === 'auto_default' 时：
      manager.register() 建用户专属 Agent（'semi' 模式）
      + 绑定默认模型
  → 返回 user + verificationToken（24h 有效）
```

邀请码：`createInviteCode` / `listInviteCodes`（db.ts），注册时校验。

## 5. 邮件说明

邮件发送目前是 **mock（日志输出）**，verificationToken 直接返回给前端。
接真 SMTP 时注意：验证邮件内容别带 token 之外的敏感信息。

---

## 回归测试清单（改本模块必跑）

- [ ] 注册新用户 → 返回 user + verificationToken，数字 ID 递增
- [ ] 邮箱验证 → emailVerified 变 true，token 过期（24h）后验证失败
- [ ] 用户名登录 ✅ / 邮箱登录 ✅ / 错误密码 401
- [ ] JWT 过期请求 → 401；伪造 token → 401
- [ ] **改过 JWT_SECRET 后旧 token 全部失效**（预期行为，发版要通知）
- [ ] 配了 JWT_SECRET_FALLBACKS 时旧平台 token 仍可用，控制台出现一次性警告
- [ ] 内网无 token 访问 admin-auto 放行；**公网模拟（带 XFF）被拒**
- [ ] 密码重置：1 小时内有效，用后失效
- [ ] 邀请码注册：无效邀请码被拒
- [ ] `npm run typecheck` 绿

## 坑位记录

### 2026-08-26 loginWithEmail 未 await 导致登录随机失败
- 现象：登录偶发 500，时好时坏
- 根因：loginWithEmail 是 async，路由层没 await，Promise 竞态
- 修复：路由层 await + 支持用户名/邮箱双输入
- 教训：**auth 层任何 async 函数，路由层必须 await，review 时重点看**