// 灵犀引擎 iOS 远程遥控器
// 角色：远程遥控器（Remote Controller），不是独立 AI 客户端。
//
// 定位（与 Android 端保持一致，勿改）：
//   手机端本身【不产生任何算力】。App 内不含任何推理运行时，不含模型权重，不跑工具。
//   全部智能与算力发生在【引擎所在机器】（你的电脑 / 本地部署 / 云端服务器）上。
//   手机只是同一账号的投影与遥控器：同一套记忆、同一批智能体、同一个工作区、
//   同一批正在运行的长任务、同一批工具能力。
//   - 必须用【同一个账号】登录；
//   - 可指向官方云引擎，也可指向你自己电脑上跑的引擎；
//   - 换地址 = 换引擎，不是换 App。
//
// 依赖：零第三方依赖。全部用系统自带 WebKit。

import UIKit
import WebKit
import UniformTypeIdentifiers

final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = EngineViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

// MARK: - 引擎地址存储

enum EngineStore {
    private static let key = "lingxi.endpoint"
    /// 默认官方云引擎。自部署用户可在「更换引擎地址」里改成自己的。
    static let defaultEndpoint = "http://<SERVER_IP>"

    static var endpoint: String {
        get {
            let raw = UserDefaults.standard.string(forKey: key) ?? ""
            return normalize(raw.isEmpty ? defaultEndpoint : raw)
        }
        set { UserDefaults.standard.set(normalize(newValue), forKey: key) }
    }

    /// 引擎移动端入口。手机端一律走 /m/，保证拿到的是移动版界面。
    static var mobileURL: URL? {
        guard let base = URL(string: endpoint) else { return nil }
        var s = base.absoluteString
        if s.hasSuffix("/") { s.removeLast() }
        return URL(string: s + "/m/")
    }

    static func normalize(_ raw: String) -> String {
        var v = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if v.isEmpty { return "" }
        if !v.hasPrefix("http://") && !v.hasPrefix("https://") { v = "http://" + v }
        while v.hasSuffix("/") { v.removeLast() }
        return v
    }

    static func shorten(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "http://", with: "")
        t = t.replacingOccurrences(of: "https://", with: "")
        if t.count > 22 {
            t = String(t.prefix(10)) + "…" + String(t.suffix(8))
        }
        return t
    }

    /// 是否属于同一台引擎 —— 必须同时比 host 和 port。
    /// 只比 host 的话，同一台机器的 3456（引擎）和 8080（路由器后台）会被误判为站内，
    /// 链接会卡在壳里打不开。
    static func isSameEngine(_ url: URL) -> Bool {
        guard let a = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let b = URLComponents(string: endpoint),
              let h1 = a.host, let h2 = b.host,
              h1.caseInsensitiveCompare(h2) == .orderedSame else { return false }
        let p1 = a.port ?? (a.scheme == "https" ? 443 : 80)
        let p2 = b.port ?? (b.scheme == "https" ? 443 : 80)
        return p1 == p2
    }
}

// MARK: - 主界面：遥控台

final class EngineViewController: UIViewController {

    private var web: WKWebView!
    private let progress = UIProgressView(progressViewStyle: .bar)
    private let statusBar = UILabel()
    private let topBar = UIView()
    private let endpointLabel = UILabel()
    private let errorView = UIStackView()
    private let errorLabel = UILabel()

    private var loadObserver: NSKeyValueObservation?
    private var failed = false

    /// WebView 发起的文件选择回调；非 nil 时说明有一次待处理的选择在飞。
    private var openPanelCompletion: (([URL]?) -> Void)?

    private let topH: CGFloat = 52
    private let statusH: CGFloat = 28

