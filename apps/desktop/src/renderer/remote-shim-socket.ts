// The connection state machine: credentials, registration, then one socket
// attempt at a time through its handshake, traffic and close.
import type { SessionSnapshot } from '../shared/contract';
import { createRelayE2EEClientHandshake, isRelayE2EEChallenge } from '../shared/remote-e2ee';
import { earlyUiT } from './early-ui-i18n';
import { isInvalidRemotePairingClose } from './remote-pairing-recovery';
import { setRemoteHostOpenAccess } from './remote-host-access';
import {
  remoteConnectionInterruptedError,
  reportRemoteConnectionIssue,
  setRemoteConnectionPhase,
  setRemoteConnectionState,
  shouldRunRemoteHeartbeat,
  type RemoteConnectionIssue,
} from './remote-connection-state';
import { REMOTE_CONNECTION_READY_EVENT, PAIRED_STORAGE_KEY } from './remote-shim-state';
import type { RemoteShimContext } from './remote-shim-state';
import { publishMediaKey, revokeMediaKey } from './remote-media-lane';

function dropMediaSession(ctx: RemoteShimContext): void {
  if (ctx.mediaSid) revokeMediaKey(ctx.mediaSid);
  ctx.mediaSid = null;
  ctx.peerMediaE2ee = false;
}

