import Foundation
import NodeMobile

/**
 * 灵犀引擎 - iOS 引擎管理器
 *
 * 管理 nodejs-mobile 引擎的生命周期：
 * - 启动引擎（前台时）
 * - 暂停引擎（后台时，iOS 限制）
 * - 数据持久化到 App 沙盒
 */
class EngineManager {
    static let shared = EngineManager()

    private var engineThread: Thread?
    private var isRunning = false
    private(set) var isReady = false
    private let enginePort = 3456

    // 引擎就绪回调
    var onEngineReady: (() -> Void)?

    private init() {}

    /// 获取数据目录（App 沙盒内）
    var dataDir: String {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("lingxi/data")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }

    /// 获取模型目录
    var modelsDir: String {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("lingxi/models")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }

    /// 启动引擎
    func startEngine() {
        guard !isRunning else { return }
        isRunning = true

        engineThread = Thread { [weak self] in
            self?.runEngine()
        }
        engineThread?.name = "lingxi-engine"
        engineThread?.qualityOfService = .userInitiated
        engineThread?.start()

        print("[EngineManager] Engine thread started")
    }

    /// 引擎主循环
    private func runEngine() {
        // 设置环境变量
        setenv("LINGXI_DATA_DIR", dataDir, 1)
        setenv("LINGXI_PORT", String(enginePort), 1)
        setenv("LINGXI_MOBILE", "true", 1)
        setenv("LINGXI_MODEL_DIR", modelsDir, 1)
        setenv("NODE_ENV", "production", 1)

        // 获取 bundle 中的引擎脚本路径
        guard let scriptPath = Bundle.main.path(forResource: "lingxi-mobile", ofType: "js", inDirectory: "nodejs-project") else {
            print("[EngineManager] ERROR: lingxi-mobile.js not found in bundle")
            return
        }

        print("[EngineManager] Starting nodejs-mobile with: \(scriptPath)")

        // 启动 nodejs-mobile
        NodeMobile.runNode(withArguments: [scriptPath])

        // 等待引擎就绪
        waitForEngine(timeout: 30)
    }

    /// 轮询等待引擎端口就绪
    private func waitForEngine(timeout: Int) {
        let deadline = Date().addingTimeInterval(TimeInterval(timeout))
        while Date() < deadline {
            if isPortOpen(port: enginePort) {
                isReady = true
                print("[EngineManager] Engine ready on port \(enginePort)")
                DispatchQueue.main.async { [weak self] in
                    self?.onEngineReady?()
                }
                return
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        print("[EngineManager] WARNING: Engine not ready after \(timeout)s")
    }

    /// 检查端口是否开放
    private func isPortOpen(port: Int) -> Bool {
        let socket = socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { return false }
        defer { close(socket) }

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")

        let result = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return result == 0
    }

    /// 停止引擎（iOS 进入后台时调用）
    func stopEngine() {
        // iOS 后台限制：引擎会在 App 挂起时自动暂停
        // 这里只做标记
        print("[EngineManager] Engine paused (background)")
    }

    /// 恢复引擎（iOS 回到前台时调用）
    func resumeEngine() {
        if isRunning && !isReady {
            // 重新检查端口
            if isPortOpen(port: enginePort) {
                isReady = true
                print("[EngineManager] Engine resumed")
            }
        }
    }
}
