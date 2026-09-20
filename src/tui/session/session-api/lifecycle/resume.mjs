// Resume: reopen a stored session, rebuild the visible transcript from its
// messages and reconcile live-share and steering at the same boundary.

export function createResumeAction(bag, { restoreTranscriptItems }) {
  const {
    runtime,
    flags,
    getState,
    set,
    flushEmitImmediate,
    replaceItems,
    clearToastTimers,
    routeState,
    restoreLeadSteeringFromDisk,
    resetStatsAndSyncContext,
  } = bag;

  return {
    resume: async (id, options = {}) => {
      if (getState().commandBusy) return false;
      // quiet: viewer-follow refreshes (session runtime share tick) re-resume
      // on every owner turn — they must not flash the "Resuming conversation"
      // status.
      set({
        commandBusy: true,
        ...(options.quiet === true
          ? {}
          : {
              commandStatus: { active: true, verb: 'Resuming conversation', startedAt: Date.now(), mode: 'resuming' },
            }),
      });
      clearToastTimers();
      try {
        const r = await runtime.resume(id);
        if (!r) return false;
        resetStatsAndSyncContext();
        const requestedLimit = Number(options.transcriptItemLimit);
        if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
          flags.resumeTranscriptItemLimit = Math.max(1, Math.floor(requestedLimit));
        }
        const itemLimit = Number(flags.resumeTranscriptItemLimit);
        const items = restoreTranscriptItems(r.messages, {
          sessionId: String(r.id || id),
          itemLimit: Number.isFinite(itemLimit) && itemLimit > 0 ? itemLimit : Number.POSITIVE_INFINITY,
        });
        set({
          items: replaceItems(items),
          toasts: [],
          queued: [],
          thinking: null,
          spinner: null,
          lastTurn: null,
          ...routeState(),
          stats: { ...getState().stats },
        });
        // Reconcile the live-share legs NOW (viewer pipe attach / owner pipe
        // start). The 3s share tick otherwise leaves a live-owned session on
        // the stale disk snapshot and then full-swaps it seconds after entry —
        // the visible transcript lurch. Connecting here makes the owner's
        // full frame land at the resume boundary, so entry paints settled.
        bag.ensureLiveShare?.();
        // A shard/process restart recreates the runtime before resuming its
        // durable session. Restore accepted steering while commandBusy is
        // still held so the central release hook drains it exactly once after
        // the transcript/session boundary is ready, rather than stranding the
        // queued prompt behind a visible Cancelled recovery marker.
        await restoreLeadSteeringFromDisk();
        return true;
      } finally {
        set({ commandBusy: false, commandStatus: null });
        // Desktop resume returns a snapshot immediately after this promise.
        // Publish the completed route/transcript boundary now so callers never
        // observe the previous frame's session id and title.
        flushEmitImmediate();
      }
    },
  };
}
