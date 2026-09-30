# v2.2.0 自主执行修复 —— 变更说明

日期：2026-09-29
目标：解决「任务做到一半就停下来，必须让用户回复"继续"」的确定性死循环。

---

## 一、真正的根因（此前判断有误，此处更正）

上一轮我判断为"框架没有完成判定机制"。**这个判断是错的。**

实际情况：机制 100% 存在，代码注释里甚至明确写着要解决这个问题。
真正的缺陷是一个**白名单漏项**：

| 位置 | 代码 | 作用 |
|---|---|---|
| `executor.ts:790` | `(requireCompletion && !isCompletionSignal(text)) ? 'idle_stop' : 'completed'` | AI 出文字但未声明完成 → 标记为 `idle_stop` |
| `router.ts`（原 491 行） | `(result.stopReason === 'aborted' \|\| result.stopReason === 'max_iterations')` | 自动续跑白名单**只有两项** |

`idle_stop` 落在白名单之外 ⇒ 续跑分支永不进入 ⇒ 控制权交还用户。

**后果**：模型每轮汇报一次进度就必然触发一次 `idle_stop` ⇒
用户被打断 100% 是必然事件，不是偶发。这解释了为什么现象如此稳定。

---

## 二、实际改动（4 处）

### 1. 新增 `src/core/autonomy.ts`（全新文件）
集中管理自主续跑策略：
- `AUTO_RESUME_STOP_REASONS` — 白名单，**新增 `idle_stop`、`tool_failures`、`repeat_tool`**
- `decideAutoResume(stopReason, lastText)` — 统一判定入口
- `inferRemainingWork(lastText)` — 从上一轮汇报中提取未完成清单，
  续跑时直接告诉模型"逐条执行，不要再列清单"，避免空转
- `STOP_REASON_TEXT` — 终止原因中文化，替代硬编码

### 2. `src/core/router.ts`
- 引入 `decideAutoResume`，替换原二元白名单判定
- `reasonText` 改为查表，去掉"不是超时也叫超出时限"的误导
- 续跑轮数 `TASK_RESUME_ROUNDS` 默认值 **2 → 6**
- 删除结尾那句"输入「继续」可从断点恢复执行"
  —— 这句话是系统自己在教用户养成坏习惯

### 3. `src/tools/executor.ts`
- `MAX_IDLE_ROUNDS` 默认 **8 → 16**：长任务容错空间翻倍
- `EXECUTOR_CONTEXT_MAX_TOKENS` 默认 **40000 → 60000**
- 上下文压缩节奏 `i % 3` → `i % 2`：更早触发压缩
- **新增上下文超限降级**：捕获 `maximum context length` 类 400 错误后，
  压缩历史（保留 system + 首条用户目标 + 最近 8 条）并 `continue`，
  而不是直接抛错让整个任务崩掉

> 第 4 条对应一次真实事故：
> `400 ... you requested about 1549035 tokens` —— 长任务跑到一半直接崩，
> 被迫重发"继续"。此前无任何降级路径。

### 4. `src/tests/autonomy-v220.test.ts`（新增 8 个用例）
覆盖 `idle_stop` 续跑、`completed` 不续跑、`ai_errors` 不续跑、
清单提取、终止原因标签完整性。

---

## 三、验证结果

```
npx tsc --noEmit          → 0 errors（全项目）
autonomy-v220.test.ts     → 8/8 passed
回归（executor/registry） → 36/36 passed
```

全量测试 130 项：116 通过 / 14 失败。
经 `git stash` 对照验证，**这 14 项失败在本次改动前即已存在**
（`auth-trust.test.ts` 2 项、`mvp-platform-revenue.test.ts` 12 项），
与本次修改无因果关系，属存量问题。

---

## 四、行为变化对照

| 场景 | 修改前 | 修改后 |
|---|---|---|
| AI 汇报进度后停下 | 交还用户，等"继续" | **自动续跑**（最多 6 轮） |
| 工具连续失败 | 交还用户 | 自动续跑换策略 |
| 重复调用收敛 | 交还用户 | 自动续跑 |
| 上下文超限 400 | 任务崩溃 | 压缩后继续 |
| AI 连续失败 5 次 | 交还用户 | 交还用户（正确，需人介入） |
| 真正完成 | 交还用户 | 交还用户（正确） |
| 用户主动停止 | 停止 | 停止（正确，未改） |

---

## 五、尚未处理（建议后续排期）

1. **独立 Verifier**：目前完成判定仍依赖模型自述 `isCompletionSignal`，
   应改为基于工具产出证据的独立验收器。
2. **任务持久化**：`src/core/task-store.ts` 已有雏形，
   但尚未接入续跑链路，中断后仍无法真正断点恢复。
3. **无进展检测**：目前靠固定轮数上限，缺少"连续 N 轮零进展则换策略"的语义判断。
4. **存量 14 项测试失败**：auth-trust 与 mvp-platform-revenue 建议单独排期修复。

---

## 六、回滚方式

```
src\core\router.ts.bak-v220-autonomy
src\tools\executor.ts.bak-v220-autonomy
```

覆盖回去即可完全回退本次改动。
