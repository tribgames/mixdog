import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
const sliceSection = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start + 1);
  return end >= 0 ? source.slice(start, end) : source.slice(start);
};
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const APP_ID = 'io.mixdog.app';
const config = JSON.parse(read('capacitor.config.json'));
check(config.appId === APP_ID, 'capacitor.config.json appId');

// Android
const gradle = read('android/app/build.gradle');
check(gradle.includes(`namespace "${APP_ID}"`) && gradle.includes(`applicationId "${APP_ID}"`), 'gradle ids');
check(gradle.includes('firebase-messaging'), 'gradle firebase-messaging dependency');
const manifest = read('android/app/src/main/AndroidManifest.xml');
check(
  manifest.includes('.MixdogMessagingService') && manifest.includes('com.google.firebase.MESSAGING_EVENT'),
  'manifest FCM service'
);
check(manifest.includes('android.permission.POST_NOTIFICATIONS'), 'manifest POST_NOTIFICATIONS');
for (const name of [
  'MainActivity',
  'MixdogMessagingService',
  'MixdogNativeHost',
  'MixdogKeys',
  'NativePushCrypto',
  'MixdogFileSave',
  'FileSaveSessions',
]) {
  check(existsSync(join(root, `android/app/src/main/java/io/mixdog/app/${name}.java`)), `android ${name}.java`);
}
check(existsSync(join(root, 'android/app/src/main/res/drawable/ic_stat_mixdog.xml')), 'android notification icon');
check(
  existsSync(join(root, 'android/app/src/main/java/io/mixdog/app/MixdogAppUpdater.java')),
  'android MixdogAppUpdater.java'
);
check(manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES'), 'manifest REQUEST_INSTALL_PACKAGES');
check(
  read('android/app/src/main/res/xml/file_paths.xml').includes(
    '<external-files-path name="updates" path="updates/" />'
  ),
  'file_paths updates folder'
);

// iOS
const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
check(pbx.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID};`), 'pbxproj app bundle id');
check(pbx.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID}.NotificationService;`), 'pbxproj extension bundle id');
check(pbx.includes('DEVELOPMENT_TEAM = Q6C35DQU78;'), 'pbxproj team id');
check(
  /MIXDOG_APS_ENVIRONMENT = production;/u.test(pbx) && /MIXDOG_APS_ENVIRONMENT = development;/u.test(pbx),
  'aps environments'
);
const defined = new Set([...pbx.matchAll(/^\t\t([0-9A-F]{24}) /gmu)].map((match) => match[1]));
const used = new Set([...pbx.matchAll(/\b([0-9A-F]{24})\b/gu)].map((match) => match[1]));
for (const id of used) check(defined.has(id), `pbxproj references undefined object ${id}`);
check(pbx.split('{').length === pbx.split('}').length, 'pbxproj braces balance');
for (const file of [
  'App/MixdogNativeBridge.swift',
  'App/MixdogViewController.swift',
  'App/AppDelegate.swift',
  'Shared/NativePushCrypto.swift',
  'Shared/MixdogKeychain.swift',
  'NotificationService/NotificationService.swift',
  'NotificationService/Info.plist',
  'NotificationService/NotificationService.entitlements',
  'App/App.entitlements',
]) {
  check(existsSync(join(root, 'ios/App', file)), `ios ${file} exists`);
  check(pbx.includes(`path = ${file.split('/').pop()};`), `pbxproj lists ${file}`);
}
check(
  read('ios/App/App/Base.lproj/Main.storyboard').includes('customClass="MixdogViewController"'),
  'storyboard controller'
);
const group = '$(AppIdentifierPrefix)io.mixdog.app.shared';
for (const file of [
  'ios/App/App/Info.plist',
  'ios/App/NotificationService/Info.plist',
  'ios/App/App/App.entitlements',
  'ios/App/NotificationService/NotificationService.entitlements',
]) {
  check(read(file).includes(group), `${file} keychain group`);
}
check(read('ios/App/App/App.entitlements').includes('$(MIXDOG_APS_ENVIRONMENT)'), 'app aps-environment');
check(
  read('ios/App/NotificationService/Info.plist').includes('com.apple.usernotifications.service'),
  'extension point'
);
check(read('ios/App/App/Info.plist').includes('remote-notification'), 'remote-notification background mode');

