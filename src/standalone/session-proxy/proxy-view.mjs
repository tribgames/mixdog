// The frame-consuming view one proxy registers with the attachment pool, and
// its disposal: the last local view of a session unsubscribes it, and an idle
// attachment is closed and released.
export function createProxyView({ binding, projection, pool, resync, recover, log }) {
  const view = {
    sessionId: () => binding.sessionId,
    applyFrame(frame, sourceAttachment = binding.attachment) {
      if (binding.disposed) return;
      if (!projection.applyBody(frame, sourceAttachment)) resync('revision gap');
    },
    applyGone(reason) {
      if (binding.disposed) return;
      log(`session ${binding.sessionId} is no longer available (${reason})`);
    },
    applyDetached(reason) {
      log(`session ${binding.sessionId} projection detached (${reason})`);
    },
    recover,
  };
  pool.addView(binding.attachment, binding.sessionId, view);
  binding.attachment.refs += 1;
  pool.track(view);

  async function dispose(reason = 'view dispose') {
    if (binding.disposed) return;
    binding.disposed = true;
    pool.untrack(view);
    const current = binding.attachment;
    const releasedSessionId = binding.sessionId;
    const lastLocalView = pool.viewCount(current, releasedSessionId) <= 1;
    if (lastLocalView) {
      try {
        await current.client.unsubscribe({ sessionId: releasedSessionId });
      } catch (error) {
        log(`session ${releasedSessionId} unsubscribe failed: ${error?.message || error}`);
      }
    }
    pool.removeView(current, releasedSessionId, view);
    projection.clearListeners();
    current.refs = Math.max(0, current.refs - 1);
    if (pool.idle(current)) {
      try {
        await current.client.close(reason);
      } catch {}
      pool.releaseIdle(current);
    }
  }

  return { view, dispose };
}
