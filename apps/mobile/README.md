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

- Deploy (`.github/workflows/deploy.yml`) ships both apps with the app release
  when anything they are built from changed since the newest `mobile-v*` tag
  (`apps/mobile/**` except Markdown, `apps/desktop/src/shared/native-app.ts`,
  the two mobile workflows; see `scripts/mobile-release.mjs`). Inputs `mobile`
  (`auto`/`force`/`skip`) and `mobile_bump` (`patch`/`minor`). Deploy publishes
  the Android release (which creates the `mobile-vX.Y.Z` tag on the release
  commit) before the relay deploy, and the relay's `/app` page links the newest
  release whose APK downloads. iOS runs beside the release: its failure fails
  the run but holds back neither the desktop release nor the relay.
- `.github/workflows/mobile-android.yml` — Deploy, tag `mobile-vX.Y.Z` or manual
  run (`version`, `publish`, `draft`, `ref`). Builds a signed release APK and
  attaches it to the GitHub Release `mobile-vX.Y.Z` (created non-"latest" so the
  desktop updater is unaffected; tag and manual runs create a hidden draft).
- `.github/workflows/mobile-ios.yml` — Deploy, tag `mobile-vX.Y.Z` or manual run.
  Signs with the one long-lived Apple Distribution certificate from the
  `IOS_DIST_P12_*` secrets (imported into a temporary keychain), fetches or
  creates the App Store profiles bound to it through the App Store Connect API
  key (`scripts/ios-ci-signing.py`), archives and uploads to TestFlight. Runs
  never create or revoke certificates; they warn 30 days before the certificate
  expires and fail once it has (see *Renewing the iOS distribution certificate*).
  Build number = UTC `YYYYMMDDHHMM` of the run (rises
  across Deploy, tag, manual runs and re-runs). Release builds use production
  APNs (`aps-environment` = `production`); Debug builds use `development` and the
  app then registers the token with `sandbox: true`.
  After the upload, `scripts/testflight-submit.py` waits (up to 45 min) for the
  build to be `VALID`, sets "What to Test" for `en-US`/`ko` from
  `testflight/what-to-test.*.txt`, adds the build to the external group
  (`TESTFLIGHT_EXTERNAL_GROUP_ID` variable/secret, default
  `ef50f70b-0be0-484c-80f0-a5c178e63bef`) and submits it for beta app review.
  Tag runs always do this; manual runs can skip it with `submit_review: false`
  (upload only).

## Repository secrets

| Secret | Used by | Content |
| --- | --- | --- |
| `APPLE_API_KEY_P8` | iOS | App Store Connect API key (`.p8` file text) |
| `APPLE_API_KEY_ID` | iOS | its key id |
| `APPLE_API_ISSUER` | iOS | issuer id |
| `IOS_DIST_P12_BASE64` | iOS | base64 `.p12` of the Apple Distribution certificate + private key |
| `IOS_DIST_P12_PASSWORD` | iOS | password of that `.p12` |
| `ANDROID_KEYSTORE_B64` | Android | base64 of the release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Android | keystore password |
| `ANDROID_KEY_ALIAS` | Android | key alias (`mixdog`) |
| `ANDROID_KEY_PASSWORD` | Android | key password |
| `FIREBASE_GOOGLE_SERVICES_JSON_B64` | Android | base64 of `google-services.json` (project `mixdog-app`, app `1:72037110974:android:fe585242b693ba891a7aef`) |

Apple identifiers: team `Q6C35DQU78`, App Store Connect app `6821430566`, bundle
`io.mixdog.app`, extension `io.mixdog.app.NotificationService`.

### Renewing the iOS distribution certificate

Create the certificate (first time, and again before it expires — Apple
Distribution certificates last one year) from a machine with the App Store
Connect API key and `gh` logged in with access to the repository secrets:

```
pip install --upgrade pyjwt "cryptography>=42"
ASC_KEY_PATH=/path/to/AuthKey_<KEY_ID>.p8 APPLE_API_KEY_ID=<KEY_ID> APPLE_API_ISSUER=<ISSUER_ID> \
  python3 apps/mobile/scripts/ios-ci-signing.py issue
```

It creates the certificate from a fresh key kept only in memory, prints its id
and expiry, and sets `IOS_DIST_P12_BASE64` and `IOS_DIST_P12_PASSWORD`. The next
run recreates the profiles for the new certificate. Revoke the replaced
certificate only after App Store Connect has processed the last build signed
with it (a revoked signature fails processing with ITMS-90035).

## One-time manual steps

1. **Apple**: the App ID `io.mixdog.app` already has Push Notifications. Issue the
   distribution certificate (*Renewing the iOS distribution certificate*); the
   first CI run then creates the `io.mixdog.app.NotificationService` App ID and
   the profiles (the API key needs the *App Manager*/*Admin* role). If it cannot, create the
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
