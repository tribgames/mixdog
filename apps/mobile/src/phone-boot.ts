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
import { publishMediaKey, revokeMediaKey } from '../../desktop/src/renderer/remote-media-lane.ts';
import { currentDeviceId, savePcName } from '../../desktop/src/renderer/remote-saved-pcs.ts';
import { readRelayPayloadRejection } from '../../desktop/src/shared/remote-payload-limit.ts';
import { REMOTE_SECURE_CHANNEL_READY_EVENT, type RemoteShimContext } from '../../desktop/src/renderer/remote-shim-state.ts';
import { connectPhone, type PhoneClient } from './phone-client.ts';
import { peerFlagsOf } from './phone-capabilities.ts';
import { createLaneFeeds, type LaneFeeds } from './phone-lanes.ts';
import type { PhoneConnection, VersionRefusal } from './phone-status.ts';
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
  /** Recover from a core initialize refusal without touching the saved pairing. */
  updateRequired(reason: VersionRefusal): void;
}

export interface PhoneBoot {
  /** Dials (once): credentials, registration, the client. Resolves when the client is up and its view is being attached. */
  start(): Promise<PhoneClient>;
  client(): ProtocolClient<SessionFold> | undefined;
  /** Called with the client that is up and with every client that replaces it (a re-pairing dials a new one); returns the unsubscribe. */
  onClient(listener: (client: ProtocolClient<SessionFold>) => void): () => void;
  onPairingReset(listener: () => void): () => void;
  resetPairing(): void;
  /** Resolves when the connection that is up has attached the app feed and the open threads. */
  synced(): Promise<void>;
  /** Resolves when the connection that is up has attached the app feed (the conversation list needs no more). */
  appSynced(): Promise<void>;
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
}

const REGISTRATION_REFUSED = new Set([401, 403, 409]);

