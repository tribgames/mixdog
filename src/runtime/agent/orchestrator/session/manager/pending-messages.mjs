// Steering / pending-message queue with sync buffering and atomic persistence.
import { readFileSync } from 'node:fs';
import { loadSession } from '../store.mjs';
import {
  currentPendingLifecycleToken,
  lifecycleTokenStale,
  pendingLifecycleEpochMoved,
  pendingLifecycleInvalidated,
  pendingLifecycleToken,
  pendingSessionLifecycle,
} from './pending-lifecycle-epoch.mjs';
import {
  _pendingPersistTails,
  chainSpoolTail,
  isValidPendingSessionId,
  normalizePendingStore,
  pendingMessagesPath,
  pendingWarn,
  setSpoolQueue,
  updateSpool,
} from './pending-spool-file.mjs';
import {
  _ackedPendingIds,
  _claimedPendingMessages,
  _inDeliveryPendingIds,
  claimPendingEntries,
  dropPendingClaims,
  pendingIdSet,
  pruneEmptyPendingIdSet,
} from './pending-claim-ledger.mjs';
import { legacyPendingMessagesPath } from './pending-spool-path.mjs';
import {
  TASK_WAIT_WAKE_NOTIFICATION,
  TASK_WAIT_WAKE_USER,
  interruptTaskWaitForSession,
  registerTaskWaitSteeringCheck,
} from '../task-wait-control.mjs';
import { pruneCleanupConfirmedLedger } from './pending-delivered-ledger.mjs';
// The durable delivered-id ledger on the session record lives in
// pending-delivered-ledger.mjs; re-exported so prior importers stay unchanged.
export { recordPendingMessageDelivery } from './pending-delivered-ledger.mjs';
import {
  _pendingPersistBuffers,
  bumpPendingStateEpoch,
  cancelPendingPersistRetry,
  flushPendingMessagePersistsSync,
  persistPendingMessages,
  schedulePendingMessagePersist,
  takeBufferedPendingMessages,
} from './pending-persist-queue.mjs';
// Stale/orphan spool retention lives in pending-spool-sweep.mjs; re-exported
// so prior importers of this module stay unchanged.
export { sweepOrphanedPendingMessages } from './pending-spool-sweep.mjs';
import {
  COMPLETION_NOTIFICATION_KIND,
  PENDING_MODE_PROMPT,
  PENDING_MODE_TASK_NOTIFICATION,
  _groupPendingMessageEntries,
  _mergePendingMessageEntries,
  completionExecutionId,
  completionIsDelivered,
  completionWasDelivered,
  entryLifecycleToken,
  isCompletionNotificationEntry,
  isStaleUserInjection,
  lateDeliveryText,
  markCompletionEntry,
  modelVisiblePendingMessages,
  newPendingMessageId,
  pendingEntryMode,
  pendingMessageId,
  pendingMessageQueueEntry,
  stampLifecycleToken,
} from './pending-message-entry.mjs';

export {
  COMPLETION_NOTIFICATION_KIND,
  PENDING_MODE_PROMPT,
  PENDING_MODE_TASK_NOTIFICATION,
  _groupPendingMessageEntries,
  _mergePendingMessageEntries,
  markCompletionEntry,
  pendingEntryMode,
};

const _sessionPendingMessages = new Map();
// Persisted entries are claimed once, asynchronously, when askSession takes
// ownership of a session. Hot-path drains consume this in-memory snapshot and
// never touch the global spool (or its cross-process lock).
const _hydratedPendingMessages = new Map();
const _pendingHydrations = new Map();

function pendingIdStillQueued(sessionId, id) {
  for (const map of [_sessionPendingMessages, _pendingPersistBuffers, _hydratedPendingMessages]) {
    const q = map.get(sessionId);
    if (Array.isArray(q) && q.some((entry) => pendingMessageId(entry) === id)) return true;
  }
  return false;
}

