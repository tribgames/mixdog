import { defaultSessionLaneStore } from './session-lane-store';
import { currentRemoteConnectionState, subscribeRemoteConnectionState } from './remote-connection-state';
import { isRemoteHostRenderer } from './remote-ui-projection';
import { TRANSCRIPT_READ_TIMEOUT_MS } from '../shared/transcript-read-policy';
import { beginSessionReadTrace, reportSessionRead, settleSessionReadTrace } from './session-read-diagnostics';

// Coalesce reads only within their interactive deadline. Late frames remain
// usable, but a hung IPC must not capture every subsequent Retry gesture.
const sessionReadsInFlight = new Map<string, Promise<boolean>>();
// In-flight reads started at boot, before the host is known to be ready.
const speculativeReads = new Set<string>();
const MAX_SESSION_READ_ATTEMPTS = 3;

function laneHasTranscript(sessionId: string): boolean {
  const lane = defaultSessionLaneStore.get(sessionId);
  return Boolean(lane && Array.isArray(lane.items) && lane.items.length > 0);
}

/** A remote renderer's link is down or still synchronizing its views. The view
 *  sync names the restored sessions and delivers their transcripts before it
 *  completes, and `prefetchSession` is held behind it anyway — so a read asked
 *  for in that window is sent only if the sync left the lane empty, instead of
 *  fetching the same transcript a second time right after it. */
function linkSyncPending(): boolean {
  const state = currentRemoteConnectionState();
  return isRemoteHostRenderer() && state !== null && state !== 'connected';
}

/** Resolves when the link has synced, or as soon as `release` aborts — the
 *  state listener is gone either way. */
function linkSynced(release: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      stop();
      release.removeEventListener('abort', done);
      resolve();
    };
    const stop = subscribeRemoteConnectionState(() => {
      if (!linkSyncPending()) done();
    });
    release.addEventListener('abort', done, { once: true });
  });
}

/** What one in-flight read shares between everyone who asked for it. */
interface ReadState {
  /** A refresh joined (or started) it: the lane it finds is not enough. */
  needsFetch: boolean;
  /** Someone asked without a signal and never goes away. */
  permanent: boolean;
  /** Askers whose signal is still live. */
  holders: number;
  /** The link-sync wait, while the read is parked in it. */
  waiting: AbortController | null;
  /** Nobody wants it any more: it is no longer joinable and will not fetch. */
  abandoned: boolean;
  /** Take the read out of the joinable maps (identity-guarded). */
  unlist(): void;
}
const readStates = new Map<string, ReadState>();

/** Count an asker. When the last one's signal aborts while the read is still
 *  parked behind the link sync, the wait is released. */
function holdRead(state: ReadState, signal: AbortSignal | undefined): void {
  if (!signal) {
    state.permanent = true;
    return;
  }
  if (signal.aborted) return;
  state.holders += 1;
  signal.addEventListener(
    'abort',
    () => {
      state.holders -= 1;
      if (state.permanent || state.holders > 0 || !state.waiting) return;
      // Unlisted BEFORE the wait is released: an asker arriving from here on
      // (a remount, in this task or a later one) starts a read of its own
      // instead of joining one that is already ending without a fetch.
      state.abandoned = true;
      state.unlist();
      state.waiting.abort();
    },
    { once: true }
  );
}

/** `speculative`: a read started before any pane asked for the session (renderer
 *  boot). A pane that joins it never inherits its failure: the pane starts its
 *  own read when the speculative one ends without a lane.
 *  `signal`: the asker went away (a pane unmounted); a read nobody else wants is
 *  dropped while it still waits for the link. */