    // MARK: 生命周期

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.051, green: 0.067, blue: 0.090, alpha: 1)

        buildTopBar()
        buildWebView()
        buildProgress()
        buildStatusBar()
        buildErrorView()

        loadEngine()
    }

    deinit { loadObserver?.invalidate() }

    // MARK: 顶栏

    private func buildTopBar() {
        topBar.backgroundColor = UIColor(red: 0.086, green: 0.106, blue: 0.133, alpha: 1)
        topBar.isUserInteractionEnabled = true
        view.addSubview(topBar)

        let icon = UIImageView(image: UIImage(systemName: "sparkles"))
        icon.tintColor = UIColor(red: 0.49, green: 0.36, blue: 1, alpha: 1)
        icon.contentMode = .scaleAspectFit
        icon.isUserInteractionEnabled = false
        topBar.addSubview(icon)

        let title = UILabel()
        title.text = "灵犀引擎"
        title.textColor = UIColor(red: 0.902, green: 0.929, blue: 0.953, alpha: 1)
        title.font = .systemFont(ofSize: 15, weight: .semibold)
        title.isUserInteractionEnabled = false
        topBar.addSubview(title)

        endpointLabel.font = .systemFont(ofSize: 11)
        endpointLabel.textColor = UIColor(red: 0.486, green: 0.522, blue: 0.565, alpha: 1)
        endpointLabel.lineBreakMode = .byTruncatingMiddle
        endpointLabel.textAlignment = .right
        endpointLabel.isUserInteractionEnabled = false
        topBar.addSubview(endpointLabel)

        let refresh = UIButton(type: .system)
        refresh.setImage(UIImage(systemName: "arrow.clockwise"), for: .normal)
        refresh.tintColor = UIColor(red: 0.486, green: 0.522, blue: 0.565, alpha: 1)
        refresh.addTarget(self, action: #selector(reloadEngine), for: .touchUpInside)
        topBar.addSubview(refresh)

        // 点顶栏任意处（除刷新键）都能换引擎
        topBar.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(promptEndpoint)))

        topBar.translatesAutoresizingMaskIntoConstraints = false
        icon.translatesAutoresizingMaskIntoConstraints = false
        title.translatesAutoresizingMaskIntoConstraints = false
        endpointLabel.translatesAutoresizingMaskIntoConstraints = false
        refresh.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topBar.topAnchor.constraint(equalTo: view.topAnchor),
            topBar.heightAnchor.constraint(equalToConstant: topH),

            icon.leadingAnchor.constraint(equalTo: topBar.leadingAnchor, constant: 14),
            icon.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 20),
            icon.heightAnchor.constraint(equalToConstant: 20),

            title.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            title.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            title.trailingAnchor.constraint(lessThanOrEqualTo: endpointLabel.leadingAnchor, constant: -8),

            refresh.trailingAnchor.constraint(equalTo: topBar.trailingAnchor, constant: -6),
            refresh.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            refresh.widthAnchor.constraint(equalToConstant: 40),
            refresh.heightAnchor.constraint(equalToConstant: 40),

            endpointLabel.trailingAnchor.constraint(equalTo: refresh.leadingAnchor, constant: -6),
            endpointLabel.centerYAnchor.constraint(equalTo: topBar.centerYAnchor),
            endpointLabel.widthAnchor.constraint(lessThanOrEqualToConstant: 150)
        ])
    }

    // MARK: WebView

    private func buildWebView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        if #available(iOS 15.0, *) {
            config.defaultWebpagePreferences.allowsContentJavaScript = true
        }

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        view.addSubview(web)

        loadObserver = web.observe(\.estimatedProgress, options: [.new]) { [weak self] w, _ in
            guard let self = self else { return }
            self.progress.setProgress(Float(w.estimatedProgress), animated: false)
            self.progress.isHidden = w.estimatedProgress >= 1.0
        }
    }

    // MARK: 进度条 / 状态条

    private func buildProgress() {
        progress.progressTintColor = UIColor(red: 0.49, green: 0.36, blue: 1, alpha: 1)
        progress.trackTintColor = .clear
        view.addSubview(progress)
    }

    private func buildStatusBar() {
        statusBar.font = .systemFont(ofSize: 11)
        statusBar.textColor = UIColor(red: 0.486, green: 0.522, blue: 0.565, alpha: 1)
        statusBar.backgroundColor = UIColor(red: 0.086, green: 0.106, blue: 0.133, alpha: 1)
        statusBar.text = "正在连接引擎…"
        view.addSubview(statusBar)
    }

    private func buildErrorView() {
        errorView.axis = .vertical
        errorView.alignment = .center
        errorView.spacing = 12
        errorView.backgroundColor = view.backgroundColor
        errorView.isHidden = true
        view.addSubview(errorView)

        let icon = UILabel()
        icon.text = "📡"
        icon.font = .systemFont(ofSize: 48)
        errorView.addArrangedSubview(icon)

        errorLabel.font = .systemFont(ofSize: 15)
        errorLabel.textColor = UIColor(red: 0.788, green: 0.819, blue: 0.851, alpha: 1)
        errorLabel.textAlignment = .center
        errorLabel.numberOfLines = 0
        errorLabel.text = "无法连接到灵犀引擎"
        errorView.addArrangedSubview(errorLabel)

        let retry = UIButton(type: .system)
        retry.setTitle("重 试", for: .normal)
        retry.setTitleColor(.white, for: .normal)
        retry.backgroundColor = UIColor(red: 0.49, green: 0.36, blue: 1, alpha: 1)
        retry.layer.cornerRadius = 8
        retry.contentEdgeInsets = UIEdgeInsets(top: 10, left: 28, bottom: 10, right: 28)
        retry.addTarget(self, action: #selector(reloadEngine), for: .touchUpInside)
        errorView.addArrangedSubview(retry)

        let settings = UIButton(type: .system)
        settings.setTitle("更换引擎地址", for: .normal)
        settings.setTitleColor(UIColor(red: 0.788, green: 0.819, blue: 0.851, alpha: 1), for: .normal)
        settings.addTarget(self, action: #selector(promptEndpoint), for: .touchUpInside)
        errorView.addArrangedSubview(settings)
    }

    // MARK: 加载

    private func loadEngine() {
        endpointLabel.text = EngineStore.shorten(EngineStore.endpoint)
        guard let url = EngineStore.mobileURL else {
            showError("引擎地址无效\n\n\(EngineStore.endpoint)")
            return
        }
        failed = false
        errorView.isHidden = true
        statusBar.text = "正在连接引擎…"
        web.load(URLRequest(url: url))
    }

    @objc private func reloadEngine() {
        failed = false
        errorView.isHidden = true
        loadEngine()
    }

    // MARK: 错误

    private func showError(_ msg: String) {
        failed = true
        errorLabel.text = msg
        errorView.isHidden = false
        statusBar.text = "未连接"
    }

    // MARK: 换引擎

    @objc private func promptEndpoint() {
        let alert = UIAlertController(
            title: "选择要遥控的引擎",
            message: "填你电脑 / 云端上那台灵犀引擎的地址。\n换一个地址就是换一个引擎，请用同一账号登录。\n\n手机不产生算力，这里填的机器才是真正干活的。",
            preferredStyle: .alert
        )
        alert.addTextField { tf in
            tf.text = EngineStore.endpoint
            tf.placeholder = "例如 http://192.168.1.10:3456"
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.autocorrectionType = .no
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel))
        alert.addAction(UIAlertAction(title: "恢复官方云端", style: .default) { [weak self] _ in
            UserDefaults.standard.removeObject(forKey: "lingxi.endpoint")
            self?.clearWebsiteData()
            self?.loadEngine()
        })
        alert.addAction(UIAlertAction(title: "连接", style: .default) { [weak self] _ in
            let before = EngineStore.endpoint
            let typed = EngineStore.normalize(alert.textFields?.first?.text ?? "")
            if !typed.isEmpty {
                EngineStore.endpoint = typed
                // 换引擎 = 换一套会话，清干净免得串号
                if typed != before { self?.clearWebsiteData() }
            }
            self?.loadEngine()
        })
        present(alert, animated: true)
    }

    /// 换引擎时清掉旧会话（Cookie / localStorage），否则会带着上一个引擎的登录态串号。
    private func clearWebsiteData() {
        let types = WKWebsiteDataStore.allWebsiteDataTypes()
        web.configuration.websiteDataStore
            .removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self] in
                // URL 删完才 reset，否则 localStorage 还会残留
                self?.web.configuration.websiteDataStore.httpCookieStore
                    .deleteAllCookies { }
            }
    }

    // MARK: 布局

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let safe = view.safeAreaInsets
        let w = view.bounds.width
        let h = view.bounds.height

        topBar.frame = CGRect(x: 0, y: 0, width: w, height: safe.top + topH)

        let webTop = topBar.frame.maxY
        let webH = max(0, h - webTop - statusH)
        web.frame = CGRect(x: 0, y: webTop, width: w, height: webH)
        errorView.frame = web.frame
        progress.frame = CGRect(x: 0, y: webTop - 2, width: w, height: 2)
        statusBar.frame = CGRect(x: 0, y: h - statusH, width: w, height: statusH)
    }
}