function acknowledgePendingMessages(sessionId, deliveredEntries, options = {}) {
  const entries = Array.isArray(deliveredEntries) ? deliveredEntries : [];
  // Expected lifecycle epoch of THIS acknowledgement: the immutable token of
  // the delivered entries (explicit option for spool-sourced entries that
  // never carried one), falling back to the epoch observed right now.
  const explicitToken =
    typeof options?.expectedToken === 'string' && options.expectedToken ? options.expectedToken : null;
  const expectedToken =
    explicitToken || entries.map(entryLifecycleToken).find(Boolean) || currentPendingLifecycleToken(sessionId);
  // An entry from a DIFFERENT epoch is not part of this ack: its rows belong
  // to another owner and must not be deleted by this transaction.
  const ids = new Set(
    entries
      .filter((entry) => {
        const token = entryLifecycleToken(entry);
        return !token || token === expectedToken;
      })
      .map(pendingMessageId)
      .filter(Boolean)
  );
  if (ids.size === 0) return Promise.resolve(false);
  // The epoch already moved before we touched anything: leave the reopened
  // owner's memory, ledger and spool rows exactly as they are.
  if (pendingLifecycleEpochMoved(sessionId, expectedToken)) return Promise.resolve(false);
  // Read-only for the in-delivery ledger: only the acked set is being GROWN
  // here, so an ack for a session with no in-delivery state must not create
  // an empty Set that then lives until an explicit close.
  const inDelivery = _inDeliveryPendingIds.get(sessionId) || null;
  const acked = pendingIdSet(_ackedPendingIds, sessionId);
  for (const id of ids) {
    inDelivery?.delete(id);
    acked.add(id);
  }
  pruneEmptyPendingIdSet(_inDeliveryPendingIds, sessionId);
  // Delivered for good: the claim copy is no longer a recovery source.
  dropPendingClaims(sessionId, ids);
  const purgeMemory = () => {
    for (const map of [_pendingPersistBuffers, _sessionPendingMessages, _hydratedPendingMessages]) {
      const q = map.get(sessionId);
      if (!Array.isArray(q)) continue;
      const kept = q.filter((entry) => !ids.has(pendingMessageId(entry)));
      if (kept.length > 0) map.set(sessionId, kept);
      else map.delete(sessionId);
    }
  };
  purgeMemory();
  // Re-read at settlement: the map state may have been replaced meanwhile.
  const forgetAckedIds = () => {
    const settledAcked = _ackedPendingIds.get(sessionId);
    for (const id of ids) settledAcked?.delete(id);
    pruneEmptyPendingIdSet(_ackedPendingIds, sessionId);
  };
  let epochMoved = false;
  const precedingPersist = _pendingPersistTails.get(sessionId) || Promise.resolve();
  const operation = precedingPersist
    .catch(() => {})
    .then(() => {
      // A failed preceding persist may have requeued after the first purge.
      // Skipped once the epoch moved: those queue entries are the new
      // owner's (a hydrate can republish the very same durable ids).
      if (!pendingLifecycleEpochMoved(sessionId, expectedToken)) purgeMemory();
      return updateSpool(sessionId, (raw) => {
        // Atomic re-validation: we now hold the spool lock. A generation
        // movement while we waited means the rows are the reopened owner's —
        // delete nothing and report failure so no ledger prune follows.
        if (pendingLifecycleEpochMoved(sessionId, expectedToken)) {
          epochMoved = true;
          return undefined;
        }
        const next = normalizePendingStore(raw);
        const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
        const kept = q.filter((entry) => !ids.has(pendingMessageId(entry)));
        if (kept.length === q.length) return undefined;
        setSpoolQueue(next, sessionId, kept);
        next.updatedAt = Date.now();
        return next;
      });
    });
  _pendingPersistTails.set(sessionId, operation);
  const reported = operation
    .then(() => !epochMoved)
    .catch((err) => {
      pendingWarn(`[session] pending-message ack failed sessionId=${sessionId}: ${err?.message || err}\n`);
      return false;
    })
    .then((ok) => {
      if (_pendingPersistTails.get(sessionId) === operation) _pendingPersistTails.delete(sessionId);
      // Refused because the epoch moved: this ack never happened. Drop the
      // acked-id suppression again — those durable rows now belong to the
      // reopened owner and its hydrate must be able to take them.
      if (epochMoved) {
        forgetAckedIds();
        return false;
      }
      // Keep the acked ids when the spool cleanup FAILED: the durable entry
      // still exists, and forgetting that it was already delivered would let
      // the hydrate path re-take it as a new message (the same message
      // duplicated in the transcript). They are dropped only once a later ack
      // round actually lands.
      if (!ok) return false;
      forgetAckedIds();
      return true;
    });
  return reported;
}

