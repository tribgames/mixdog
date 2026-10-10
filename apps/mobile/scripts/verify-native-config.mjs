// Static consistency checks for the generated native projects. Xcode and the
// Android SDK are not available on every machine (nor in `npm run check`), so
// this catches the mistakes that only show up there: ids that disagree, a Swift
// file missing from a target, a manifest without its service.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');
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
check(manifest.includes('.MixdogMessagingService') && manifest.includes('com.google.firebase.MESSAGING_EVENT'), 'manifest FCM service');
check(manifest.includes('android.permission.POST_NOTIFICATIONS'), 'manifest POST_NOTIFICATIONS');
for (const name of ['MainActivity', 'MixdogMessagingService', 'MixdogNativeHost', 'MixdogKeys', 'NativePushCrypto']) {
  check(existsSync(join(root, `android/app/src/main/java/io/mixdog/app/${name}.java`)), `android ${name}.java`);
}
check(existsSync(join(root, 'android/app/src/main/res/drawable/ic_stat_mixdog.xml')), 'android notification icon');

// iOS
const pbx = read('ios/App/App.xcodeproj/project.pbxproj');
check(pbx.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID};`), 'pbxproj app bundle id');
check(pbx.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID}.NotificationService;`), 'pbxproj extension bundle id');
check(pbx.includes('DEVELOPMENT_TEAM = Q6C35DQU78;'), 'pbxproj team id');
check(/MIXDOG_APS_ENVIRONMENT = production;/u.test(pbx) && /MIXDOG_APS_ENVIRONMENT = development;/u.test(pbx), 'aps environments');
const defined = new Set([...pbx.matchAll(/^\t\t([0-9A-F]{24}) /gmu)].map((match) => match[1]));
const used = new Set([...pbx.matchAll(/\b([0-9A-F]{24})\b/gu)].map((match) => match[1]));
for (const id of used) check(defined.has(id), `pbxproj references undefined object ${id}`);
check(pbx.split('{').length === pbx.split('}').length, 'pbxproj braces balance');
for (const file of ['App/MixdogNativeBridge.swift', 'App/MixdogViewController.swift', 'App/AppDelegate.swift', 'Shared/NativePushCrypto.swift', 'Shared/MixdogKeychain.swift', 'NotificationService/NotificationService.swift', 'NotificationService/Info.plist', 'NotificationService/NotificationService.entitlements', 'App/App.entitlements']) {
  check(existsSync(join(root, 'ios/App', file)), `ios ${file} exists`);
  check(pbx.includes(`path = ${file.split('/').pop()};`), `pbxproj lists ${file}`);
}
check(read('ios/App/App/Base.lproj/Main.storyboard').includes('customClass="MixdogViewController"'), 'storyboard controller');
const group = '$(AppIdentifierPrefix)io.mixdog.app.shared';
for (const file of ['ios/App/App/Info.plist', 'ios/App/NotificationService/Info.plist', 'ios/App/App/App.entitlements', 'ios/App/NotificationService/NotificationService.entitlements']) {
  check(read(file).includes(group), `${file} keychain group`);
}
check(read('ios/App/App/App.entitlements').includes('$(MIXDOG_APS_ENVIRONMENT)'), 'app aps-environment');
check(read('ios/App/NotificationService/Info.plist').includes('com.apple.usernotifications.service'), 'extension point');
check(read('ios/App/App/Info.plist').includes('remote-notification'), 'remote-notification background mode');

// Origin allow-list: no wildcard navigation, bridge restricted to allowed origins.
check(!('allowNavigation' in (config.server ?? {})), 'capacitor.config.json must not set server.allowNavigation');
const javaDir = 'android/app/src/main/java/io/mixdog/app/';
const mainActivity = read(`${javaDir}MainActivity.java`);
const nativeHost = read(`${javaDir}MixdogNativeHost.java`);
check(!/addJavascriptInterface/u.test(mainActivity + nativeHost), 'android must not use addJavascriptInterface');
check(nativeHost.includes('addWebMessageListener') && nativeHost.includes('OriginPolicy.isAllowed'), 'android bridge origin checks');
check(nativeHost.includes('isMainFrame') && nativeHost.includes('OriginPolicy.isBundled(origin)'), 'android main-frame / bundled-only setAllowedOrigins');
check(mainActivity.includes('MixdogWebViewClient') && read(`${javaDir}MixdogWebViewClient.java`).includes('shouldOverrideUrlLoading'), 'android navigation guard');
check(gradle.includes('androidx.webkit:webkit'), 'gradle androidx.webkit dependency');
const swiftBridge = read('ios/App/App/MixdogNativeBridge.swift');
check(swiftBridge.includes('frameInfo.isMainFrame') && swiftBridge.includes('frameInfo.securityOrigin'), 'ios handler checks calling frame');
check(swiftBridge.includes('window.location.origin') && swiftBridge.includes('MixdogOriginPolicy.isAllowed(origin)'), 'ios user script / handler origin checks');
check(swiftBridge.includes('decidePolicyFor') && read('ios/App/App/MixdogViewController.swift').includes('MixdogNavigationDelegate'), 'ios navigation guard');
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
