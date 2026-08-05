import UIKit
import Capacitor

/**
 * 灵犀引擎 - iOS AppDelegate
 *
 * 集成 Capacitor + nodejs-mobile 引擎：
 * - App 启动时启动引擎
 * - 引擎就绪后加载 WebView
 * - 前后台切换管理引擎生命周期
 */
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {

        // 启动引擎
        EngineManager.shared.onEngineReady = {
            print("[AppDelegate] Engine ready, WebView can connect")
            // 发送通知给 Capacitor WebView
            NotificationCenter.default.post(name: NSNotification.Name("LingxiEngineReady"), object: nil)
        }
        EngineManager.shared.startEngine()

        return true
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // 回到前台：恢复引擎
        EngineManager.shared.resumeEngine()
        print("[AppDelegate] App foreground - engine resumed")
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // 进入后台：iOS 限制后台执行
        // 引擎会在 App 挂起时自动暂停
        EngineManager.shared.stopEngine()
        print("[AppDelegate] App background - engine paused")

        // 请求额外后台时间（保存数据库）
        var bgTask: UIBackgroundTaskIdentifier = .invalid
        bgTask = application.beginBackgroundTask {
            application.endBackgroundTask(bgTask)
            bgTask = .invalid
        }

        // 通知引擎保存数据
        DispatchQueue.global().async {
            // 给引擎 5 秒保存数据
            Thread.sleep(forTimeInterval: 2)
            application.endBackgroundTask(bgTask)
            bgTask = .invalid
        }
    }

    func applicationWillTerminate(_ application: UIApplication) {
        print("[AppDelegate] App terminating")
    }

    // ── Capacitor 必需 ──

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return CAPBridge.handleOpenUrl(url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity,
                     restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return CAPBridge.handleContinueActivity(userActivity, restorationHandler: restorationHandler)
    }
}