export function finalizePendingMessageDelivery(session, deliveredEntries, durableSave, persistPrunedLedger) {
  const ids = new Set((Array.isArray(deliveredEntries) ? deliveredEntries : []).map(pendingMessageId).filter(Boolean));
  if (!session || ids.size === 0) return Promise.resolve(false);
  // Strict durability order: ledger/session first, spool deletion second.
  // Both operations are detached from the completion tick.
  return Promise.resolve(durableSave).then(async () => {
    const cleaned = await acknowledgePendingMessages(session.id, deliveredEntries);
    if (!cleaned) return false;
    await pruneCleanupConfirmedLedger(session.id, deliveredEntries, session, persistPrunedLedger);
    return true;
  });
}

export function releasePendingMessages(sessionId, deliveredEntries) {
  // Read-only lookups: a release for a session that carries no ledger state
  // must not materialize two empty Sets (they were pruned only on close).
  const inDelivery = _inDeliveryPendingIds.get(sessionId) || null;
  const acked = _ackedPendingIds.get(sessionId) || null;
  const claim = _claimedPendingMessages.get(sessionId);
  // Restoring is a WRITE of pending state: allowed only while the DURABLE
  // lifecycle is still open AND still the exact epoch THIS delivery was
  // claimed under. The token is read from the released entry itself and only
  // falls back to the map when the two agree — a newer claim/ack that
  // replaced or removed the map state can never re-open an old release.
  const claimToken = (entry) =>
    entryLifecycleToken(entry) || (claim?.entries.has(pendingMessageId(entry)) ? claim.token : null);
  const releasedIds = [];
  const restored = [];
  for (const entry of Array.isArray(deliveredEntries) ? deliveredEntries : []) {
    const id = pendingMessageId(entry);
    if (!id) continue;
    inDelivery?.delete(id);
    releasedIds.push(id);
    // The turn did NOT deliver this input. Restore the claimed entry so it
    // is queued (and durable) again: the drain that claimed it may have
    // consumed the not-yet-flushed persist buffer, in which case clearing
    // the id alone would lose the message from memory, spool and replay.
    if (acked?.has(id)) continue;
    const token = claimToken(entry);
    // No token at all (never claimed through a drain) → fail closed.
    if (!token || pendingLifecycleInvalidated(sessionId, token)) continue;
    if (pendingIdStillQueued(sessionId, id)) continue;
    const claimed = claim?.entries.get(id) || pendingMessageQueueEntry(entry);
    if (claimed) restored.push(stampLifecycleToken(claimed, token));
  }
  if (restored.length > 0) {
    const q = _sessionPendingMessages.get(sessionId) || [];
    q.push(...restored);
    // FIFO by original enqueue time — a restored entry predates anything
    // queued while the failed turn was running.
    q.sort((a, b) => (Number(a?.enqueuedAt) || 0) - (Number(b?.enqueuedAt) || 0));
    _sessionPendingMessages.set(sessionId, q);
    // Durability: persistPendingMessages is id-idempotent, so an entry that
    // was already flushed keeps its single spool row while one that never
    // reached disk gets written now (restart replays it exactly once).
    for (const entry of restored) schedulePendingMessagePersist(sessionId, entry);
  }
  dropPendingClaims(sessionId, releasedIds);
  pruneEmptyPendingIdSet(_inDeliveryPendingIds, sessionId);
  pruneEmptyPendingIdSet(_ackedPendingIds, sessionId);
}

/** Splits one session's spool rows for hydration: rows this process may take
 *  over, rows the durable ledger already records as delivered, and ledger ids
 *  whose spool row is gone. */