// MARK: - WKNavigationDelegate

extension EngineViewController: WKNavigationDelegate {

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if !failed {
            errorView.isHidden = true
            statusBar.text = "已连接 · 算力运行在引擎端（你的电脑或云端）"
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showError(Self.describe(error))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showError(Self.describe(error)
            + "\n\n· 手机和引擎要在同一网络，或引擎已开放公网地址"
            + "\n· 确认引擎已启动并在监听端口"
            + "\n· 顶栏点一下可以更换引擎地址")
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if EngineStore.isSameEngine(url) {
            decisionHandler(.allow)
            return
        }
        // 站内留 WebView；外链交给 Safari，避免卡在壳里出不去
        UIApplication.shared.open(url, options: [:]) { _ in decisionHandler(.cancel) }
    }

    /// 引擎活着但返回 4xx/5xx 时也要给提示，否则用户对着白屏发呆。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let http = navigationResponse.response as? HTTPURLResponse,
           let url = navigationResponse.response.url,
           EngineStore.isSameEngine(url) {
            let code = http.statusCode
            if code == 404 {
                showError("这台引擎上没有手机版页面\n\n地址：\(url.absoluteString)\n\n(HTTP 404)"
                    + "\n\n· 这台引擎可能不是灵犀引擎，或版本太老"
                    + "\n· 请到引擎根地址确认一下，再重试")
                decisionHandler(.cancel)
                return
            }
            if code >= 400 {
                showError("引擎返回了错误\n\n地址：\(url.absoluteString)\n\n(HTTP \(code))"
                    + "\n\n· 引擎服务可能正在重启，稍后重试")
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    private static func describe(_ error: Error) -> String {
        let ns = error as NSError
        var head = "连不上这台引擎"
        var detail = ns.localizedDescription
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorTimedOut:
                head = "连接超时"
            case NSURLErrorCannotFindHost:
                head = "找不到这台引擎"
            case NSURLErrorCannotConnectToHost:
                head = "引擎端口没开"
            case NSURLErrorNotConnectedToInternet:
                head = "手机没连网"
            case NSURLErrorSecureConnectionFailed:
                head = "HTTPS 证书有问题"
            case NSURLErrorAppTransportSecurityRequiresSecureConnection:
                head = "系统禁止了不安全的 http 连接"
                detail = "iOS 默认拦截 http。请用 https 访问这台引擎，或在 Info.plist 放开 ATS。"
            default:
                head = "连不上这台引擎"
            }
        }
        let url = EngineStore.mobileURL?.absoluteString ?? EngineStore.endpoint
        return "\(head)\n\n地址：\(url)\n\n\(detail)"
    }
}

