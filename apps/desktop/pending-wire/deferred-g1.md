# DESKTOP-WIRE-G1: fragment lines not applied

Every other line of the eleven G1 desktop fragments was applied (see the DESKTOP-WIRE-G1 commits); the fragments are deleted.

## s1-mica (native and CI lines)

These lines are outside apps/desktop and packages/, which DESKTOP-WIRE-G1 was limited to (native/ was being wired
by the core side at the same time). The apps/desktop half (prepare-runtime.mjs `mixdog_window.node` with window-library
schemaVersion 2, electron-builder.yml signExts, dev-profile.mjs wording, window-mica.ts) is applied. Until the lines
below land, native/mixdog-window does not build (lib.rs is already the Node-API module) and Windows prepare:runtime
cannot produce `mixdog_window.node`.

- native/mixdog-window/Cargo.toml: `[dependencies]` napi = { version = "=3.12.2", default-features = false,
  features = ["napi6", "dyn-symbols"] }, napi-derive = "=3.6.3"; `[build-dependencies]` napi-build = "=2.4.1";
  comment above `[lib]`: "Loaded by window-mica.ts as a Node-API module"; the `[profile.dev]` comment becomes
  "# A panic must not unwind across the Node-API boundary." (panic = "abort" stays).
- native/mixdog-window/build.rs (new): `fn main() { napi_build::setup(); }`
- native/mixdog-window/.cargo/config.toml: both targets' rustflags `["-C", "target-feature=+crt-static"]` instead of
  `/NODEFAULTLIB`; header comment: comctl32 and user32 as raw-dylib, C runtime linked statically.
- native/mixdog-window/build.ps1: copy to `(Join-Path $OutputDirectory 'mixdog_window.node')` ($library stays
  `mixdog_window.dll`, cargo's name); final message and error text say "Node-API module".
- native/mixdog-window/Cargo.lock: `cargo generate-lockfile --offline`, then `cargo build --locked`.
- .github/workflows/desktop-package.yml: `native-tools/mixdog_window.dll` -> `native-tools/mixdog_window.node`,
  window-library cache key v1 -> v2, and 'native/mixdog-window/build.rs' added to the desktop-prepared-runtime
  hashFiles list after 'native/mixdog-window/build.ps1'.

## s2a-ts-host-extras (preload mirror)

The four channels are in DESKTOP_IPC (enableAllowAllActions, observeSignIn, pcQuotaInvoke, pcQuotaRead),
HOST_EXTRAS_IPC uses them, and ipc.ts registers registerHostExtrasIpc per window. The preload half waits for
DESKTOP-WIRE-G5 (G5, "preload host API"): these members are not DesktopApi members but DesktopHostExtras of
`window.mixdogDesktopHost` (shared/desktop-api-split.ts); adding them to DesktopApi breaks DESKTOP_API_COMPLETE.
G5 must map them onto the channels, whose shapes differ from DesktopHostExtras: observeSignIn is sent as
(request, value), and the PC quota channels answer null for a call that is not the PC's quota.

## Notes for later tasks (not fragment lines)

- HOST_METHOD rows browserLiveControl / screenDisplays / browserPage (x-host-gating-ts item 1) were not added: each
  method name already lives in its own module (browser-live-control.ts, HOST_SCREEN_DISPLAYS, HOST_BROWSER_PAGE),
  and the x-host-screen-displays review removed that duplicate row.
- host/browser/surface: main/index.ts no longer passes onSurfaceRequest (the browserRemoteOpen desktop operation),
  so each reveal/hide is sent once, by registerBrowserSurfaceReport. Now unused, for the deletion task: the
  onSurfaceRequest option chain (browser/host.ts, host-pages.ts and its filter copy, guest-lifecycle.ts,
  guest-surface-requests.ts) and the browserRemoteOpen route in protocol/desktop-operation-route.ts.
- ipc-host-extras.ts still imports PcQuotaHost from ipc-window-settings.ts (the deletion task moves it).
- host/browser/page has no resend on reclaim (x-host-browser-page review): a stream still alive across a core restart
  reports again only on its next relock or navigation.
