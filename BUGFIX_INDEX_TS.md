# Bug 修复补丁说明 — index.ts

由于 index.ts 文件过大（102KB），以下是需要手动应用的修复：

## Bug #1: loginWithEmail 是 async 但路由层当同步调用

**位置**: 搜索 `auth.loginWithEmail(email, password)`

**修复**: 改为 `await auth.loginWithEmail(email, password)` 并将路由回调改为 async：

```ts
// ── V7: 登录（邮箱 + 密码） ──
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: '邮箱和密码必填' });
    const result = await auth.loginWithEmail(email, password);  // ← 加 await
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});
```

## Bug #3: startAutoSave 注释说"每30秒"但实际传了 5000ms

**位置**: 搜索 `startAutoSave(5000)`

**修复**: 改为 `startAutoSave(30000)` 或修改注释为"每5秒"：

```ts
startAutoSave(30000);  // 每30秒自动保存到磁盘
```

## Bug #4: rbac 函数使用 req.user?.id 但 JWT payload 的字段是 sub

**位置**: 搜索 `req.user?.id`

**修复**: 改为 `req.user?.sub`：

```ts
function rbac(requiredRole: Role) {
  return (req: any, res: any, next: any) => {
    const chatId = req.params.id || req.params.chatId || req.body?.chatId;
    const userId = (req.user?.sub || req.query.userId || req.body?.userId || '') as string;  // ← id 改为 sub
    ...
  };
}
```

## Bug #5: getParticipantRole 调用 d.listParticipants 但 DB 实例没有这个方法

**位置**: 搜索 `d.listParticipants(chatId)`

**修复**: 改用 db.ts 导出的 `getChatParticipants` 函数：

```ts
function getParticipantRole(chatId: string, userId: string): Role | null {
  try {
    // Bug #5 修复：使用 db.ts 导出的 getChatParticipants 函数，而非 sql.js 实例上不存在的方法
    const { getChatParticipants } = require('./src/storage/db.js');
    const participants = getChatParticipants(chatId);
    const p = participants.find((x: any) => x.user_id === userId || x.agent_id === userId);  // ← 字段名也修正
    return (p?.role as Role) || null;
  } catch { return null; }
}
```

注意：`getChatParticipants` 返回的行字段名是 `user_id` 和 `agent_id`（数据库列名），不是 `userId` 和 `agentId`。

## Bug #17: verificationCodes Map 定义了但从未使用（遗留代码）

**位置**: 搜索 `const verificationCodes = new Map`

**修复**: 可以安全删除以下代码：
```ts
interface VerificationCode {
  email: string;
  code: string;
  username?: string;
  expiresAt: number;
}

const verificationCodes = new Map<string, VerificationCode>();
```

**注意**: `verificationCodes` 在旧版兼容路由 `/api/auth/send-code` 和 `/api/auth/register-with-email` 中有使用，所以不能直接删除。这些路由是兼容旧版的 demo 模式，保留即可。Bug #17 的修复应该是：添加注释标记为遗留代码，不影响功能。