export const installRemoteSocket = (ctx: RemoteShimContext): void => {
  const connect = async (): Promise<WebSocket> => {
    await ctx.waitForCredential();
    if (ctx.socket && ctx.socket.readyState === WebSocket.OPEN && ctx.connectionReady) {
      return Promise.resolve(ctx.socket);
    }
    try {
      await ctx.ensureClientRegistration();
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      reportRemoteConnectionIssue('registration-failed', error, status);
      // 401/403/409: this credential was revoked or its slot is gone — only a
      // new approval fixes it. Anything else (network, 429, 5xx) retries.
      if (status === 401 || status === 403 || status === 409) {
        // The status travels into the message on purpose: this is the one
        // failure a user can only report, never inspect.
        ctx.resetApprovalAndAsk(earlyUiT('This device is no longer approved ({{status}}).', { status }));
      } else {
        ctx.scheduleReconnect();
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (ctx.backgroundSuspended) throw remoteConnectionInterruptedError();
    ctx.openPromise ??= new Promise<WebSocket>((resolve, reject) => openSocketAttempt(ctx, connect, resolve, reject));
    return ctx.openPromise;
  };

  Object.assign(ctx, { connect });
};

/** Re-register what a legacy (non-view-synchronizing) peer needs after a
 *  connection became ready: on a REconnect the visible sessions and lanes, on
 *  a cold launch the restored session set. */
const replaySubscriptions = (ctx: RemoteShimContext, reconnected: boolean): void => {
  if (reconnected && !ctx.peerViewSync) {
    // E2EE relay handshakes already trigger an authoritative full state
    // push from the desktop. Only legacy direct sockets need the RPC.
    if (!ctx.e2eePairing) {
      void ctx
        .call<SessionSnapshot>('getSnapshot')
        .then(ctx.dispatchState)
        .catch(() => {});
    }
    // The renderer only announces visible sessions when its pane set
    // CHANGES, so nothing re-registered this browser with the relay's
    // fresh client record: the phone silently stopped receiving
    // transcript frames until a session switch or a reload (user: 다른
    // 앱 갔다 들어오니 동기 안 됨). Replay it before the lane re-reads
    // below, whose replay frames pass through the same filter.
    // Encryption is asynchronous, so merely starting these RPCs in
    // order does not guarantee wire order. Finish the registration
    // before any transcript re-read can publish its recovery frame.
    void (async () => {
      if (ctx.lastVisibleSessionIds.length > 0) {
        try {
          await ctx.call<boolean>('setVisibleSessions', [ctx.lastVisibleSessionIds]);
        } catch {
          // The reconnect loop or the next pane registration retries it.
        }
      }
      // Always announced, even when empty: that is what tells the fresh
      // client record this browser speaks the lane protocol and wants
      // nothing but what it asks for.
      ctx.publishLanes();
      ctx.refreshBroadcastLanes();
    })();
  } else if (!ctx.peerViewSync && ctx.lastVisibleSessionIds.length > 0) {
    // COLD launch. The panes that will ask for this transcript are still
    // being parsed; naming the session now lets the desktop's own read
    // and projection run underneath that work instead of after it. The
    // pane registration that follows is authoritative and simply
    // re-announces the same set.
    // setVisibleSessionsForSource now replays an already-resident
    // projection to a NEW browser, while a cold projection is filled by
    // that same subscription. One call therefore owns both registration
    // and transcript delivery; a second prefetch only added another RTT.
    void ctx.call<boolean>('setVisibleSessions', [ctx.lastVisibleSessionIds]).catch(() => false);
  }
};

/** One socket attempt, from `new WebSocket` to its close. The attempt owns its
 *  own timers and flags; everything shared with the rest of the shim goes
 *  through the context. `redial` is the connect() that follows a quiet
 *  recycle. */
const openSocketAttempt = (
  ctx: RemoteShimContext,
  redial: () => Promise<WebSocket>,
  resolve: (ws: WebSocket) => void,
  reject: (error: Error) => void
): void => {
  setRemoteConnectionPhase('websocket');
  const ws = new WebSocket(ctx.wsUrl());
  ctx.openingSocket = ws;
  ctx.openingStartedAt = Date.now();
  ws.binaryType = 'arraybuffer';
  let opened = false;
  let closed = false;
  let failureReported = false;
  let handshakeTimer: number | null = null;
  const reportFailure = (issue: RemoteConnectionIssue, error?: unknown, code?: number): void => {
    failureReported = true;
    reportRemoteConnectionIssue(issue, error, code);
  };
  // Browser suspension can postpone onclose indefinitely. Detach this
  // attempt before asking the network to close, and ignore its late work.
  const retire = (code?: number, reason?: string): void => {
    if (closed) return;
    finishClose();
    try {
      ws.close(code, reason);
    } catch {
      /* this attempt is already detached */
    }
  };
  ctx.retireConnection = retire;
  const expireHandshake = (): void => {
    if (closed) return;
    reportFailure('encryption-timeout');
    retire();
  };
  const openingTimer = window.setTimeout(() => {
    if (closed || opened || ws.readyState !== WebSocket.CONNECTING) return;
    reportFailure('websocket-timeout');
    retire();
  }, 12_000);
  const finishOpen = () => {
    // The relay can preserve this browser socket while the desktop leg
    // redials. In that case a fresh E2EE challenge makes the already-open
    // socket temporarily unready, then this same completion path restores
    // its subscriptions without requiring a browser reconnect.
    if (closed || (opened && ctx.connectionReady)) return;
    const firstReady = !opened;
    const reconnected = ctx.everConnected;
    if (firstReady) {
      opened = true;
      window.clearTimeout(openingTimer);
      if (ctx.openingSocket === ws) ctx.openingSocket = null;
    }
    ctx.connectionReady = true;
    if (!ctx.peerViewSync) setRemoteConnectionState('connected');
    if (handshakeTimer !== null) {
      window.clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    ctx.retryMs = 500;
    if (!ctx.approvalVerificationInFlight) {
      document.getElementById('mixdog-remote-pairing')?.remove();
    }
    if (!ctx.everPaired) {
      ctx.everPaired = true;
      try {
        localStorage.setItem(PAIRED_STORAGE_KEY, '1');
      } catch {
        /* no storage */
      }
    }
    if (!ctx.peerViewSync) window.dispatchEvent(new Event(REMOTE_CONNECTION_READY_EVENT));
    replaySubscriptions(ctx, reconnected);
    ctx.resyncOnWake = false;
    ctx.everConnected = true;
    if (firstReady) resolve(ws);
    if (ctx.peerViewSync) {
      ctx.pendingReconnectNotification = reconnected;
      ctx.viewSync.open();
    }
    // Existing terminal panes can hold PTY ids from the relay leg that
    // just died. Notify them only after the replacement connection has
    // settled so their ensure calls cannot race the reconnecting request.
    if (reconnected && !ctx.peerViewSync) {
      queueMicrotask(() => window.dispatchEvent(new Event('mixdog:remote-reconnected')));
    }
  };
  /** One path for every decrypted frame, whichever wire form carried it:
   *  the handshake completion, the readiness guard and the authenticated
   *  dispatch must never drift apart between the two. */
  const deliverSecureFrame = async (payload: unknown): Promise<void> => {
    if (!ctx.secureChannel) throw new Error('Relay encryption handshake was not established.');
    const decrypted = await ctx.secureChannel.decryptJson(payload);
    if (closed) return;
    if (!decrypted || typeof decrypted !== 'object') return;
    const message = decrypted as Record<string, unknown>;
    if (message.type === 'e2ee-ready' && message.version === 1) {
      // The caps the desktop learned from the relay handshake; this leg
      // never sees `relay-capabilities` itself.
      ctx.limits.learnRoutingCaps(message);
      ctx.peerViewSync = message.viewSync === 1;
      // Every handshake restates it: a reconnect may reach an older host.
      setRemoteHostOpenAccess(message.remoteOpenAccess === 1);
      finishOpen();
      return;
    }
    if (!ctx.connectionReady) throw new Error('Relay sent data before encryption was ready.');
    // Decrypted on this leg's own channel: authenticated.
    ctx.handleMessage(message, true);
  };
  ws.onopen = () => {
    if (closed) return;
    ctx.socket = ws;
    ctx.connectionReady = false;
    ctx.secureChannel = null;
    ctx.relayBinaryFrames = false;
    ctx.peerRemoteParity = false;
    ctx.peerNativePush = false;
    ctx.peerBrowserParity = false;
    dropMediaSession(ctx);
    ctx.limits.resetLearnedCaps();
    if (!ctx.e2eePairing) {
      finishOpen();
      return;
    }
    setRemoteConnectionPhase('encryption');
    handshakeTimer = window.setTimeout(expireHandshake, 10_000);
  };
  ws.onerror = () => {
    if (!closed && !failureReported) reportRemoteConnectionIssue('websocket-error');
  };
  ws.onmessage = (event) => {
    if (closed) return;
    // Traffic on ANY lane, encrypted or clear, refreshes the keepalive
    // window; only real silence may cost a probe.
    ctx.lastTrafficAt = Date.now();
    void (async () => {
      if (event.data instanceof ArrayBuffer) {
        await deliverSecureFrame(event.data);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      const clear = parsed as Record<string, unknown>;
      ctx.awaitingPong = false;
      ctx.clearWakePongTimer();
      if ('pong' in clear) return;
      if ('resync' in clear) {
        ctx.handleClearResync(clear);
        return;
      }
      if (!ctx.e2eePairing) {
        // Supported legacy mode: this frame is cleartext off the socket,
        // so nothing in it may pick a victim.
        ctx.handleMessage(clear, false);
        return;
      }
      if (isRelayE2EEChallenge(clear)) {
        if (opened) {
          // The VPS retained this phone while its desktop leg redialed.
          // Calls sent to the old leg cannot complete; fail them now and
          // establish a new channel on the existing browser socket.
          ctx.connectionReady = false;
          ctx.viewSync.close();
          setRemoteConnectionState('reconnecting');
          ctx.resetDeltaState();
          const failure = remoteConnectionInterruptedError();
          for (const entry of [...ctx.pending.values()]) entry.reject(failure);
          ctx.pending.clear();
        } else if (ctx.secureChannel) {
          throw new Error('Duplicate relay encryption challenge.');
        }
        ctx.secureChannel = null;
        ctx.relayBinaryFrames = clear.binaryFrames === 1;
        // Restated by every challenge: a reconnect may reach another host.
        ctx.peerRemoteParity = clear.remoteParity === 1;
        ctx.peerNativePush = clear.nativePush === 1;
        ctx.peerBrowserParity = clear.browserParity === 1;
        // The previous leg's media session ended with it.
        dropMediaSession(ctx);
        ctx.peerMediaE2ee = clear.mediaE2ee === 1;
        // A replacement desktop leg on the same browser socket: its caps
        // are its own, and the previous leg's must not survive into it.
        ctx.limits.resetLearnedCaps();
        ctx.compactFrames.reset();
        if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
        setRemoteConnectionPhase('encryption');
        handshakeTimer = window.setTimeout(expireHandshake, 10_000);
        const handshake = await createRelayE2EEClientHandshake(ctx.e2eePairing, clear);
        if (closed) return;
        ctx.secureChannel = handshake.channel;
        // The worker decrypts media with this session's key; it never leaves
        // this browser. Only a host that advertised the lane derived one.
        if (ctx.peerMediaE2ee && handshake.channel.mediaKey) {
          ctx.mediaSid = clear.challenge;
          publishMediaKey(clear.challenge, handshake.channel.mediaKey);
        }
        // promptHistoryPatch: this build's snapshot decoder applies head
        // patches to the prompt history; a desktop that predates it
        // ignores the flag and keeps sending the whole field.
        ws.send(JSON.stringify({ ...handshake.hello, viewSync: 1, promptHistoryPatch: 2 }));
        return;
      }
      await deliverSecureFrame(clear);
    })().catch((error) => {
      if (closed) return;
      reportFailure('frame-failed', error);
      retire();
    });
  };
  const finishClose = (event?: CloseEvent): void => {
    if (closed) return;
    if (event && !ctx.backgroundSuspended && !failureReported) {
      reportFailure('websocket-closed', undefined, event.code);
    }
    closed = true;
    ctx.retireConnection = null;
    ctx.viewSync.close();
    window.clearTimeout(openingTimer);
    if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
    if (ctx.socket === ws) ctx.socket = null;
    if (ctx.openingSocket === ws) ctx.openingSocket = null;
    ctx.openPromise = null;
    ctx.connectionReady = false;
    ctx.secureChannel = null;
    dropMediaSession(ctx);
    ctx.relayBinaryFrames = false;
    ctx.clearWakePongTimer();
    ctx.awaitingPong = false;
    ctx.resyncOnWake = true;
    // A new connection starts a fresh delta lane; a stale base revision
    // must never accidentally match the new encoder's numbering. Only
    // intact decoders survive, and only to be verified by revision and
    // content digest before the desktop continues any lane from them (a
    // new encoder's first frame is always a full baseline).
    // An attempt that closes before its first sync keeps the token it
    // was carrying: nothing consumed it.
    if (ctx.viewResumeToken) ctx.carriedResumeToken = ctx.viewResumeToken;
    ctx.viewResumeToken = null;
    if (!ctx.carriedResumeToken) ctx.resetDeltaState();
    // Decided BEFORE the rejection sweep empties the map: a keepalive
    // recycle only stays quiet while nothing was waiting on this leg.
    const quietRecycle = ctx.quietRecycledSockets.delete(ws) && ctx.pending.size === 0;
    const failure = remoteConnectionInterruptedError();
    for (const entry of [...ctx.pending.values()]) entry.reject(failure);
    ctx.pending.clear();
    if (!opened) reject(failure);
    if (event && isInvalidRemotePairingClose(event)) {
      ctx.resetApprovalAndAsk(earlyUiT('This device is no longer approved ({{status}}).', { status: event.code }));
      return;
    }
    if (quietRecycle) {
      // One silent redial at full speed. If THAT one fails, the next close
      // runs the normal path and the disconnect countdown starts.
      setRemoteConnectionState('connecting');
      if (!ctx.backgroundSuspended && shouldRunRemoteHeartbeat(document.visibilityState)) {
        ctx.retryMs = 500;
        void redial().catch(() => {
          /* the retry loop takes over */
        });
        return;
      }
    }
    ctx.scheduleReconnect();
  };
  ws.onclose = finishClose;
};
