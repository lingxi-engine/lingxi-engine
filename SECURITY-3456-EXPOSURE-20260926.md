# 3456 端口暴露面评估报告（"好多大模型可以直接用" 复核）

- 日期：2026-09-26
- 触发：用户在浏览器打开 `http://localhost:3456` 后反馈"好像不干净啊，好多大模型都在上面可以直接用"
- 结论：**没有密钥泄漏，但存在一个真实的内网免登录暴露面**，已在本提交中提供可配置开关（默认行为不变）。

---

## 一、先说清楚"你看到的到底是哪个引擎"

| 探测项 | 本机（Windows，浏览器点开的那个） | 新装的 Linux 服务器 |
|---|---|---|
| 版本 | `2.0.23 / f113593`（9/23 构建，进程 9/24 启动，旧进程未重启） | `2.0.27`（本次安装部署） |
| `/api/health` | 实测返回 2.0.23 | — |
| 模型数 | **31 个**（实测 `/api/models`） | 取决于是否填了 API Key，默认 0 |
| 默认端口 3456 的浏览器结果 | 命中的是**本机引擎** | 未建隧道时**访问不到** |

> 关键：你在浏览器点 `http://localhost:3456`，如果**没先建 SSH 隧道**，那打开的就是本机（Windows）上那个引擎，
> 不是刚装好的那台服务器。所以"好多模型"是**你自己这台机器上早就配好的**，不是新服务器带出来的。

## 二、为什么"好多大模型可以直接用"——三条来源，都查清了

1. **本地 Ollama 模型**（`provider: local-ollama`, `isLocal: true`）
   `qwen3.8:27b-32k`、`kimi-k2.7-code:cloud`、`minimax-m3:cloud`、`glm-5.2:cloud` …
   这类本来就**不需要 API Key**（真本地推理，或经本地 Ollama daemon 转发的云端模型），谁连上谁能用。
2. **你自己 `.env` 里配的云端 Key**（NVIDIA / OpenRouter / DeepSeek…）——用户自己的额度，不是别人塞的。
3. **内置 Provider 目录**：`src/ai/hub.ts` 的 `DEFAULT_PROVIDERS` 是写死的目录；没有 Key 的 provider 会被跳过（`if (!cfg.apiKey && !cfg.isLocal) continue;`），所以"看得见一堆、点了报错"是正常的。

## 三、有没有密钥被夹带进发布包？——没有（实测）

| 检查 | 方法 | 结果 |
|---|---|---|
| 线上发布包 `public/lingxi-engine.tar.gz` | 下载 1,246,090 字节后用 tar 解流全量扫描 `nvapi-*` / `sk-or-v1-*` | **NO_HARDCODED_KEYS_FOUND** |
| 包内 `.env.template` | 提取并 grep | 只有占位符 `# NVIDIA_API_KEY=your-key` |
| 包内含 `.env` 吗 | `tar -tzf` | 只有 `.env.example` / `.env.template`，**无 `.env`** |
| 安装脚本写什么 | `site/install.sh` 第 349-362 行 | 只写入 `NVIDIA_API_KEY=`（空值）+ 随机 `JWT_SECRET`/`ADMIN_TOKEN` |

→ 任何下载安装包的人都拿不到别人的 Key。**"不干净"不是这个原因。**

## 四、真正的风险点：内网免登录（这次要修的）

`src/middleware/jwt-auth.ts` 的 `isTrustedLocalSource()`：只要来源是 **loopback 或 RFC1918**（`127.*` / `10.*` / `192.168.*` / `172.16-31.*`），
且请求**不带任何认证头**，就直接注入 `{ sub:'admin', sid:'admin-auto', roles:['admin'] }`。

实测证据：
```
匿名 GET http://127.0.0.1:3456/api/models  →  HTTP 200，返回 31 个模型
```

含义：
- 本机用 → 免登录（这是 v2.0.5 的"个人本地引擎兜底"设计，符合预期）
- **同一 Wi-Fi / 同一内网的任何设备**打开 `http://<本机IP>:3456` → 同样免登录，**直接以 admin 身份**使用你的全部模型额度、会话与数据
- 公网来源**已被拒绝**（v2.0.7 收紧 + XFF 防洗白），这一层没问题

风险等级：**中**（取决于你的局域网里都有谁；家里/办公室独享网段 = 低，宿舍/公司共享网段 = 高）。

## 五、本次交付的开关（默认值 = 旧行为，零变更）

| 环境变量 | 取值 | 作用 |
|---|---|---|
| `BIND_ADDR` | `0.0.0.0`（默认）/ `127.0.0.1` | 监听地址；设 `127.0.0.1` 则只有本机能访问，**内网入口直接消失** |
| `TRUSTED_LOCAL_MODE` | `all`（默认）/ `loopback` / `none` | 谁可以免登录：`all`=本机+内网；`loopback`=仅本机；`none`=一律要凭证 |

### 推荐配置

**A. 本机（Windows）想要"更干净的本地体验"**——在 `.env` 里加一行：
```
TRUSTED_LOCAL_MODE=loopback
```
效果：本机浏览器照旧免登录，同一局域网的其他设备必须带 `ADMIN_TOKEN` 才能进。**不影响你自己用。**

**B. 无头服务器（`iv-yegto0qfb4h0t6hif3e5`）**——它只通过 SSH 隧道访问，最干净的是：
```
BIND_ADDR=127.0.0.1
```
效果：只有隧道/本机能连，公网、内网都摸不到。

### 复核命令（改完重启后跑）

```bash
curl -s http://127.0.0.1:3456/api/health
curl -s -o /dev/null -w "anon /api/models -> %{http_code}\n" http://127.0.0.1:3456/api/models
# 从**另一台**内网机器跑（应得 401）：
curl -s -o /dev/null -w "lan anon -> %{http_code}\n" http://<本机IP>:3456/api/models
```

## 六、验证与兼容性

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ 0 错误 |
| `npx vitest run` | ✅ 6 文件 **110/110**（原 100 + 新增 10） |
| 新增测试 | `src/tests/auth-trust.test.ts`：三种模式 / XFF 伪造防护 / `::ffff:` 归一化 / fail-closed |
| 默认行为 | 与旧版**完全一致**（不设环境变量时不改变任何逻辑） |

## 七、遗留与建议

1. **本机 3456 仍是 2.0.23 的旧进程**（磁盘代码已 2.0.28+）。需要手动重启才能加载新开关：
   ```powershell
   taskkill /F /PID 20184
   cd C:\Users\Administrator\lingxi-engine
   npm start
   ```
   （`taskkill` 被引擎的防自杀保护挡住，AI 端无法代执行——引擎自身就跑在那个进程里。）
2. 服务器侧若要"公网直连也能用"，请务必先设好 `ADMIN_TOKEN` 再放行端口，或走反代 + HTTPS；**不要**设 `ALLOW_PUBLIC_ADMIN_AUTO=1`。
3. 未纳入本提交的未跟踪文件（待你确认是否入库）：`DEPLOY_RECORD_20260926-public-v2.0.28.md`、`skills/release-deploy-verify.json`、`skills/release-verify-publish.json`。
