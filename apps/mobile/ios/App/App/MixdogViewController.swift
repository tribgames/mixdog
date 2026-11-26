import Capacitor
import UIKit
import WebKit

private final class MixdogThemeMessageHandler: NSObject, WKScriptMessageHandler {
    weak var controller: MixdogViewController?

    init(controller: MixdogViewController) {
        self.controller = controller
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let origin = MixdogOriginPolicy.origin(of: message.frameInfo.securityOrigin),
              MixdogOriginPolicy.isAllowed(origin),
              let body = message.body as? [String: Any]
        else { return }
        let followSystem = body["followSystem"] as? Bool ?? false
        let surfaceHex = body["surface"] as? String
        let bandHex = body["band"] as? String
        DispatchQueue.main.async { [weak self] in
            self?.controller?.applyThemeBacking(followSystem: followSystem, surfaceHex: surfaceHex, bandHex: bandHex)
        }
    }
}

/// The Capacitor bridge controller with the Mixdog native host attached to
/// its WebView (Main.storyboard names this class).
class MixdogViewController: CAPBridgeViewController {
    private static let themeHandlerName = "mixdogTheme"
    private static let pickerBandColor = UIColor(red: 0x18 / 255.0, green: 0x18 / 255.0, blue: 0x18 / 255.0, alpha: 1)
    private var hasExplicitThemeBacking = false
    private var currentSurfaceColor: UIColor = MixdogViewController.systemSurfaceColor()
    private var currentBandColor: UIColor = MixdogViewController.systemBandColor()

    /// Installed here, not in `webViewConfiguration(for:)`: Capacitor swaps in
    /// its own user content controller after that hook, which would drop the
    /// bridge script and handler (pages then never get `window.mixdogNative`).
    override func webView(with frame: CGRect, configuration: WKWebViewConfiguration) -> WKWebView {
        MixdogNativeBridge.shared.install(on: configuration)
        configuration.userContentController.add(
            MixdogThemeMessageHandler(controller: self),
            contentWorld: .page,
            name: Self.themeHandlerName
        )
        return super.webView(with: frame, configuration: configuration)
    }

    /// Strongly held: WKWebView keeps its navigation delegate weakly.
    private var navigationGuard: MixdogNavigationDelegate?

    private static func systemSurfaceColor() -> UIColor {
        UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(red: 0x11 / 255.0, green: 0x11 / 255.0, blue: 0x11 / 255.0, alpha: 1)
                : UIColor(red: 0xfc / 255.0, green: 0xfc / 255.0, blue: 0xfc / 255.0, alpha: 1)
        }
    }

    private static func systemBandColor() -> UIColor {
        UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(red: 0x18 / 255.0, green: 0x18 / 255.0, blue: 0x18 / 255.0, alpha: 1)
                : UIColor(red: 0xf7 / 255.0, green: 0xf7 / 255.0, blue: 0xf7 / 255.0, alpha: 1)
        }
    }

    private static func parseHexColor(_ value: String?) -> UIColor? {
        guard let raw = value, raw.count == 7, raw.first == "#" else { return nil }
        let hex = raw.dropFirst()
        guard hex.allSatisfy(\.isHexDigit), let rgb = UInt32(hex, radix: 16) else { return nil }
        return UIColor(
            red: CGFloat((rgb >> 16) & 0xff) / 255.0,
            green: CGFloat((rgb >> 8) & 0xff) / 255.0,
            blue: CGFloat(rgb & 0xff) / 255.0,
            alpha: 1
        )
    }

    private static func isLightColor(_ color: UIColor, traits: UITraitCollection) -> Bool {
        let resolved = color.resolvedColor(with: traits)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        if resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha) {
            return 0.2126 * red + 0.7152 * green + 0.0722 * blue >= 0.5
        }
        var white: CGFloat = 0
        if resolved.getWhite(&white, alpha: &alpha) {
            return white >= 0.5
        }
        return false
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        if #available(iOS 13.0, *) {
            return Self.isLightColor(currentBandColor, traits: traitCollection) ? .darkContent : .lightContent
        }
        return Self.isLightColor(currentBandColor, traits: traitCollection) ? .default : .lightContent
    }

    private func applyWindowBandColor() {
        view.window?.backgroundColor = currentBandColor
    }

    private func applyBackingColors(surface: UIColor, band: UIColor) {
        currentSurfaceColor = surface
        currentBandColor = band
        // CAPBridgeViewController sets `view = webView`, so band belongs on the
        // window (and any distinct wrapper view) while surface belongs on webView.
        applyWindowBandColor()
        if view !== webView {
            view.backgroundColor = band
        }
        // WKWebView defaults to opaque white, which flashes on background resume and overscroll.
        webView?.isOpaque = false
        webView?.backgroundColor = surface
        webView?.scrollView.backgroundColor = surface
        if #available(iOS 15.0, *) {
            webView?.underPageBackgroundColor = surface
        }
        setNeedsStatusBarAppearanceUpdate()
    }

    func applyPickerThemeBacking() {
        hasExplicitThemeBacking = true
        applyBackingColors(surface: Self.pickerBandColor, band: Self.pickerBandColor)
    }

    func applyThemeBacking(followSystem: Bool, surfaceHex: String?, bandHex: String?) {
        if followSystem {
            hasExplicitThemeBacking = false
            applyBackingColors(surface: Self.systemSurfaceColor(), band: Self.systemBandColor())
            return
        }
        guard let surface = Self.parseHexColor(surfaceHex), let band = Self.parseHexColor(bandHex) else { return }
        hasExplicitThemeBacking = true
        applyBackingColors(surface: surface, band: band)
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if !hasExplicitThemeBacking,
           previousTraitCollection?.userInterfaceStyle != traitCollection.userInterfaceStyle {
            setNeedsStatusBarAppearanceUpdate()
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        applyWindowBandColor()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        applyWindowBandColor()
    }

    override func capacitorDidLoad() {
        MixdogNativeBridge.shared.viewController = self
        if hasExplicitThemeBacking {
            applyBackingColors(surface: currentSurfaceColor, band: currentBandColor)
        } else {
            applyBackingColors(surface: Self.systemSurfaceColor(), band: Self.systemBandColor())
        }
        if let inner = webView?.navigationDelegate {
            let guardDelegate = MixdogNavigationDelegate(inner: inner)
            navigationGuard = guardDelegate
            webView?.navigationDelegate = guardDelegate
        }
    }
}
