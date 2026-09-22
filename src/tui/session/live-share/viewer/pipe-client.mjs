/**
 * src/tui/session/live-share/viewer/pipe-client.mjs - the viewer's socket
 * lifecycle: connect, frame routing into the mirror, teardown, and the retry
 * timer that owns re-connection. The link record it mutates is the viewer
 * leg's, so waitForSync/sendSubmit read the same `up`/`syncedId` state.
 */
import { connect } from 'node:net';
import { attachLineReader, destroyQuietly } from '../wire.mjs';
import { createRetryTimer } from '../retry.mjs';
import { routeViewerFrame } from './frame-router.mjs';

export function createPipeClient({
  link,
  sync,
  acks,
  mirror,
  viewerSessionId,
  socketPathFor,
  onOwnerClosed,
  isDisposed,
  retryMinMs,
  retryMaxMs,
}) {
  const retry = createRetryTimer({
    minMs: retryMinMs,
    maxMs: retryMaxMs,
    shouldStart: (id) => !isDisposed() && !link.socket && String(viewerSessionId() || '') === id,
    start: (id) => startClient(id),
  });

  const resetLink = () => {
    link.socket = null;
    link.id = '';
    link.up = false;
    link.syncedId = '';
  };

  const stopClient = () => {
    retry.clear();
    retry.reset();
    const closing = link.socket;
    const closingId = link.id;
    const wasUp = link.up;
    resetLink();
    if (closingId) sync.settle(closingId, false);
    if (closing) destroyQuietly(closing);
    // Deliberate teardown (session switch / role change / dispose) destroys
    // the socket AFTER link.up is already false, so the socket's close
    // handler sees wasUp=false and never clears the mirror. Clear it here:
    // otherwise the owner's mirrored busy/spinner/queue leaks into the next
    // resumed session as a frozen working indicator (user report: finished
    // session shows a spinner + stop button after switching away from a
    // busy live-attached session).
    if (wasUp) mirror.clearLiveState();
  };

  // Frame routing: viewer/frame-router.mjs.
  const onFrame = (socket, id, frame) =>
    routeViewerFrame(frame, { socket, id, link, sync, acks, mirror, viewerSessionId });

  const startClient = (id) => {
    if (isDisposed() || link.socket || !id) return;
    retry.clear();
    let socket;
    try {
      socket = connect(socketPathFor(id));
    } catch {
      retry.schedule(id);
      return;
    }
    link.socket = socket;
    link.id = id;
    link.up = false;
    link.syncedId = '';
    socket.setNoDelay?.(true);
    socket.on('connect', () => {
      if (link.socket !== socket) return;
      link.up = true;
      retry.clear();
      retry.reset();
    });
    const down = (ownerClosed) => {
      const wasCurrent = link.socket === socket;
      const wasUp = link.up && wasCurrent;
      if (wasCurrent) resetLink();
      // Anything still awaiting an ack died with this socket: report it as
      // undelivered so the caller re-delivers durably.
      if (wasCurrent) acks.failAll();
      destroyQuietly(socket);
      if (wasUp) mirror.clearLiveState();
      // A live link that dropped means the owner ended or crashed: nudge the
      // promotion path instead of waiting for the next store-mtime change.
      if (wasUp) onOwnerClosed?.(id, ownerClosed);
      if (wasCurrent) retry.schedule(id);
    };
    socket.on('error', () => down(false));
    socket.on('close', () => down(false));
    attachLineReader(
      socket,
      (frame) => {
        if (onFrame(socket, id, frame)) down(true);
      },
      () => down(false)
    );
  };

  return { retry, startClient, stopClient };
}