// MARK: - WKUIDelegate（文件选择 / 新窗口）

extension EngineViewController: WKUIDelegate {

    /// 引擎里点附件上传：拉起系统文件选择器。
    /// 缺这个实现，WebView 会静默取消 —— 用户表现为「点了附件没反应」。
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        // 引擎可能只接受图片/文档，按它要的类型给筛选器
        var types: [UTType] = [.data]
        if parameters.acceptsImages { types.append(.image) }
        if parameters.acceptsMedia {
            types.append(contentsOf: [.movie, .audio])
        }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.allowsMultipleSelection = parameters.allowsMultipleSelection
        picker.delegate = self
        picker.modalPresentationStyle = .formSheet

        // 已有一次选择在进行中，先把它取消掉，避免回调泄漏
        if let prev = openPanelCompletion { prev(nil) }
        openPanelCompletion = completionHandler
        present(picker, animated: true)
    }

    /// 引擎里 window.open 弹新标签：站内留壳内，站外交给 Safari。
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 forWindowFeatures windowFeatures: WKWindowFeatures) {
        guard let url = navigationAction.request.url else { return }
        if EngineStore.isSameEngine(url) {
            webView.load(URLRequest(url: url))
        } else {
            UIApplication.shared.open(url, options: [:])
        }
    }

    /// JS alert/confirm/prompt：壳内必须处理，否则网页弹窗全部卡死。
    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "好", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "确定", style: .default) { _ in
            completionHandler(a.textFields?.first?.text)
        })
        present(a, animated: true)
    }
}

// MARK: - 文件选择结果回填

extension EngineViewController: UIDocumentPickerDelegate {

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        // asCopy: true 时文件已拷进沙盒，引擎端可以直接读
        let completion = openPanelCompletion
        openPanelCompletion = nil
        completion?(urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let completion = openPanelCompletion
        openPanelCompletion = nil
        completion?(nil)
    }
}
