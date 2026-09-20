/**
 * live-share/viewer/submit-acks.mjs - submit delivery tracking. A pipe write
 * only proves the bytes left this process: the owner can REFUSE the prompt
 * (disposed / itself attached) and the socket can die before it is read.
 * Every submit therefore carries an ack token, and an unacknowledged one is
 * reported to the caller so it can re-deliver through the durable spool
 * instead of losing the message.
 */
import { frameLine } from '../wire.mjs';

const SUBMIT_ACK_TIMEOUT_MS = 2_000;

/** The submit frame for `prompt`, tagged with its ack token. */
export function submitFrame(prompt, meta, ackId) {
  const id = meta && meta.id != null && String(meta.id).trim() ? String(meta.id) : undefined;
  const submittedAt = Number(meta?.submittedAt);
  const displayText = String(
    meta?.displayText ?? meta?.options?.displayText ?? (typeof prompt === 'string' ? prompt : '')
  );
  return frameLine({
    t: 'submit',
    text: displayText,
    prompt,
    ...(meta?.options && typeof meta.options === 'object' ? { options: meta.options } : {}),
    ack: ackId,
    ...(id ? { id } : {}),
    ...(Number.isFinite(submittedAt) && submittedAt > 0 ? { submittedAt: Math.round(submittedAt) } : {}),
  });
}

export function createSubmitAcks() {
  const pending = new Map();
  let seq = 0;

  function nextAckId() {
    seq += 1;
    return `ack-${process.pid}-${Date.now()}-${seq}`;
  }

  function settle(ackId, delivered) {
    const entry = pending.get(ackId);
    if (!entry) return;
    pending.delete(ackId);
    clearTimeout(entry.timer);
    if (delivered) return;
    try {
      entry.onUndelivered?.();
    } catch {
      /* fallback is best-effort */
    }
  }

  /** Written, not yet delivered: an owner that never acknowledges triggers re-delivery. */
  function track(ackId, onUndelivered) {
    const timer = setTimeout(() => settle(ackId, false), SUBMIT_ACK_TIMEOUT_MS);
    timer.unref?.();
    pending.set(ackId, { timer, onUndelivered });
  }

  function failAll() {
    for (const ackId of [...pending.keys()]) settle(ackId, false);
  }

  return { nextAckId, settle, track, failAll };
}
