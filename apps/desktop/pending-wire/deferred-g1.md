# DESKTOP-WIRE-G1: fragment lines not applied

Every other line of the eleven G1 desktop fragments was applied (see the DESKTOP-WIRE-G1 commits); the fragments are deleted.

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
