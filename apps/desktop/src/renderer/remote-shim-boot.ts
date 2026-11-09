// Browser-mode DesktopApi: when the Relay serves this page to a phone/tablet, install the protocol-client-backed implementation
// of window.mixdogDesktop before any module reads it.
// Inside Electron the preload bridge already exists and this is a no-op.
//
// The page's one connection is the phone's protocol client (apps/mobile/src/phone-boot.ts). This file is the switch: pairing and
// the context stay here, `createPhoneApi` builds the DesktopApi over the client, and every `remote-protocol-<group>.ts` adapter
// answers its calls (remote-shim-adapters.ts). A Node call name no adapter claimed fails with its name.
import type { DesktopApi } from '../shared/contract';
import desktopPackage from '../../package.json';
import type { PhoneEnv } from '../../../mobile/src/phone-boot';
import type { RelaySocket } from '../../../mobile/src/relay-connector';
import { earlyUiT } from './early-ui-i18n';
import { isInstalledMobileWebAppSurface } from './mobile-surface';
import { REMOTE_NATIVE_PUSH_GLOBAL, createNativePushHost, installNativePushBridge } from './native-push-bridge';
import { installPushSubscriptionSync } from './push-notification-bridge';
import {
  markRemoteApprovalReason,
  setRemoteConnectionState,
  shouldRunRemoteHeartbeat,
} from './remote-connection-state';
import { remoteBootApproval } from './remote-pairing-recovery';
import type { PhoneProtocolAdapter } from './remote-shim-protocol';
import { createPhoneApi } from './remote-shim-phone';
import { installRemotePairing } from './remote-shim-pairing';
import { REMOTE_CONNECTION_READY_EVENT, createRemoteShimContext, type RemoteShimContext } from './remote-shim-state';

export function installPhoneShim(adapters: readonly PhoneProtocolAdapter[]): void {
  const w = window as Window & { mixdogDesktop?: DesktopApi };
  if (w.mixdogDesktop || typeof WebSocket === 'undefined') return;

  const ctx = createRemoteShimContext();
  installRemotePairing(ctx);
  w.mixdogDesktop = Object.freeze(createPhoneApi(ctx, adapters, phoneEnv(ctx)));
  // A renewed subscription reaches the desktop without a trip through Settings.
  installPushSubscriptionSync(w.mixdogDesktop, REMOTE_CONNECTION_READY_EVENT);
  // The phone app's APNs/FCM token reaches the host over this same channel.
  (w as unknown as Record<string, unknown>)[REMOTE_NATIVE_PUSH_GLOBAL] = Object.freeze(createNativePushHost(ctx));
  installNativePushBridge();
  // Settings → Connection on a remote surface: expose where this session is
  // connected so the panel shows live status instead of desktop-only pairing.
  (w as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer = ctx.serverBase || location.origin;
  void begin(ctx);
}

async function begin(ctx: ReturnType<typeof createRemoteShimContext>): Promise<void> {
  // A surface that holds no credential yet (a browser tab before its first
  // approval) asks the PC for approval directly; once approved it is marked and
  // dials like an installed app.
  const installed = isInstalledMobileWebAppSurface();
  // The OS may have trimmed localStorage and kept IndexedDB.
  if (installed && (!ctx.token || !ctx.e2eePairing)) await ctx.restoreDurablePairing();
  let claimPending = false;
  try {
    claimPending = Boolean(localStorage.getItem(ctx.pairingKeys.claim));
  } catch {
    /* no storage: nothing pending */
  }
  const approval = remoteBootApproval({
    installed,
    token: ctx.token,
    hasE2eePairing: Boolean(ctx.e2eePairing),
    browserIdStored: ctx.browserIdStored,
    claimPending,
  });
  if (approval !== 'dial') markRemoteApprovalReason(approval === 'lost' ? 'no-token' : approval);
  if (approval === 'not-installed' || approval === 'no-token') {
    ctx.showPairingScreen('');
    return;
  }
  if (approval === 'lost') {
    ctx.showPairingScreen(
      earlyUiT('This device’s saved sign-in was lost. Connect again to ask your PC.'),
      false,
      earlyUiT('Saved sign-in lost')
    );
    return;
  }
  if (approval === 'no-key') {
    ctx.resetApprovalAndAsk(earlyUiT('This connection is incomplete. Connect again.'));
    return;
  }
  setRemoteConnectionState('connecting');
  if (!ctx.backgroundSuspended && shouldRunRemoteHeartbeat(document.visibilityState)) {
    void ctx.phone.start().catch(() => {
      /* the client's own ladder keeps running; a refused registration already showed the pairing screen */
    });
  }
}

/** What the phone's connection needs from this page. */
function phoneEnv(ctx: RemoteShimContext): PhoneEnv {
  return {
    // The relay serves this page at the PC's version; the core's `initialize` gate compares it exactly.
    version: desktopPackage.version,
    createSocket: (url) => new WebSocket(url) as unknown as RelaySocket,
    suspendApplies: () => isInstalledMobileWebAppSurface() && !!ctx.token && !!ctx.e2eePairing,
    visualizePanels: () => ctx.visualizePanelIds,
    ...(typeof RTCPeerConnection === 'undefined'
      ? {}
      : {
          webrtc: {
            createPeer: (configuration: RTCConfiguration) => new RTCPeerConnection(configuration),
            visible: () => document.visibilityState !== 'hidden',
            log: (line: string) => console.info(line),
          },
        }),
    updateRequired: () =>
      ctx.showPairingScreen(
        earlyUiT('Update Mixdog on your PC, then reopen this page.'),
        false,
        earlyUiT('Update required')
      ),
  };
}