/**
 * src/tui/session/live-share/mirror.mjs - viewer-side application of owner
 * frames into the local session store.
 */
const LIVE_LIMIT_KEYS = ['displayContextWindow', 'compactBoundaryTokens', 'autoCompactTokenLimit'];

export function createMirror(viewerApply) {
  const upsertItem = (item) => {
    if (!item || item.id == null) return;
    const items = viewerApply.getState().items;
    const exists = Array.isArray(items) && items.some((it) => it?.id === item.id);
    if (exists) viewerApply.patchItem(item.id, item);
    else viewerApply.appendItems([item]);
  };

  // Mirror the owner's live-state subset into the viewer store. Context stats
  // merge over the local stats object so unmirrored accumulator fields keep
  // their last local values instead of vanishing.
  const applyLiveState = (live) => {
    if (!live || typeof live !== 'object') return;
    const patch = {
      busy: live.busy === true,
      commandBusy: live.commandBusy === true,
      queued: Array.isArray(live.queued) ? live.queued : [],
      activeToolSummary: live.activeToolSummary || null,
      activeTools: live.activeTools || null,
      agentWorkers: Array.isArray(live.agentWorkers) ? live.agentWorkers : [],
      agentJobs: Array.isArray(live.agentJobs) ? live.agentJobs : [],
      ownerClientHostPid: Number(live.ownerClientHostPid) || 0,
    };
    for (const key of LIVE_LIMIT_KEYS) {
      if (Number(live[key]) > 0) patch[key] = Number(live[key]);
    }
    if (live.stats && typeof live.stats === 'object' && Object.keys(live.stats).length > 0) {
      const current = viewerApply.getState().stats;
      patch.stats = { ...(current && typeof current === 'object' ? current : {}), ...live.stats };
    }
    viewerApply.set(patch);
  };

  // Owner gone (clean close, crash, or pipe drop): the mirrored activity is
  // no longer authoritative — clear it so the viewer never shows a frozen
  // spinner/queue while the promotion path takes over.
  const clearLiveState = () => {
    try {
      viewerApply?.set?.({
        busy: false,
        commandBusy: false,
        spinner: null,
        queued: [],
        activeToolSummary: null,
        activeTools: null,
        agentWorkers: [],
        agentJobs: [],
        ownerClientHostPid: 0,
      });
    } catch {
      /* viewer store already disposed */
    }
  };

  // Returns false when a tail suffix did not match the local base — this
  // mirror lost a frame and the caller must request a full resync.
  const applyTailAppend = (tailAppend) => {
    const current = viewerApply.getState().streamingTail;
    const base = Number(tailAppend.base) || 0;
    const matches =
      current && current.id === tailAppend.id && typeof current.text === 'string' && current.text.length === base;
    if (!matches) return false;
    viewerApply.updateStreamingTail(tailAppend.id, {
      ...(tailAppend.meta || {}),
      text: current.text + String(tailAppend.text || ''),
    });
    return true;
  };

  /** Apply one owner frame; false means the mirror is desynced. */
  const applyFrame = (frame) => {
    if (frame.t === 'full') {
      viewerApply.replaceItems(Array.isArray(frame.items) ? frame.items : []);
      if (frame.tail) viewerApply.updateStreamingTail(frame.tail.id, frame.tail, {}, { resetText: true });
      viewerApply.set({ spinner: frame.spinner || null });
      applyLiveState(frame.live);
      return true;
    }
    if (frame.t !== 'delta') return true;
    if (Array.isArray(frame.items)) {
      viewerApply.replaceItems(frame.items, { preserveStreamingTail: true });
    } else {
      for (const item of frame.changed || []) upsertItem(item);
      for (const item of frame.appended || []) upsertItem(item);
    }
    let synced = true;
    if (frame.tailAppend) {
      synced = applyTailAppend(frame.tailAppend);
    } else if ('tail' in frame) {
      if (frame.tail) viewerApply.updateStreamingTail(frame.tail.id, frame.tail, {}, { resetText: true });
      else viewerApply.clearStreamingTail();
    }
    if ('spinner' in frame) viewerApply.set({ spinner: frame.spinner || null });
    if ('live' in frame) applyLiveState(frame.live);
    return synced;
  };

  return { applyFrame, clearLiveState };
}