function partitionHydratableSpoolRows(q, { deliveredLedger, inDelivery, acked }) {
  const spoolIds = new Set(q.map(pendingMessageId).filter(Boolean));
  // Ledger IDs only suppress matching durable spool entries. If no
  // such entry exists, cleanup was already completed (possibly just
  // before a crash) and the ledger ID is structurally stale.
  const staleLedgerEntries = [...deliveredLedger].filter((id) => !spoolIds.has(id)).map((id) => ({ id }));
  const alreadyDelivered = [];
  const hydrated = q.filter((entry) => {
    const id = pendingMessageId(entry);
    if (id && deliveredLedger.has(id)) {
      alreadyDelivered.push(entry);
      return false;
    }
    if (!id || inDelivery?.has(id) || acked?.has(id)) return false;
    return true;
  });
  return { hydrated, alreadyDelivered, staleLedgerEntries };
}

export function hydratePendingMessages(sessionId) {
  if (!isValidPendingSessionId(sessionId)) return Promise.resolve(0);
  const existingHydration = _pendingHydrations.get(sessionId);
  if (existingHydration) return existingHydration;
  const hydration = (async () => {
    const precedingPersist = _pendingPersistTails.get(sessionId);
    if (precedingPersist) await precedingPersist.catch(() => {});
    let hydrated = [];
    const alreadyDelivered = [];
    let staleLedgerEntries = [];
    const ledgerSession = loadSession(sessionId);
    // Durable lifecycle epoch this hydration started under. Publishing claims the
    // durable entries into THIS process's memory, so it must be revalidated
    // after every await (spool IO, ack/prune): a close
    // (tombstone) or a close/detach generation bump in between means the
    // entries belong to the next owner, not to us. Aborting publishes
    // nothing and leaves the durable rows untouched for that owner.
    const startLifecycle = pendingSessionLifecycle(sessionId);
    const startToken = pendingLifecycleToken(startLifecycle);
    if (startLifecycle.closed) return 0;
    try {
      const deliveredLedger = new Set(ledgerSession?.deliveredPendingMessageIds || []);
      // Read-only: hydration runs on EVERY session takeover, and creating the
      // two id Sets here leaked one empty pair per resumable session (only an
      // explicit close ever pruned them). They are created below, once there
      // is an id to actually suppress.
      const inDelivery = _inDeliveryPendingIds.get(sessionId) || null;
      const acked = _ackedPendingIds.get(sessionId) || null;
      await updateSpool(sessionId, (raw) => {
        const next = normalizePendingStore(raw);
        const q = Array.isArray(next.sessions[sessionId]) ? next.sessions[sessionId] : [];
        const rows = partitionHydratableSpoolRows(q, { deliveredLedger, inDelivery, acked });
        staleLedgerEntries = rows.staleLedgerEntries;
        hydrated = rows.hydrated;
        alreadyDelivered.push(...rows.alreadyDelivered);
        // Stale genuine user/steering entries DELIVER with a
        // late-delivery header instead of being silently dropped (the old
        // behavior discarded them; user report: remote/steering sends
        // silently ignored around owner restarts). Completion entries
        // keep their own resume-drop policy (drain discards them).
        for (const entry of hydrated) {
          if (!isStaleUserInjection(entry)) continue;
          if (typeof entry.message === 'string') {
            entry.message = lateDeliveryText(entry.message, entry);
          }
        }
        // Read-only claim: durable data remains until successful delivery
        // acknowledges these exact ids. A crash here therefore redelivers.
        return undefined;
      });
      if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
    } catch (err) {
      pendingWarn(`[session] pending-message hydrate failed sessionId=${sessionId}: ${err?.message || err}\n`);
      return 0;
    }
    const cleanupConfirmed = staleLedgerEntries.slice();
    if (alreadyDelivered.length > 0) {
      const cleaned = await acknowledgePendingMessages(sessionId, alreadyDelivered, { expectedToken: startToken });
      if (cleaned) cleanupConfirmed.push(...alreadyDelivered);
      // Every individual cleanup await is its own window: stop before the
      // next mutation once the lifecycle moved (the remaining spool rows and
      // the ledger belong to the new owner from here on).
      if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
    }
    if (cleanupConfirmed.length > 0) {
      try {
        // One session save prunes both IDs whose replay spool was removed
        // now and IDs whose spool was already absent at hydration start.
        await pruneCleanupConfirmedLedger(sessionId, cleanupConfirmed, ledgerSession, null, startToken);
      } catch (err) {
        pendingWarn(`[session] pending-message ledger prune failed sessionId=${sessionId}: ${err?.message || err}\n`);
      }
      if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
    }
    if (hydrated.length > 0) {
      // Last revalidation: the ack/prune awaits above are another window.
      if (pendingLifecycleInvalidated(sessionId, startToken)) return 0;
      const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
      for (const entry of hydrated) {
        const id = pendingMessageId(entry);
        if (id) inDelivery.add(id);
        // Durable rows carry no symbol: stamp the epoch this hydration was
        // validated under, so every later clone/claim/ack judges itself by
        // that immutable token instead of the epoch current at the time.
        stampLifecycleToken(entry, startToken);
      }
      const existing = _hydratedPendingMessages.get(sessionId) || [];
      existing.push(...hydrated);
      _hydratedPendingMessages.set(sessionId, existing);
    }
    return hydrated.length;
  })();
  _pendingHydrations.set(sessionId, hydration);
  hydration
    .finally(() => {
      if (_pendingHydrations.get(sessionId) === hydration) _pendingHydrations.delete(sessionId);
    })
    .catch(() => {});
  return hydration;
}

