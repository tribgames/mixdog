# Mixdog phone app (iOS + Android)

A thin Capacitor shell (`io.mixdog.app`) around the relay web app. The only
bundled UI is the first-run screen (`src/`): scan the desktop's QR code with the
camera, or paste the pairing link, and the WebView navigates to
`https://<relay>/d/<deviceId>/`. Paired hosts are remembered. Everything after
that is served by the relay, so the UI updates without a new app build.

The reason the app exists is **reliable native push**:

- The shell registers for APNs (iOS) / FCM (Android) and generates a per-install
  P-256 key pair. The private key never leaves the Keychain (iOS, shared access
  group) / Android Keystore (wraps the key).
- It exposes `window.mixdogNative` (iOS) / `window.MixdogNativeHost` (Android) and
  a `MixdogApp/1` user-agent token (`apps/desktop/src/shared/native-app.ts`), so
  the relay web app treats it as an installed surface (pairing/claim + E2EE run
  as usual).
- The web app (`apps/desktop/src/renderer/native-push-bridge.ts`) hands
  `{ platform, token, publicKey, sandbox? }` to the host with `registerNativePush`
  over the E2EE channel — only if the host advertises `nativePush: 1`.
- Push payloads are the encrypted `mx` field (`mixdog-native-push-v1`, see
  `apps/desktop/src/shared/native-push-crypto.ts`). iOS: the Notification Service
  Extension decrypts and rewrites the alert. Android: `MixdogMessagingService`
  decrypts the FCM data message and posts a local notification.
- Approval notifications carry **Allow** / **Deny**; they open the app on that
  session and resolve the approval with `resolveToolApprovalForSession`. A plain
  tap opens the session through the web app's notification navigation.
- Android checks GitHub Releases (`mobile-v*` with an `.apk` asset) at launch and
  offers the download. iOS updates come through TestFlight.

## Origin allow-list (security)

Only the bundled pairing screen (`https://localhost` on Android,
`capacitor://localhost` on iOS) and the relay origins of **saved hosts** may load
in the WebView; every other link opens in the system browser (no wildcard
`allowNavigation`). The native bridge is limited the same way:

- The pairing screen reports the saved origins (`setAllowedOrigins`, accepted
  from the bundled screen only); each platform persists them.
- Android: `MixdogNativeHost` is an AndroidX `WebMessageListener` registered with
  those origins as rules and re-checks main frame + origin on every message;
  `MixdogWebViewClient` guards top-level navigation.
- iOS: the user script defines `window.mixdogNative` only where
  `location.origin` is allowed, the message handler checks
  `frameInfo.securityOrigin` (main frame), and `MixdogNavigationDelegate` guards
  top-level navigation.
- One rule set in three implementations (`src/origins.ts`, `OriginPolicy.java`,
  `MixdogOriginPolicy`), pinned by `test-vectors/origin-policy.json`;
  `npm test` runs the TS side and `npm run test:java` the Android side.

Settings → Connection in the relay web app shows **Switch PC** on the native app,
which calls `openHostPicker` to return to the pairing screen.

## Layout

| Path | What |
| --- | --- |
| `src/` | Bundled pairing screen (`main.ts`, `hosts.ts`, `update.ts`) + tests |
| `android/` | Gradle project; `io.mixdog.app` Java sources (`MixdogNativeHost`, `MixdogMessagingService`, `MixdogKeys`, `NativePushCrypto`, …) |
| `ios/App/` | Xcode project (CocoaPods); `App` target, `NotificationService` extension, `Shared/` (compiled into both) |
| `test-vectors/native-push-v1.json` | Cross-check vector for the native decryptors (mirrors `NATIVE_PUSH_TEST_VECTOR`) |
| `scripts/` | `build-web.mjs`, `verify-native-config.mjs` (static native-config checks) |

## Commands

```
npm ci
npm run check          # typecheck + unit tests + native config checks + web build
npm run sync:android   # build web, cap sync android
npm run apk:debug      # needs the Android SDK
npm run sync:ios       # build web, cap sync ios (+ pod install, macOS)
```

## CI

- `.github/workflows/mobile-android.yml` — tag `mobile-vX.Y.Z` or manual run
  (`version`, `publish`). Builds a signed release APK and attaches it to the
  GitHub Release `mobile-vX.Y.Z` (created non-"latest" so the desktop updater is
  unaffected).
- `.github/workflows/mobile-ios.yml` — tag `mobile-vX.Y.Z` or manual run. Archives
  with automatic signing through the App Store Connect API key and uploads to
  TestFlight. Build number = workflow run number. Release builds use production
  APNs (`aps-environment` = `production`); Debug builds use `development` and the
  app then registers the token with `sandbox: true`.

## Repository secrets

| Secret | Used by | Content |
| --- | --- | --- |
| `APPLE_API_KEY_P8` | iOS | App Store Connect API key (`.p8` file text) |
| `APPLE_API_KEY_ID` | iOS | its key id |
| `APPLE_API_ISSUER` | iOS | issuer id |
| `ANDROID_KEYSTORE_B64` | Android | base64 of the release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Android | keystore password |
| `ANDROID_KEY_ALIAS` | Android | key alias (`mixdog`) |
| `ANDROID_KEY_PASSWORD` | Android | key password |
| `FIREBASE_GOOGLE_SERVICES_JSON_B64` | Android | base64 of `google-services.json` (project `mixdog-app`, app `1:72037110974:android:fe585242b693ba891a7aef`) |

Apple identifiers: team `Q6C35DQU78`, App Store Connect app `6821430566`, bundle
`io.mixdog.app`, extension `io.mixdog.app.NotificationService`.

## One-time manual steps

1. **Apple**: the App ID `io.mixdog.app` already has Push Notifications. The first
   CI run creates the `io.mixdog.app.NotificationService` App ID and the profiles
   (the API key needs the *App Manager*/*Admin* role). If it cannot, create the
   extension App ID in the developer portal by hand (no capabilities needed).
2. **APNs key**: the host sender needs an APNs auth key (`.p8`) enabled for the
   team (sandbox and production); configure it on the host side — the phone app
   needs nothing beyond the entitlement.
3. **TestFlight**: after the first upload answer the export-compliance prompt
   (the app declares `ITSAppUsesNonExemptEncryption = false`), then add internal
   testers.
4. **Firebase**: in project `mixdog-app` enable Cloud Messaging for the Android
   app; the host sender needs a service-account key to call FCM HTTP v1.
5. **Android**: keep the release keystore safe — updates must be signed by the
   same key. First install is a sideload (allow "install unknown apps").
6. Optional first release: `git tag mobile-v1.0.0 && git push origin mobile-v1.0.0`
   (or run either workflow manually).

## Known limits

- On iOS a newly paired host's page gets the bridge in the same launch through an
  additional (idempotent) user script; WebKit cannot remove scripts, so a
  forgotten host keeps a stale script until relaunch — it is still refused
  navigation and every native call.
- Xcode and the Android SDK were not available when this was written: the
  native projects are statically checked (`npm run verify:native`) and the Java
  decryptor was verified on a JVM against the shared vector, but neither
  platform was built or run on a device.
