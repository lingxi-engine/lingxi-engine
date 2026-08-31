# 模块文档：部署与发版（doc-deploy）

> 覆盖：部署脚本、版本号体系、CI、三平台安装包 ｜ 更新：2026-08-29

---

## 1. 部署脚本地图

| 文件 | 平台 | 说明 |
|------|------|------|
| `deploy.sh` | Linux 服务器 | 一键部署（apt/dnf/yum 三分支） |
| `install.sh` | Linux/macOS | 原生安装（含 macOS LaunchAgent、--fix-app Gatekeeper 修复） |
| `install.ps1` | Windows | 安装 + start.bat 启动链 |
| `setup.sh` / `setup.bat` | 开发环境初始化 | |
| `ecosystem.config.cjs` | pm2 进程管理 | |
| `start.bat` / `start-dev.sh` | 启动入口 | |
| `.github/workflows/ci.yml` | CI（桌面三平台构建在 lingxi-desktop 仓库） | |

## 2. 版本号对齐清单 ⚠️ 发版必查（当前就有不同步案例）

| 位置 | 当前值 | 说明 |
|------|--------|------|
| package.json | 2.0.13 | ✅ 基准 |
| version.txt（根） | 2.0.13 | ✅ |
| **src/version.txt** | **2.0.12** | ❌ **落后一个版本，待同步** |
| lingxi-desktop package.json | 独立版本 | 桌面壳仓库，发版时对齐 |

**发版流程**：改版本号 → 四处全改 → 打 tag → CI 出包 → 验证升级接口
能读到新版本。**src/version.txt 与根 version.txt 并存本身就是坑**，
待办：统一由 package.json 生成，删掉冗余副本。

## 3. 三平台一行命令部署

- Linux：`curl -fsSL <host>/deploy.sh | bash`（内部判断 apt/dnf/yum）
- macOS：`install.sh` 原生支持（LaunchAgent 托管 + `--fix-app` 修 Gatekeeper）
- Windows：`install.ps1`（需 PowerShell 执行策略放行）
- 桌面壳（Electron 33）：exe / deb / AppImage / dmg 四包，
  dmg 双架构（Intel + Apple Silicon），adhoc 签名防 Apple Silicon SIGKILL

## 4. 部署副本规则（最高优先级纪律）

`workspace/site_inner/` 是部署副本（~11K 行）。**禁止手改**，流程：

```
改 src/ → npm run typecheck → scripts/sync-site-inner.ps1 同步 → 部署
```

历史上"修完这个那个坏"的头号元凶就是改了副本没改源码（或反之）。
sync 脚本落地前，至少要做到：部署前 diff 一遍 src/ 与 site_inner/src/。

## 5. 环境变量（.env）

- `JWT_SECRET`：必配，没配引擎起不来（fail-fast）
- `JWT_SECRET_FALLBACKS`：云平台 token 兼容，生产用完清空
- `ALLOW_PUBLIC_ADMIN_AUTO`：公网免登录开关，**生产严禁 =1**
- 模板见 `.env.example`；`.env.bak-*` 是历史备份，清理时归档

## 6. CI

`.github/workflows/ci.yml` 当前单文件。规划中：
- typecheck + 冒烟必须过
- tag 触发三平台打包（exe/deb/AppImage/dmg）
- 产物上传 release

---

## 回归测试清单（改部署/发版必跑）

- [ ] 版本号三处一致（package.json / 根 version.txt / src/version.txt）
- [ ] `npm run typecheck` 绿
- [ ] `npm start` 能起，健康检查 200
- [ ] deploy.sh 在干净 Ubuntu 容器跑通（历史验证过 22.04）
- [ ] install.sh --help 正常，darwin 分支语法检查通过（bash -n）
- [ ] install.ps1 在 PowerShell 5.1 与 7 都能跑
- [ ] 升级接口三平台分流正确（win/linux/darwin 各返回对应包）
- [ ] .env 缺 JWT_SECRET 时启动失败且报错清晰（不是静默起半截）

## 坑位记录

### 2026-08-29（建档）版本号三处不同步（活案例）
- 现状：src/version.txt = 2.0.12，根 version.txt / package.json = 2.0.13
- 风险：升级接口按 src/version.txt 判断时会给用户推"升级"到同版本，
  或桌面壳健康检查误判
- 待办：①立即把 src/version.txt 同步为 2.0.13；②长期改为构建时从
  package.json 生成，消灭手工同步

### 2026-08-28 install.sh/deploy.sh 多轮修改
- 三平台安装脚本改动频繁（8/28、8/29 连续两轮），每次改完必须在
  至少一个真实 Linux 容器跑冒烟，防止"脚本跑完但服务起不来"（glibc 类问题）