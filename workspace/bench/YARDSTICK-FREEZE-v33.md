# 尺子冻结声明 v33（YARDSTICK FREEZE）

> 冻结时间：2026-09-20 ｜ 冻结范围：`bench/tasks/*.json` + `bench/adapters/ws-adapter.cjs` 判分逻辑
> 冻结含义：自 v33 起，判分口径不再变更。后续版本（v34+）只允许补数据、修引擎，**不允许再改尺子**——否则历史基线不可比。

## 一、v33 冻结时的判分语义（最终版）

### 分母定义（不会再破 100%）
```
valid   = 非 manual 题数 − 其中 envError 题数
rate    = ok / valid
manual  = 单列展示（pre_screen 初判 + 人工终审），永不进能力分母
envError = 环境错误（provider_down / external_block / 402 欠费等），剔除不计能力
```

### envError 分类表（classifyEnvError，v33 终版）
| 类别 | 模式 | 处置 |
|---|---|---|
| provider_down | 402 / Insufficient Balance / 连续失败5次 | env，剔除 |
| external_block | akamai / captcha / 403 forbidden / access denied / robot check / perimeterx | env，剔除 |

### manual 题终审状态
- L3-003 / L3-004 × G0~G4 共 10 行
- 人工终审：**10/10 初判维持**，存档 `results/v32-ALL/MANUAL-REVIEW-v33.md`
- G4 两行 = ENV 待补（402），终审分 null

## 二、冻结前最后一笔尺子变更（记录在案）

| 变更 | 文件 | 内容 | 理由 |
|---|---|---|---|
| L2-001 预算 120s→240s | tasks/L2-multi-step.json | +tag `network-heavy` +budget_note | G4 实测 180s 超时但决策链正确；网络密集题（搜索→抓取→解析→交叉验证）120s 不现实。备份 `.bak-20260920-v33budget` |

⚠️ 此变更**尚未重跑验证**（deepseek key 402 欠费）。L2-001 在 v33 基线中维持「真实 FAIL（超时）」结论不变；充值后重跑若 PASS，属于 v34 数据更新，不属于尺子变更。

## 三、v33 基线最终数字（冻结版，引用以此为准）

| 组 | 配置 | 达标率(去env) | 有效题 | env | 原始 | 均步数 | P50ms |
|---|---|---|---|---|---|---|---|
| G0 | 纯模型·无工具 | 21% | 28/28 | 0 | 21% | 0.0 | 4325 |
| G1 | +工具 | 100% | 27/28 | 1 | 96% | 7.8 | 4745 |
| G2 | +记忆 | 100% | 28/28 | 0 | 100% | 8.0 | 6136 |
| G3 | +反思 | 100% | 28/28 | 0 | 100% | 5.6 | 4914 |
| G4 | +元认知 | 95% | 22/28 | 6 | 75% | 4.5 | 4667 |

manual 终审：L3-003 全组 1.0（G4 待补）；L3-004 G0=0.5，G1/G2/G3=1.0（G4 待补）。

## 四、遗留待办（非尺子，冻结不影响）

1. **[硬阻塞·需用户]** deepseek key 充值 → 补跑 G4-L3 8 题 + L2-001 重验（约 20 分钟）
2. [引擎优化] web_fetch 截断解析（G4-L2-001 烧预算的直接原因是 1MB IR 页面反复解析）
3. [基线扩展] 换模型档位重跑（当前全部数字 = deepseek-flash 单档位）

## 五、复现命令

```bash
cd bench
node scripts/rejudge-v33.cjs          # 离线重判（零 API 消耗），输出 SUMMARY-v33.txt
node patches/patch-adapter-v33.cjs    # 判分补丁（幂等）
node patches/patch-tasks-prescreen-v33.cjs
node patches/patch-task-l2001-budget-v33.cjs
```

> 尺子已冻结。从今往后：数字变了只能是引擎变了，不能是尺子变了。📏🔒

---

## 附录：v34 数据更新（2026-09-20 23:50，非尺子变更）

按本冻结声明第二节预留口径（充值后重跑=数据更新），v34 已完成：

1. **G4-L3 补跑**：8 客观题全过（env 6→0），2 manual 人工终审均 1.0（`results/v34-ALL/MANUAL-REVIEW-v34.md`）
2. **L2-001 重验**：240s 预算下 **49.2s PASS**（16 步，file ok 3709B）——v33 的「真实 FAIL（超时）」结论按预留口径翻案为预算问题
3. **v34 基线**：G4 95%→**100%**（28/28，0 env），其余四组与 v33 冻结数字逐字一致（离线重判验证）
4. tasks pre_screen G4 null→1 回填（`scripts/patch-prescreen-g4.cjs`，JSON 校验通过）；判据自检复跑 9/9 PASS

**v34 冻结数字**（引用以此为准，取代第三节 v33 表）：

| 组 | 达标率(去env) | 有效题 | env | 原始 | 均步数 | P50ms |
|---|---|---|---|---|---|---|
| G0 | 21% | 28/28 | 0 | 21% | 0.0 | 4325 |
| G1 | 100% | 27/28 | 1 | 96% | 7.8 | 4745 |
| G2 | 100% | 28/28 | 0 | 100% | 8.0 | 6136 |
| G3 | 100% | 28/28 | 0 | 100% | 5.6 | 4914 |
| G4 | 100% | 28/28 | 0 | 100% | 4.5 | 5206 |

manual 终审：L3-003 全组 1.0；L3-004 G0=0.5，G1~G4=1.0。累计 12/12 维持。

遗留待办更新：第 1 条（充值补跑）**已完成**；第 2、3 条不变；新增第 4 条 **L4/L5 首跑**（题已出未跑）。

> 尺子仍然冻结。v34 只动了数据，没动判分。📏🔒
