# 灵犀引擎手机版（mobile-app/）

Android + iOS 双端遥控壳。**零第三方依赖。**
App 内**不含任何推理运行时、不含模型权重、不跑任何工具**。

---

## 一、产品定位：手机不跑模型，手机是账号的遥控器

**手机端本身不产生算力。** 全部智能与算力发生在**引擎所在机器** —— 你的电脑、本地部署机器，或云端服务器。手机只负责渲染界面、下发指令、回收结果。

**智能来自同一个账号。** 用与电脑端／本地部署／云端**完全相同的账号**登录后，手机里出现的就是**同一个灵犀引擎**，不是副本：

- 同一套长期记忆
- 同一批智能体与技能配置
- 同一个工作区与文件
- 同一批正在运行的长任务
- 同一批工具能力（搜索 / 文件 / 终端 / 计算 / 子代理 / 协作）

功能与部署到云端或本地时**完全一致**，因为本来就是同一个引擎。电脑上跑的任务，手机上看进度、继续下指令即可接管；任务仍在引擎侧持续运行，手机息屏也不中断。

> ⚠️ 因此**必须使用同一账号登录**。登录不同账号 = 连到不同的引擎，会话与数据自然不同。
> 自部署场景下，手机访问的正是**你那台引擎**（内网 IP 或公网地址），App 内可随时切换。

一句话：**手机是投影，不是分身。算力在哪台机器上，智能就在哪台机器上。**

---

## 二、目录结构

```
mobile-app/
├── app/                    Android 工程
│   ├── build.gradle        v1.1.0-remote / versionCode 3
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/lingxi/engine/MainActivity.java
│       └── res/layout/activity_main.xml
├── ios/                    iOS 工程
│   ├── EngineViewController.swift   遥控台（UIKit + WKWebView）
│   ├── LingxiEngine-Info.plist      ATS 放开 + 权限文案
│   └── project.yml                 XcodeGen 工程定义
├── gen-icon.cjs            纯 Node 图标生成器
└── README.md
```

两端逻辑**刻意保持一致**：同样的地址存储、同样的 `/m/` 入口、同样的错误文案、同样的「算力在引擎端」状态条。

---

## 三、引擎地址可切换（v1.1.0 新增）

App 不把地址写死。顶栏常驻显示当前引擎地址，点顶栏或错误页「更换引擎地址」即可填写：

| 填什么 | 指向哪台引擎 |
|---|---|
| `http://192.168.1.10:3456` | 家里 / 公司电脑上的自部署引擎 |
| `https://你的域名` | 公网引擎 |
| 留空 / 恢复官方云端 | 官方演示引擎 |

- Android 持久化在 `SharedPreferences("lingxi")`
- iOS 持久化在 `UserDefaults("lingxi.endpoint")`

**换地址 = 换引擎 = 换一套会话。** 切换时自动清空 Cookie / localStorage，避免带着上一个引擎的登录态串号。请用新引擎的账号重新登录。

---

## 四、两端功能对照

| 能力 | Android | iOS | 说明 |
|---|:-:|:-:|---|
| 引擎对话 / 多模型 | ✅ | ✅ | 全部由引擎端执行 |
| 工具调用 | ✅ | ✅ | 服务端执行 |
| 文件上传（附件） | ✅ | ✅ | 走系统文件选择器 |
| 拍照 / 语音输入 | ✅ | ✅ | 需授相机 / 麦克风 |
| 换引擎地址 + 持久化 | ✅ | ✅ | |
| 站外链接跳系统浏览器 | ✅ | ✅ | 不困在壳里 |
| 错误排查页 | ✅ | ✅ | 含 404 / 端口未开 / 证书 / ATS 分类 |
| 下载导出文件 | ✅ | ⚠️ | iOS 交给系统，需手动存到「文件」 |
| JS alert/confirm/prompt | ✅ | ✅ | iOS 必须实现，否则弹窗卡死 |
| 离线可用 | ❌ | ❌ | 无离线缓存，离线即不可用 |

---

## 五、Android 构建