function clearPersistedPendingMessages(sessionId) {
  if (!isValidPendingSessionId(sessionId)) return;
  // ASYNC, chained behind this session's persist tail. The previous SYNC
  // variant self-deadlocked: closeSession ran it on the event loop while an
  // in-flight async spool op (persist/ack/hydrate) in the SAME process held
  // the lock — the sync wait starved the holder's continuations, so every
  // such race burned the full 8s lock timeout (observed as an 8s shard-child
  // stall after each one-shot session close). In-memory queues are already
  // dropped synchronously by _dropPendingMessageState; only the durable
  // spool row lags behind, exactly like the ack path.
  const preceding = _pendingPersistTails.get(sessionId) || Promise.resolve();
  // Epoch this clear was ordered under (normally the tombstone that just
  // landed). Re-validated inside the lock: a reopen/detach that moves the
  // generation while this async clear waits must leave the new owner's rows.
  const epochToken = currentPendingLifecycleToken(sessionId);
  const operation = preceding
    .catch(() => {})
    .then(() =>
      updateSpool(sessionId, (raw) => {
        if (pendingLifecycleEpochMoved(sessionId, epochToken)) return undefined;
        const next = normalizePendingStore(raw);
        if (!Object.hasOwn(next.sessions, sessionId)) return undefined;
        setSpoolQueue(next, sessionId, []);
        next.updatedAt = Date.now();
        return next;
      })
    )
    .catch((err) => {
      pendingWarn(`[session] pending-message clear failed sessionId=${sessionId}: ${err?.message || err}\n`);
    });
  chainSpoolTail(sessionId, operation);
}

export function enqueuePendingMessage(sessionId, message) {
  const normalized = pendingMessageQueueEntry(message);
  // Caller-provided ids are never trusted across sessions/processes.
  // Completion ids are content/execution-addressed by markCompletionEntry:
  // preserving them makes fallback retries idempotent, while genuine
  // user/steering ids remain freshly generated and session-local.
  let entry = null;
  if (normalized) {
    const keepId = isCompletionNotificationEntry(normalized) && normalized.id;
    entry = { ...normalized, id: keepId ? normalized.id : newPendingMessageId() };
  }
  if (!sessionId || !entry) return 0;
  // A terminal task read may ACK before an async fallback enqueue settles.
  // Treat that completion as already delivered and never publish it.
  if (completionWasDelivered(entry, 'enqueue')) return 1;
  // A provider/tool completion that lands after the session was tombstoned
  // must NOT recreate memory/spool state (and never clears the tombstone):
  // only an explicit create/reopen record makes the session writable again.
  const token = currentPendingLifecycleToken(sessionId);
  if (pendingLifecycleInvalidated(sessionId)) return 0;
  stampLifecycleToken(entry, token);
  // Re-validate immediately before the memory publish: a close/detach landing
  // in this window must reject the input instead of recreating state for a
  // session the new owner already took over.
  if (pendingLifecycleInvalidated(sessionId, token)) return 0;
  if (isCompletionNotificationEntry(entry) && pendingIdStillQueued(sessionId, entry.id)) return 1;
  let q = _sessionPendingMessages.get(sessionId);
  if (!q) {
    q = [];
    _sessionPendingMessages.set(sessionId, q);
  }
  q.push(entry);
  const bufferedDepth = schedulePendingMessagePersist(sessionId, entry);
  const wake = pendingEntryWake(entry);
  if (wake) {
    interruptTaskWaitForSession(
      sessionId,
      wake,
      wake === TASK_WAIT_WAKE_NOTIFICATION ? completionExecutionId(entry) : null
    );
  }
  return Math.max(q.length, bufferedDepth || 0);
}

