import Capacitor
import WebKit

/// The Capacitor bridge controller with the Mixdog native host attached to
/// its WebView (Main.storyboard names this class).
class MixdogViewController: CAPBridgeViewController {
    /// Installed here, not in `webViewConfiguration(for:)`: Capacitor swaps in
    /// its own user content controller after that hook, which would drop the
    /// bridge script and handler (pages then never get `window.mixdogNative`).
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        MixdogNativeBridge.shared.install(on: configuration)
        return super.webView(with: frame, configuration: configuration)
    }

    /// Strongly held: WKWebView keeps its navigation delegate weakly.
    private var navigationGuard: MixdogNavigationDelegate?

    override func capacitorDidLoad() {
        MixdogNativeBridge.shared.viewController = self
        if let inner = webView?.navigationDelegate {
            let guardDelegate = MixdogNavigationDelegate(inner: inner)
            navigationGuard = guardDelegate
            webView?.navigationDelegate = guardDelegate
        }
    }
}
