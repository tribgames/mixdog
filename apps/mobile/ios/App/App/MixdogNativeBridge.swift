import Capacitor
import UIKit
import UserNotifications
import WebKit

/// Which origins may load in the WebView and talk to the native bridge: the
/// bundled pairing screen and the relay origins of paired hosts. Same rules as
/// apps/mobile/src/origins.ts and android OriginPolicy.java, pinned by
/// test-vectors/origin-policy.json.
enum MixdogOriginPolicy {
    static let bundled: Set<String> = ["https://localhost", "capacitor://localhost"]
    private static let savedKey = "mixdog.allowed.origins"
    private static let loopback: Set<String> = ["localhost", "127.0.0.1", "[::1]"]
    private static let maxOrigins = 32

    /// scheme://host[:port], lower-case, default port dropped; nil for anything else.
    static func origin(scheme rawScheme: String, host rawHost: String, port: Int?) -> String? {
        let scheme = rawScheme.lowercased()
        var host = rawHost.lowercased()
        if host.contains(":") && !host.hasPrefix("[") { host = "[\(host)]" }
        guard !host.isEmpty else { return nil }
        if scheme == "capacitor" { return host == "localhost" && port == nil ? "capacitor://localhost" : nil }
        guard scheme == "https" || scheme == "http" else { return nil }
        var suffix = ""
        if let port, port > 0, port != (scheme == "https" ? 443 : 80) { suffix = ":\(port)" }
        return "\(scheme)://\(host)\(suffix)"
    }

    static func origin(of url: URL) -> String? {
        guard url.user == nil, url.password == nil, let scheme = url.scheme, let host = url.host else { return nil }
        return origin(scheme: scheme, host: host, port: url.port)
    }

    static func origin(of securityOrigin: WKSecurityOrigin) -> String? {
        origin(scheme: securityOrigin.protocol, host: securityOrigin.host,
               port: securityOrigin.port == 0 ? nil : securityOrigin.port)
    }

    /// https, or http on a loopback host.
    static func isRemote(_ origin: String) -> Bool {
        guard let url = URL(string: origin), let host = url.host else { return false }
        if url.scheme == "https" { return true }
        let shown = host.contains(":") ? "[\(host)]" : host
        return url.scheme == "http" && loopback.contains(shown.lowercased())
    }

    static func sanitize(_ list: [Any]) -> [String] {
        var out: [String] = []
        for item in list {
            guard let text = item as? String, let url = URL(string: text.trimmingCharacters(in: .whitespaces)),
                  let origin = origin(of: url), isRemote(origin), !bundled.contains(origin), !out.contains(origin)
            else { continue }
            out.append(origin)
            if out.count >= maxOrigins { break }
        }
        return out
    }

    static var saved: [String] {
        sanitize(UserDefaults.standard.array(forKey: savedKey) ?? [])
    }

    static func save(_ list: [Any]) {
        UserDefaults.standard.set(sanitize(list), forKey: savedKey)
    }

    static func isAllowed(_ origin: String?) -> Bool {
        guard let origin else { return false }
        return bundled.contains(origin) || saved.contains(origin)
    }

    static func isAllowed(url: URL) -> Bool {
        isAllowed(origin(of: url))
    }
}

/// Top-level navigation is limited to the bundled pairing screen and the saved
/// relay origins; any other http(s) link opens in Safari. Everything else is
/// forwarded to Capacitor's own navigation delegate.
final class MixdogNavigationDelegate: NSObject, WKNavigationDelegate {
    private let inner: WKNavigationDelegate

    init(inner: WKNavigationDelegate) {
        self.inner = inner
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || inner.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner.responds(to: aSelector) ? inner : super.forwardingTarget(for: aSelector)
    }

    /// A new page replaced the old one: its pending native downloads go with it.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        MixdogFileSave.shared.abortAll(for: webView)
        inner.webView?(webView, didCommit: navigation)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let topLevel = navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true
        guard topLevel, let url = navigationAction.request.url else {
            // Frames inside a page are not top-level navigation (and get no bridge).
            inner.webView?(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
                ?? decisionHandler(.allow)
            return
        }
        // `<a download>` and blob:/data: links used to be cancelled here (so the
        // download vanished); WebKit downloads them and MixdogDownloadHandler
        // presents the share sheet. blob:/data: have no origin of their own, so
        // the page that started them must be an allowed one.
        if #available(iOS 14.5, *), navigationAction.shouldPerformDownload {
            let source = MixdogOriginPolicy.origin(of: navigationAction.sourceFrame.securityOrigin)
            let local = url.scheme == "blob" || url.scheme == "data"
            if local ? MixdogOriginPolicy.isAllowed(source) : MixdogOriginPolicy.isAllowed(url: url) {
                decisionHandler(.download)
                return
            }
        }
        if url.scheme == "about" || MixdogOriginPolicy.isAllowed(url: url) {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "https" || url.scheme == "http" {
            DispatchQueue.main.async { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
        }
        decisionHandler(.cancel)
    }

    /// A response the WebView cannot show, or an attachment, from an allowed
    /// origin is downloaded instead of dropped.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if #available(iOS 14.5, *), navigationResponse.isForMainFrame,
           let url = navigationResponse.response.url, MixdogOriginPolicy.isAllowed(url: url) {
            let disposition = (navigationResponse.response as? HTTPURLResponse)?
                .value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
            if !navigationResponse.canShowMIMEType || disposition.hasPrefix("attachment") {
                decisionHandler(.download)
                return
            }
        }
        inner.webView?(webView, decidePolicyFor: navigationResponse, decisionHandler: decisionHandler)
            ?? decisionHandler(.allow)
    }

