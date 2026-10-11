// View synchronization, delta-lane resumption and the resync request path.
import type { SessionSnapshot } from '../shared/contract';
import { createRemoteViewSync } from './remote-view-sync';
import { createViewResumeRequest, readViewResumeGrant, type ViewResumePoint } from '../shared/remote-view-resume';
import {
  takeRemoteConnectionTimeline,
  remoteConnectionInterruptedError,
  reportRemoteConnectionIssue,
  setRemoteConnectionPhase,
  setRemoteConnectionState,
} from './remote-connection-state';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-shim-state';
import type { RemoteShimContext } from './remote-shim-state';

export const installRemoteSync = (ctx: RemoteShimContext): void => {
  const viewSyncSessionIds = (): string[] =>
    ctx.restoredVisibleSessionIds.length > 0
      ? [...new Set([...ctx.lastVisibleSessionIds, ...ctx.restoredVisibleSessionIds])]
      : ctx.lastVisibleSessionIds;
  const sessionSetKey = (sessionIds: readonly string[]): string => [...new Set(sessionIds)].sort().join('\0');

  // Delta-lane resumption (shared/remote-view-resume.ts). The desktop issues a
  // token with each completed view sync; it stays valid only while every
  // decoder holds exactly what that desktop's encoders sent. A close carries
  // it (and the decoders) over to the next connection's first sync; any gap,
  // resync or reset clears it, and the epoch voids a sync already in flight.
  const invalidateViewResume = (): void => {
    ctx.viewResumeToken = null;
    ctx.carriedResumeToken = null;
    ctx.deltaEpoch += 1;
  };
  const viewSync = createRemoteViewSync({
    synchronize: async () => {
      setRemoteConnectionPhase('sync');
      const sessionIds = viewSyncSessionIds();
      ctx.requestedViewSyncKey = sessionSetKey(sessionIds);
      const resumeToken = ctx.carriedResumeToken;
      ctx.carriedResumeToken = null;
      ctx.viewResumeToken = null;
      const epoch = ctx.deltaEpoch;
      // Captured synchronously: a frame landing while the digests are computed
      // replaces decoder state instead of mutating what was captured.
      const points = resumeToken
        ? {
            state: ctx.stateDecoder.resumePoint(),
            sessions: ctx.sessionsDecoder.resumePoint(),
            agentPool: ctx.agentPoolDecoder.resumePoint(),
            sessionStates: sessionIds.map((sessionId): [string, ViewResumePoint | null] => [
              sessionId,
              ctx.sessionStateDecoders.get(sessionId)?.resumePoint() ?? null,
            ]),
          }
        : null;
      const resume = await createViewResumeRequest(resumeToken, points);
      // The persisted roster, claimed by version: an unchanged roster costs
      // one small frame instead of the whole list.
      const roster = await ctx.rosterCache.claim();
      const retained = ctx.viewBaselines.begin();
      try {
        const result = await ctx.invoke('synchronizeViews', [sessionIds, retained.offer, resume, roster]);
        ctx.restoredVisibleSessionIds = [];
        if (epoch === ctx.deltaEpoch) ctx.viewResumeToken = readViewResumeGrant(result);
        // A resumed sync may resend no transcript: the phone already shows
        // it, so the wait ends at the receipt instead of going unreported.
        if (resumeToken) {
          const timeline = takeRemoteConnectionTimeline('resumed');
          if (timeline) ctx.fire('reportConnectionTimeline', [timeline]);
        }
        return result;
      } finally {
        retained.finish();
      }
    },
    state: (state) => {
      setRemoteConnectionState(state);
      if (state !== 'connected') return;
      window.dispatchEvent(new Event(REMOTE_CONNECTION_READY_EVENT));
      ctx.publishLanes();
      if (ctx.pendingReconnectNotification) {
        ctx.pendingReconnectNotification = false;
        window.dispatchEvent(new Event('mixdog:remote-reconnected'));
      }
    },
    error: (error) => {
      reportRemoteConnectionIssue('sync-failed', error);
      console.warn('[mixdog-remote] view synchronization failed; retrying', error);
    },
    interrupted: remoteConnectionInterruptedError,
    // A leg that keeps failing synchronizeViews is open but useless; calls
    // gate on the sync, so only a fresh connection can end their wait.
    recycle: () => ctx.retireConnection?.(),
  });

  const resetDeltaState = (): void => {
    invalidateViewResume();
    ctx.stateDecoder.reset();
    for (const decoder of ctx.sessionStateDecoders.values()) decoder.reset();
    ctx.sessionStateDecoders.clear();
    ctx.sessionsDecoder.reset();
    ctx.agentPoolDecoder.reset();
    ctx.sessionsCatalog.reset();
    ctx.agentsCatalog.reset();
    ctx.sessionInbox.reset();
  };
  // stateResync only restores the bound-session state lane, so this still has
  // to tell the renderer to re-read its per-session transcript lanes.
  //
  // The catalog lanes are NOT refetched here. The desktop retains the last
  // roster and re-sends it in full on join and on resync (remote-relay.ts
  // sendClientLists), and those frames are not droppable, so asking for
  // listSessions/listAgentPool on the same reconnect delivered the whole
  // catalog twice — measured at ~283KB per copy, the largest single item on
  // the RPC lane. A patch that cannot apply still reports it: the keyed decoder
  // answers `ok: false` and that path already calls requestResync().
  const refreshBroadcastLanes = (): void => {
    window.dispatchEvent(new Event('mixdog:remote-state-gap'));
  };
  // Unsolicited resync requests (relay drop hint, foreground wake) share one
  // short debounce: a tab that flips visibility repeatedly must not pull a
  // full transcript per flip, while a real gap still recovers immediately.
  const requestResync = (): void => {
    // A gap, a dropped frame or a wake that doubts the stream: this browser's
    // decoders no longer vouch for what the desktop last sent.
    invalidateViewResume();
    if (ctx.peerViewSync && ctx.connectionReady) {
      void viewSync.request().catch(() => undefined);
      return;
    }
    const now = Date.now();
    // Decoders reject mismatched patches themselves. Resetting every healthy
    // lane here made one gap invalidate unrelated catalogs during recovery.
    const sinceLast = now - ctx.lastResyncAt;
    if (sinceLast < 3_000) {
      // TRAIL it, never drop it: a wake that lands inside the window of the
      // resync its own disconnect fired would otherwise be swallowed, and a
      // finished turn sends no further push to expose the gap.
      if (ctx.trailingResyncTimer === null) {
        ctx.trailingResyncTimer = window.setTimeout(() => {
          ctx.trailingResyncTimer = null;
          requestResync();
        }, 3_000 - sinceLast);
      }
      return;
    }
    if (ctx.trailingResyncTimer !== null) {
      window.clearTimeout(ctx.trailingResyncTimer);
      ctx.trailingResyncTimer = null;
    }
    ctx.lastResyncAt = now;
    ctx.fire('stateResync', []);
    refreshBroadcastLanes();
  };
  // Reassembly is the shared snapshot decoder's job — it already handles both
  // wire shapes (the original one and the compact frames a current desktop
  // sends), including the legacy full snapshot whose missing revision leaves
  // the next patch unverifiable. The shim only has to turn a rejected patch
  // into a resync request.
  const applyStatePayload = (payload: unknown): SessionSnapshot | null => {
    const decoded = ctx.stateDecoder.decode(payload);
    if (!decoded.ok) {
      reportRemoteConnectionIssue('state-gap');
      requestResync();
      return null;
    }
    return decoded.snapshot as SessionSnapshot;
  };

  Object.assign(ctx, {
    viewSync,
    viewSyncSessionIds,
    sessionSetKey,
    invalidateViewResume,
    resetDeltaState,
    refreshBroadcastLanes,
    requestResync,
    applyStatePayload,
  });
};
