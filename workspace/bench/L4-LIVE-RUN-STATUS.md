# L4 真机实跑记录（本地模型 + 线上实例验证）

**时间**：2026-09-21 / 22
**引擎**：`localhost:3801`，version=2.0.22，commit=16d5167（含本轮全部修复）
**模型**：`qwen3.8:27b-32k`（本地 Ollama，27.3B Q4_K_M，7.9GB VRAM + 大量 CPU 卸载）

---

## 一、实跑过程中抓到并修复的真实 bug

### `ws-adapter.cjs` 的 `--timeout` 单位与 `--min-timeout` 不一致
- `--timeout` 传的是**毫秒**（`timeoutMs: Number(args.timeout)`），而 `--min-timeout` 传的是**秒**（`* 1000`）
- 后果：本次实跑误传 `--timeout 240` 被当成 **240ms** → 5 题库题瞬间 `timeout>0s`、`steps=0`、`out=""`，与新修复的管道逻辑无关
- 修复：`--timeout` 统一为**秒**（`Number(args.timeout) * 1000`），与 `--min-timeout` 一致
- 验证：`node --check` 通过；适配器判据自检 **15/15**；computeTimeoutMs 回归 **9/9**

> 这条也解释了「为什么必须做真机实跑」——纯读代码不会发现 CLI 单位不一致，只有真跑才会暴露。

---

## 二、实跑结论

- **引擎侧修复确已生效**：引擎接受 WS 连接（`wsConnections=1`）、为 5 题建好隔离 agent（`agents=6`），Ollama 模型被正常调起（`/api/ps` 可见 27B 加载中）
- **但本次 L4 完整跑分未能在合理时间内完成**：本地 27B Q4 在 8GB VRAM 上大量 CPU 卸载，单题生成耗时长；20+ 分钟无单题产出
- **定性**：未完成的原因是**本机模型吞吐不足**（环境限制），**不是**判分器/事件管道缺陷——后者已由确定性单测覆盖（L4 判分 6/6、事件回传 3/3、超时 9/9）

### 结论表
| 项 | 结果 |
|---|---|
| 引擎接受连接 + 建隔离 agent | ✅ 实证（ws=1, agents=6） |
| 模型被调起 | ✅ 实证（ollama /api/ps） |
| L4 完整跑分产出 | ⏳ 未完成（本机 27B 吞吐不足） |
| 判分/管道逻辑正确性 | ✅ 单测 9/9 + L4 判分 6/6 + 事件 3/3 |

### 可行的下一步（需外部条件之一）
1. 换**快模型档位**（云端 `glm-5.2:cloud` 等，需配额）实跑 L4/L5 → 这是原评估报告建议的「≥3 个模型档位」路线
2. 或对本机 27B 只跑**单题**、把单题预算放大到 600s+，验证「非零 steps」而不求全层完成
3. 或升配 GPU（当前 7.9GB VRAM 对 27B Q4 严重不足）

---

## 三、本轮新增脚本（可复用）

- `workspace/bench/run-l4-local.cjs`：起引擎 + 跑 L4 + 判分（全自动，含日志）
- `workspace/bench/rerun-l4.cjs`：对**已运行**引擎直接跑 L4（不重启）
- `workspace/bench/verify-all.cjs`：9 项回归一键汇总

用法：
```bash
npm start -- --port 3801 --data-dir data-v36local       # 终端A（或复用已在跑实例）
node workspace/bench/rerun-l4.cjs                        # 终端B
```
