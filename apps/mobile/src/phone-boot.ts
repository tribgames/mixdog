// The relay web app's connection to the PC, on `phone-client`. It replaces the Node shim's socket, liveness, view-sync and call
// modules: credentials and registration run before the dial, the protocol client carries everything after it, and the existing
// connection indicator (`data-mixdog-remote-connection` / `-phase`, read by the banner and the gates) is driven from the client's
// status so nothing that reads it changes.
import { ladderDelay, type ProtocolClient, type SessionFold } from '../../../packages/protocol-client/src/index.ts';
import { earlyUiT } from '../../desktop/src/renderer/early-ui-i18n.ts';
import {
  REMOTE_CONNECTION_READY_EVENT,
  REMOTE_WAKE_EVENT,
  beginRemoteConnectionTimeline,
  remoteConnectionInterruptedError,
  reportRemoteConnectionIssue,
  setRemoteConnectionPhase,
  setRemoteConnectionState,
} from '../../desktop/src/renderer/remote-connection-state.ts';
import { setRemoteHostName, setRemoteHostOpenAccess } from '../../desktop/src/renderer/remote-host-access.ts';
import { currentDeviceId, savePcName } from '../../desktop/src/renderer/remote-saved-pcs.ts';
import { REMOTE_SECURE_CHANNEL_READY_EVENT, type RemoteShimContext } from '../../desktop/src/renderer/remote-shim-state.ts';
import { connectPhone, type PhoneClient } from './phone-client.ts';
import { peerFlagsOf } from './phone-capabilities.ts';
import { createLaneFeeds, type LaneFeeds } from './phone-lanes.ts';
import type { PhoneConnection } from './phone-status.ts';
import { createViewManager, type ViewManager } from './phone-view.ts';
import type { RelaySocket } from './relay-connector.ts';

/** A quick app switch must not cost the connection: going hidden only arms this, and the suspension runs if the page is still hidden when it ends. */
export const BACKGROUND_GRACE_MS = 30_000;

export interface PhoneEnv {
  readonly version: string;
  readonly build?: string;
  createSocket(url: string): RelaySocket;
  /** Installed app with a credential: only then is a hidden page released from the relay (a plain tab keeps its socket). */
  suspendApplies(): boolean;
  /** The sessions whose visualize panel the page shows. */
  visualizePanels(): readonly string[];
  readonly webrtc?: Parameters<typeof connectPhone>[0]['webrtc'];
  readonly random?: () => number;
  /** The PC runs another version than this page; the page must be reloaded from the relay after the update. */
  updateRequired(): void;
}

export interface PhoneBoot {
  /** Dials (once): credentials, registration, the client. Resolves when the client is up and its view is being attached. */
  start(): Promise<PhoneClient>;
  client(): ProtocolClient<SessionFold> | undefined;
  /** Resolves when the connection that is up has attached the app feed and the open threads. */
  synced(): Promise<void>;
  setVisibleSessions(threadIds: readonly string[]): Promise<boolean>;
  /** The page or the shown threads changed. */
  refreshScreen(): void;
  useLanes(lanes: Iterable<string>): void;
  declareLane(lane: string, feedIds: readonly string[]): void;
  readonly link: PhoneClient['link'] | undefined;
  /** Node's wakeProbe: what an overdue or silent call asks of the connection. */
  wakeProbe(): void;
  /** Nothing has arrived since `since` and no probe is out. */
  silentSince(since: number): boolean;
  /** Resolves when the next request frame has left this page. */
  nextRequestSent(): Promise<void>;
}

const REGISTRATION_REFUSED = new Set([401, 403, 409]);

