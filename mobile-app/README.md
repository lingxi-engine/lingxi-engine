# 灵犀引擎 Android App（mobile-app/）

零第三方依赖的 WebView 壳：打开即连你自托管实例的移动端入口（例如 `https://your-domain.example/m/`），
聊天、智能体、工作流、技能市场全功能与桌面同源；在分发前请先把当前 Android WebView 入口 `./app/src/main/java/com/lingxi/engine/MainActivity.java` 里的 `HOME_URL` 改成你自己的 `/m/` 地址（token 仍存 WebView localStorage）。

当前源码里的默认值仍是历史测试地址；请在执行下面的 `tar -czf apk-src.tgz ...` 打包步骤或任何正式分发构建之前完成替换。

## 构建（服务器云构建，本机无需 Android SDK）

```bash
# 1) 打包源码
tar -czf apk-src.tgz -C mobile-app settings.gradle build.gradle gradle.properties app
# 2) 上传到构建服务器（lingxi-server，已预装 JDK17 + Gradle8.5 + SDK android-34）
scp apk-src.tgz lingxi-server:/tmp/apk-src.tgz
ssh lingxi-server "bash /tmp/build-apk.sh"
# 产物自动落到 /var/www/lingxi/public/lingxi-app.apk（官网下载直链）
```

`/tmp/build-apk.sh` 与 `/tmp/setup-android-build.sh` 的源副本在仓库 `workspace/`（部署用，未入库）。

## 图标

`node mobile-app/gen-icon.cjs mobile-app` 重新生成 5 档密度 PNG（纯 Node，零依赖）。

## 版本

- v1.0.1-webview：WebView 壳 + 错误重试页 + 进度条，minSdk 24 / target 34，debug 签名（测试分发）
- 正式发布需替换 release keystore（`app/build.gradle` signingConfig）

## 后续（v2 计划）

本地引擎版：`app/`（Capacitor + nodejs-mobile 骨架）+ `scripts/build-mobile.mjs`
已能把引擎打成单文件并在 nodejs-mobile 下冒烟通过（/api/mobile/status 200），
差 nodejs-mobile 的 Java 桥接层与真机验证，属独立里程碑。
