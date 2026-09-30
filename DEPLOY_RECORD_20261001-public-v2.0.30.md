# 发布记录 · 官网 public v2.0.30

- 日期：2026-10-01
- 站点：http://47.93.157.83:8080
- 发布版本：**2.0.30**
- 打包所依据的源码提交：`a4367d8`
- 发布件：`lingxi-engine-v2.0.30.tar.gz`，1,838,958 字节
- SHA256：`54A97A869744A6D6C69FED7E73A114083526E7CE70945E16F8F4A8990A280ED0`
- 服务器备份：`/var/www/lingxi/.bak-pre-v2030-20261001-003749`

> 站点根目录：`/var/www/lingxi`，静态文件在 `/var/www/lingxi/public`。
> 服务器别名 `lingxi-server`（`~/.ssh/config`），可 BatchMode 免交互。

---

## 一、变更内容

### 1. 统一自动重试与失败自愈（`9517c2d`）

新增 `src/core/retry-coordinator.ts` 作为全引擎唯一重试决策点。

| 原问题 | 后果 |
|---|---|
| `router.ts` 续跑 `catch` 直接 `break` | 网络抖一下整个任务停摆，并提示用户「输入继续」 |
| `executor` / `hub` / OpenAI SDK 三层各自重试 | 一次 429 被叠乘放大 |
| `hub` 写死退避、无 jitter、无视 `Retry-After` | 限流立刻重撞；多任务同时重试形成惊群 |

### 2. 修掉三个真 bug

| bug | 用户可见后果 |
|---|---|
| `isRetryableError` 不认 `AbortError` | 点「停止」后任务仍被后台复活 |
| 不支持 `Retry-After` 的 HTTP-date 格式 | 服务端说「等 10 分钟」，引擎 8 秒后照撞 |
| 解析层 120s 硬腰斩 | 双重封顶导致提前重试，白耗配额 |

### 3. 依赖安全（`131f3d4`）

multer 2.2.0–2.3.0 存在上传中断导致孤立磁盘写入的 DoS（GHSA-3pph-fpjx-jg34），
升级至 2.4.0，`npm audit` 现为 **0 vulnerabilities**。

### 4. 打包与校验链路修复（`5152b3f`）

实际发布时暴露的四个静默失败：

1. **排除表漏 `stage/`** —— 脚本自身的 junk 断言正确拦下（断言没写错，是排除表不完整）。
   `stage/` 内含历史改动快照，可能带真实手机号与内部地址，打进公开下载包有隐私风险。
2. **`credits ||-bug` 断言已过期** —— 该断言检查的代码已随 marketplace 下线（`969b385`）整段移除，
   于是永久失败并阻断发布。改为按功能存废自适应，保留而非删除。
3. **BUILD-INFO 人工字段被每次打包冲掉** —— 改为继承 `highlights` / `quality` / `commitMeaning`。
4. **PowerShell 5.1 的 ANSI 编码 bug（两处脚本同源）** ——
   `Get-Content` 默认按系统 ANSI 代码页读文件，而这些文件是无 BOM 的 UTF-8。
   UTF-8 中文按 GBK 解释会**吞掉后随的 ASCII 字符**，实测把 `BUILD-INFO.json` 中
   文字符串结尾的 `\"` 一起吞掉，引号配对断裂，`ConvertFrom-Json` 报 `Invalid array`。
   这不是显示问题 —— 是真的读不出该 JSON。`pack-release.ps1` 表现为静默丢字段，
   `verify-site-consistency.ps1` 表现为校验失败。两处统一显式 `-Encoding UTF8`。

---

## 二、验收

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 0 错误 |
| `npx vitest run` | ✅ 6 文件 / 106 通过 |
| `npm audit` | ✅ 0 vulnerabilities |
| `pack-release.ps1` | ✅ Packaging completed successfully，全部断言通过 |
| `verify-site-consistency.ps1` | ✅ **SITE CONSISTENT: 12 checks passed, 0 failed** |

上线后校验逐项：

```
[OK] version.txt declares tarball SHA256 54a97a86...
[OK] tarball SHA256 matches version.txt declaration
[OK] in-pack version.txt == site version.txt (2.0.30)
[OK] served installer == installer embedded in the package
[OK] BUILD-INFO version == site version
[OK] package.json version == site version
[OK] download page advertises 2.0.30
[OK] no stale engine version strings on the download page
[OK] versioned archive copy is byte-identical to the release artifact
[OK] install.ps1 points at the generic tarball
```

---

## 三、四处同步状态

| 目标 | 状态 |
|---|---|
| GitHub `lingxi-engine/lingxi-engine` | ✅ `a4367d8..5152b3f` |
| D 盘 OSS 镜像 `D:\lingxi-engine-oss` | ✅ `a4367d8..5152b3f` |
| F 盘备份 | ✅ `F:\lingxi-engine-backup-20261001-retry-heal`（`git archive` 干净快照） |
| 官网 `47.93.157.83:8080` | ✅ v2.0.30 已上线，12 项一致性校验全过 |

官网改动落在 `web/`（真正的发布源），而非服务器快照 ——
`publish-site.ps1` 每次发布都从 `web/` 上传，改服务器快照会被下次发布静默覆盖。

---

## 四、回滚方法

如需回退到 v2.0.28：

```bash
ssh lingxi-server
BK=/var/www/lingxi/.bak-pre-v2030-20261001-003749
PUB=/var/www/lingxi/public
cp -a $BK/public/version.txt $BK/public/download.html \
      $BK/public/index.html $BK/public/lingxi-engine.tar.gz $PUB/
cp -a $BK/version.txt /var/www/lingxi/
rm -f $PUB/lingxi-engine-v2.0.30.tar.gz
```

回滚后再跑一次 `scripts/verify-site-consistency.ps1` 确认一致。

---

## 五、尚未完成（诚实列出）

1. **`TurnRecoveryState` 多轮自动恢复预算未接入 Router 主循环** ——
   能力已实现（`canAutoRecover` / `startAutoRecovery`），本轮只接线了
   `classifyFailure` / `computeDelayMs` / `shouldWaitAndRetry`。
2. **`compress` / `continue-length` / `redirect` 三种恢复模式未接执行端** ——
   分级函数能正确识别，执行动作的代码在 executor。
3. **无跨进程恢复检查点** —— 进程崩溃后任务状态仍丢失。
   Hermes 的 `turn_retry_state` 是内存态，我们尚无持久化。
4. **未做真实限流压测** —— 单元测试用 mock 构造 429，未在真实供应商验证。
5. **服务器 stage 目录未清理** —— `/opt/lingxi-stage/` 留有本次上传的临时文件。
