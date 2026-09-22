// Per-session delivery bookkeeping for pending messages: which ids a turn
// currently holds (in-delivery), which were already acknowledged (acked) and
// the exact claimed payloads a failed turn may restore. Owns the hygiene
// rules for those ledgers — nothing about persistence or delivery order.
import { currentPendingLifecycleToken } from './pending-lifecycle-epoch.mjs';
import { entryLifecycleToken, pendingMessageId, stampLifecycleToken } from './pending-message-entry.mjs';

export const _inDeliveryPendingIds = new Map();
export const _ackedPendingIds = new Map();
// Claim ledger for the in-delivery ids: the exact entries a drain handed to a
// turn. A drain consumes the not-yet-flushed persist buffer, so without this
// copy a failed turn could release ids whose payload exists nowhere (memory,
// spool, replay) any more. Claims are dropped on ack (delivered) or on
// release (restored by releasePendingMessages). A release may only restore while the session
// record still accepts pending state — a tombstoned session refuses it however
// old the claim is.
export const _claimedPendingMessages = new Map();

export function pendingIdSet(map, sessionId) {
  let ids = map.get(sessionId);
  if (!ids) {
    ids = new Set();
    map.set(sessionId, ids);
  }
  return ids;
}

// Ledger hygiene: an id set only exists while it actually suppresses ids.
// Read paths (hydrate, release, ack) must never MATERIALIZE an empty set —
// those accumulated one pair of dead Sets per resumable session and were
// pruned only by an explicit session close.
export function pruneEmptyPendingIdSet(map, sessionId) {
  const ids = map.get(sessionId);
  if (ids && ids.size === 0) map.delete(sessionId);
}

export function claimPendingEntries(sessionId, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const currentToken = currentPendingLifecycleToken(sessionId);
  const prior = _claimedPendingMessages.get(sessionId);
  // Claims are stamped with the lifecycle epoch observed at claim time; a
  // claim from an older epoch is stale and never merges into the new one.
  const claims = prior && prior.token === currentToken ? prior : { token: currentToken, entries: new Map() };
  for (const entry of entries) {
    const id = pendingMessageId(entry);
    if (!id) continue;
    // The token also rides on the delivered entry OBJECT: a later claim or
    // ack may replace/remove this session's map state, and the old release
    // must still judge itself by the epoch it was handed.
    //
    // NEVER restamp: the token an entry was ACCEPTED under is immutable.
    // Overwriting it with the epoch current at claim time was exactly how
    // a generation-0 entry that survived a generation-1 detach got
    // legitimized (and then restored by a failed turn). Entries reaching
    // here without a token were never stamped (legacy/foreign paths) and
    // are claimed under the epoch observed now.
    if (!entryLifecycleToken(entry)) stampLifecycleToken(entry, currentToken);
    claims.entries.set(id, entry);
  }
  if (claims.entries.size > 0) _claimedPendingMessages.set(sessionId, claims);
}

export function dropPendingClaims(sessionId, ids) {
  const claims = _claimedPendingMessages.get(sessionId);
  if (!claims) return;
  for (const id of ids) claims.entries.delete(id);
  if (claims.entries.size === 0) _claimedPendingMessages.delete(sessionId);
}
