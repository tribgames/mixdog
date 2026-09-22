// Durable lifecycle gate for pending-message state: reads the session's
// on-disk record and turns it into the epoch tokens every enqueue, claim,
// hydration and spool mutation judges itself by. Pure authority — it owns no
// queue state and mutates nothing.
import { readSessionLifecycleStateFromDisk } from '../store.mjs';

// Authoritative pending-state lifecycle gate. The DURABLE record is the only
// authority: readSessionLifecycleStateFromDisk reports absence / open / closed
// / unreadable straight from disk, bypassing every live/pending snapshot, so a
// stale open live copy (e.g. an id under _droppedSaveIds) can never mask a
// tombstone. Only an explicit create/reopen/new-generation record — never an
// ordinary enqueue — makes a session writable again.
//   'absent'     → never saved: open and writable (generation 0)
//   'open'       → durable record at this generation
//   'closed'     → tombstone: refuses every write
//   'unreadable' → IO error / malformed / foreign record: FAIL CLOSED, and a
//                  live snapshot may only ADD refusal, never open it
export function pendingSessionLifecycle(sessionId) {
  let disk = null;
  try {
    disk = readSessionLifecycleStateFromDisk(sessionId);
  } catch {
    disk = null;
  }
  const state = disk?.state;
  if (state === 'open' || state === 'closed') {
    return { source: state, closed: state === 'closed', generation: Number(disk.generation) || 0 };
  }
  if (state === 'absent') return { source: 'absent', closed: false, generation: 0 };
  // Unreadable/corrupt/foreign (or the read itself threw): never writable.
  return { source: 'unreadable', closed: true, generation: 0 };
}

// Epoch token: the exact lifecycle a claim/enqueue/hydration was taken under.
export function pendingLifecycleToken(lifecycle) {
  return `${lifecycle.source}:${lifecycle.generation}`;
}

export function currentPendingLifecycleToken(sessionId) {
  return pendingLifecycleToken(pendingSessionLifecycle(sessionId));
}

// Pure epoch comparison against an already-read lifecycle (no IO), so a caller
// that judges many entries reads the durable record once.
export function lifecycleTokenStale(now, sinceToken) {
  if (sinceToken === null || sinceToken === undefined) return false;
  const separator = String(sinceToken).indexOf(':');
  const sinceSource = String(sinceToken).slice(0, separator);
  const sinceGeneration = Number(String(sinceToken).slice(separator + 1)) || 0;
  // Only close/detach moves the durable generation, so a differing one means
  // the session was closed/detached/reopened since: refuse.
  if (now.generation !== sinceGeneration) return true;
  // A record that was DURABLE at claim/hydration start must still be durable:
  // an unreadable record must never be mistaken for an open session. The
  // reverse (never-saved → first durable save at the same generation) is the
  // ordinary lifecycle of a fresh session and stays valid.
  if (sinceSource === 'open' && now.source !== 'open') return true;
  return false;
}

// True when pending state for this session must NOT be (re)created/published:
// tombstoned, or the durable lifecycle epoch moved since `sinceToken`.
export function pendingLifecycleInvalidated(sessionId, sinceToken = null) {
  const now = pendingSessionLifecycle(sessionId);
  if (now.closed) return true;
  return lifecycleTokenStale(now, sinceToken);
}

// Epoch check for DESTRUCTIVE spool/ledger mutations (ack, prune, clear,
// foreign drain). Deliberately tombstone-TOLERANT: deleting the rows of the
// epoch that just closed is legitimate (the close path itself does it), while
// a generation move — the reopened/detached owner taking over — means those
// rows are no longer ours to touch. Callers re-evaluate this INSIDE the spool
// transaction, immediately before mutating.
export function pendingLifecycleEpochMoved(sessionId, sinceToken = null) {
  if (sinceToken === null || sinceToken === undefined) return false;
  const now = pendingSessionLifecycle(sessionId);
  const separator = String(sinceToken).indexOf(':');
  const sinceGeneration = Number(String(sinceToken).slice(separator + 1)) || 0;
  if (now.generation !== sinceGeneration) return true;
  // An unreadable/foreign record is never authority for a deletion.
  if (now.source === 'unreadable') return true;
  return false;
}
