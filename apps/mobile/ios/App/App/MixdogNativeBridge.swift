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
        if url.scheme == "about" || MixdogOriginPolicy.isAllowed(url: url) {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "https" || url.scheme == "http" {
            DispatchQueue.main.async { UIApplication.shared.open(url, options: [:], completionHandler: nil) }
        }
        decisionHandler(.cancel)
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
    static let approvalCategory = "MIXDOG_APPROVAL"
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
        let allow = UNNotificationAction(identifier: "allow", title: "Allow", options: [.foreground])
        let deny = UNNotificationAction(identifier: "deny", title: "Deny", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: Self.approvalCategory, actions: [allow, deny], intentIdentifiers: [], options: [])
        ])
        // Keep the token fresh on every launch once the user has allowed alerts.
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
            }
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
        case "takePendingAction":
            replyHandler(takePendingAction() ?? NSNull(), nil)
        case "openHostPicker":
            openHostPicker()
            replyHandler(true, nil)
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

    private func park(action: String, sessionId: String, approvalId: String?) {
        var queue = (UserDefaults.standard.array(forKey: Self.pendingKey) as? [[String: String]]) ?? []
        var entry = ["action": action, "sessionId": sessionId]
        if let approvalId, !approvalId.isEmpty { entry["approvalId"] = approvalId }
        queue.append(entry)
        UserDefaults.standard.set(Array(queue.suffix(8)), forKey: Self.pendingKey)
    }

    private func takePendingAction() -> [String: String]? {
        var queue = (UserDefaults.standard.array(forKey: Self.pendingKey) as? [[String: String]]) ?? []
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
            park(action: action, sessionId: sessionId, approvalId: info["mxApprovalId"] as? String)
            notifyWeb()
        }
        completionHandler()
    }
}
