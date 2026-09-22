/**
 * src/tui/session/live-share/viewer/frame-router.mjs - where one owner frame
 * goes: submit-ack verdicts, the mirrored state, and the full-frame sync
 * barrier. Returns true when the frame ends the link (owner close).
 */
export function routeViewerFrame(frame, { socket, id, link, sync, acks, mirror, viewerSessionId }) {
  if (link.socket !== socket) return false;
  if (frame.t === 'close') return true;
  // Delivery verdicts are session-independent: settle them before the
  // session-scope guard, so a submit acknowledged during a session switch
  // is not counted as lost (and re-sent as a duplicate).
  if (frame.t === 'submit-ack') {
    acks.settle(String(frame.ack || ''), frame.ok !== false);
    return false;
  }
  if (viewerSessionId() !== id) return false;
  try {
    const synced = mirror.applyFrame(frame);
    if (!synced) sync.requestSync(socket);
    // A connected socket is not an entry boundary: the viewer must wait
    // until the owner's atomic full frame has replaced the stale disk
    // restore. Desktop resume holds its renderer publication on this
    // barrier, preventing "last user message first, whole turn later".
    if (frame.t === 'full') {
      link.syncedId = id;
      sync.settle(id, true);
    }
  } catch {
    sync.requestSync(socket);
  }
  return false;
}