    @available(iOS 14.5, *)
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        MixdogDownloadHandler.shared.attach(download)
    }

    @available(iOS 14.5, *)
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        MixdogDownloadHandler.shared.attach(download)
    }
}

/// Saves a WebKit download to a private temp folder and presents the share
/// sheet (which offers "Save to Files"). The page's own blob downloads go
/// through the `fileSave*` bridge instead; this catches what skips it.
/// UNBUILT / UNVERIFIED: written on a PC that cannot build the iOS app.
@available(iOS 14.5, *)
final class MixdogDownloadHandler: NSObject, WKDownloadDelegate {
    static let shared = MixdogDownloadHandler()
    private var files: [ObjectIdentifier: URL] = [:]

    func attach(_ download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("mixdog-download-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            completionHandler(nil)
            return
        }
        let file = folder.appendingPathComponent(MixdogFileSave.sanitize(suggestedFilename))
        files[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = files.removeValue(forKey: ObjectIdentifier(download)) else { return }
        DispatchQueue.main.async { Self.present(file) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        guard let file = files.removeValue(forKey: ObjectIdentifier(download)) else { return }
        try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }

    private static func present(_ file: URL) {
        let folder = file.deletingLastPathComponent()
        guard let controller = MixdogNativeBridge.shared.viewController else {
            try? FileManager.default.removeItem(at: folder)
            return
        }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: folder) }
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = controller.view
            popover.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        var top: UIViewController = controller
        while let next = top.presentedViewController { top = next }
        top.present(sheet, animated: true)
    }
}

/// `window.mixdogNative` for the bundled pairing screen and paired relay
/// origins only (shared/native-app.ts): a WKUserScript defines the object where
/// the page origin is allowed, and the reply-capable message handler re-checks
/// the calling frame (main frame, allowed origin) on every call. This also
/// owns the notification-center delegate: taps and Allow / Deny are parked and
/// the web app is told with the `mixdognativepush` window event.
final class MixdogNativeBridge: NSObject, WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate {
    static let shared = MixdogNativeBridge()
    static let handlerName = "mixdogNative"
    /// Deny and Allow: an approval the PC's card allows once with a bare Enter (`allowOnce`).
    static let approvalCategory = "MIXDOG_APPROVAL"
    /// Deny alone: any other approval opens the app on it to be decided there.
    static let approvalDenyCategory = "MIXDOG_APPROVAL_DENY"
    private static let labelsKey = "mixdog.notification.labels"
    private static let tokenKey = "mixdog.apns.token"
    private static let pendingKey = "mixdog.pending.actions"
    private static let askedKey = "mixdog.push.asked"

    weak var viewController: CAPBridgeViewController?

    // MARK: - Wiring

