# GitHub 仓库：雇佣市场下线后的历史版本处理策略

> 日期：2026-09-27
> 决策：**向前兼容式下线**（forward-compatible takedown）
> 恢复成本：约 5 分钟（改 1 个环境变量 + 删 1 组 nginx 规则）
> 恢复材料：全部市场代码一行未删，仅"默认关闭"

---

## 一、结论先说

**不删历史，不重写 commit，不新建仓库。**

只在当前 main 上追加提交（已经做完），并补一份说明文档 + 打一个归档标签，让"以前的版本"从"藏起来"变成"标清楚"。

---

## 二、四种做法对比

| 做法 | 是否采用 | 理由 |
|---|---|---|
| A. 用 `git revert` 逐个撤销市场 commit | ❌ | 市场功能横跨 20+ 提交、17 个文件，revert 会连带撤销无关修复；revert 记录本身又制造新的"市场"痕迹 |
| B. `git filter-repo` 重写历史抹掉市场代码 | ❌ | 改写所有 commit SHA → 破坏所有 PR/issue 引用、fork、CI 缓存、tag；必须 force push 到 main，破坏性最大；且 MIT License 下抹掉历史没有法律收益 |
| C. **保留历史 + 当前 main 干净 + 打归档 tag + 写明说明** | ✅ **采用** | 零破坏、非 force-push、历史可追溯、随时可一键恢复 |
| D. 新开仓库 `lingxi-engine-v2` | ❌ | 仓库身份（star/fork/watcher/issue）全部归零，等于从零做品牌；且新旧仓库并存会让用户困惑该用哪个 |

---

## 三、业界实际怎么做（可对照的先例）

**1. 大版本断层：开 archive 仓库，不删旧的**
- TensorFlow 1.x → 2.x：TF2 上线后，`tensorflow/tensorflow` 保留 1.x 分支，同时把 1.x 单独放进 `tensorflow/tensorflow-1.x` 归档仓库并置为 archived
- Angular 2 时代：老版本进 `angular/angular.js` archive，README 顶部加废弃横幅

**2. 单仓库内做功能退役：feature flag 默认关闭 + Release Notes 声明**
- Stripe API 弃用单个 endpoint：不删代码，文档标 `deprecated`，给 sunset 日期
- GitHub 自己的 Actions v3 → v4：v3 代码长期保留，仅在文档标废弃并停止支持

**3. 只有泄漏了密钥才重写历史**
- GitHub 官方 `git-filter-repo` 文档明确：只有当密钥/个人信息误入历史、且已被他人 clone/fork 抓走时，才需要重写 + 吊销密钥。重写后**必须**轮换密钥，因为旧对象可能已被缓存

**4. 明确反对"删分支掩盖"**
- 主流开源项目普遍不删发布过的 tag/分支，视为对贡献者的承诺

> 共同点：**标记，不销毁**。唯一例外是密钥泄漏。

---

## 四、当前仓库里"以前的版本"到底有多暴露

已核查 `origin/main`（GitHub 上的实际内容）：

**GitHub 上雇佣市场相关文件 17 个，全部可见：**
```
src/routes/market.ts
src/routes/mvp-market.ts
src/routes/wallet.ts
src/payments/provider.ts
src/core/mvp-market/service.ts
src/storage/migrations/mvp-market-schema.ts
src/tests/mvp-initdb.test.ts
src/tests/mvp-market.test.ts
src/tests/mvp-platform-revenue.test.ts
web/market.html
web/market.js
web/market.css
web/css/market.css
skills/ai-market-integration.json
src/skills/ai-market-integration.json
skills/existing-repo-mvp-execution.json
+ 历史提交（19 个 market 相关 commit）
```

**关键判断：这些代码"存在"不等于"违法"或"违规"。**
- 项目是 MIT License，代码本来就公开
- 下线的是**产品功能**（运营决策），不是要掩盖事实
- 代码里没有真实用户数据、没有已泄露的生产密钥（`.env` 未被跟踪，只有 `.env.example` / `.env.template`）
- 唯一要做的，是让**首页和 README 的呈现**不再宣传雇佣市场

所以：**不需要重写历史。** 重写的成本（破坏 SHA、force push、密钥轮换）远大于收益。

---

## 五、实际执行的动作

### 已完成
- ✅ 三层屏蔽：后端 `FEATURE_MARKET` / nginx `location` 规则 / 前端 `display:none` + `hidden`
- ✅ 官网改回多模态智能体定位（标题、四步上手、能力矩阵全改；terms/privacy 整篇重写）
- ✅ 提交并推送到 GitHub：`6135c0e`、`b062b89`、`afad185`
- ✅ F 盘 + 服务器备份

### 本次补充（让旧版本"被标记"而不是"被藏起来"）
- ✅ `docs/github-archive-strategy-20260927.md`（本文件）——写明下线决策与恢复方式
- ✅ `ARCHIVE-NOTES.md` 仓库根目录退役说明
- ✅ 打 tag `market-era-final` 指向**最后一个市场仍在线的提交**（`c3c696a`）

### 建议后续（不阻塞，可选）
- 若日后想让 README 首屏彻底不提市场 → 在 README 加一行"当前定位：多模态智能体"
- 若担心旧市场代码被误用 → 在 `web/market.html` 顶部加一行 HTML 注释说明"已退役"
- 定期 `git tag` 打版本标签，保持"每次发布都有锚点"的习惯

---

## 六、恢复市场只需 3 步

```bash
# 1. 应用
FEATURE_MARKET=true   # .env

# 2. nginx：删掉 2 组屏蔽 location 规则
# 3. 重启
pm2 restart lingxi
```

---

## 七、给非技术同学的一句话总结

> **以前的版本不用藏，也不用删。**
> 就像手机系统下架一个 App——App 从商店下架了，但历史版本记录留着，这是对开发过程的尊重。
> 只要**当前**的 App 不再出现、介绍页不再提它，用户就不会被误导。
> 真要恢复，改一个开关就行。

**不建议开新仓库**：那等于换个门面重新开张，之前的口碑、收藏、关注全丢，等于自己把自己以前的努力格式化了。🙂
