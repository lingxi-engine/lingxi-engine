# 灵犀引擎 App - Capacitor 原生壳

## 打包步骤

### 前置条件
- Node.js 18+
- 灵犀引擎已能正常 `npm start` 运行

### iOS（需要 macOS）
```bash
# 安装 Capacitor
npm install @capacitor/core @capacitor/cli
npm install @capacitor/ios @capacitor/push-notifications @capacitor/local-notifications
npm install @capacitor/splash-screen @capacitor/status-bar

# 初始化 iOS 项目
npx cap init 灵犀引擎 com.lingxi.engine --web-dir=web
npx cap add ios

# 同步 Web 资源
npx cap sync ios

# 打开 Xcode
npx cap open ios
# 在 Xcode 中配置签名、推送通知权限，然后 Build
```

### Android
```bash
# 安装 Capacitor（如果上面没装）
npm install @capacitor/core @capacitor/cli
npm install @capacitor/android @capacitor/push-notifications @capacitor/local-notifications
npm install @capacitor/splash-screen @capacitor/status-bar

# 初始化 Android 项目
npx cap init 灵犀引擎 com.lingxi.engine --web-dir=web
npx cap add android

# 同步 Web 资源
npx cap sync android

# 打开 Android Studio
npx cap open android
# 在 Android Studio 中配置 FCM 推送，然后 Build APK
```

### 配置服务器地址

编辑 `app/capacitor.config.json` 中的 `server.url`：
- 本地测试：`http://localhost:3456`
- 远程服务器：`https://your-server.com:3456`

### 推送通知配置

#### iOS (APNs)
1. 在 Apple Developer Portal 创建 App ID，启用 Push Notifications
2. 创建 APNs Key
3. 在灵犀引擎 .env 中配置：
   ```
   PUSH_APNS_KEY=...
   PUSH_APNS_KEY_ID=...
   PUSH_APNS_TEAM_ID=...
   ```

#### Android (FCM)
1. 在 Firebase Console 创建项目
2. 添加 Android 应用，下载 google-services.json
3. 放入 app/android/app/google-services.json
4. 在灵犀引擎 .env 中配置：
   ```
   PUSH_FCM_SERVER_KEY=...
   PUSH_FCM_PROJECT_ID=...
   ```

### 构建 APK（Android）

```bash
cd android
./gradlew assembleRelease
# APK 输出：android/app/build/outputs/apk/release/app-release.apk
```

### 构建 IPA（iOS）

```bash
# 在 Xcode 中 Product → Archive → Export
```

## 注意事项

- Capacitor 原生壳是 Web 内核，所以前端体验和浏览器一致
- WebSocket 在移动端会自动通过 Capacitor 的原生网络层
- 推送通知需要用户授权
- 后台保活通过 Capacitor 的 Background Task 插件实现
- iOS 需要真机才能测试推送，模拟器不支持