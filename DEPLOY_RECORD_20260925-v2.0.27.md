# 部署记录：官网 v2.0.27（修复「验证器自己说谎」）

- 日期：2026-09-25（周五）深夜，Asia/Shanghai
- 发布人：灵犀平台本地软件研发总智能体（AI）
- 线上出口：http://47.93.157.83:8080
- 本地 HEAD（打包时）：`7ac2471`
- 线上版本：**2.0.27**

---

## 一、本轮修的两个真问题

### 1. `install.sh --dry-run` 打印 `vunknown`（验证模式给出误导性版本号）

`--dry-run` 不真下载解压 → 读不到包内 `version.txt` → banner 与「📥 下载灵犀引擎 vX」双双显示
`vunknown`。一个专门用来做验证的模式，输出的版本号是错的。

修复：新增 `fetch_site_version()`，包内读不到版本时回退站点索引 `version.txt`
（与 tar 包同批次写入，带版本硬门禁）。**站点也不可达时如实输出 `unknown`，绝不编造。**

### 2. `test-install-linger.sh` 的「无 loginctl」用例**恒为假失败**

该用例用 `PATH="$TMPD:$PATH"` 模拟"系统里没有 loginctl"，却把真实 PATH 追加了回来，
宿主机自带的 `/usr/bin/loginctl` 仍被 `command -v` 找到 → 走成功分支 → **永远 FAIL**。

- 实测复现（阿里云 `iZ2ze8ihighjoo6ktzcsofZ`，真 Linux）：原版 install.sh 上 **3/4**，
  报 `FAIL: 未见缺失 loginctl 提示`。也就是说，此前"4/4 通过"的说法**与实测不符**。
- 修复两处：① `mode=none` 时 PATH 真正隔离为 `$TMPD`；② 隔离后裸 `bash` 找不到自己
  （实测 `rc=127: bash: command not found`），改用 `$BASH_BIN` 绝对路径调用。
- 新增防退化断言：**隔离不成功直接判 FAIL**，避免该用例再次悄悄失去意义。

---

## 二、新增：`scripts/test-install-version-fallback.sh`（13 项）

从真实 `site/install.sh` 抽取 `fetch_site_version()` 与两处调用点，用**桩 curl** 驱动，**不依赖网络**：

- 静态 7 项：定义存在 / dry-run 与部署后 else 两处调用存在 / 调用次数恰为 3 /
  无硬编码 `VERSION="x.y.z"` / LF-only / 无 BOM
- 行为 6 项：纯 LF、BOM+CRLF、无尾换行 → 均正确解析；
  **站点不可达 → 空输出（不编造）**；无 curl 且无 wget → 空输出

---

## 三、新增：发布流程的**字节级门禁**（`scripts/publish-site.ps1`）

版本号一致**证明不了**用户拿到的是新包——v2.0.26 就出过"scp 传到父目录死路径、
所有版本检查全绿、用户却一直下旧包"的事故。故新增三项实测：

1. 下载 `$SiteUrl/install.sh` 与本地 `site/install.sh` 比对 SHA256
2. 下载 `$SiteUrl/install.ps1` 与本地 `site/install.ps1` 比对 SHA256
3. 下载线上 tarball，与 `version.txt` **自己声明的** SHA256 比对（专治"元数据撒谎"）

> 门禁自己也被实测纠错两次，如实记录：
> - 首跑把线上 `install.ps1` 当成 `install.sh` 比对（`$InstallUrl` 实为 `/install.ps1`），
>   误报 "install.sh DIFFERS" —— 已改为两个安装器各比各的；
> - `[SHA256]::Create` 漏了调用括号，得到 PSMethod 而非实例，抛 `does not contain a method
>   named ComputeHash` —— 已加 `()`。
> **门禁没验证过自己，就不算门禁。**

---

## 四、顺手清掉的元数据漂移

`/var/www/lingxi/version.txt`（父目录那份）**没人服务、却每次都漂**：
2.0.23 → "2.0.25 / d787b34"（`d787b34` 在 main 历史里根本不存在）→ 2.0.26 又漂。

本轮不再手工打补丁，而是**断根**：`publish-site.ps1` 在每次发布的同一个事务里
`cp` 同步该副本。实测：orphan 与 `public/version.txt` `diff` 完全一致（IDENTICAL_OK）。

---

## 五、验证清单（全部实测，非推断）

| 项 | 结果 |
|---|---|
| `tsc --noEmit` | ✅ 0 错误 |
| `vitest run` | ✅ **100/100 通过**（5 文件） |
| `test-install-linger.sh`（真 Linux） | ✅ **4/4 ALL CASES PASS** |
| `test-version-parse.sh`（真 Linux） | ✅ **5/5 ALL VERSION-PARSE CASES PASS** |
| `test-install-version-fallback.sh`（真 Linux） | ✅ **13/13 ALL VERSION-FALLBACK CASES PASS** |
| `site/install.sh` | ✅ 22915 B，LF-only，无 BOM |
| `publish-site.ps1` PS 解析 | ✅ `POWERSHELL_SYNTAX_OK`，ASCII-only |
| 线上 `/install.sh` vs 本地 | ✅ **byte-identical** `79f2d2095b0b5919…` |
| 线上 `/install.ps1` vs 本地 | ✅ **byte-identical** `76925bcae6fe97f3…` |
| 线上 tarball vs `version.txt` 声明 | ✅ 一致 `c044a1bcf9069373…` |
| 本地 tarball vs 线上 tarball | ✅ 三方同 SHA `c044a1bcf9069373…` |
| 线上 version.txt | ✅ `2.0.27`（135 B） |
| 父目录 orphan 副本 | ✅ 与 public 一致（diff 无输出） |
| 线上 fresh 下载 + `--dry-run` | ✅ banner/下载行均为 **v2.0.27** |
| 线上 HTTP 入口 | ✅ 全部 200（`/` 10681 B、`/public/install.sh` 22915 B、`/install.ps1` 17734 B、tarball 1233720 B） |
| git | ✅ 工作区干净，`main == origin/main` |

---

## 六、用户安装（Linux）

```bash
loginctl enable-linger $USER
curl -fsSL http://47.93.157.83:8080/install.sh | bash
```

第一条止血：用户级 systemd 服务不开启 linger 会随 SSH 断开被回收。
两条命令**分开逐条粘贴**——终端 bracketed-paste 会把 `^[[200~` 混进命令。

---

## 七、仍未闭合（需要人手动执行）

本机（Windows）运行中的引擎进程仍自报 `2.0.23 / f113593`，而磁盘代码已是 2.0.27。
`taskkill` 被"防自杀保护"统一拦截（我本身就跑在那个 node 进程里），故只能人工：

```bash
taskkill /F /PID 20184
taskkill /F /PID 3256
cd C:\Users\Administrator\lingxi-engine && npm start
```
