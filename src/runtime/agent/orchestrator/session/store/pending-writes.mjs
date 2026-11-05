/**
 * Debounced saves not yet recorded: one slot per session id holding the
 * newest copy handed to saveSession, its options and its summary version.
 * The 150 ms window is the store's only timer; read-your-writes readers
 * (loadSession, listings) see the slot's copy.
 */
import { hasUnackedRecords } from './session-writers.mjs';
import { hasWaitingSave } from './session-sequence.mjs';

export const SAVE_DEBOUNCE_MS = 150;
const _pending = new Map(); // id → { session, opts, summaryVersion, timer }

/** Keeps the newest copy in `id`'s slot; the first one opens the window,
 *  whose end hands the slot to `write`. */
export function schedulePendingWrite(id, session, opts, summaryVersion, write) {
  const slot = _pending.get(id);
  if (slot) {
    slot.session = session;
    slot.opts = opts;
    slot.summaryVersion = summaryVersion;
    return;
  }
  const next = { session, opts, summaryVersion, timer: null };
  next.timer = setTimeout(() => {
    if (_pending.get(id) !== next) return;
    _pending.delete(id);
    write(next);
  }, SAVE_DEBOUNCE_MS);
  next.timer.unref?.();
  _pending.set(id, next);
}

/** Removes `id`'s slot (its timer too) and returns it, or null. */
export function takePendingWrite(id) {
  const slot = _pending.get(id);
  if (!slot) return null;
  clearTimeout(slot.timer);
  _pending.delete(id);
  return slot;
}

/** Every slot, removed (the exit drain records them itself). */
export function takeAllPendingWrites() {
  const slots = [..._pending.values()];
  for (const slot of slots) clearTimeout(slot.timer);
  _pending.clear();
  return slots;
}

/** The copy waiting in `id`'s slot, or null. */
export function pendingSessionCopy(id) {
  return _pending.get(id)?.session ?? null;
}

/** Whether a write of `id` is still to land: a debounced slot, a save
 *  waiting behind a delete, or records not yet acknowledged. */
export function hasPendingSessionWrite(id) {
  return _pending.has(id) || hasWaitingSave(id) || hasUnackedRecords(id);
}

/** `visit(id, session)` for every copy waiting in a slot. */
export function forEachUnpersistedSession(visit) {
  for (const [id, slot] of _pending) visit(id, slot.session);
}
