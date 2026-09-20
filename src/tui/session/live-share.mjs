/**
 * src/tui/session/live-share.mjs — real-time cross-surface session mirroring.
 *
 * OWNER leg: hosts a local named-pipe (win32) / unix-socket server for the
 * session it owns and pushes frame-batched transcript deltas (items /
 * streaming tail / spinner) to attached viewers. Push-only: zero polling,
 * idle cost is one open listener.
 * VIEWER leg: connects to the owner's pipe and mirrors those deltas into the
 * local session runtime store, so streaming output appears live on every co-open
 * surface (desktop <-> terminal). Viewer submits travel over the same pipe
 * into the owner's normal submit queue (concurrent input from both sides is
 * serialized there); the durable pending spool remains the fallback when the
 * pipe is down. Ownership/promotion semantics are unchanged — the pipe is a
 * transport, never a second writer.
 */
import { createOwnerLeg } from './live-share/owner.mjs';
import { createViewerLeg } from './live-share/viewer.mjs';

// Session entry is latency-sensitive: the owner pipe can be a few event-loop
// turns behind the viewer resume. Retry locally instead of waiting for the
// coarse 3s session runtime safety tick.
const LIVE_CONNECT_RETRY_MIN_MS = 10;
const LIVE_CONNECT_RETRY_MAX_MS = 160;

export function liveSharePipePath(sessionId, sessionFilePath) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\mixdog-live-${sessionId}` : `${sessionFilePath}.live.sock`;
}

export function createLiveShare({
  ownerSessionId,
  viewerSessionId,
  socketPathFor,
  getPublishedState,
  listeners,
  onRemoteSubmit,
  onRemoteAbort,
  onOwnerClosed,
  viewerApply,
  viewerRetryMinMs = LIVE_CONNECT_RETRY_MIN_MS,
  viewerRetryMaxMs = LIVE_CONNECT_RETRY_MAX_MS,
}) {
  let disposed = false;
  const isDisposed = () => disposed;
  const clientRetryMinimumMs = Math.max(
    LIVE_CONNECT_RETRY_MIN_MS,
    Number(viewerRetryMinMs) || LIVE_CONNECT_RETRY_MIN_MS
  );
  const clientRetryMaximumMs = Math.max(clientRetryMinimumMs, Number(viewerRetryMaxMs) || LIVE_CONNECT_RETRY_MAX_MS);

  const owner = createOwnerLeg({
    ownerSessionId,
    socketPathFor,
    getPublishedState,
    onRemoteSubmit,
    onRemoteAbort,
    isDisposed,
    retryMinMs: LIVE_CONNECT_RETRY_MIN_MS,
    retryMaxMs: LIVE_CONNECT_RETRY_MAX_MS,
  });
  const viewer = createViewerLeg({
    viewerSessionId,
    socketPathFor,
    viewerApply,
    onOwnerClosed,
    isDisposed,
    reconcile: () => ensureShare(),
    retryMinMs: clientRetryMinimumMs,
    retryMaxMs: clientRetryMaximumMs,
  });
  listeners.add(owner.onPublish);

  // Reconciles both legs against the current session role. Failed pipe opens
  // continue through the local retry timers; the session runtime's 3s call is
  // only a safety net, never the normal connection cadence.
  const ensureShare = () => {
    if (disposed) return;
    const ownerId = String(ownerSessionId() || '');
    const attachId = ownerId ? '' : String(viewerSessionId() || '');
    owner.ensure(ownerId);
    viewer.ensure(attachId);
  };

  return {
    ensure: ensureShare,
    viewerConnected: viewer.connected,
    waitForViewerSync: viewer.waitForSync,
    sendSubmit: viewer.sendSubmit,
    sendAbort: viewer.sendAbort,
    dispose() {
      disposed = true;
      listeners.delete(owner.onPublish);
      owner.stop();
      viewer.dispose();
    },
  };
}

/**
 * ONE viewer-submit intake for EVERY session runtime entry point. The TUI store calls
 * submit(); the daemon awaits submitAsync() (session-service prefers it).
 * Wrapping only one of them let the other path enqueue the prompt on the VIEWER
 * session runtime, so that surface rendered its own local user row beside the owner's
 * mirrored one — the same message twice on screen
 * (user: 데스크탑에서만 입력이 두 개로 들어간다).
 *
 * `spool(submissionId)` is the durable fallback. The submission id is minted
 * here when the caller has none, so the pipe frame and the spool entry carry
 * the SAME identity and the owner reuses it for the settled user row — which is
 * what releases the submitting surface's optimistic bubble.
 */
export function forwardViewerSubmit({ prompt = null, text, options = {}, share, spool, pid = process.pid }) {
  const value = String(text || '').trim();
  const content = prompt ?? value;
  if (!value && !(Array.isArray(content) && content.length > 0)) return false;
  // Reconcile first so a session that became attachable this event-loop turn
  // takes the instant pipe path instead of the durable detour.
  try {
    share.ensure?.();
  } catch {
    /* durable fallback below */
  }
  const submissionId =
    options.id != null && String(options.id).trim() ? String(options.id).trim() : `view-submit-${pid}-${Date.now()}`;
  const deliverDurably = () => spool?.(submissionId) === true;
  // A pipe WRITE is not a delivery: the owner may refuse the prompt and the
  // socket may die between write and read, so an unacknowledged submit is
  // re-delivered through the spool — late, never lost.
  if (
    share.sendSubmit(content, {
      id: submissionId,
      submittedAt: options.submittedAt,
      displayText: value,
      options,
      onUndelivered: deliverDurably,
    })
  )
    return true;
  return deliverDurably();
}
