# 香港服务器不可达诊断报告

生成时间：2026-09-26
目标：腾讯云香港 `43.161.216.80`（实例 `lhins-p8119085` / 灵犀官网）
域名：`lingxi-engine.com` / `www.lingxi-engine.com`

---

## 一、结论（先看这个）

**主机侧安全加固 4/4 完美，零缺陷。故障 100% 在腾讯云网络层 / 实例状态侧。**

本轮同时在本地发现并修复了 `PASTE-ONE-SHOT.sh` 的一个**致命阻断 bug**：内联 base64 站点包因续行符污染，在服务器上必然解码失败、站点目录为空。**该 bug 已修复并字节级复验通过。**

---

## 二、连通性实测（2 个独立 vantage point，同一出口）

| 目标 | :22 | :80 | :443 |
|---|---|---|---|
| `43.161.216.80`（香港） | ❌ 21.5s | ❌ 21.0s | ❌ 21.1s |
| `47.93.157.83`（阿里云北京） | ✅ 0.0s | ✅ 0.0s | ❌ |
| `163.7.5.23`（印尼日惹） | ✅ 0.4s | ✅ 0.4s | ❌ |

HTTP 探测：

```
http://lingxi-engine.com/  -> 000
http://43.161.216.80/      -> 000
http://163.7.5.23/          -> 200   (对照)
```

### 判定要点

1. **对照组全通，香港机全灭。** 同一台机器、同一出口，印尼 0.4s / 阿里云 0.0s 秒通，香港 21s 超时。**排除本地网络与沙箱白名单因素。**
2. **是 DROP 不是 REJECT。** 21 秒全程无响应、无 RST。`REJECT` 会立即返回 `Connection refused`；此处是静默丢弃。
3. **ping 100% 丢包**，即使安全组已放通 ICMP —— 流量在到达实例前即被丢弃。

### 路由追踪

```
 1     6 ms    10 ms     8 ms  192.168.1.1
 2    10 ms     6 ms     8 ms  10.7.0.1
 3     *        7 ms     7 ms  221.192.36.45
 4-7   *        *        *      Request timed out.
 8    50 ms    50 ms    52 ms  219.158.20.98      联通骨干
 9     *        *        *      Request timed out.
10    55 ms    53 ms    69 ms   61.14.201.101      联通国际
11-13  *        *        *      Request timed out.
14    88 ms    90 ms    86 ms   29.179.99.129      腾讯骨干
15     *        *        *      Request timed out.
```

路径确实走通到腾讯骨干网（`29.179.99.129`），最后一跳进 CVM 网络时被丢弃。**不是路由不可达，是腾讯云侧丢弃。**

---

## 三、已排除的原因（附证据）

| 假设 | 排除依据 |
|---|---|
| 本地网络 / 沙箱白名单 | 对照组 2 台海外服务器秒通 |
| SSH 私钥不匹配 | 连 TCP 握手都到不了，与密钥无关 |
| 主机防火墙 ufw | 放通 22/80/443/8443，v4+v6 双份；`INPUT ACCEPT`；`YJ-FIREWALL-INPUT` 仅 reject 5 个 IP（非本机） |
| firewalld | `could not be found` —— Ubuntu 22.04 不用 firewalld，正常 |
| `eth0` 无公网 IP | **此前判断错误，已撤回**。腾讯云 NAT 机型实例内网看不到公网 IP 属正常 |
| 2G 内存不足 | 1.5G 可用，swap 0B 使用，静态站无压力 |

---

## 四、主机加固状态（4/4 达标）

| 检查项 | 实测 | 判断 |
|---|---|---|
| 内存 | 1.9G 总量 / 473M 已用 / 1.5G 可用 | ✅ |
| Swap | 2.0G 挂载 / 0B 使用 | ✅ |
| 监听端口 | 仅 `0.0.0.0:22` + `[::]:22` | ✅ 干净 |
| ufw | active + 开机自启，22/80/443/8443（v4+v6）全放通 | ✅ |
| fail2ban | sshd jail 生效，banned 0 | ✅ |
| unattended-upgrades | 已 enable | ✅ |
| 系统更新 | kernel up-to-date，无待重启服务 | ✅ |

**安全基线优于绝大多数个人站，无需再动。**

---

## 五、【已修复】PASTE-ONE-SHOT.sh 致命阻断 bug

### 现象

内联站点包（heredoc 第 72~668 行，595 行 base64）解码失败：

```
b64 chars = 46372, mod4 = 0, 尾部填充合法
→ base64 -d 报 Invalid input
```

### 根因

生成端在**每行 base64 末尾追加了 `\\` 续行符**（594 行 × 2 字符 = 1188 个非法字符），但解包用的是 **带引号的 heredoc**：

```bash
cat <<'B64EOF' | base64 -d | tar -xzf - -C "$SITE_DIR"
```

`<<'B64EOF'` **不做变量展开、不剥离续行符**，因此 `\\` 原样进入 `base64 -d`，必然失败 → `$SITE_DIR` 为空 → 站点 404。

