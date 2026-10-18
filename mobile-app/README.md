# 灵犀手机 App（v1.2.0）

**一句话：手机是账号的遥控器，不是分身。** 登录同一个账号，就能操控你**电脑上**或**云端**的灵犀；
前提是那台引擎**在线**并且**登录了同一个账号**。

App 内**不含推理运行时、不含模型权重、不跑工具**。全部算力与数据都在引擎所在机器上。

---

## 一、这一版做了什么

| 能力 | 说明 |
|---|---|
| 账号登录 | App 内直接登录（邮箱 / 账号 + 密码），登录后即进入控制台 |
| 我的灵犀 | 列出**云端** + **你自己的电脑**上的所有引擎，实时显示在线 / 离线 |
| 在线判定 | 电脑端登录账号后自动登记到云端目录，并每 60 秒心跳；超过 150 秒无心跳即判为离线 |
| 一键接管 | 只对**在线**设备开放。手机向云端申请一次性票据，目标引擎用实例密钥回源校验，换成本地登录态 |
| 三语 | 简体中文 / 繁體中文 / English，App 原生与网页界面同步切换，首次启动跟随系统语言 |
| 自建引擎 | 可填任意地址（`http://192.168.1.10:3456` 或 `https://你的域名`），也可以从电脑端的局域网地址进入 |
| 双向可见 | 手机连到电脑端时，电脑端也会把云端的设备列出来（反之亦然） |

**为什么必须「在线 + 登录同一账号」**：
设备列表是按账号（邮箱）归档的，登记时使用的就是**云端签发的登录凭证**。
没登录过同一账号的机器不会出现在列表里；离线机器显示为灰色，点「接管」会被拒绝（HTTP 409）。

---

## 二、目录与入口

```
web/app/                手机 App 控制台（三语，纯静态 + 同源 API）
  index.html            登录 / 我的灵犀 / 设置
  app.js                三语词典 + 设备列表 + 票据接管
  app.css
  connect.html          一次性票据兑换页（目标引擎上）
src/routes/app-connect.ts  后端连接层（登记 / 心跳 / 票据 / 设备列表）
mobile-app/app/         Android 工程（WebView 壳 + 原生三语）
mobile-app/ios/         iOS 工程（WKWebView 壳 + 原生三语）
mobile-app/build-apk-nogradle.sh  无 Gradle 构建脚本（1GB 内存机器可用）
```

入口：`https://lingxi-engine.com/app/`（云端）。自建引擎则是 `http://你的地址:3456/app/`。

---

## 三、后端接口

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| GET | `/api/app/ping` | 公开 | 探活，手机判断引擎在不在线 |
| GET | `/api/app/instances` | JWT | 我名下的所有引擎（云端 + 电脑），含在线状态 |
| POST | `/api/app/register` | JWT | 电脑端登记到云端（必须用云端账号的 token） |
| POST | `/api/app/heartbeat` | 实例密钥 | 电脑端 60 秒心跳 |
| POST | `/api/app/ticket` | JWT | 手机为某台在线设备申请一次性票据 |
| POST | `/api/app/ticket/verify` | 实例密钥 | 云端校验票据（电脑端回源调用） |
| POST | `/api/app/ticket/redeem` | 票据 | 目标引擎兑换本地登录态 |
| GET/POST | `/api/app/status` `/api/app/link` | JWT | 本机绑定状态 / 手动绑定云端 |

**安全设计**

- 登记必须携带**云端账号 JWT**，无法凭空把别人的机器塞进你的列表；
- 票据 **60 秒过期、一次性、绑定 instanceId**，校验时目标引擎必须出示**实例密钥**；
- 实例密钥在登记时由云端生成，保存在电脑端 `data/app-link.json`；
- 手机端只登录一次，跨引擎不需要重复输入密码；
- `LINGXI_HUB_URL=off` 可完全关闭云端登记（纯离线部署）。

---

## 四、三语

| 位置 | 简体 | 繁體 | English |
|---|---|---|---|
| App 控制台 | ✅ | ✅ | ✅ |
| 聊天界面（/chat/ /m/） | ✅ | ✅ | ✅ |
| Android 原生壳（弹窗、状态条） | ✅ | ✅ | ✅ |
| iOS 原生壳 | ✅ | ✅ | ✅ |

切换方式：App 右上角「中文 ▾」；Android 顶栏「文」；iOS 顶栏「文」。
选择保存在本地，下次启动沿用；未选择时跟随系统语言。

---

## 五、构建 Android APK

本机没有 JDK / Android SDK，用构建服务器（已装 JDK17 + SDK 34）：

```bash
scp -r mobile-app/app lingxi-server:/tmp/apk-src/app
scp mobile-app/build-apk-nogradle.sh lingxi-server:/tmp/build-apk.sh
ssh lingxi-server "bash /tmp/build-apk.sh"
# 产物：/tmp/lingxi-app.apk（已用 lingxi-release.jks 签名）
```

产物已放到：

- 线上：`https://lingxi-engine.com/lingxi-app.apk`
- 仓库：`mobile-app/lingxi-app-v1.2.0.apk`

版本：`versionCode 4 / versionName 1.2.0-app`，minSdk 24，targetSdk 34。
签名证书 SHA-256：`fc3654fdab59a4bb331bf7bfb492518593934d3f2dab8942a7b43a2546713753`
（如需上架应用商店，请换成你自己的正式 keystore。）

---

## 六、iOS

需要 Mac + Xcode 15+：

```bash
brew install xcodegen
cd mobile-app/ios && xcodegen generate
open LingxiEngine.xcodeproj    # 填 DEVELOPMENT_TEAM 后 Archive
```

没有 Mac 时：Safari 打开 `https://lingxi-engine.com/app/` → 分享 → **添加到主屏幕**，
效果与 App 一致（全屏、独立图标、离线壳）。

---

## 七、上线检查清单

- [x] 云端已部署 `/app/`、`/app/connect`、`/api/app/*`
- [x] `.env` 增加 `APP_PUBLIC_URL=https://lingxi-engine.com`（否则云端自报地址会是内网 IP）
- [x] nginx：`/app/` 代理到引擎，`/m/` 不再跳说明页
- [x] APK 已签名并可从官网下载
- [ ] 电脑端引擎升级到本版本并**重启一次**（重启后登录账号即自动登记）
- [ ] 如需公网访问家里的电脑：给 3456 端口做映射，或设置 `APP_PUBLIC_URL=https://你的域名`

---

## 八、已知限制（说清楚，不吹）

1. **电脑端必须能保持运行**。关机、休眠、退出引擎都会变离线。
2. **局域网场景**：手机和电脑要在同一 WiFi；跨网需公网映射或内网穿透。
3. **iOS 未在真机编译验证**（本机无 macOS），Swift 代码做了静态校验；APK 已在真机可安装级别产出但未做多机型回归。
4. **无推送**：长任务在引擎侧继续跑，但手机不会主动响，切回 App 才能看到进度。
5. 登记目录按**邮箱**归档；电脑端与云端必须使用**同一个邮箱账号**。
