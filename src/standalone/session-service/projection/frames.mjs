// Frame publication: one durable session-addressed frame per revision step,
// coalesced per entry to one display-frame clock. The runtime pool is a
// daemon implementation detail and never enters the client contract.
import { frameBody } from './revisions.mjs';

export function createFramePublisher({
  index,
  advance,
  onFrame,
  log,
  isClosed,
  publishIntervalMs,
  updateEntryBusy,
  releaseProjection,
  startEvictionSweep,
  prependViewer = () => false,
}) {
  function publishStep(entry, step) {
    const sessionId = index.currentSessionId(entry);
    if (!sessionId) return;
    // This step rebuilt a watched projection; the sweep may have stopped when
    // the last one was released, and it alone reclaims this one when idle.
    startEvictionSweep();
    // Session runtime revisions may predate the session address (a reservation becomes
    // a materialized session during newSession/resume). A session subscriber
    // has no copy of that session runtime-only base, so the first frame for each session
    // address must be FULL; only later frames may use session runtime revision deltas.
    const continues = entry.publishedSessionId === sessionId;
    const body = continues ? frameBody(step) : { revision: step.revision, full: step.snapshot };
    entry.publishedSessionId = sessionId;
    entry.lastPublishedAt = Date.now();
    const frame = (frameBodyValue) => ({
      type: 'session-state',
      key: `session-state:${sessionId}`,
      sessionId,
      ...frameBodyValue,
    });
    // An older-history page reaches views that announced transcriptPrepend
    // as the revealed rows only; every other view gets the ordinary patch.
    const subscribers = entry.subscribers;
    const prepending = continues && step.prependPatch && subscribers ? [...subscribers].filter(prependViewer) : [];
    if (prepending.length === 0) {
      onFrame(frame(body), subscribers);
      return;
    }
    onFrame(frame(frameBody(step, true)), new Set(prepending));
    const others = [...subscribers].filter((token) => !prepending.includes(token));
    if (others.length > 0) onFrame(frame(body), new Set(others));
  }

  function publish(entry) {
    if (isClosed() || entry.disposed) return;
    try {
      if ((entry.subscribers?.size || 0) === 0) {
        // A headless turn still needs busy/index liveness, but no client can
        // consume a wire projection. Avoid cloning the growing transcript on
        // every token; the next subscriber receives a fresh full snapshot.
        const raw = entry.runtime.getState?.() || {};
        index.indexSessionEntry(entry, raw.sessionId);
        updateEntryBusy(entry, raw);
        releaseProjection(entry);
        return;
      }
      // Identical state produces no frame at all; a changed one travels as a
      // DELTA against the revision every attached view already holds.
      const step = advance(entry);
      if (!step.changed) return;
      publishStep(entry, step);
    } catch (err) {
      const sessionId = entry.addressedSessionId || entry.indexedSessionId || '(creating)';
      log(`publish failed session=${sessionId}: ${err?.message || err}`);
    }
  }

  /** Session runtime events fire per streamed token. Publish immediately after an idle
   *  interval, then coalesce the rest of the burst to one display-frame clock.
   *  This avoids charging every first token a fixed delay. */
  function schedulePublish(entry) {
    if (entry.timer || entry.disposed || isClosed()) return;
    const elapsed = Date.now() - (entry.lastPublishedAt || 0);
    entry.timer = setTimeout(
      () => {
        entry.timer = null;
        publish(entry);
      },
      Math.max(0, publishIntervalMs - elapsed)
    );
    entry.timer.unref?.();
  }

  return { publishStep, publish, schedulePublish };
}
