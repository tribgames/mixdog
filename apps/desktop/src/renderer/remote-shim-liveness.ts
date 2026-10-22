// Keepalive, foreground wake, background suspension and the reconnect backoff.
import { isInstalledMobileWebAppSurface } from './mobile-surface';
import {
  REMOTE_WAKE_EVENT,
  beginRemoteConnectionTimeline,
  isRemoteDesktopOffline,
  reportRemoteConnectionIssue,
  setRemoteConnectionPhase,
  setRemoteConnectionState,
  shouldRunRemoteHeartbeat,
} from './remote-connection-state';
import { REMOTE_CONNECTION_READY_EVENT, type RemoteShimContext } from './remote-shim-state';

/** Shortest wait before a reconnect attempt after the immediate first one. */
const RECONNECT_MIN_MS = 500;
/** How far the first retry after a relay-side close of a live leg is spread. */
const FLEET_FIRST_RETRY_SPREAD_MS = 1_500;
/** Longest wait between two reconnect attempts. */
const RECONNECT_MAX_MS = 10_000;
/** The same ceiling while the relay's latest answer is "PC offline": nothing
 *  can connect until the PC returns, so each phone backs off much further
 *  instead of being refused every few seconds. A wake still redials at once. */
const OFFLINE_RECONNECT_MAX_MS = 60_000;
/** How long a foreground wake waits for the relay to answer its probe. */
const WAKE_PROBE_MS = 2_500;
/** Frames still arriving this long after a wake probe come from a live leg.
 *  Anything earlier may be the burst a frozen page queued before its socket
 *  died, dispatched only when the page thaws. */
const WAKE_TRAFFIC_PROOF_MS = 1_000;