export function bootPhone(ctx: RemoteShimContext, env: PhoneEnv): PhoneBoot {
  const random = env.random ?? Math.random;
  let phone: PhoneClient | undefined;
  // The link of a first connection still being dialed: the page lifecycle reaches it before `phone` exists.
  let dialLink: PhoneClient['link'] | undefined;
  let starting: Promise<PhoneClient> | undefined;
  let view: ViewManager | undefined;
  let lanes: LaneFeeds | undefined;
  let pendingLanes: Iterable<string> = [];
  const declaredLanes = new Map<string, readonly string[]>();
  const clientListeners = new Set<(client: ProtocolClient<SessionFold>) => void>();
  const pairingResetListeners = new Set<() => void>();
  let pairingGeneration = 0;
  // The threads the page itself asked for (`setVisibleSessions`), kept across client replacement and apart from what storage restored.
  let explicitSelection: readonly string[] = [];
  let dial: AbortController | undefined;
  let versionRefused = false;
  const clearMedia = (): void => {
    if (ctx.mediaSid) revokeMediaKey(ctx.mediaSid);
    ctx.mediaSid = null;
  };
  const resetPairing = (): void => {
    pairingGeneration++;
    clearMedia();
    dial?.abort();
    dialLink = undefined;
    releaseHolders();
    starting = undefined;
    view?.stop();
    view = undefined;
    lanes?.stop();
    lanes = undefined;
    const retired = phone;
    phone = undefined;
    for (const listener of pairingResetListeners) listener();
    void retired?.client.close();
  };
  // The page told the PC it is in the background (Node's `reportedBackground`).
  let background = false;
  // Node's resyncOnWake / resyncAfterWakeProbe: a page that was away, or whose connection ended, resyncs on its next wake, and only once the relay
  // has answered that wake's probe (a leg that does not answer is replaced by a connection that syncs on its own).
  let resyncOnWake = false;
  let resyncAfterProbe = false;
  const hidden = (): boolean => document.visibilityState === 'hidden';
  // The first connection's one owner of wake, hide, suspend and abort, registration included: every wait before the first socket is a
  // holder, released by a foreground wake or a pairing reset, and none ends while the page is hidden or suspended.
  const holders = new Set<() => void>();
  const releaseHolders = (): void => {
    const all = [...holders];
    holders.clear();
    for (const release of all) release();
  };
  const pause = (ms: number): Promise<void> =>
    new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer);
        holders.delete(finish);
        done();
      };
      const timer = setTimeout(() => {
        if (!hidden() && !ctx.backgroundSuspended) finish();
      }, ms);
      holders.add(finish);
    });
  const untilForeground = async (assertCurrent: () => void): Promise<void> => {
    // Rule B: no socket opens while the page is hidden or suspended.
    while (ctx.backgroundSuspended || hidden()) {
      await new Promise<void>((release) => holders.add(release));
      assertCurrent();
    }
  };

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
        ctx.resetApprovalAndAsk(earlyUiT('Your PC disconnected this device.'));
        return;
      case 'update-required':
        ctx.connectionReady = false;
        versionRefused = true;
        env.updateRequired(next.reason);
        return;
      case 'closed':
        ctx.connectionReady = false;
    }
  };

  // A relay pong permits the check; only the core's answer can establish that the feeds need no recovery.
  let wakeCheck: Promise<void> | undefined;
  let hintedDuringCheck = false;
  let gapGeneration: number | undefined;
  const wakeView = (hint = false): void => {
    const waking = view;
    if (!waking) return;
    if (wakeCheck) {
      hintedDuringCheck ||= hint;
      return;
    }
    let recovering = false;
    const recover = (): void => {
      if (view !== waking) return;
      recovering = true;
      gapGeneration = pairingGeneration;
      // A missed feed is not repaired by reattaching only the app and thread feeds. Replace the leg so every wanted feed
      // is reattached once, with its own cursor, and no late attach can replace the recovered subscription.
      phone?.link.retire();
    };
    const check = waking.wake(lanes?.expected()).then((confirmed) => {
      if (!confirmed) recover();
    }, recover).finally(() => {
      wakeCheck = undefined;
      const again = hintedDuringCheck;
      hintedDuringCheck = false;
      if (again && !recovering) wakeView();
    });
    wakeCheck = check;
  };

  const onSynced = (): void => {
    ctx.restoredVisibleSessionIds = [];
    setRemoteConnectionState('connected');
    window.dispatchEvent(new Event(REMOTE_CONNECTION_READY_EVENT));
    phone?.screen?.synced();
    if (gapGeneration === pairingGeneration) {
      gapGeneration = undefined;
      window.dispatchEvent(new Event('mixdog:remote-state-gap'));
    }
    // Terminal panes can hold PTY ids from the connection that died: told only after the replacement settled.
    if (ctx.pendingReconnectNotification) {
      ctx.pendingReconnectNotification = false;
      window.dispatchEvent(new Event('mixdog:remote-reconnected'));
    }
  };

  const register = async (assertCurrent: () => void): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      assertCurrent();
      try {
        await ctx.ensureClientRegistration();
        return;
      } catch (error) {
        assertCurrent();
        const status = (error as { status?: number } | null)?.status;
        reportRemoteConnectionIssue('registration-failed', error, status);
        // This credential was revoked or its slot is gone: only a new approval fixes it. Anything else retries.
        if (status !== undefined && REGISTRATION_REFUSED.has(status)) {
          ctx.resetApprovalAndAsk(earlyUiT('Your PC disconnected this device.'));
          throw error;
        }
        await pause(ladderDelay(attempt, random()));
        assertCurrent();
        await untilForeground(assertCurrent);
      }
    }
  };

  const run = async (): Promise<PhoneClient> => {
    const generation = pairingGeneration;
    const assertCurrent = (): void => {
      if (generation !== pairingGeneration) throw remoteConnectionInterruptedError();
    };
    const controller = new AbortController();
    dial = controller;
    await ctx.waitForCredential();
    assertCurrent();
    await untilForeground(assertCurrent);
    await register(assertCurrent);
    assertCurrent();
    // A registration that finished after the background grace opens no socket until the page is back.
    await untilForeground(assertCurrent);
    setRemoteConnectionPhase('websocket');
    const connected = await connectPhone({
      deviceId: ctx.deviceId,
      version: env.version,
      ...(env.build ? { build: env.build } : {}),
      pairing: () => ctx.e2eePairing!,
      socketUrl: () => ctx.wsUrl(),
      createSocket: env.createSocket,
      visible: () => !hidden(),
      linked: (link) => {
        if (generation === pairingGeneration) dialLink = link;
      },
      ...(env.webrtc ? { webrtc: env.webrtc } : {}),
      random,
      signal: controller.signal,
      onConnection: (state) => {
        if (generation === pairingGeneration) onConnection(state);
      },
      onClose: (code, _reason, info) => {
        if (generation !== pairingGeneration) return;
        clearMedia();
        resyncOnWake = true;
        resyncAfterProbe = false;
        ctx.limits.resetLearnedCaps();
        if (info.remote && !phone?.link.suspended) reportRemoteConnectionIssue('websocket-closed', undefined, code);
      },
      dialing: () => setRemoteConnectionPhase('websocket'),
      encrypting: () => setRemoteConnectionPhase('encryption'),
      unresponsive: () => reportRemoteConnectionIssue('heartbeat-timeout'),
      probeAnswered: () => {
        if (generation !== pairingGeneration) return;
        if (!resyncAfterProbe) return;
        resyncAfterProbe = false;
        wakeView();
      },
      resyncHint: (word) => {
        if (generation !== pairingGeneration) return;
        // A `frame-too-large` notice carries the ceiling the relay enforces: learned, and told to the user (Node: handleClearResync).
        const rejected = readRelayPayloadRejection(word, false);
        if (rejected) ctx.limits.applyRelayPayloadRejection(rejected);
        wakeView(true);
      },
      ready: (hello, media) => {
        if (generation !== pairingGeneration) return;
        if (media) {
          ctx.mediaSid = media.sid;
          publishMediaKey(media.sid, media.key, { base: ctx.serverBase || location.origin, token: ctx.currentToken });
        }
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
    if (generation !== pairingGeneration) {
      await connected.client.close();
      assertCurrent();
    }
    phone = connected;
    dialLink = undefined;
    const applyFlags = (): void => void Object.assign(ctx, peerFlagsOf(connected.client.server.capabilities));
    applyFlags();
    connected.client.on((event) => {
      if (event.type === 'status' && event.status.state === 'ready') applyFlags();
    });
    view = createViewManager(connected.client, {
      restored: ctx.restoredVisibleSessionIds,
      // What the last visit left is only restored; the page's own selection survives the replacement of its client (a re-pairing).
      wanted: explicitSelection,
      onSynced,
      syncing: () => setRemoteConnectionState('syncing'),
      error: (error) => {
        reportRemoteConnectionIssue('sync-failed', error);
        console.warn('[mixdog-remote] view synchronization failed; retrying', error);
      },
      recycle: () => connected.link.retire(),
      probe: () => wake(),
      silentSince: (since) => connected.link.silentSince(since),
    });
    lanes = createLaneFeeds(connected.client, {
      redraw: () => {
        if (generation === pairingGeneration) window.dispatchEvent(new Event('mixdog:remote-terminal-gap'));
      },
      retire: () => connected.link.retire(),
    });
    for (const [lane, feeds] of declaredLanes) lanes.declare(lane, feeds);
    lanes.use(pendingLanes);
    // Each client the page dials (a re-pairing makes a new one in the same page) is handed to whoever reads its events.
    for (const listener of [...clientListeners]) listener(connected.client);
    // The first sync, and every later connection's, is the view machine's own.
    return connected;
  };

  const start = (): Promise<PhoneClient> => {
    // A page the OS put in the background holds no connection until it is back.
    if (!starting && ctx.backgroundSuspended) return Promise.reject(remoteConnectionInterruptedError());
    if (!starting) {
      const attempt = run();
      starting = attempt;
      void attempt.catch(() => {
        if (starting === attempt && !versionRefused) starting = undefined;
      });
    }
    return starting;
  };

  // Page lifecycle: the grace before a hidden page lets go of the relay, the report to the PC, and the wake.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let frozen = false;
  const beginBackgroundGrace = (): void => {
    (phone?.link ?? dialLink)?.hidden();
    resyncOnWake = true;
    if (!env.suspendApplies()) return;
    if (!background) {
      background = true;
      phone?.screen?.refresh();
    }
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
    (phone?.link ?? dialLink)?.suspend();
  };
  const wake = (event?: Event): void => {
    if (versionRefused) return;
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
      // Before the first connection the redial wait (up to 60 s) and a suspension are the link's: a wake releases both.
      dialLink?.wake();
      releaseHolders();
      void start().catch(() => undefined);
      return;
    }
    const probing = phone.link.wake();
    if (!probing) resyncOnWake = true;
    else if (resyncOnWake || event?.type === 'online' || event?.type === REMOTE_WAKE_EVENT) {
      resyncOnWake = false;
      resyncAfterProbe = true;
    }
  };
  document.addEventListener('freeze', () => {
    frozen = true;
    resyncOnWake = true;
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
    client: () => phone?.client,
    onClient: (listener) => {
      clientListeners.add(listener);
      if (phone) listener(phone.client);
      return () => void clientListeners.delete(listener);
    },
    onPairingReset: (listener) => {
      pairingResetListeners.add(listener);
      return () => void pairingResetListeners.delete(listener);
    },
    resetPairing,
    synced: async () => {
      await start();
      await view!.synced();
    },
    appSynced: async () => {
      await start();
      await view!.appSynced();
    },
    setVisibleSessions: async (threadIds) => {
      explicitSelection = [...threadIds];
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