// Origin allow-list: no wildcard navigation, bridge restricted to allowed origins.
check(!('allowNavigation' in (config.server ?? {})), 'capacitor.config.json must not set server.allowNavigation');
const javaDir = 'android/app/src/main/java/io/mixdog/app/';
const mainActivity = read(`${javaDir}MainActivity.java`);
const nativeHost = read(`${javaDir}MixdogNativeHost.java`);
check(!/addJavascriptInterface/u.test(mainActivity + nativeHost), 'android must not use addJavascriptInterface');
check(
  nativeHost.includes('addWebMessageListener') && nativeHost.includes('OriginPolicy.isAllowed'),
  'android bridge origin checks'
);
check(
  nativeHost.includes('isMainFrame') && nativeHost.includes('OriginPolicy.isBundled(origin)'),
  'android main-frame / bundled-only setAllowedOrigins'
);
const webViewClientJava = read(`${javaDir}MixdogWebViewClient.java`);
check(
  mainActivity.includes('MixdogWebViewClient') && webViewClientJava.includes('shouldOverrideUrlLoading'),
  'android navigation guard'
);
// A failed relay page is brought back under a cover, not left on the browser's
// error page; the network trigger needs the network-state permission. The cover
// is the app's background alone (#111): no text, no spinner, no button.
check(
  webViewClientJava.includes('onReceivedError') && mainActivity.includes('MixdogReconnect'),
  'android reconnect hooks'
);
const reconnectJava = read(`${javaDir}MixdogReconnect.java`);
check(
  existsSync(join(root, `${javaDir}NetworkSwitchTracker.java`)) &&
    mainActivity.includes('onStop()') &&
    mainActivity.includes('nativeHost.onBackground()') &&
    mainActivity.includes('notifyNetworkChanged()') &&
    nativeHost.includes('"mixdognativebackground"') &&
    nativeHost.includes('"mixdognativeforeground"') &&
    nativeHost.includes('"mixdognativenetwork"') &&
    reconnectJava.includes('registerDefaultNetworkCallback') &&
    reconnectJava.includes('NET_CAPABILITY_VALIDATED') &&
    reconnectJava.includes('activity.notifyNetworkChanged()'),
  'android immediate background suspend and foreground network-switch notifications'
);
check(manifest.includes('android.permission.ACCESS_NETWORK_STATE'), 'manifest ACCESS_NETWORK_STATE');
const lightColors = read('android/app/src/main/res/values/colors.xml');
const darkColors = read('android/app/src/main/res/values-night/colors.xml');
check(
  /<color name="mixdogWebViewSurface">#fcfcfc<\/color>/iu.test(lightColors) &&
    /<color name="mixdogWebViewBand">#f7f7f7<\/color>/iu.test(lightColors) &&
    /<color name="mixdogWebViewSurface">#111111<\/color>/iu.test(darkColors) &&
    /<color name="mixdogWebViewBand">#181818<\/color>/iu.test(darkColors),
  'android light/dark WebView backing colors match renderer themes'
);
check(
  mainActivity.includes('findViewById(com.getcapacitor.android.R.id.webview)') &&
    mainActivity.includes('applyWebViewThemeColors(this, webView)') &&
    mainActivity.includes('webView.setBackgroundColor(surface)') &&
    mainActivity.includes('((View) webView.getParent()).setBackgroundColor(band)') &&
    mainActivity.includes('R.color.mixdogWebViewSurface') &&
    mainActivity.includes('R.color.mixdogWebViewBand') &&
    mainActivity.includes('onConfigurationChanged'),
  'android MainActivity programmatically applies DayNight backing colors to WebView and its parent'
);
check(
  mainActivity.includes('"MixdogNativeTheme"') &&
    mainActivity.includes('addWebMessageListener') &&
    mainActivity.includes('isMainFrame') &&
    mainActivity.includes('OriginPolicy.isAllowed') &&
    mainActivity.includes('explicitWebViewSurfaceColor') &&
    mainActivity.includes('explicitWebViewBandColor') &&
    mainActivity.includes('followSystem'),
  'android WebView synchronizes explicit Mixdog theme backing without overwriting onConfigurationChanged'
);
const androidPickerBody = sliceSection(mainActivity, 'void applyPickerThemeBacking()', '\n  void openHostPicker()');
const androidOpenPickerBody = sliceSection(
  mainActivity,
  'void openHostPicker()',
  '\n  private void applyWebViewThemeColors('
);
check(
  androidPickerBody.includes('ContextCompat.getColor(this, R.color.mixdogBand)') &&
    androidPickerBody.includes('explicitWebViewSurfaceColor = pickerBg;') &&
    androidPickerBody.includes('explicitWebViewBandColor = pickerBg;') &&
    androidPickerBody.includes('applyWebViewThemeColors(this, webView);') &&
    androidOpenPickerBody.includes('applyPickerThemeBacking();') &&
    mainActivity.includes('setAppearanceLightStatusBars') &&
    mainActivity.includes('setAppearanceLightNavigationBars') &&
    reconnectJava.includes('activity.openHostPicker()') &&
    nativeHost.includes('activity.openHostPicker()') &&
    webViewClientJava.includes('OriginPolicy.isBundled(OriginPolicy.originOf(url))') &&
    webViewClientJava.includes('activity.applyPickerThemeBacking()'),
  'android resets dark #181818 picker backing and system bars when returning to the bundled saved-PC picker'
);
const viewController = read('ios/App/App/MixdogViewController.swift');
const applyBackingBody = sliceSection(viewController, 'private func applyBackingColors(', '\n    func ');
const storedSurfaceIdx = applyBackingBody.indexOf('currentSurfaceColor = surface');
const storedBandIdx = applyBackingBody.indexOf('currentBandColor = band');
const applyBandIdx = applyBackingBody.indexOf('applyWindowBandColor()');
const applySurfaceIdx = applyBackingBody.indexOf('webView?.backgroundColor = surface');
check(
  viewController.includes('userInterfaceStyle == .dark') &&
    viewController.includes('0x11') &&
    viewController.includes('0xfc') &&
    viewController.includes('0x18') &&
    viewController.includes('0xf7') &&
    viewController.includes('view.window?.backgroundColor = currentBandColor') &&
    storedSurfaceIdx >= 0 &&
    storedBandIdx >= 0 &&
    applyBandIdx > storedBandIdx &&
    applySurfaceIdx > storedSurfaceIdx &&
    applyBackingBody.includes('view !== webView') &&
    applyBackingBody.includes('webView?.isOpaque = false') &&
    applyBackingBody.includes('webView?.scrollView.backgroundColor = surface') &&
    applyBackingBody.includes('webView?.underPageBackgroundColor = surface') &&
    applyBackingBody.includes('setNeedsStatusBarAppearanceUpdate()') &&
    viewController.includes('override var preferredStatusBarStyle: UIStatusBarStyle') &&
    /override func viewWillAppear\([^)]*\)\s*\{[^}]*applyWindowBandColor\(\)/u.test(viewController) &&
    /override func viewDidAppear\([^)]*\)\s*\{[^}]*applyWindowBandColor\(\)/u.test(viewController),
  'ios WKWebView stores and preserves distinct window band and non-opaque WebView surface backing colors'
);
check(
  viewController.includes('"mixdogTheme"') &&
    viewController.includes('WKScriptMessageHandler') &&
    viewController.includes('frameInfo.isMainFrame') &&
    viewController.includes('MixdogOriginPolicy.isAllowed(origin)') &&
    viewController.includes('applyThemeBacking') &&
    viewController.includes('followSystem'),
  'ios WKWebView synchronizes explicit Mixdog theme backing with origin checks'
);
const swiftBridge = read('ios/App/App/MixdogNativeBridge.swift');
const swiftDidCommitBody = sliceSection(
  swiftBridge,
  'func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!)',
  '\n    func webView('
);
const swiftOpenPickerBody = sliceSection(swiftBridge, 'private func openHostPicker()', '\n    // MARK:');
check(
  viewController.includes('func applyPickerThemeBacking()') &&
    viewController.includes('pickerBandColor') &&
    swiftOpenPickerBody.includes('applyPickerThemeBacking()') &&
    swiftOpenPickerBody.includes('controller.webView?.load') &&
    swiftOpenPickerBody.indexOf('applyPickerThemeBacking()') <
      swiftOpenPickerBody.indexOf('controller.webView?.load') &&
    swiftDidCommitBody.includes('MixdogOriginPolicy.bundled.contains(origin)') &&
    swiftDidCommitBody.includes('applyPickerThemeBacking()'),
  'ios resets dark #181818 picker backing when returning to the bundled saved-PC picker'
);
const offlineCover = read('android/app/src/main/res/layout/mixdog_reconnect.xml');
check(
  offlineCover.includes('android:background="@color/mixdogOfflineFrame"') &&
    !/<(TextView|ProgressBar|Button|ImageView)\b/u.test(offlineCover) &&
    /<color name="mixdogOfflineFrame">#111111<\/color>/u.test(
      read('android/app/src/main/res/values/mixdog_colors.xml')
    ),
  'android offline cover is the app background alone'
);
// Soft keyboard: adjustResize on older releases; under Android 15+ edge-to-edge
// MainActivity fits the WebView to the IME insets itself, as the single owner.
check(manifest.includes('android:windowSoftInputMode="adjustResize"'), 'manifest adjustResize');
check(
  mainActivity.includes('WindowInsetsCompat.Type.ime()') && mainActivity.includes('WebViewInsets.margins'),
  'android WebView fits the soft keyboard'
);
check(
  !('adjustMarginsForEdgeToEdge' in (config.android ?? {})),
  'capacitor.config.json must leave edge-to-edge margins to MainActivity'
);
check(gradle.includes('androidx.webkit:webkit'), 'gradle androidx.webkit dependency');
check(
  swiftBridge.includes('frameInfo.isMainFrame') && swiftBridge.includes('frameInfo.securityOrigin'),
  'ios handler checks calling frame'
);
check(
  swiftBridge.includes('window.location.origin') && swiftBridge.includes('MixdogOriginPolicy.isAllowed(origin)'),
  'ios user script / handler origin checks'
);
check(
  swiftBridge.includes('decidePolicyFor') && viewController.includes('MixdogNavigationDelegate'),
  'ios navigation guard'
);
const policyCases = JSON.parse(read('test-vectors/origin-policy.json'));
check(policyCases.allowed.length > 0 && policyCases.origin.length > 0, 'origin policy cases');

// Shared contract
const vector = JSON.parse(read('test-vectors/native-push-v1.json'));
check(typeof vector.mx === 'string' && typeof vector.devicePrivatePkcs8 === 'string', 'test vector');

if (failures.length) {
  console.error(`[verify:native] ${failures.length} problem(s):\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('[verify:native] ok');