export function bootPhone(ctx: RemoteShimContext, env: PhoneEnv): PhoneBoot {
  const random = env.random ?? Math.random;
  let phone: PhoneClient | undefined;
  let starting: Promise<PhoneClient> | undefined;
  let view: ViewManager | undefined;
  let lanes: LaneFeeds | undefined;
  let pendingLanes: Iterable<string> = [];
  const declaredLanes = new Map<string, readonly string[]>();
  // The page told the PC it is in the background (Node's `reportedBackground`).
  let background = false;
  // Node's resyncOnWake / resyncAfterWakeProbe: a page that was away, or whose connection ended, resyncs on its next wake, and only once the relay
  // has answered that wake's probe (a leg that does not answer is replaced by a connection that syncs on its own).
  let resyncOnWake = false;
  let resyncAfterProbe = false;
  const hidden = (): boolean => document.visibilityState === 'hidden';
  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  const onConnection = (next: PhoneConnection): void => {
    switch (next.state) {
      case 'connecting':
      case 'reconnecting':
        // Node's finishClose: no connection is ready, and until a host's challenge says otherwise there is no host to read capabilities from.
        ctx.connectionReady = false;
        ctx.peerBrowserWebrtc = 0;
        ctx.peerBrowserFit = null;
        setRemoteConnectionState(next.state);
        return;
      case 'connected':
        // A new leg is unknown to the PC until the screen reporter tells it; each connection states its visibility once.
        background = hidden();
        resyncOnWake = false;
        ctx.connectionReady = true;
        // Node's finishOpen: connection history is recorded at once, so a first connection that dies before its first sync completes still
        // makes its replacement a reconnection; the notice is told after that replacement syncs (onSynced).
        ctx.pendingReconnectNotification = ctx.everConnected;
        ctx.everConnected = true;
        setRemoteConnectionPhase('sync');
        setRemoteConnectionState('syncing');
        if (!ctx.everPaired) {
          ctx.everPaired = true;
          try {
            localStorage.setItem(ctx.pairingKeys.paired, '1');
          } catch {
            /* no storage */
          }
        }
        if (!ctx.approvalVerificationInFlight) document.getElementById('mixdog-remote-pairing')?.remove();
        window.dispatchEvent(new Event(REMOTE_SECURE_CHANNEL_READY_EVENT));
        return;
      case 'pairing-lost':
        ctx.connectionReady = false;
        starting = undefined;
        phone = undefined;
        ctx.resetApprovalAndAsk(earlyUiT('Your PC disconnected this device.'));
        return;
      case 'update-required':
        ctx.connectionReady = false;
        env.updateRequired();
        return;
      case 'closed':
        ctx.connectionReady = false;
    }
  };

  const onSynced = (): void => {
    ctx.restoredVisibleSessionIds = [];
    setRemoteConnectionState('connected');
    window.dispatchEvent(new Event(REMOTE_CONNECTION_READY_EVENT));
    phone?.screen?.synced();
    // Terminal panes can hold PTY ids from the connection that died: told only after the replacement settled.
    if (ctx.pendingReconnectNotification) {
      ctx.pendingReconnectNotification = false;
      window.dispatchEvent(new Event('mixdog:remote-reconnected'));
    }
  };

  const register = async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await ctx.ensureClientRegistration();
        return;
      } catch (error) {
        const status = (error as { status?: number } | null)?.status;
        reportRemoteConnectionIssue('registration-failed', error, status);
        // This credential was revoked or its slot is gone: only a new approval fixes it. Anything else retries.
        if (status !== undefined && REGISTRATION_REFUSED.has(status)) {
          ctx.resetApprovalAndAsk(earlyUiT('Your PC disconnected this device.'));
          throw error;
        }
        await sleep(ladderDelay(attempt, random()));
      }
    }
  };

  const run = async (): Promise<PhoneClient> => {
    await ctx.waitForCredential();
    await register();
    setRemoteConnectionPhase('websocket');
    const connected = await connectPhone({
      deviceId: ctx.deviceId,
      version: env.version,
      ...(env.build ? { build: env.build } : {}),
      pairing: () => ctx.e2eePairing!,
      socketUrl: () => ctx.wsUrl(),
      createSocket: env.createSocket,
      visible: () => !hidden(),
      ...(env.webrtc ? { webrtc: env.webrtc } : {}),
      random,
      onConnection,
      onClose: (code, _reason, info) => {
        resyncOnWake = true;
        resyncAfterProbe = false;
        ctx.limits.resetLearnedCaps();
        if (info.remote && !phone?.link.suspended) reportRemoteConnectionIssue('websocket-closed', undefined, code);
      },
      dialing: () => setRemoteConnectionPhase('websocket'),
      encrypting: () => setRemoteConnectionPhase('encryption'),
      unresponsive: () => reportRemoteConnectionIssue('heartbeat-timeout'),
      probeAnswered: () => {
        if (!resyncAfterProbe) return;
        resyncAfterProbe = false;
        void view?.resync().catch(() => undefined);
      },
      resyncHint: () => void view?.resync().catch(() => undefined),
      ready: (hello) => {
        ctx.limits.learnRoutingCaps(hello);
        setRemoteHostOpenAccess(hello.remoteOpenAccess === 1);
        if (typeof hello.hostName === 'string') {
          setRemoteHostName(hello.hostName);
          savePcName(currentDeviceId(), hello.hostName);
        }
      },
      screen: {
        active: () => !background,
        threads: () => ctx.lastScreenSessionIds,
        browserId: () => ctx.browserId,
        visualizePanels: () => env.visualizePanels(),
      },
    });
    phone = connected;
    const applyFlags = (): void => void Object.assign(ctx, peerFlagsOf(connected.client.server.capabilities));
    applyFlags();
    connected.client.on((event) => {
      if (event.type === 'status' && event.status.state === 'ready') applyFlags();
    });
    view = createViewManager(connected.client, {
      restored: ctx.restoredVisibleSessionIds,
      wanted: ctx.lastVisibleSessionIds,
      onSynced,
      syncing: () => setRemoteConnectionState('syncing'),
      error: (error) => {
        reportRemoteConnectionIssue('sync-failed', error);
        console.warn('[mixdog-remote] view synchronization failed; retrying', error);
      },
      recycle: () => connected.link.retire(),
      probe: () => wake(),
      silentSince: (since) => connected.link.silentSince(since),
      nextRequestSent: () => connected.link.nextRequestSent(),
    });
    lanes = createLaneFeeds(connected.client);
    for (const [lane, feeds] of declaredLanes) lanes.declare(lane, feeds);
    lanes.use(pendingLanes);
    // The threads the page named (or the last visit had); the first sync, and every later connection's, is the view machine's own.
    void view.set(ctx.lastVisibleSessionIds).catch(() => undefined);
    return connected;
  };

  const start = (): Promise<PhoneClient> => {
    // A page the OS put in the background holds no connection until it is back.
    if (!starting && ctx.backgroundSuspended) return Promise.reject(remoteConnectionInterruptedError());
    starting ??= run().catch((error: unknown) => {
      starting = undefined;
      throw error;
    });
    return starting;
  };

  // Page lifecycle: the grace before a hidden page lets go of the relay, the report to the PC, and the wake.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let frozen = false;
  const beginBackgroundGrace = (): void => {
    phone?.link.hidden();
    if (!env.suspendApplies()) return;
    if (!background) {
      background = true;
      phone?.screen?.refresh();
    }
    resyncOnWake = true;
    if (graceTimer !== undefined) return;
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      if (hidden()) suspend();
    }, BACKGROUND_GRACE_MS);
  };
  const suspend = (): void => {
    if (!env.suspendApplies()) return;
    setRemoteConnectionPhase('background');
    ctx.backgroundSuspended = true;
    resyncOnWake = true;
    setRemoteConnectionState('connecting');
    phone?.link.suspend();
  };
  const wake = (event?: Event): void => {
    if (event?.type === 'resume') frozen = false;
    if (hidden()) {
      beginBackgroundGrace();
      return;
    }
    if (frozen) return;
    clearTimeout(graceTimer);
    graceTimer = undefined;
    if (background) {
      background = false;
      phone?.screen?.refresh();
    }
    if (ctx.backgroundSuspended) beginRemoteConnectionTimeline('wake');
    ctx.backgroundSuspended = false;
    if (!phone) {
      void start().catch(() => undefined);
      return;
    }
    const probing = phone.link.wake();
    if (!probing) resyncOnWake = true;
    else if (resyncOnWake || event?.type === 'online') {
      resyncOnWake = false;
      resyncAfterProbe = true;
    }
  };
  document.addEventListener('freeze', () => {
    frozen = true;
  });
  document.addEventListener('visibilitychange', wake);
  document.addEventListener('resume', wake);
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('pagehide', beginBackgroundGrace);
  // Tapping the disconnect overlay runs the same recovery a wake does.
  window.addEventListener(REMOTE_WAKE_EVENT, wake);

  return {
    start,
    /** Node's wakeProbe: what an overdue or silent call asks of the connection. */
    wakeProbe: () => wake(),
    silentSince: (since: number): boolean => phone?.link.silentSince(since) ?? false,
    nextRequestSent: (): Promise<void> => phone?.link.nextRequestSent() ?? Promise.resolve(),
    client: () => phone?.client,
    synced: async () => {
      await start();
      await view!.synced();
    },
    setVisibleSessions: async (threadIds) => {
      await start();
      return view!.set(threadIds);
    },
    refreshScreen: () => phone?.screen?.refresh(),
    useLanes: (set) => {
      pendingLanes = [...set];
      lanes?.use(pendingLanes);
    },
    declareLane: (lane, feedIds) => {
      declaredLanes.set(lane, feedIds);
      lanes?.declare(lane, feedIds);
    },
    get link() {
      return phone?.link;
    },
  };
}
