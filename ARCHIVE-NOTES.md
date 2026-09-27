# ARCHIVE-NOTES · 功能退役记录

本文件记录灵犀引擎**已从主分支移除的产品功能**，以及如何恢复。

---

## 雇佣市场 / AI 员工市场（2026-09-27 起下线）

### 当前状态

| 层 | 处理方式 |
|---|---|
| 后端接口 | `FEATURE_MARKET=false` → `/market`、`/api/market/*`、`/api/mvp/*`、`/api/hire/*`、`/api/skills/market` 全部 404 |
| nginx | 2 组 `location` 规则强制 404（不依赖应用进程） |
| 前端 | 底部「市场」按钮 `display:none` + `hidden`；市场面板 `display:none`；误触自动回退「会话」 |
| 官网 | 标题、四步上手、能力矩阵改为多模态智能体定位；钱包/充值入口全部移除；terms/privacy 按无金融功能重写 |

**产品定位已从「AI 员工雇佣平台」回到「开源多模态智能体」。**

### 代码状态：全部保留，一行未删

市场相关代码在仓库中**完整保留**（17 个文件），随时可恢复。
本仓库为 MIT License，历史提交不做任何改写或删除。

标记为「历史版本」的提交：
- 最后上线市场的提交：`c3c696a`（tag: `market-era-final`）
- 下线提交：`6135c0e`

### 如何恢复

```bash
# 1. 应用环境变量
FEATURE_MARKET=true

# 2. nginx：删除 2 组屏蔽 location 规则

# 3. 重启
pm2 restart lingxi
```

预计耗时：约 5 分钟。

### 决策依据

详见 [`docs/github-archive-strategy-20260927.md`](docs/github-archive-strategy-20260927.md)。
核心原则：**标记，不销毁**。仅当密钥或个人信息误入历史且已被他人抓取时，才重写历史并轮换密钥。

---

*本文件会持续累积后续的功能退役记录。*
