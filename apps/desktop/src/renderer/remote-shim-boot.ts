import type { DesktopApi } from '../shared/contract';
import desktopPackage from '../../package.json';
import type { PhoneEnv } from '../../../mobile/src/phone-boot';
import type { RelaySocket } from '../../../mobile/src/relay-connector';
import { devInfo } from './dev-console';
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
import { createFirstScreenHold } from './remote-first-screen-hold';
import { installRemotePairing } from './remote-shim-pairing';
import { REMOTE_CONNECTION_READY_EVENT, createRemoteShimContext, type RemoteShimContext } from './remote-shim-state';

export function installPhoneShim(adapters: readonly PhoneProtocolAdapter[]): void {
  const w = window as Window & { mixdogDesktop?: DesktopApi; mixdogDesktopHost?: unknown };
  // Inside the desktop app the preload exposes the host half (window.mixdogDesktopHost) and the window composes
  // window.mixdogDesktop from it later (core-direct/install): the phone's API must not take its place meanwhile.
  if (w.mixdogDesktop || w.mixdogDesktopHost || typeof WebSocket === 'undefined') return;

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
    void ctx.phone
      .start()
      .then(() =>
        // The app's first screen waits on these; they ride the connection that is already syncing instead of following the app's
        // chunk download and evaluation. Only here: a redial or a wake never prefetches again.
        ctx.phone.prefetchBootReads([
          ['getSnapshot', []],
          ...(ctx.peerRemoteParity === true ? [['getUpdaterState', []] satisfies [string, unknown[]]] : []),
          ['listProjects', []],
          ['readSettings', []],
          ['readHostDisplayPreferences', []],
          ['readActivityRailPins', []],
          ['viewerDevice', []],
        ])
      )
      .catch(() => {
        /* the client's own ladder keeps running; a refused registration already showed the pairing screen */
      });
  }
}

/** What the phone's connection needs from this page. */
function phoneEnv(ctx: RemoteShimContext): PhoneEnv {
  const holdSignals = createFirstScreenHold();
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
            holdSignals,
            visible: () => document.visibilityState !== 'hidden',
            log: devInfo,
          },
        }),
    updateRequired: (reason) =>
      ctx.showPairingScreen(
        reason === 'clientOutdated'
          ? earlyUiT('Your PC has a newer version of Mixdog. Reload this page to get its matching web client.')
          : earlyUiT('Your PC has an older version of Mixdog. Reload this page or update Mixdog on your PC.'),
        false,
        earlyUiT('Version mismatch'),
        'reload'
      ),
  };
}
