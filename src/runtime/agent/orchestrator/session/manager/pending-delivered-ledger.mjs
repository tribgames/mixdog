// The DURABLE delivered-id ledger carried on the session record
// (session.deliveredPendingMessageIds): the replay protection a restart reads
// and the confirmed-id pruning that keeps it bounded. Owns the session-record
// side of pending delivery only — never the in-memory queues or the spool.
import { loadSession, saveSessionAsync } from '../store.mjs';
import { pendingLifecycleEpochMoved } from './pending-lifecycle-epoch.mjs';
import { entryLifecycleToken, pendingMessageId } from './pending-message-entry.mjs';

export function recordPendingMessageDelivery(session, deliveredEntries) {
  if (!session || !Array.isArray(deliveredEntries) || deliveredEntries.length === 0) return;
  const added = deliveredEntries.map(pendingMessageId).filter(Boolean);
  if (added.length === 0) return;
  const ledger = Array.isArray(session.deliveredPendingMessageIds)
    ? session.deliveredPendingMessageIds.filter((id) => typeof id === 'string' && id)
    : [];
  // This may temporarily exceed the nominal bound while spool cleanup is
  // failing. Never evict an ID whose durable spool copy may still exist.
  session.deliveredPendingMessageIds = [...new Set([...ledger, ...added])];
}

export async function pruneCleanupConfirmedLedger(
  sessionId,
  confirmedEntries,
  session = null,
  persist = null,
  expectedToken = null
) {
  const confirmedIds = new Set(
    (Array.isArray(confirmedEntries) ? confirmedEntries : []).map(pendingMessageId).filter(Boolean)
  );
  if (confirmedIds.size === 0) return false;
  // Same atomic ownership rule as the spool ack: the ledger of a session
  // whose durable epoch moved belongs to the reopened owner.
  const token =
    expectedToken ||
    (Array.isArray(confirmedEntries) ? confirmedEntries.map(entryLifecycleToken).find(Boolean) : null) ||
    null;
  if (token && pendingLifecycleEpochMoved(sessionId, token)) return false;
  const target = session || loadSession(sessionId);
  if (!target) return false;
  const ledger = Array.isArray(target.deliveredPendingMessageIds)
    ? target.deliveredPendingMessageIds.filter((id) => typeof id === 'string' && id)
    : [];
  const kept = ledger.filter((id) => !confirmedIds.has(id));
  if (kept.length === ledger.length) return false;
  // Confirmed IDs need no replay protection and are removed immediately
  // (therefore bounded below any finite confirmed-ID retention cap).
  // Unconfirmed IDs are never size-evicted.
  // Re-checked immediately before the mutation: the load above is an await
  // boundary for the caller's chain.
  if (token && pendingLifecycleEpochMoved(sessionId, token)) return false;
  target.deliveredPendingMessageIds = kept;
  if (typeof persist === 'function') await persist();
  else await saveSessionAsync(target, { expectedGeneration: target.generation });
  return true;
}
