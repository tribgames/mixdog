/**
 * src/tui/session/live-share/viewer.mjs - viewer leg: pipe client that
 * mirrors owner deltas into the local store, tracks full-sync and submit-ack
 * delivery, and sends submit/abort frames back to the owner. viewer/:
 * sync-waiters (full-frame barrier + throttled resync), submit-acks
 * (delivery tokens and the durable re-delivery fallback).
 */
import { frameLine } from './wire.mjs';
import { createMirror } from './mirror.mjs';
import { reconcileLeg } from './retry.mjs';
import { createPipeClient } from './viewer/pipe-client.mjs';
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
  // Socket lifecycle (connect, frame routing, teardown, retry): viewer/pipe-client.mjs.
  const { retry, startClient, stopClient } = createPipeClient({
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
  });

  const waitForSync = (id, timeoutMs = 1500) => {
    const target = String(id || '');
    if (!target) return Promise.resolve(false);
    reconcile();
    if (link.up && link.id === target && link.syncedId === target) {
      return Promise.resolve(true);
    }
    return sync.wait(target, timeoutMs);
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
