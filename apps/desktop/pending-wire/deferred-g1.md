# DESKTOP-WIRE-G1: fragment lines not applied

Every other line of the eleven G1 desktop fragments was applied (see the DESKTOP-WIRE-G1 commits); the fragments are deleted.

## s2a-ts-host-extras (preload mirror)

Moved to deferred-g2.md (the channel mapping now exists in preload/host-api.ts; the preload exposure stays with
DESKTOP-WIRE-G5).

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
