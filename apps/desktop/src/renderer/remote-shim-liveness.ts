// Keepalive, foreground wake, background suspension and the reconnect backoff.
import { isInstalledMobileWebAppSurface } from './mobile-surface';
import {
  REMOTE_WAKE_EVENT,
  beginRemoteConnectionTimeline,
  reportRemoteConnectionIssue,
  setRemoteConnectionPhase,
  setRemoteConnectionState,
  shouldRunRemoteHeartbeat,
} from './remote-connection-state';
import { REMOTE_CONNECTION_READY_EVENT, type RemoteShimContext } from './remote-shim-state';

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
  // Recycling a silent socket is invisible maintenance: nothing is waiting on
  // an answer, so the redial that follows must not raise the disconnect
  // surface. A close with calls in flight keeps the normal, visible path.
  const recycleIdleSocket = (ws: WebSocket): void => {
    reportRemoteConnectionIssue('heartbeat-timeout');
    if (ctx.pending.size === 0) ctx.quietRecycledSockets.add(ws);
    ctx.retireConnection?.();
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
    if (ctx.reconnectTimer !== null) {
      window.clearTimeout(ctx.reconnectTimer);
      ctx.reconnectTimer = null;
    }
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
    if (!backgroundSuspendApplies()) return;
    reportForeground(false);
    ctx.resyncOnWake = true;
    if (ctx.backgroundGraceTimer !== null) return;
    ctx.backgroundGraceTimer = window.setTimeout(() => {
      ctx.backgroundGraceTimer = null;
      if (document.visibilityState === 'hidden') suspendRemoteConnection();
    }, BACKGROUND_GRACE_MS);
  };
  const wakeProbe = (event?: Event): void => {
    if (document.visibilityState === 'hidden') {
      beginBackgroundGrace();
      return;
    }
    clearBackgroundGrace();
    reportForeground(true);
    if (ctx.backgroundSuspended) beginRemoteConnectionTimeline('wake');
    ctx.backgroundSuspended = false;
    const shouldResync = ctx.resyncOnWake || event?.type === 'online';
    const ws = ctx.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ctx.resyncOnWake = true;
      ctx.retryMs = 500;
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
    ctx.retryMs = 500;
    ctx.heartbeatSentAt = Date.now();
    ctx.awaitingPong = true;
    try {
      ws.send('{"ping":1}');
    } catch {
      /* surfaces as close */
    }
    // Foreground recovery should not inherit the normal 10s background
    // heartbeat budget. If this exact probe gets no response, recycle the
    // half-open socket promptly and let the reconnect loop re-register lanes.
    clearWakePongTimer();
    const probeSentAt = ctx.heartbeatSentAt;
    ctx.wakePongTimer = window.setTimeout(() => {
      ctx.wakePongTimer = null;
      if (ctx.socket !== ws || !ctx.awaitingPong || ctx.heartbeatSentAt !== probeSentAt) return;
      ctx.awaitingPong = false;
      recycleIdleSocket(ws);
    }, 2_500);
    // A live socket proves nothing about the transcript: pushes sent while
    // this tab was hidden may have been dropped for a congested leg, and a
    // finished turn never sends another patch to expose it.
    if (shouldResync) {
      ctx.resyncOnWake = false;
      ctx.requestResync();
    }
  };
  document.addEventListener('visibilitychange', wakeProbe);
  window.addEventListener('online', wakeProbe);
  window.addEventListener('focus', wakeProbe);
  window.addEventListener('pageshow', wakeProbe);
  window.addEventListener('pagehide', beginBackgroundGrace);
  // Tapping the disconnect overlay runs the same recovery a wake does, so a
  // waiting user never has to sit out the remaining backoff.
  window.addEventListener(REMOTE_WAKE_EVENT, wakeProbe);

  const scheduleReconnect = (): void => {
    if (ctx.backgroundSuspended || !shouldRunRemoteHeartbeat(document.visibilityState)) {
      setRemoteConnectionState('connecting');
      return;
    }
    setRemoteConnectionState(ctx.everConnected ? 'reconnecting' : 'connecting');
    // Registration failures and socket closes can both ask for a retry in the
    // same tick; one timer serves them all.
    if (ctx.reconnectTimer !== null) return;
    const delay = ctx.retryMs;
    ctx.retryMs = Math.min(10_000, ctx.retryMs * 2);
    ctx.reconnectTimer = window.setTimeout(() => {
      ctx.reconnectTimer = null;
      void ctx.connect().catch(() => {});
    }, delay);
  };

  Object.assign(ctx, { clearWakePongTimer, wakeProbe, scheduleReconnect });
};