// What one queued entry wakes a passive task wait or shell hold for, so it
// reaches the loop now: steering (a Lead message to its agent) as user input,
// and an undelivered task completion (agent/shell, any status). A plain
// channel notice (scheduled or event-rule inject) waits for the turn, as it
// does in the Lead's queue.
function pendingEntryWake(entry) {
  if (pendingEntryMode(entry) === PENDING_MODE_PROMPT) return TASK_WAIT_WAKE_USER;
  if (isCompletionNotificationEntry(entry) && !completionIsDelivered(entry)) return TASK_WAIT_WAKE_NOTIFICATION;
  return false;
}

// Anything already queued when a wait or hold begins ends it at once, exactly
// like what arrives during it. A completion the agent already received is no
// longer deliverable and never wakes.
registerTaskWaitSteeringCheck((sessionId) => {
  let wake = false;
  for (const entry of _sessionPendingMessages.get(sessionId) || []) {
    const found = pendingEntryWake(entry);
    if (found === TASK_WAIT_WAKE_USER) return found;
    wake = wake || found;
  }
  return wake;
});

// True when this session's queue holds task notifications and nothing else:
// the mid-chain boundary may then take the whole queue without bypassing the
// prompt filters that keep queued prompts for the terminal boundary.
export function pendingQueueHoldsOnlyNotifications(sessionId) {
  const queued = [
    ...(_sessionPendingMessages.get(sessionId) || []),
    ...(_hydratedPendingMessages.get(sessionId) || []),
  ];
  return queued.length > 0 && queued.every((entry) => pendingEntryMode(entry) === PENDING_MODE_TASK_NOTIFICATION);
}

// Drain order: enqueue time, then source (hydrated < buffered < memory), then
// position within the source.
function byEnqueueOrder(a, b) {
  const at = Number(a.entry?.enqueuedAt) || 0;
  const bt = Number(b.entry?.enqueuedAt) || 0;
  return at - bt || a.source - b.source || a.index - b.index;
}

