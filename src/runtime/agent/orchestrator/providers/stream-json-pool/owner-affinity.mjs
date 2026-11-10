/**
 * stream-json-pool/owner-affinity.mjs — owner → worker affinity with a
 * refcount of in-flight work. An owner with work in flight is NEVER evicted,
 * because moving a live stream to another worker is exactly what reorders
 * it; only idle metadata is pruned at the soft cap.
 *
 * A hold is taken when a submission ENTERS the pool — before it waits behind
 * its stream's FIFO tail, before it is queued for backpressure and before
 * any worker owns it — and released when that submission settles. An owner
 * with queued OR in-flight work therefore has `active > 0` for the whole
 * window, so neither pruning nor a drainWaiting() burst can move a live
 * stream to a different worker between its chunks.
 */
export function createOwnerAffinities({ idleMax }) {
  // owner -> { slot, active }
  const owners = new Map();
  // Explicit transport-lifetime holds. A stream can be active while waiting
  // for its next network chunk, when no pool task exists to carry the normal
  // per-submission hold. The transport retains once and releases in finally.
  const retainedStreams = new Map();

  /** Drop only IDLE affinity entries when the soft cap is reached. */
  function prune() {
    if (owners.size < idleMax) return;
    for (const [owner, entry] of owners) {
      if (entry.active > 0) continue;
      owners.delete(owner);
      if (owners.size < idleMax) return;
    }
  }

  function acquire(owner) {
    if (!owner) return null;
    let entry = owners.get(owner);
    if (!entry) {
      prune();
      entry = { slot: null, active: 0 };
      owners.set(owner, entry);
    }
    entry.active += 1;
    return entry;
  }

  function release(entry) {
    if (!entry) return;
    entry.active = Math.max(0, entry.active - 1);
    // Settlement is itself a pruning opportunity: metadata that just went
    // idle is reclaimed here, so a finished fan-out burst does not leave
    // the map above its cap until some unrelated owner happens to arrive.
    if (entry.active === 0) prune();
  }

  function releaseWhenSettled(entry, result) {
    if (!entry) return result;
    if (!result || typeof result.then !== 'function') {
      release(entry);
      return result;
    }
    result.then(
      () => release(entry),
      () => release(entry)
    );
    return result;
  }

  /** Run one submission under an affinity hold spanning its whole lifetime. */
  function underHold(owner, needsHold, produce) {
    const entry = needsHold ? acquire(owner) : null;
    if (!entry) return produce();
    let result;
    try {
      result = produce();
    } catch (error) {
      release(entry);
      throw error;
    }
    return releaseWhenSettled(entry, result);
  }

  function retainStream(key, owner) {
    if (retainedStreams.has(key)) return true;
    const entry = acquire(owner);
    if (!entry) return false;
    retainedStreams.set(key, entry);
    return true;
  }

  function releaseStream(key) {
    const entry = retainedStreams.get(key);
    if (!entry) return;
    retainedStreams.delete(key);
    release(entry);
  }

  return {
    acquire,
    release,
    underHold,
    retainStream,
    releaseStream,
    entryFor: (owner) => (owner ? owners.get(owner) : null),
    // Keep the entry — its refcount tracks live queued/in-flight work. Only
    // the dead slot pointer is dropped, so the next chunk re-picks a worker
    // while the owner's hold stays intact.
    forgetSlot(slot) {
      for (const entry of owners.values()) {
        if (entry.slot === slot) entry.slot = null;
      }
    },
    get size() {
      return owners.size;
    },
    get retainedCount() {
      return retainedStreams.size;
    },
    clear() {
      retainedStreams.clear();
      owners.clear();
    },
  };
}
