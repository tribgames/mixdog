/**
 * src/tui/session/live-share/viewer.mjs - viewer leg: pipe client that
 * mirrors owner deltas into the local store, tracks full-sync and submit-ack
 * delivery, and sends submit/abort frames back to the owner. viewer/:
 * sync-waiters (full-frame barrier + throttled resync), submit-acks
 * (delivery tokens and the durable re-delivery fallback).
 */
import { connect } from 'node:net';
import { attachLineReader, destroyQuietly, frameLine } from './wire.mjs';
import { createMirror } from './mirror.mjs';
import { createRetryTimer, reconcileLeg } from './retry.mjs';
import { createSyncWaiters } from './viewer/sync-waiters.mjs';
import { createSubmitAcks, submitFrame } from './viewer/submit-acks.mjs';

export function createViewerLeg({
  viewerSessionId,
  socketPathFor,
  viewerApply,
  onOwnerClosed,
  isDisposed,
  reconcile,
  retryMinMs,
  retryMaxMs,
}) {
  // The pipe client for the attached session: `up` flips on connect, and
  // `syncedId` once the owner's atomic full frame has replaced the disk restore.
  const link = { socket: null, id: '', up: false, syncedId: '' };
  const sync = createSyncWaiters();
  const acks = createSubmitAcks();
  const mirror = createMirror(viewerApply);
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

  const waitForSync = (id, timeoutMs = 1500) => {
    const target = String(id || '');
    if (!target) return Promise.resolve(false);
    reconcile();
    if (link.up && link.id === target && link.syncedId === target) {
      return Promise.resolve(true);
    }
    return sync.wait(target, timeoutMs);
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

  const onFrame = (socket, id, frame) => {
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
  };

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

  // Reconcile against the session this surface is attached to ('' = none).
  const ensure = (attachId) =>
    reconcileLeg(attachId, {
      retry,
      legId: () => link.id,
      legUp: () => Boolean(link.socket),
      stop: stopClient,
      start: startClient,
    });

  const sendSubmit = (prompt, meta = null) => {
    if (!link.up || !link.socket) return false;
    const ackId = acks.nextAckId();
    const onUndelivered = typeof meta?.onUndelivered === 'function' ? meta.onUndelivered : null;
    try {
      link.socket.write(submitFrame(prompt, meta, ackId));
    } catch {
      return false;
    }
    // Written, not yet delivered. The caller gets its synchronous `true`
    // (the store contract), and an owner that never acknowledges — refusal,
    // crash, half-open pipe — triggers the durable re-delivery instead of
    // silently eating the prompt.
    if (onUndelivered) acks.track(ackId, onUndelivered);
    return true;
  };

  const sendAbort = () => {
    if (!link.up || !link.socket) return false;
    try {
      link.socket.write(frameLine({ t: 'abort' }));
      return true;
    } catch {
      return false;
    }
  };

  const dispose = () => {
    acks.failAll();
    stopClient();
    sync.failAll();
  };

  return { ensure, connected: () => link.up, waitForSync, sendSubmit, sendAbort, dispose };
}
