# 阶段3 落地总结：沙盒执行 + 环境反馈闭环

> 对应 AGI 进化路线图【阶段3·让它"接地"】：让引擎从"嘴炮"到**可验证的通用能力**。

## 新增内容

| 文件 | 说明 |
|---|---|
| `sandbox.py`（新增） | 受限执行环境：四档模式开关 + 白名单 + 两级黑名单 + 超时 + 输出捕获 |
| `role_discussion.py`（改造） | 新增 `run_with_feedback()`，实现"讨论 → 执行 → 反馈 → 调整"闭环 |
| `config.py` | 新增 `enable_sandbox` / `sandbox_mode` / `sandbox_timeout` / `sandbox_cwd` |
| `__init__.py` | 导出 `Sandbox`，版本 0.3.0 → 0.4.0 |
| `tests/verify_stage3_sandbox.py`（新增） | **30 项断言**验证脚本 |
| `tests/verify_sandbox_modes.py`（新增） | **19 项断言**：四档模式全覆盖（strict/open/full/off + 非法值回落 + 环境变量覆盖 + off 早退） |

## 核心能力

### 1. 安全执行（Sandbox）——四档模式开关

`config['sandbox_mode']`（或环境变量 `LINGXI_SANDBOX_MODE`）控制能力边界，**默认 strict 宁严勿松**：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| `strict`（默认） | 只放行无害查询类命令（echo/dir/ls/type/cat/pwd/find/where/which/ping），不含任何解释器 | 默认安全基线 |
| `open` | strict 基础上放行常用开发工具：python/py/node/npm/npx/pip/git/curl/ffmpeg/tar/ssh 等 | 可信环境让模型真正跑脚本验证方案 |
| `full` | 跳过白名单，任何命令放行；仅保留黑名单 + 超时 + 无 shell 三道防线 | 完全可信的本机自动化，风险自担 |
| `off` | 完全关闭，任何 `run()` 抛 `SandboxError`；`run_with_feedback` 明确早退不烧模型调用 | 禁用沙盒 |

- **非法 mode 值一律回落 strict**：配置写错时宁严勿松
- 显式传入 `sandbox_allow` 列表可完全覆盖模式白名单（按需开门的口子）
- `enable_sandbox=False` 优先级最高，强制等效 off

### 2. 安全模型（所有模式不变的防线）

- **无 shell**：外部命令经 Windows 友好切分器解析（保留反斜杠路径、支持引号分组）后
  以列表传给 `subprocess.run(shell=False)`，管道/重定向/`&&`/反引号等元字符
  只是惰性文本，不会被解释执行
- **白名单精确匹配**：按首个 token **精确匹配**，不做前缀匹配
- **两级黑名单**（纵深防御，`full` 档同样生效）：
  - **token 级精确匹配**：`rm/del/format/dd/shutdown/reboot/chown` 等破坏性词根，
    `-delete/-exec/-execdir/-ok/-rf/--force` 等危险标志
    （精确匹配避免误伤：`-ok` 不会拦下 `echo full-mode-ok`）
  - **短语级子串匹配**：`drop database` / `push --delete` / `rd /s` /
    `> /dev/sda` / `chmod 777` / `:(){` 等多 token 危险组合
- **原生内建命令**：`echo/dir/ls/type/cat/pwd` 用 Python 直接实现，
  完全不经过子进程与 shell，跨平台行为一致且无注入面
  - 【2026-08-24 复查修复】纯文本参数（无 shell 元字符）只是数据，跳过黑名单检查，
    避免 `echo rm`、`dir /s` 被 token 级黑名单误伤；
    参数一旦出现 shell 元字符（`&& || ; | > <` 反引号 `$(`）视为注入信号，
    恢复从严黑名单检查，`echo hi && rm -rf /tmp/x` 仍被拦截
- **超时控制**：防止命令挂死（默认 10s，可配置；配置传字符串也会归一化为数字，
  避免 `subprocess.run` 抛 TypeError）
- **结构化结果**：每条执行返回 `{ok, stdout, stderr, exit_code, elapsed}`

### 3. 环境反馈闭环（run_with_feedback）【真闭环】
```
讨论得出行动方案 → 沙盒实际执行 → 把执行结果作为环境反馈喂回模型
→ 模型判断"目标达成"或给出下一步调整建议
→ 该建议会被【实际执行】，其结果再作为新一轮反馈继续调整
→ 最多调整 max_adjust 轮
```

这填补了前两个阶段的空白：阶段1/2让引擎"会记忆、会反思、会调度资源"，但都停留在**输出文字**。阶段3让引擎真正**在环境里试错**——这是"可验证通用能力"的临门一脚。

## 验证结果

- 阶段3 专项：**30/30 通过**（含解释器拒绝、shell 注入拒绝、find 危险参数拦截、超时捕获、真闭环验证）
- 沙盒模式专项：**19/19 通过**（四档模式 + 非法值回落 + 环境变量覆盖 + off 早退 + 黑名单兜底）
- 回归（阶段1/2/配置/分歧）：17 + 9 + 38 + 8 + 16 + 15 = **103/103 通过**
- 合计 **152 断言全绿**，全部纳入 `tests/run_all.py` 统一回归

## 与阶段1/2 的融合

`run_with_feedback` 内部先调用 `run_discussion`（阶段0/1/2 的能力全保留），
讨论结束后才进入沙盒执行。元认知（阶段2）可决定讨论轮次，沙盒执行结果
可作为新的经验沉淀回记忆（阶段1 的蒸馏闭环），形成完整迭代。

## 路线图进度

```
阶段0 ✅ 多轮+角色+收敛+反思
阶段1 ✅ 三层记忆+蒸馏+闭环沉淀
阶段2 ✅ 元认知+动态资源分配+记忆注入
阶段3 ✅ 沙盒执行+环境反馈闭环（四档模式）   ← 本次落地
阶段4 受限自改进+宪法对齐      → 待做
```
