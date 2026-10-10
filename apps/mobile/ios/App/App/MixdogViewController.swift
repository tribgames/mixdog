import Capacitor
import WebKit

/// The Capacitor bridge controller with the Mixdog native host attached to
/// its WebView (Main.storyboard names this class).
class MixdogViewController: CAPBridgeViewController {
    override func webViewConfiguration(for instanceConfiguration: InstanceConfiguration) -> WKWebViewConfiguration {
        let configuration = super.webViewConfiguration(for: instanceConfiguration)
        MixdogNativeBridge.shared.install(on: configuration)
        return configuration
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
