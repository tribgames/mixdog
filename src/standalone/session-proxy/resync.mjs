/**
 * session-proxy/resync.mjs — one in-flight resync at a time. A gap noticed
 * while a resync is running marks it dirty and re-runs once it settles; a
 * failed resync retries after a short delay instead of immediately.
 */
export function createResync({ binding, projection, openParams, log }) {
  let resyncing = false;
  let dirty = false;
  let dirtyReason = '';
  let failed = false;

  function scheduleRetry() {
    if (!dirty || binding.disposed) return;
    dirty = false;
    const retryReason = dirtyReason || 'revision gap';
    dirtyReason = '';
    if (!failed) {
      resync(retryReason);
      return;
    }
    failed = false;
    const timer = setTimeout(() => {
      if (!binding.disposed) resync(retryReason);
    }, 250);
    timer.unref?.();
  }

  function resync(reason) {
    if (binding.disposed) return;
    if (resyncing) {
      dirty = true;
      dirtyReason = String(reason || 'revision gap');
      return;
    }
    resyncing = true;
    const requestAttachment = binding.attachment;
    const { sessionId } = binding;
    void requestAttachment.client
      .read({
        sessionId,
        open: openParams,
        baseRevision: projection.baseRevisionFor(requestAttachment),
      })
      .then((result) => {
        if (binding.disposed || requestAttachment !== binding.attachment) return;
        projection.markResult(result, requestAttachment);
        if (!projection.applyBody(result, requestAttachment) && result?.revision !== undefined) {
          log(`session ${sessionId} resync returned an unusable body`);
          dirty = true;
          failed = true;
          dirtyReason = 'unusable resync body';
        }
      })
      .catch((error) => {
        log(`session ${sessionId} resync after ${reason} failed: ${error?.message || error}`);
        dirty = true;
        failed = true;
        dirtyReason = `retry after failed resync (${reason})`;
      })
      .finally(() => {
        resyncing = false;
        scheduleRetry();
      });
  }

  return resync;
}