export function drainPendingMessages(sessionId) {
  const q = _sessionPendingMessages.get(sessionId);
  const memory = q && q.length > 0 ? q.slice() : [];
  _sessionPendingMessages.delete(sessionId);
  const hydrated = _hydratedPendingMessages.get(sessionId) || [];
  _hydratedPendingMessages.delete(sessionId);
  // FIFO: takeover-hydrated disk entries predate the not-yet-flushed buffer.
  // This path is deliberately memory-only: no file lock, stat, parse, or
  // atomic rename can run in the agent-completion tick.
  const buffered = takeBufferedPendingMessages(sessionId);
  // A completion that reached the spool and was never acknowledged was never
  // delivered to the model (delivery acknowledges and removes it), so it
  // survives a restart: the hydrated disk entries drain like live in-memory
  // ones. Dropping them on resume lost a finished (or failed) task's only
  // notification.
  // Drain-time belt: drop MARKED completion entries whose text hash was
  // already delivered+ACKed (TUI execution-ui) this process — those would
  // double-inject next turn. Only marked completion entries are eligible;
  // genuine user/steering entries carry no marker and are always kept.
  const deliveredIds = new Set();
  const deliveredEntries = [];
  const keepUndelivered = (entry) => {
    if (!isCompletionNotificationEntry(entry)) return true;
    const id = pendingMessageId(entry);
    if (id && deliveredIds.has(id)) return false;
    if (!completionWasDelivered(entry, 'drain')) return true;
    if (id) deliveredIds.add(id);
    deliveredEntries.push(entry);
    return false;
  };
  const hydratedKept = hydrated.filter(keepUndelivered);
  const memoryKept = memory.filter(keepUndelivered);
  const bufferedKept = buffered.filter(keepUndelivered);
  const tagged = [
    ...hydratedKept.map((entry, index) => ({ entry, source: 0, index })),
    ...bufferedKept.map((entry, index) => ({ entry, source: 1, index })),
    ...memoryKept.map((entry, index) => ({ entry, source: 2, index })),
  ];
  tagged.sort(byEnqueueOrder);
  const byId = new Map();
  for (const item of tagged) {
    const normalized = pendingMessageQueueEntry(item.entry);
    if (!normalized?.id) continue;
    // Prefer the live form for duplicate spool/buffer copies; content and id
    // are identical, but the live completion marker is authoritative.
    const prior = byId.get(normalized.id);
    if (!prior || item.source > prior.source) byId.set(normalized.id, { ...item, entry: normalized });
  }
  const ordered = [...byId.values()].sort(byEnqueueOrder);
  if (deliveredEntries.length > 0) acknowledgePendingMessages(sessionId, deliveredEntries);
  const visible = modelVisiblePendingMessages(ordered.map(({ entry }) => entry));
  // Epoch gate. Normalization above rebuilds every entry, but each copy
  // inherits the IMMUTABLE token the entry was accepted under. An entry from
  // an older epoch (a cross-process close/detach moved the generation while
  // it sat in memory) belongs to the previous owner: it is REJECTED here,
  // never restamped with the current epoch — which would legitimize it and
  // let a failed turn restore it into the new owner's queue.
  const lifecycleNow = pendingSessionLifecycle(sessionId);
  const accepted = [];
  let rejected = 0;
  for (const entry of visible) {
    const token = entryLifecycleToken(entry);
    if (token && (lifecycleNow.closed || lifecycleTokenStale(lifecycleNow, token))) {
      rejected += 1;
      continue;
    }
    accepted.push(entry);
  }
  if (rejected > 0) {
    pendingWarn(
      `[session] rejected ${rejected} queued message(s) from a superseded lifecycle epoch sessionId=${sessionId}\n`
    );
  }
  // Only materialize the ledger when there is an id to suppress: an empty
  // drain used to leave a dead Set behind on every call.
  const claimedIds = accepted.filter((entry) => entry.id);
  if (claimedIds.length > 0) {
    const inDelivery = pendingIdSet(_inDeliveryPendingIds, sessionId);
    for (const entry of claimedIds) inDelivery.add(entry.id);
  }
  // Keep the exact claimed payloads until ack (delivered) or release.
  claimPendingEntries(sessionId, accepted);
  return accepted;
}

// Snapshot queued entries without draining them. Compaction uses this to keep
// sidecars referenced by a message that is waiting for the next turn, whether
// it is still in memory, buffered for persistence, or already on disk.
export function _getPendingMessagesForSession(sessionId) {
  if (!isValidPendingSessionId(sessionId)) return [];
  const queued = [...(_sessionPendingMessages.get(sessionId) || []), ...(_pendingPersistBuffers.get(sessionId) || [])];
  // The not-yet-migrated global spool can still hold this session's rows.
  for (const path of [pendingMessagesPath(sessionId), legacyPendingMessagesPath()]) {
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    const persisted = normalizePendingStore(JSON.parse(raw)).sessions[sessionId];
    if (Array.isArray(persisted)) queued.push(...persisted);
  }
  return queued;
}

