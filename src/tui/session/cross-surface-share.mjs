/**
 * src/tui/session/cross-surface-share.mjs - owner/viewer wiring for one session
 * opened on several surfaces (terminal + desktop pane).
 *
 * Presence + the durable pending spool remain the ownership/base layer; a
 * local pipe layer (live-share) streams frame deltas so co-open surfaces
 * mirror each other in real time.
 *  - presence: mark OUR current session as held open (idle included) so a
 *    cross-open elsewhere attaches as a viewer instead of splitting
 *    ownership; cleared on session switch here and on dispose
 *    (session-api-ext), with sidecar staleness covering crashes.
 *  - owner leg: host the live pipe, push transcript/tail/spinner deltas,
 *    and run foreign submits through the normal queue — full user bubble +
 *    streaming on every surface. The spool drain stays as the fallback
 *    intake (instant via fs.watch, 3s tick as safety net).
 *  - viewer leg: connect to the owner's pipe and mirror its live state.
 *    While the pipe is up the disk-mtime re-resume is skipped (no turn-end
 *    flicker); when the owner disappears the quiet re-resume promotes this
 *    surface to real ownership.
 */
import { statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { sessionPath } from '../../runtime/agent/orchestrator/session/store/paths-heartbeat.mjs';
import { createLiveShare, forwardViewerSubmit, liveSharePipePath } from './live-share.mjs';
import { promptDisplayText } from './queue-helpers.mjs';
import { sharedDirWatch } from './shared-dir-watch.mjs';

const SPOOL_WATCH_DEBOUNCE_MS = 120;
const OWNER_CLOSED_PROMOTE_DELAY_MS = 1500;
const REMOTE_ATTACH_TICK_MS = 3000;
// A healthy local owner serves its full frame on connect within tens of ms; a
// dead presence sidecar or an owner blocked mid-turn never will. The old
// 1500ms default made exactly those sessions stall entry for the full budget
// (measured 1571/1519ms resumes — user: 세션 로드가 가끔 매우 느림). Cap the
// boundary wait low: late owner frames still land through viewerApply and
// simply replace the disk restore when they arrive.
const VIEWER_SYNC_WAIT_MS = 400;

// The spool drain waits for its cross-process lock OFF the event loop now, so
// a watch event and the 3s tick can overlap: one drain at a time.
function createRemoteInjectionDrain({ runtime, bag }) {
  let inFlight = null;
  return () => {
    if (inFlight) return inFlight;
    const run = (async () => {
      const injected = (await runtime.takeRemoteInjections?.()) || [];
      if (injected.length === 0) return;
      for (const item of injected) {
        if (!item || typeof item !== 'object' || (item.text == null && item.content == null)) continue;
        const content = item.content ?? item.text;
        const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined;
        bag.enqueue(content, {
          ...(item.options && typeof item.options === 'object' ? item.options : {}),
          ...(item.text ? { displayText: item.text } : {}),
          ...(id ? { id } : {}),
        });
      }
      void bag.drain();
    })().catch(() => {
      /* the watch/tick pair retries */
    });
    const tracked = run.finally(() => {
      if (inFlight === tracked) inFlight = null;
    });
    inFlight = tracked;
    return tracked;
  };
}

const quietResume = (api, id) =>
  void Promise.resolve(api.resume(id, { quiet: true })).catch(() => {
    /* next tick retries */
  });

function createSessionLiveShare({ api, bag, flags, getState, getPublishedState, listeners, set, createShare }) {
  const liveShare = createShare({
    ownerSessionId: () => {
      const state = getState();
      return flags.disposed || flags.pendingSessionReset || state.sessionRemoteAttached
        ? ''
        : String(state.sessionId || '');
    },
    viewerSessionId: () => {
      const state = getState();
      return flags.disposed || !state.sessionRemoteAttached ? '' : String(state.sessionId || '');
    },
    socketPathFor: (id) => liveSharePipePath(id, sessionPath(id)),
    getPublishedState,
    listeners,
    onRemoteSubmit: (prompt, meta) => {
      // A refusal must be REPORTED, never silent. This session runtime can be unable to
      // take a foreign prompt (disposed, or it became an attached viewer
      // itself); swallowing it here is what made a submitted message vanish
      // with no transcript row and no error (user: 입력이 씹힘). The ack sent
      // by live-share carries this verdict back so the sender can re-deliver.
      if (flags.disposed || getState().sessionRemoteAttached) return false;
      // Preserve the viewer's submission id end-to-end: the queue entry and
      // the settled user item then carry the id the submitting surface used
      // for its optimistic row, so that row releases instead of duplicating.
      const queued = bag.enqueue(prompt, meta && typeof meta === 'object' ? meta : {}) !== false;
      void bag.drain();
      return queued;
    },
    onRemoteAbort: () => {
      // Forwarded viewer stop: interrupt OUR active turn (we are the owner).
      if (flags.disposed || getState().sessionRemoteAttached) return;
      try {
        api.abort?.();
      } catch {
        /* abort is best-effort */
      }
    },
    onOwnerClosed: (id) => {
      // Owner left (clean close or crash): promote via the normal quiet
      // re-resume once its final save/presence-clear has landed.
      const timer = setTimeout(() => {
        const state = getState();
        if (flags.disposed || !state.sessionRemoteAttached) return;
        if (String(state.sessionId || '') !== id) return;
        if (liveShare.viewerConnected()) return;
        quietResume(api, id);
      }, OWNER_CLOSED_PROMOTE_DELAY_MS);
      timer.unref?.();
    },
    viewerApply: {
      getState,
      set,
      replaceItems: (...args) => bag.replaceItems(...args),
      patchItem: (...args) => bag.patchItem(...args),
      appendItems: (...args) => bag.appendItems(...args),
      updateStreamingTail: (...args) => bag.updateStreamingTail(...args),
      clearStreamingTail: (...args) => bag.clearStreamingTail(...args),
    },
  });
  return liveShare;
}

// Viewer legs ride the owner's pipe (instant user bubble + shared streaming);
// the durable spool remains the fallback. Every intake boundary the daemon or
// UI can reach (submit, submitAsync, abort) is wrapped, otherwise a hosted
// viewer queues the prompt locally and its own user row stands beside the
// owner's mirrored twin.
function wrapViewerApi({ api, bag, runtime, liveShare, getState, ensureLiveShare }) {
  // Returns null when this surface is NOT an attached viewer, so the local
  // session runtime keeps the prompt.
  const viewerSubmitIntake = (prompt, options = {}) => {
    if (!getState().sessionRemoteAttached) return null;
    const text = String(promptDisplayText(prompt, options) || '').trim();
    if (!text) return { accepted: false };
    return {
      accepted: forwardViewerSubmit({
        prompt,
        text,
        options,
        share: liveShare,
        // Writing to the owner's spool instead of starting a fake local turn
        // that would render an error/synthetic assistant message here.
        spool: (submissionId) =>
          runtime.enqueueRemoteAttachedPrompt?.({
            content: prompt,
            text,
            id: submissionId,
            options,
          }) === true,
      }),
    };
  };
  if (typeof api.submit === 'function') {
    const baseSubmit = api.submit;
    api.submit = (prompt, options = {}) => {
      const forwarded = viewerSubmitIntake(prompt, options);
      return forwarded ? forwarded.accepted : baseSubmit(prompt, options);
    };
  }
  if (typeof api.submitAsync === 'function') {
    const baseSubmitAsync = api.submitAsync;
    api.submitAsync = async (prompt, options = {}) => {
      const forwarded = viewerSubmitIntake(prompt, options);
      return forwarded ? forwarded.accepted : baseSubmitAsync(prompt, options);
    };
  }
  // Viewer stop button: the local session runtime has no in-flight turn to
  // cancel — forward the interrupt to the owner over the pipe. Falls back to
  // the local abort (no-op safe) when the pipe is down.
  if (typeof api.abort === 'function') {
    const baseAbort = api.abort;
    api.abort = (...args) => {
      if (getState().sessionRemoteAttached && liveShare.viewerConnected() && liveShare.sendAbort()) {
        return true;
      }
      return baseAbort(...args);
    };
  }
  // Attach-time pipe fast-path: session entry (resume) reconciles the live
  // pipe IMMEDIATELY instead of waiting for the 3s share tick. The attach
  // render comes from the last disk save WITHOUT the in-flight turn, so that
  // tick-wide window is exactly when a running tool call / mid-turn
  // conversation looks missing and then pops in late (user report). The
  // owner leg benefits equally: its pipe server starts the moment the
  // session opens, so cross-surface viewers can connect at once.
  for (const method of ['resume', 'newSession', 'switchContext']) {
    if (typeof api[method] !== 'function') continue;
    const base = api[method].bind(api);
    api[method] = async (...args) => {
      const result = await base(...args);
      bag.cancelQueuedGoalContinuations?.();
      bag.refreshGoalState?.();
      bag.scheduleGoalContinuation?.();
      ensureLiveShare();
      if (method === 'resume' && result === true && getState().sessionRemoteAttached) {
        const id = String(getState().sessionId || '');
        // The session projection holds renderer publications across resume.
        // Keep that hold until the owner's first FULL frame replaces the
        // persisted transcript, then synchronously publish the complete draft
        // before getState().
        if (id && (await liveShare.waitForViewerSync(id, VIEWER_SYNC_WAIT_MS))) bag.flushEmit();
      }
      return result;
    };
  }
}

// Instant input pickup: watch the shared pending spool so an attached
// surface's fallback submit reaches this owner immediately instead of on the
// 3s tick. Best-effort — the tick remains the safety net. The spool sits
// directly in the data dir, so that is the narrowest directory to watch; the
// handle is shared by every session in the process (shared-dir-watch.mjs)
// and each session keeps its own filter/debounce below.
function startSpoolWatcher({ runtime, flags, getState, drainRemoteInjections, watchDir }) {
  let release = null;
  let debounce = null;
  try {
    const spoolPath = String(runtime.pendingSpoolPath?.() || '');
    if (spoolPath) {
      const spoolFile = basename(spoolPath);
      release = watchDir(dirname(spoolPath), (_event, filename) => {
        if (filename && String(filename) !== spoolFile) return;
        if (flags.disposed || debounce) return;
        debounce = setTimeout(() => {
          debounce = null;
          if (flags.disposed || flags.pendingSessionReset) return;
          const state = getState();
          if (state.busy || state.commandBusy || state.sessionRemoteAttached) return;
          try {
            void drainRemoteInjections();
          } catch {
            /* tick fallback */
          }
        }, SPOOL_WATCH_DEBOUNCE_MS);
        debounce.unref?.();
      });
    }
  } catch {
    /* spool watch is an optimization; the 3s tick remains */
  }
  return {
    close: () => {
      release?.();
      release = null;
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
    },
  };
}

// Viewer leg of the tick: follow the owner live over the pipe, otherwise
// re-resume from disk when the owner saved or disappeared.
function createViewerTick({ runtime, api, liveShare, getState }) {
  let storeMtime = 0;
  return {
    reset: () => {
      storeMtime = 0;
    },
    run: () => {
      const id = String(getState().sessionId || '');
      if (!id) return;
      // Pipe-connected viewers follow the owner live; the disk-mtime
      // re-resume would only reload mid-stream state and flicker.
      if (liveShare.viewerConnected()) {
        storeMtime = 0;
        return;
      }
      // Self-heal: a force-killed owner never announces onOwnerClosed and
      // its final save never bumps the store mtime, so without this probe
      // the surface stays a viewer forever, spooling messages to nobody.
      // When the resume guard says the owner is gone, promote via the same
      // quiet re-resume (it drains the pending spool on the next tick).
      if (runtime.sessionOwnerGone?.(id) === true) {
        storeMtime = 0;
        quietResume(api, id);
        return;
      }
      let mtime = 0;
      try {
        mtime = statSync(sessionPath(id)).mtimeMs || 0;
      } catch {
        return;
      }
      // First attached tick only baselines: the resume that attached this
      // surface already loaded the current on-disk transcript.
      if (!storeMtime) {
        storeMtime = mtime;
        return;
      }
      if (mtime > storeMtime) {
        storeMtime = mtime;
        quietResume(api, id);
      }
    },
  };
}

function startRemoteAttachTicker({ runtime, api, flags, getState, liveShare, spoolWatcher, drainRemoteInjections }) {
  let heldPresenceId = '';
  const viewerTick = createViewerTick({ runtime, api, liveShare, getState });
  const timer = setInterval(() => {
    if (flags.disposed) {
      clearInterval(timer);
      try {
        liveShare.dispose();
      } catch {
        /* best-effort */
      }
      spoolWatcher.close();
      return;
    }
    if (flags.pendingSessionReset) return;
    try {
      const heldId = runtime.publishSessionPresence?.() || '';
      if (heldPresenceId && heldPresenceId !== heldId) runtime.clearSessionPresence?.(heldPresenceId);
      heldPresenceId = heldId;
    } catch {
      /* best-effort */
    }
    try {
      liveShare.ensure();
    } catch {
      /* next tick retries */
    }
    try {
      const state = getState();
      if (state.busy || state.commandBusy) return;
      if (state.sessionRemoteAttached) {
        viewerTick.run();
        return;
      }
      viewerTick.reset();
      void drainRemoteInjections();
    } catch {
      /* best-effort */
    }
  }, REMOTE_ATTACH_TICK_MS);
  timer.unref?.();
}

export function attachCrossSurfaceShare({
  runtime,
  api,
  bag,
  flags,
  getState,
  getPublishedState,
  listeners,
  set,
  // Test seams: the pipe layer is replaced by a fake share in unit tests, and
  // the process-wide directory watch by an isolated registry.
  createShare = createLiveShare,
  watchDir = sharedDirWatch.subscribe,
}) {
  const drainRemoteInjections = createRemoteInjectionDrain({ runtime, bag });
  const liveShare = createSessionLiveShare({
    api,
    bag,
    flags,
    getState,
    getPublishedState,
    listeners,
    set,
    createShare,
  });
  // Immediate live-share reconcile for session entry/promotion. Waiting for
  // the 3s share tick left a just-resumed live-owned session showing the
  // stale disk snapshot, then full-swapped the transcript mid-view once the
  // pipe finally connected (visible up/down lurch until heights resettled).
  // resume() calls this right after installing the restored items so the
  // owner's full frame lands at the entry boundary instead of seconds later.
  const ensureLiveShare = () => {
    try {
      liveShare.ensure();
    } catch {
      /* share tick retries */
    }
  };
  bag.ensureLiveShare = ensureLiveShare;
  // Pulse guard: while this surface is an attached viewer with a live pipe,
  // owner frames own stats/agent/tool state (see the runtime pulse timer).
  bag.liveShareMirroring = () => getState().sessionRemoteAttached && liveShare.viewerConnected();
  wrapViewerApi({ api, bag, runtime, liveShare, getState, ensureLiveShare });
  // Cover session runtimes whose runtime already has a session at construction
  // time; do not wait for a lifecycle method or the 3s safety pulse to open the pipe.
  ensureLiveShare();
  const spoolWatcher = startSpoolWatcher({ runtime, flags, getState, drainRemoteInjections, watchDir });
  startRemoteAttachTicker({ runtime, api, flags, getState, liveShare, spoolWatcher, drainRemoteInjections });
}