export const installRemoteLiveness = (ctx: RemoteShimContext): void => {
  // NAT/carrier middleboxes silently drop idle WebSockets; the browser
  // cannot send protocol pings, so an app-level ping/pong detects the
  // half-dead socket and recycles it, and a foreground/online wake probe
  // reconnects immediately instead of on the next (hanging) tap.
  // Any inbound frame already proves this leg is alive. The keepalive lane
  // therefore exists ONLY for a silent socket: a busy session never spends a
  // probe, and never risks the recycle that a lost pong triggers.
  const clearWakePongTimer = (): void => {
    if (ctx.wakePongTimer === null) return;
    window.clearTimeout(ctx.wakePongTimer);
    ctx.wakePongTimer = null;
  };
  const clearReconnectTimer = (): void => {
    if (ctx.reconnectTimer === null) return;
    window.clearTimeout(ctx.reconnectTimer);
    ctx.reconnectTimer = null;
  };
  // Recycling a silent socket is invisible maintenance: nothing is waiting on
  // an answer, so the redial that follows must not raise the disconnect
  // surface. A close with calls in flight keeps the normal, visible path.
  const recycleIdleSocket = (ws: WebSocket): void => {
    reportRemoteConnectionIssue('heartbeat-timeout');
    if (ctx.pending.size === 0) ctx.quietRecycledSockets.add(ws);
    ctx.retireConnection?.();
  };
  // The leg answered after a wake: it is live again, and only now is the
  // resync that wake asked for worth sending. Started earlier, it would put a
  // possibly dead socket into 'syncing' and run the disconnect countdown
  // through the probe, the redial and the fresh connection's own sync.
  const wakeProbeAnswered = (): void => {
    ctx.unprovenSocket = null;
    if (!ctx.resyncAfterWakeProbe) return;
    ctx.resyncAfterWakeProbe = false;
    ctx.requestResync();
  };
  // Only the relay's pong answers a wake probe: frames dispatched as a frozen
  // page thaws may have been queued before its socket died.
  const answerWakeProbe = (): void => {
    if (ctx.wakePongTimer === null) return;
    clearWakePongTimer();
    wakeProbeAnswered();
  };
  window.setInterval(() => {
    if (ctx.backgroundSuspended || !shouldRunRemoteHeartbeat(document.visibilityState)) {
      ctx.awaitingPong = false;
      return;
    }
    const ws = ctx.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ctx.awaitingPong = false;
      return;
    }
    if (ctx.awaitingPong) {
      if (Date.now() - ctx.heartbeatSentAt >= 10_000) {
        ctx.awaitingPong = false;
        recycleIdleSocket(ws);
      }
      return;
    }
    // Silence, not elapsed time, is what needs probing: a leg that just
    // delivered a frame is provably alive.
    if (Date.now() - Math.max(ctx.lastTrafficAt, ctx.heartbeatSentAt) >= 25_000) {
      ctx.heartbeatSentAt = Date.now();
      ctx.awaitingPong = true;
      try {
        ws.send('{"ping":1}');
      } catch {
        /* surfaces as close */
      }
    }
  }, 5_000);
  beginRemoteConnectionTimeline('boot');
  const backgroundSuspendApplies = (): boolean => isInstalledMobileWebAppSurface() && !!ctx.token && !!ctx.e2eePairing;
  const suspendRemoteConnection = (): void => {
    if (!backgroundSuspendApplies()) return;
    setRemoteConnectionPhase('background');
    ctx.backgroundSuspended = true;
    ctx.resyncOnWake = true;
    ctx.awaitingPong = false;
    clearWakePongTimer();
    clearReconnectTimer();
    setRemoteConnectionState('connecting');
    ctx.retireConnection?.(1000, 'background');
  };
  // A quick app switch must not cost the relay leg: going hidden only arms
  // this grace, and the suspend above runs only if the page is still hidden
  // when it expires. A return within the grace takes the live-socket wake
  // path (ping probe, half-dead recycle, resync) instead of a full redial.
  const BACKGROUND_GRACE_MS = 30_000;
  // The socket outlives the grace above, so "connected" no longer means "on
  // screen": the desktop is told directly, or it would hold back the push
  // notification for a turn that finishes while the phone is in a pocket.
  // Every report names this browser: the relay gives each leg a fresh id, and
  // only the browser id ties the leg to this browser's push subscription.
  let reportedBackground = false;
  const reportForeground = (foreground: boolean): void => {
    if (reportedBackground === !foreground) return;
    reportedBackground = !foreground;
    if (ctx.socket?.readyState !== WebSocket.OPEN) return;
    ctx.fire('setForeground', [foreground, ctx.browserId]);
  };
  // A new leg is unknown to the desktop until it reports, so each connection
  // states its current visibility once.
  window.addEventListener(REMOTE_CONNECTION_READY_EVENT, () => {
    reportedBackground = document.visibilityState === 'hidden';
    ctx.fire('setForeground', [!reportedBackground, ctx.browserId]);
  });
  const clearBackgroundGrace = (): void => {
    if (ctx.backgroundGraceTimer === null) return;
    window.clearTimeout(ctx.backgroundGraceTimer);
    ctx.backgroundGraceTimer = null;
  };
  const beginBackgroundGrace = (): void => {
    // A phone suspends a backgrounded page and may kill its socket without a
    // close it can deliver before the page is back. Until a wake probe proves
    // it, this leg dying is the cost of the background, not an outage.
    if (ctx.socket?.readyState === WebSocket.OPEN) ctx.unprovenSocket = ctx.socket;
    if (!backgroundSuspendApplies()) return;
    reportForeground(false);
    ctx.resyncOnWake = true;
    if (ctx.backgroundGraceTimer !== null) return;
    ctx.backgroundGraceTimer = window.setTimeout(() => {
      ctx.backgroundGraceTimer = null;
      if (document.visibilityState === 'hidden') suspendRemoteConnection();
    }, BACKGROUND_GRACE_MS);
  };
  // A frozen page is thawed AFTER `visibilitychange` (and `focus`) fire, and
  // the engine fails any WebSocket opened while the page is still frozen
  // ("Page entered Back-Forward Cache", close 1006, ~20-100 ms). Every wake
  // therefore waits for `resume`, which re-runs this same probe.
  let frozen = false;
  document.addEventListener('freeze', () => {
    frozen = true;
  });
  const wakeProbe = (event?: Event): void => {
    if (event?.type === 'resume') frozen = false;
    if (document.visibilityState === 'hidden') {
      beginBackgroundGrace();
      return;
    }
    if (frozen) return;
    clearBackgroundGrace();
    reportForeground(true);
    if (ctx.backgroundSuspended) beginRemoteConnectionTimeline('wake');
    ctx.backgroundSuspended = false;
    const shouldResync = ctx.resyncOnWake || event?.type === 'online';
    const ws = ctx.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ctx.resyncOnWake = true;
      ctx.retryMs = 0;
      // The redial below replaces the wait still running: left armed (up to
      // 60 s while the PC is offline), it would swallow this redial's own
      // failure and the backoff would never restart from the minimum.
      clearReconnectTimer();
      // Neither a stalled handshake nor a delayed close event may keep
      // connect() pinned to the previous attempt after a foreground wake.
      const attempt = ctx.openingSocket ?? ws;
      if (
        attempt &&
        (attempt.readyState >= WebSocket.CLOSING ||
          (attempt.readyState === WebSocket.CONNECTING && Date.now() - ctx.openingStartedAt >= 1_500))
      ) {
        ctx.retireConnection?.();
      }
      void ctx.connect().catch(() => {
        /* the retry loop keeps running */
      });
      return;
    }
    // A wake must never inherit a grown backoff: if this probe fails, the
    // redial that follows IS the gap the user watches.
    ctx.retryMs = 0;
    ctx.heartbeatSentAt = Date.now();
    ctx.awaitingPong = true;
    ctx.unprovenSocket = ws;
    try {
      ws.send('{"ping":1}');
    } catch {
      /* surfaces as close */
    }
    // Foreground recovery should not inherit the normal 10s background
    // heartbeat budget. If this exact probe gets no response, recycle the
    // half-open socket promptly; its close redials silently (unprovenSocket).
    clearWakePongTimer();
    const probeSentAt = ctx.heartbeatSentAt;
    ctx.wakePongTimer = window.setTimeout(() => {
      ctx.wakePongTimer = null;
      if (ctx.socket !== ws || ctx.unprovenSocket !== ws) return;
      // A leg still delivering a backlog queues the pong behind it.
      if (ctx.lastTrafficAt - probeSentAt >= WAKE_TRAFFIC_PROOF_MS) {
        wakeProbeAnswered();
        return;
      }
      ctx.awaitingPong = false;
      recycleIdleSocket(ws);
    }, WAKE_PROBE_MS);
    // A live socket proves nothing about the transcript: pushes sent while
    // this tab was hidden may have been dropped for a congested leg, and a
    // finished turn never sends another patch to expose it. The resync waits
    // for the probe (wakeProbeAnswered); a recycled leg's replacement runs its
    // own full sync instead.
    if (shouldResync) {
      ctx.resyncOnWake = false;
      ctx.resyncAfterWakeProbe = true;
    }
  };
  document.addEventListener('visibilitychange', wakeProbe);
  document.addEventListener('resume', wakeProbe);
  window.addEventListener('online', wakeProbe);
  window.addEventListener('focus', wakeProbe);
  window.addEventListener('pageshow', wakeProbe);
  window.addEventListener('pagehide', beginBackgroundGrace);
  // Tapping the disconnect overlay runs the same recovery a wake does, so a
  // waiting user never has to sit out the remaining backoff.
  window.addEventListener(REMOTE_WAKE_EVENT, wakeProbe);

  /** `fleet`: the relay closed a leg that was live, so every phone on it may
   *  be retrying in this same instant. */
  const scheduleReconnect = (fleet = false): void => {
    if (ctx.backgroundSuspended || !shouldRunRemoteHeartbeat(document.visibilityState)) {
      setRemoteConnectionState('connecting');
      return;
    }
    setRemoteConnectionState(ctx.everConnected ? 'reconnecting' : 'connecting');
    // Registration failures and socket closes can both ask for a retry in the
    // same tick; one timer serves them all.
    if (ctx.reconnectTimer !== null) return;
    // The first retry of an outage (step 0, after every connection that
    // became ready and every foreground wake) leaves at once: most gaps are
    // one dead socket, and its replacement is the gap the user waits on —
    // except when the relay itself closed a live leg (`fleet`): a relay
    // restart closes every phone in the same instant, so that first retry is
    // spread over [0, FLEET_FIRST_RETRY_SPREAD_MS] instead of one burst.
    // From then on each delay is drawn from [step, next step], floored at
    // RECONNECT_MIN_MS; at the ceiling the range stays [ceiling / 2, ceiling],
    // so retries that reached the cap never line up again. The ceiling is
    // OFFLINE_RECONNECT_MAX_MS only while the relay's latest answer is "PC
    // offline"; any other failure returns it to RECONNECT_MAX_MS.
    const ceiling = isRemoteDesktopOffline() ? OFFLINE_RECONNECT_MAX_MS : RECONNECT_MAX_MS;
    const step = ctx.retryMs;
    let delay: number;
    if (step === 0) {
      delay = fleet ? Math.round(Math.random() * FLEET_FIRST_RETRY_SPREAD_MS) : 0;
    } else {
      const high = Math.min(ceiling, step * 2);
      const low = Math.min(step, high / 2);
      delay = Math.round(low + Math.random() * (high - low));
    }
    ctx.retryMs = step === 0 ? RECONNECT_MIN_MS : Math.min(ceiling, step * 2);
    ctx.reconnectTimer = window.setTimeout(() => {
      ctx.reconnectTimer = null;
      void ctx.connect().catch(() => {});
    }, delay);
  };

  Object.assign(ctx, { clearWakePongTimer, answerWakeProbe, wakeProbe, scheduleReconnect });
};