// Cleanup hook for closeSession — drop the in-memory queue and buffered-persist
// entry so both Maps do not accumulate one entry per closed session.
export function _dropPendingMessageState(id, { clearPersisted = true } = {}) {
  // Bumped FIRST: every write already in flight now belongs to a superseded
  // state generation and may neither requeue nor re-arm a retry after this
  // teardown. The detach re-persist below runs under the NEW generation, so
  // it keeps its own retry.
  bumpPendingStateEpoch(id);
  if (!clearPersisted) {
    const buffered = _pendingPersistBuffers.get(id);
    if (buffered?.length) {
      try {
        persistPendingMessages(id, buffered);
      } catch {
        /* ignore */
      }
    }
  }
  // Tombstoned close: the claim copies are dead (the session record itself
  // now refuses any restore). Detach keeps them so a still-in-flight ask can
  // release and restore its claimed entries after this cleanup runs.
  if (clearPersisted) _claimedPendingMessages.delete(id);
  _sessionPendingMessages.delete(id);
  _hydratedPendingMessages.delete(id);
  _pendingPersistBuffers.delete(id);
  try {
    cancelPendingPersistRetry(id, { resetBackoff: true });
  } catch {
    /* ignore */
  }
  _inDeliveryPendingIds.delete(id);
  _ackedPendingIds.delete(id);
  _pendingHydrations.delete(id);
  if (clearPersisted) {
    try {
      clearPersistedPendingMessages(id);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Shutdown drain (and test determinism seam): flush this module's buffered
 * persist batch and await its own async spool tails (persist / ack / clear)
 * plus in-flight hydrations, so a process may exit knowing every ACCEPTED
 * message reached the durable spool. Tails can re-chain (an ack chains behind
 * a persist), so this loops until the maps are empty, bounded by timeoutMs.
 *
 * Runtime-safe: the exit path gets a RESOLVED verdict — `true` when everything
 * settled, `false` when the budget expired (logged, never thrown), so a stuck
 * spool write can neither break nor hang a shutdown. Tests can opt into a
 * strict timeout through `throwOnTimeout`.
 *
 * @param {{ timeoutMs?: number, throwOnTimeout?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function settlePendingMessageWrites({ timeoutMs = 5000, throwOnTimeout = false } = {}) {
  try {
    await drainPendingMessageWrites(timeoutMs);
    return true;
  } catch (err) {
    if (throwOnTimeout) throw err;
    pendingWarn(`[session] pending-message shutdown drain incomplete: ${err?.message || err}\n`);
    return false;
  }
}

async function drainPendingMessageWrites(timeoutMs = 5000) {
  const budget = Math.max(0, Number(timeoutMs) || 0);
  const deadline = Date.now() + budget;
  const expired = () =>
    new Error(
      `pending-message writes did not settle within ${budget}ms ` +
        `(tails=${_pendingPersistTails.size}, hydrations=${_pendingHydrations.size}, buffers=${_pendingPersistBuffers.size})`
    );
  let timer = null;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(expired()), Math.max(0, deadline - Date.now()));
  });
  // Deliberately NOT unref'd: while settle waits on a stuck tail there may be
  // no other handle, and an unref'd timer would let the loop drain (the wait
  // would then never reject). The finally below always clears it.
  expiry.catch(() => {});
  try {
    for (;;) {
      // Snapshot BEFORE flushing: persistPendingMessages OVERWRITES this
      // session's map entry with the new operation, so an in-flight tail
      // captured only after the flush would be silently dropped and never
      // awaited. Both the pre-flush tails and the newly chained ones must
      // be awaited, and the loop repeats because acks/clears chain further
      // tails behind them.
      const preFlushTails = [..._pendingPersistTails.values()];
      flushPendingMessagePersistsSync();
      const inflight = new Set([...preFlushTails, ..._pendingPersistTails.values(), ..._pendingHydrations.values()]);
      if (inflight.size === 0 && _pendingPersistBuffers.size === 0) return;
      if (Date.now() > deadline) throw expired();
      // Raced against the absolute deadline: a never-settling tail must
      // reject within timeoutMs instead of blocking here forever.
      await Promise.race([Promise.allSettled([...inflight]), expiry]);
      await Promise.race([new Promise((resolve) => setImmediate(resolve)), expiry]);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// TEST-ONLY: publish a promise as this session's persist tail using the same
// set + self-removal pattern as persistPendingMessages, so settle tests can
// model a slow (or stuck) spool write deterministically. Runtime code never
// calls this and behavior is unchanged.
export function _setPendingPersistTailForTest(sessionId, promise) {
  return chainSpoolTail(
    sessionId,
    Promise.resolve(promise).catch(() => {})
  );
}