    func userScript() -> WKUserScript {
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? ""
        let allowed = Array(MixdogOriginPolicy.bundled) + MixdogOriginPolicy.saved
        let source = """
        (function () {
          if (window.mixdogNative || \(Self.jsList(allowed)).indexOf(window.location.origin) < 0) return;
          var post = function (method, args) {
            return window.webkit.messageHandlers.\(Self.handlerName).postMessage({ method: method, args: args || {} });
          };
          Object.defineProperty(window, 'mixdogNative', {
            value: Object.freeze({ platform: 'ios', version: \(Self.jsString(version)), call: post }),
            enumerable: false
          });
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    private static func jsString(_ value: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [value])
        let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(array.dropFirst().dropLast())
    }

    private static func jsList(_ values: [String]) -> String {
        let data = try? JSONSerialization.data(withJSONObject: values)
        return data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }

    private weak var contentController: WKUserContentController?

    func install(on configuration: WKWebViewConfiguration) {
        contentController = configuration.userContentController
        configuration.userContentController.addUserScript(userScript())
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: Self.handlerName)
    }

    /// A newly paired host needs the bridge on its page in this very launch.
    /// WebKit cannot remove one user script, so the refreshed list is added as
    /// another idempotent script; a forgotten host keeps a stale script but is
    /// refused navigation and every call (see `MixdogOriginPolicy`).
    private func refreshUserScript() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let controller = self.contentController else { return }
            controller.addUserScript(self.userScript())
        }
    }

    /// Called from AppDelegate at launch, before any notification response is delivered.
    func configureNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        registerCategories()
        // Keep the token fresh on every launch once the user has allowed alerts.
        refreshRegistration()
        // Coming back from Settings: the permission may have changed there.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.refreshRegistration()
            self?.notifyWeb()
        }
    }

    /// The approval actions in the card's order and words (거절 · 한 번만 허용), in the
    /// web app's language once it said them (setNotificationLabels).
    private func registerCategories() {
        let labels = UserDefaults.standard.dictionary(forKey: Self.labelsKey) as? [String: String] ?? [:]
        let deny = UNNotificationAction(identifier: "deny", title: labels["deny"] ?? "Deny", options: [.foreground])
        let allow = UNNotificationAction(
            identifier: "allow", title: labels["allowOnce"] ?? "Allow just once", options: [.foreground])
        UNUserNotificationCenter.current().setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.approvalCategory, actions: [deny, allow], intentIdentifiers: [], options: []),
            UNNotificationCategory(
                identifier: Self.approvalDenyCategory, actions: [deny], intentIdentifiers: [], options: []),
        ])
    }

    /// False (nothing kept) when either label is missing.
    private func setNotificationLabels(_ args: [String: Any]?) -> Bool {
        let label = { (value: Any?) -> String in
            String(((value as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        }
        let deny = label(args?["deny"])
        let allowOnce = label(args?["allowOnce"])
        guard !deny.isEmpty, !allowOnce.isEmpty else { return false }
        UserDefaults.standard.set(["deny": deny, "allowOnce": allowOnce], forKey: Self.labelsKey)
        registerCategories()
        return true
    }

    private func refreshRegistration() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            }
        }
    }

    /// This app's notification settings (iOS 16+), else the app's settings page.
    private func openNotificationSettings(_ done: @escaping (Bool) -> Void) {
        DispatchQueue.main.async {
            let target: String
            if #available(iOS 16.0, *) {
                target = UIApplication.openNotificationSettingsURLString
            } else {
                target = UIApplication.openSettingsURLString
            }
            guard let url = URL(string: target) else { return done(false) }
            UIApplication.shared.open(url, options: [:]) { done($0) }
        }
    }

    // MARK: - APNs token

    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(hex, forKey: Self.tokenKey)
        notifyWeb()
    }

    func notifyWeb() {
        DispatchQueue.main.async { [weak self] in
            self?.viewController?.webView?.evaluateJavaScript(
                "window.dispatchEvent(new Event('mixdognativepush'))", completionHandler: nil)
        }
    }

    // MARK: - JS calls

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        // Only the main frame of an allowed origin gets an answer.
        guard message.frameInfo.isMainFrame,
              let origin = MixdogOriginPolicy.origin(of: message.frameInfo.securityOrigin),
              MixdogOriginPolicy.isAllowed(origin)
        else {
            replyHandler(NSNull(), nil)
            return
        }
        let body = message.body as? [String: Any]
        let method = body?["method"] as? String ?? ""
        switch method {
        case "setAllowedOrigins":
            // Only the bundled pairing screen may widen what can load.
            guard MixdogOriginPolicy.bundled.contains(origin) else {
                replyHandler(false, nil)
                return
            }
            let args = body?["args"] as? [String: Any]
            MixdogOriginPolicy.save(args?["origins"] as? [Any] ?? [])
            refreshUserScript()
            replyHandler(true, nil)
        case "getPushState":
            pushState { replyHandler($0, nil) }
        case "requestPush":
            requestPush { replyHandler($0, nil) }
        case "openNotificationSettings":
            openNotificationSettings { replyHandler($0, nil) }
        case "setNotificationLabels":
            replyHandler(setNotificationLabels(body?["args"] as? [String: Any]), nil)
        case "peekPendingActions":
            let args = body?["args"] as? [String: Any]
            replyHandler(peekPendingActions(hostId: args?["hostId"] as? String ?? ""), nil)
        case "ackPendingAction":
            let args = body?["args"] as? [String: Any]
            ackPendingAction(id: args?["id"] as? String ?? "")
            replyHandler(true, nil)
        case "takePendingAction":
            replyHandler(takePendingAction() ?? NSNull(), nil)
        case "openHostPicker":
            openHostPicker()
            replyHandler(true, nil)
        case "getNativeCapabilities":
            replyHandler(["fileSave": 1], nil)
        case "fileSaveBegin":
            let args = body?["args"] as? [String: Any]
            MixdogFileSave.shared.begin(owner: message.webView, args: args) { replyHandler($0, nil) }
        case "fileSaveWrite":
            let args = body?["args"] as? [String: Any]
            MixdogFileSave.shared.write(owner: message.webView, args: args) { replyHandler($0, nil) }
        case "fileSaveFinish":
            let args = body?["args"] as? [String: Any]
            MixdogFileSave.shared.finish(owner: message.webView, args: args) { replyHandler($0, nil) }
        case "fileSaveAbort":
            let args = body?["args"] as? [String: Any]
            MixdogFileSave.shared.abort(owner: message.webView, args: args) { replyHandler($0, nil) }
        case "fileSaveShare":
            let args = body?["args"] as? [String: Any]
            MixdogFileSave.shared.share(owner: message.webView, args: args) { replyHandler($0, nil) }
        default:
            replyHandler(NSNull(), nil)
        }
    }

    private func pushState(_ done: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let permission: String
            switch settings.authorizationStatus {
            case .notDetermined: permission = "prompt"
            case .denied: permission = "denied"
            default: permission = "granted"
            }
            // Development (Xcode/debug) builds get sandbox APNs tokens; TestFlight
            // and App Store builds (Release) get production ones.
            #if DEBUG
            let sandbox = true
            #else
            let sandbox = false
            #endif
            done([
                "platform": "apns",
                "token": UserDefaults.standard.string(forKey: Self.tokenKey) ?? "",
                "publicKey": MixdogKeychain.publicKey(),
                "permission": permission,
                "sandbox": sandbox,
            ])
        }
    }

    private func requestPush(_ done: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            if granted {
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            }
            self.notifyWeb()
            self.pushState(done)
        }
    }

    private func openHostPicker() {
        DispatchQueue.main.async { [weak self] in
            guard let controller = self?.viewController,
                  let base = controller.bridge?.config.serverURL,
                  let url = URL(string: "/?manage=1", relativeTo: base)
            else { return }
            controller.webView?.load(URLRequest(url: url))
        }
    }

    // MARK: - Parked notification actions

    private static let pendingTTL: TimeInterval = 6 * 60 * 60

    /// Parked actions that have not expired; entries from older builds get an id and a timestamp.
    private func loadQueue() -> [[String: String]] {
        let now = Date().timeIntervalSince1970
        let stored = (UserDefaults.standard.array(forKey: Self.pendingKey) as? [[String: String]]) ?? []
        return stored.map { item -> [String: String] in
            var entry = item
            if entry["id"] == nil { entry["id"] = UUID().uuidString }
            if entry["createdAt"] == nil { entry["createdAt"] = String(now) }
            return entry
        }.filter { now - (Double($0["createdAt"] ?? "") ?? 0) <= Self.pendingTTL }
    }

    private func park(id: String, action: String, sessionId: String, approvalId: String?, hostId: String?) {
        var queue = loadQueue()
        // A re-delivered response parks once.
        guard !queue.contains(where: { $0["id"] == id }) else { return }
        var entry = ["id": id, "action": action, "sessionId": sessionId,
                     "createdAt": String(Date().timeIntervalSince1970)]
        if let approvalId, !approvalId.isEmpty { entry["approvalId"] = approvalId }
        if let hostId, !hostId.isEmpty { entry["hostId"] = hostId }
        queue.append(entry)
        UserDefaults.standard.set(Array(queue.suffix(8)), forKey: Self.pendingKey)
    }

    /// Actions the page connected to `hostId` may act on (its own and unbound ones); nothing is removed.
    private func peekPendingActions(hostId: String) -> [[String: String]] {
        let queue = loadQueue()
        UserDefaults.standard.set(queue, forKey: Self.pendingKey)
        return queue.filter { ($0["hostId"] ?? "").isEmpty || $0["hostId"] == hostId }
    }

    private func ackPendingAction(id: String) {
        UserDefaults.standard.set(loadQueue().filter { $0["id"] != id }, forKey: Self.pendingKey)
    }

    /// Legacy (pre-ack web clients): oldest parked action, removed.
    private func takePendingAction() -> [String: String]? {
        var queue = loadQueue()
        guard !queue.isEmpty else { return nil }
        let first = queue.removeFirst()
        UserDefaults.standard.set(queue, forKey: Self.pendingKey)
        return first
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        if let sessionId = info["mxSessionId"] as? String, !sessionId.isEmpty {
            let action: String
            switch response.actionIdentifier {
            case "allow": action = "allow"
            case "deny": action = "deny"
            default: action = "open"
            }
            park(id: response.notification.request.identifier + ":" + response.actionIdentifier,
                 action: action, sessionId: sessionId,
                 approvalId: info["mxApprovalId"] as? String, hostId: info["mxHostId"] as? String)
            notifyWeb()
        }
        completionHandler()
    }
}
