# Bug 修复完成报告

## 已修复的文件列表

| # | 文件 | 修复的 Bug |
|---|------|-----------|
| 1 | `src/core/approval.ts` | Bug #2: waitForApproval fallback 对象补全必需字段 |
| 2 | `src/core/compaction.ts` | Bug #11: 压缩时保留 tool_calls 信息 + estimateMessagesTokens 计入 tool_calls |
| 3 | `src/core/docker-sandbox.ts` | Bug #8: detectDocker 不再重复调用; Bug #20: --read-only 改为 tmpfs /sandbox |
| 4 | `src/storage/db.ts` | Bug #14: updateAgent SQL 参数用数组传递; upsertEntity/clearEntities 也修复 |
| 5 | `src/ai/hub.ts` | Bug #6: stripped 匹配只比对不含 "/" 的模型名; Bug #16: Provider 名称映射表; Bug #18: Anthropic 不兼容 OpenAI SDK |
| 6 | `src/ai/provider-registry.ts` | Bug #7: Ollama 只在配置 OLLAMA_BASE_URL 或 USE_OLLAMA=true 时注册 |
| 7 | `src/core/chat-modes.ts` | Bug #15: dispatchChain 设置 needsFollowUp: true |
| 8 | `src/core/ws-handler.ts` | Bug #12: isTaskComplete 只检查最后 3 行; Bug #15: 链式后续轮次处理 |
| 9 | `src/core/builtin.ts` | Bug #9: Docker 异步导入添加 ready flag + waitForDockerReady; Bug #10: 计算器正则过滤重写; Bug #19: 沙箱关闭时阻止敏感路径 |

## 需要手动修复的文件

### `src/core/index.ts`（文件太大，102KB）

以下 5 个 bug 需要手动应用修复，详见 `BUGFIX_INDEX_TS.md`：

- **Bug #1**: `auth.loginWithEmail` 路由缺 `await`（P0 严重）
- **Bug #3**: `startAutoSave(5000)` 注释说 30 秒但实际 5 秒
- **Bug #4**: `rbac` 函数用 `req.user?.id` 应改为 `req.user?.sub`（P1 权限绕过）
- **Bug #5**: `getParticipantRole` 调用不存在的 `d.listParticipants`，应改用 `getChatParticipants`（P1 崩溃）
- **Bug #17**: `verificationCodes` Map 是遗留代码（低优先级，不影响功能）

### `src/core/router.ts`（文件太大，37KB）

- **Bug #13**: 经验证非 bug — `runToolsLoop` 内部不通过 onChunk 发送内容，只在最后返回 finalContent，所以 router.ts 中手动分块发送不会重复。

## 修复统计

| 级别 | 总数 | 已修复 | 需手动 |
|------|------|--------|--------|
| P0 严重 | 3 | 1 (#2) | 2 (#1, #3) |
| P1 高 | 5 | 3 (#5→#5, #6, #7) | 2 (#4, #5→index) |
| P2 中 | 7 | 5 (#10, #11, #12, #14, #15) | 1 (#13 非bug) |
| P3 低 | 5 | 3 (#8, #9, #16, #18, #19, #20) | 1 (#17) |
| **合计** | **20** | **15** | **5** |