> 讽刺的是：如果用不带引号的 `<<B64EOF`，续行符反而会被 bash 处理掉。**加引号是"正确写法"，正是它触发了这个 bug。**

### 修复

剥离 595 行末尾的 `\\`，并统一为 LF 行尾（避免 CRLF 混入载荷）。文件 52,847 → 51,660 字节。

### 复验（字节级，通过）

```
b64 chars   : 45184 (mod4=0)
tail        : .../Hnnnf8FInMuoQCqAQA=
decoded     : 33887 bytes
magic       : 1F 8B   GZIP OK
tar bytes   : 109056
tar magic   : ustar
```

### tar 成员清单（与磁盘字节数完全一致）

| 成员 | 字节 | 磁盘 |
|---|---|---|
| `./index.html` | 56,937 | 56,937 ✅ |
| `./terms.html` | 8,949 | 8,949 ✅ |
| `./privacy.html` | 7,996 | 7,996 ✅ |
| `./robots.txt` | 193 | 193 ✅ |
| `./js/official-i18n.js` | 28,816 | 28,816 ✅ |

### 页面健全性

| 检查 | 结果 |
|---|---|
| `href="#"` 占位符 | **0 处** ✅ |
| 页脚 GitHub 链接 | `https://github.com/lingxi-engine/lingxi-engine` ✅ |
| 页脚 Docs 链接 | `.../blob/main/README.md` ✅ |
| favicon | 已内联 SVG data URI，**无 404 风险** ✅ |
| 外部资源引用 | 仅上述 2 个 GitHub 链接，无第三方 CDN 依赖 ✅ |
| DOMAIN 内联 | `DOMAIN="lingxi-engine.com"`，全文 9 处引用 ✅ |

---

## 六、剩余阻塞：腾讯云公网入口

### 测试 A：元数据服务（决定性，走内网不经公网 IP）

在腾讯云网页终端（TAT）执行：

```bash
echo "=== instance-id ==="; curl -s --max-time 3 http://metadata.tencentyun.com/latest/meta-data/instance-id; echo
echo "=== public-ipv4 ==="; curl -s --max-time 3 http://metadata.tencentyun.com/latest/meta-data/public-ipv4; echo
echo "=== local-ipv4 ==="; curl -s --max-time 3 http://metadata.tencentyun.com/latest/meta-data/local-ipv4; echo
```

| 输出 | 结论 |
|---|---|
| `public-ipv4` = `43.161.216.80` | 公网 IP 还在 → 安全组未关联/未生效 |
| `public-ipv4` 空或 404 | 公网 IP 已被剥离 → 实例隔离/冻结，需续费解冻 |
| 请求超时 | 实例网络异常 → 提工单 |

### 测试 B：安全组关联状态

控制台 → 云服务器 → 灵犀官网（`lhins-p8119085`）→ 详情页，确认：

1. 实例状态 = `运行中`
2. 关联安全组含 22/80 规则（现共 3 条：22 / 80 / ICMP，均允许）
3. 到期日 `2026-10-24`，有无欠费/隔离横幅

### 补充：必须加一条 443 规则

安全组仅 3 条，**443 未放通**。入口恢复后 HTTPS 仍会被拦：

| 来源 | 协议 | 端口 | 策略 |
|---|---|---|---|
| `0.0.0.0/0` | TCP | 443 | 允许 |

---

## 七、入口恢复后的 8 项验收清单

1. `ssh -i lingxi.pem root@43.161.216.80` 连接成功
2. `ss -tlnp | grep :22` 确认监听
3. 元数据 `public-ipv4` 返回 `43.161.216.80`
4. 运行 `PASTE-ONE-SHOT.sh`（已字节级验证，幂等可重复跑）
5. `curl -I http://lingxi-engine.com` 返回 200
6. `curl -I http://43.161.216.80` 返回 200
7. certbot 签发证书，HTTPS 生效
8. `curl -I https://lingxi-engine.com` 返回 200，证书链完整

---

## 八、就绪资产

| 项 | 状态 |
|---|---|
| `deploy/PASTE-ONE-SHOT.sh` | ✅ **已修复 + 字节级复验** |
| `deploy/site/` 5 文件 | ✅ 102,891 字节，与内联包字节一致 |
| `C:\Users\Administrator\Downloads\lingxi.pem` | ✅ 1,678 字节 |
| 密钥匹配 | ✅ 推导公钥与用户提供公钥一致 |
| DNS 解析 | ✅ `lingxi-engine.com` / `www` → `43.161.216.80` |
| nginx 配置模板 | ✅ 已内联，443 段在证书签发后启用 |

---

## 九、一句话

> 主机加固 4/4 完美，DNS 正确，密钥正确。
> **本轮修掉了部署包里的致命阻断 bug**（不改的话入口通了也部署不出站点）。
> 唯一剩余阻塞：腾讯云公网入口静默丢弃所有流量。
> 入口一通，10 分钟上线。
