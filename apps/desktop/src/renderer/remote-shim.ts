// Browser-mode DesktopApi: when the Relay serves this page to a phone/tablet,
// install a WebSocket-backed implementation of window.mixdogDesktop before
// any module reads it.
// Inside Electron the preload bridge already exists and this is a no-op.
//
// The transport is split by responsibility, all sharing one context
// (remote-shim-state.ts): pairing, view sync, inbound dispatch, liveness, the
// socket state machine, calls, the payload-limit handling and the api table.
import type { DesktopApi } from '../shared/contract';
import { earlyUiT } from './early-ui-i18n';
import { isInstalledMobileWebAppSurface } from './mobile-surface';
import { REMOTE_NATIVE_PUSH_GLOBAL, createNativePushHost, installNativePushBridge } from './native-push-bridge';
import { syncPushSubscription } from './push-notification-bridge';
import { setRemoteConnectionState, shouldRunRemoteHeartbeat } from './remote-connection-state';
import { createRemoteApi } from './remote-shim-api';
import { installRemoteCalls } from './remote-shim-calls';
import { installRemoteDispatch } from './remote-shim-dispatch';
import { installRemoteLiveness } from './remote-shim-liveness';
import { installRemotePairing } from './remote-shim-pairing';
import { installRemoteSocket } from './remote-shim-socket';
import { REMOTE_CONNECTION_READY_EVENT, createRemoteShimContext } from './remote-shim-state';
import { installRemoteSync } from './remote-shim-sync';

(() => {
  const w = window as Window & { mixdogDesktop?: DesktopApi };
  if (w.mixdogDesktop || typeof WebSocket === 'undefined') return;

  const ctx = createRemoteShimContext();
  installRemoteSync(ctx);
  installRemotePairing(ctx);
  installRemoteDispatch(ctx);
  installRemoteLiveness(ctx);
  installRemoteSocket(ctx);
  installRemoteCalls(ctx);

  w.mixdogDesktop = Object.freeze(createRemoteApi(ctx));
  // A renewed subscription reaches the desktop without a trip through Settings.
  window.addEventListener(REMOTE_CONNECTION_READY_EVENT, () => void syncPushSubscription(w.mixdogDesktop), {
    once: true,
  });
  // The phone app's APNs/FCM token reaches the host over this same channel.
  (w as unknown as Record<string, unknown>)[REMOTE_NATIVE_PUSH_GLOBAL] = Object.freeze(createNativePushHost(ctx));
  installNativePushBridge({ api: w.mixdogDesktop });
  // Settings → Connection on a remote surface: expose where this session is
  // connected so the panel shows live status instead of desktop-only pairing.
  (w as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer = ctx.serverBase || location.origin;
  // A browser tab always gets the install guide. A desktop-installed PWA is
  // also guide-only: only an installed phone/tablet app may hold a credential
  // and dial the relay.
  if (!isInstalledMobileWebAppSurface() || !ctx.token) {
    ctx.showPairingScreen('');
    return;
  }
  if (!ctx.e2eePairing) {
    ctx.resetApprovalAndAsk(earlyUiT('This device has incomplete approval data. Ask for approval again.'));
    return;
  }
  setRemoteConnectionState('connecting');
  if (!ctx.backgroundSuspended && shouldRunRemoteHeartbeat(document.visibilityState)) {
    void ctx.connect().catch(() => {
      /* the retry loop keeps running */
    });
  }
})();