export function requestSessionRead(
  sessionId: string,
  {
    refresh = false,
    speculative = false,
    signal,
  }: { refresh?: boolean; speculative?: boolean; signal?: AbortSignal } = {}
): Promise<boolean> {
  if (!sessionId) return Promise.resolve(false);
  if (!refresh && laneHasTranscript(sessionId)) return Promise.resolve(true);
  const inFlight = sessionReadsInFlight.get(sessionId);
  if (inFlight) {
    reportSessionRead(sessionId, 'request-joined');
    const joined = readStates.get(sessionId);
    if (joined) {
      // A refresh joining a read that still waits for the link must fetch: the
      // lane the sync lands is exactly what the refresh doubts.
      if (refresh) joined.needsFetch = true;
      holdRead(joined, signal);
    }
    // The in-flight entry is cleared before this continuation runs, so the
    // retry below is a new request, not a join of the failed one.
    return speculative || !speculativeReads.has(sessionId)
      ? inFlight
      : inFlight.then((accepted) => accepted || requestSessionRead(sessionId, { refresh, signal }));
  }
  const readSession = window.mixdogDesktop?.prefetchSession;
  if (typeof readSession !== 'function') return Promise.resolve(false);
  defaultSessionLaneStore.start();
  const traceId = beginSessionReadTrace(sessionId);
  const state: ReadState = {
    needsFetch: refresh,
    permanent: false,
    holders: 0,
    waiting: null,
    abandoned: false,
    unlist: () => {},
  };
  holdRead(state, signal);
  let expired = false;
  let timer = 0;
  const deadline = new Promise<boolean>((resolve) => {
    timer = window.setTimeout(() => {
      expired = true;
      state.waiting?.abort();
      reportSessionRead(
        sessionId,
        'wait-expired',
        {
          hasLane: defaultSessionLaneStore.get(sessionId) !== null,
        },
        traceId
      );
      resolve(false);
    }, TRANSCRIPT_READ_TIMEOUT_MS);
  });
  const operation = (async () => {
    if (!state.needsFetch && linkSyncPending()) {
      if (!state.permanent && state.holders <= 0) return false;
      const waiting = new AbortController();
      state.waiting = waiting;
      await linkSynced(waiting.signal);
      state.waiting = null;
      if (expired || state.abandoned) return false;
      if (!state.needsFetch && laneHasTranscript(sessionId)) return true;
    }
    for (let attempt = 1; attempt <= MAX_SESSION_READ_ATTEMPTS; attempt += 1) {
      if (expired) return false;
      let accepted = false;
      const startedAt = performance.now();
      try {
        accepted = (await Promise.resolve(readSession(sessionId, undefined, traceId))) === true;
        if (expired) return false;
        reportSessionRead(
          sessionId,
          'request-result',
          {
            attempt,
            accepted,
            durationMs: performance.now() - startedAt,
            hasLane: defaultSessionLaneStore.get(sessionId) !== null,
          },
          traceId
        );
      } catch {
        if (expired) return false;
        reportSessionRead(
          sessionId,
          'request-failed',
          {
            attempt,
            durationMs: performance.now() - startedAt,
          },
          traceId
        );
      }
      if (accepted) {
        if (defaultSessionLaneStore.get(sessionId) === null) {
          try {
            window.mixdogDesktop?.resyncSessionState?.(sessionId);
          } catch {
            // A closed bridge remains recoverable through the pane's Retry UI.
          }
        }
        return true;
      }
      if (attempt < MAX_SESSION_READ_ATTEMPTS) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      }
    }
    return false;
  })();
  const request = Promise.race([operation, deadline]).finally(() => {
    window.clearTimeout(timer);
    state.waiting?.abort();
  });
  const unlist = () => {
    if (sessionReadsInFlight.get(sessionId) !== request) return;
    sessionReadsInFlight.delete(sessionId);
    readStates.delete(sessionId);
    speculativeReads.delete(sessionId);
  };
  state.unlist = unlist;
  sessionReadsInFlight.set(sessionId, request);
  readStates.set(sessionId, state);
  if (speculative) speculativeReads.add(sessionId);
  void request.finally(() => {
    unlist();
    settleSessionReadTrace(sessionId, traceId, defaultSessionLaneStore.get(sessionId) !== null);
  });
  return request;
}