本机无 JDK / Android SDK，走服务器云构建：

```bash
# 1) 打包源码
tar -czf apk-src.tgz -C mobile-app settings.gradle build.gradle gradle.properties app

# 2) 上传到构建服务器（lingxi-server，已预装 JDK17 + Gradle 8.5 + SDK android-34）
scp apk-src.tgz lingxi-server:/tmp/apk-src.tgz
ssh lingxi-server "bash /tmp/build-apk.sh"

# 3) 产物自动落到 /var/www/lingxi/public/lingxi-app.apk（官网下载直链）
```

**正式发布前必须**替换 release keystore —— `app/build.gradle` 当前用 debug 签名，仅供直装验证。

图标：`node mobile-app/gen-icon.cjs mobile-app` 重新生成 5 档密度 PNG（纯 Node，零依赖）。

---

## 六、iOS 构建

需要 Mac + Xcode 15+。工程用 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 从 `ios/project.yml` 生成，**不提交 `.xcodeproj`** 以免合并冲突。

```bash
# 1) 生成工程
brew install xcodegen
cd mobile-app/ios && xcodegen generate

# 2) 命令行出包
xcodebuild -project LingxiEngine.xcodeproj \
           -scheme LingxiEngine \
           -configuration Release \
           -archivePath build/LingxiEngine.xcarchive archive

xcodebuild -exportArchive -archivePath build/LingxiEngine.xcarchive \
           -exportOptionsPlist ExportOptions.plist \
           -exportPath build/export
```

**签名**：需在 `project.yml` 的 `DEVELOPMENT_TEAM` 填你自己的 Apple 开发者 Team ID，并配置 `CODE_SIGN_STYLE: Automatic`。免费账号（Personal Team）签的包**7 天后过期**，只适合自己测试；对外分发需付费开发者账号（$99/年）。

**iOS 特有坑（已在代码中处理）**：

- `NSAllowsArbitraryLoads` 已在 `Info.plist` 放开，否则内网 `http://` 会被系统直接掐断
- 声明了 `NSLocalNetworkUsageDescription`，iOS 14+ 访问局域网会弹权限框
- `UIDocumentPickerViewController(asCopy: true)` —— 沙盒内文件引擎端才能直接读

---

## 七、已知限制（说清楚，别吹）

1. **本机未做真机编译验证。** 无 JDK / Android SDK / macOS，`gradlew` 与 `xcodebuild` 都没跑过。代码只做了静态校验：R.id 引用 ↔ XML 定义对应、布局层级闭合、API 合法性、Swift 语法自检。
2. **无推送通知。** 长任务在引擎侧跑，但手机不会主动响。切回 App 才看得到进度。
3. **无离线缓存。** 断网即白屏，靠错误页提示重连。
4. **`.apk` 官网直链是否有效需在服务器核实。** 历史上测到 `lingxi-app.apk` 曾返回 HTML 而非安装包。
5. **iOS 上传文件不落「文件」App。** 需自行长按导出。

---

## 八、版本

| 版本 | 说明 |
|---|---|
| v1.1.0-remote | 引擎地址可切换并持久化、顶栏显示连接目标、状态条明示算力在引擎端、**文件上传回调补全**、**HTTP 错误页补全**、**站内判定加端口比对**、**换引擎清会话**、**退出二次确认**、**iOS 壳落地** |
| v1.0.1-webview | 初版 WebView 壳 + 错误重试页 + 进度条 |
| v1.0.0 | 首个 WebView 壳 |

---

## 九、v2 计划（尚未开始）

真正的本地引擎版：`app/`（Capacitor + nodejs-mobile 骨架）+ `scripts/build-mobile.mjs`。
已能把引擎打包成单文件并在 nodejs-mobile 下冒烟通过（`/api/mobile/status` 200），差 Java 桥接层与真机验证，属独立里程碑。

> ⚠️ v2 是**手机本地跑引擎**，算力在手机自己身上 —— 与当前 v1.1 的「遥控器」定位**完全不同**。两者是独立产品线，不要混为一谈。
