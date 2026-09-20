// ingest/ordinal-state.mjs
// Untimestamped-repeat ordinal state, per session. `occNext[identity]` is the
// next FREE occurrence ordinal for a (role,content) identity in a session. It
// disambiguates textually identical UNTIMESTAMPED turns (a timestamped turn
// carries a durable ts and never needs it). Monotonic and
// compaction-independent so a genuine appended repeat lands ABOVE every
// already-persisted copy rather than colliding with one under
// ON CONFLICT DO NOTHING.
//
// In-memory only, LRU-bounded so it cannot grow without bound across session
// ids. Correctness does NOT depend on it surviving eviction or a restart: on a
// miss the high-water is rebuilt from the WeakMap of already-assigned ordinals
// for the messages STILL in the array (survivors advance occNext, so a following
// genuine append still lands above them), and any truly-cold walk falls back
// to POSITIONAL ordinals, which reproduce a fresh full/subset re-ingest exactly
// and therefore never mint a duplicate row.
//
// DURABILITY: a genuine untimestamped append arriving in a LATER (warm) call
// after a restart/eviction IS distinguishable from the cold-replay survivors —
// the cold replay seeded occNext = survivor-count T, but the DB holds K>T
// persisted copies, so a warm first-seen turn drawing T would silently collide.
// `state.durable` (identity hash → next-ordinal, persisted per session for
// untimestamped identities that reached occurrence>0) restores that K: a WARM
// first-seen untimestamped turn draws max(occNext, durableK). The COLD
// positional replay path is NOT consulted for durable, so a fresh full/subset
// re-ingest stays pure-positional and dedupes even with a stale or deleted
// state file. The only residual (unavoidable) collapse is an identical append
// that is ALREADY inside the cold-replay array on a compacted restart —
// indistinguishable from a survivor; it never DUPLICATES.
import crypto from 'node:crypto';

const ORDINAL_STATE_MAX_SESSIONS = 2048;

// Short, content-derived key for the durable untimestamped high-water map so
// the persisted blob stores a fixed-width hash per duplicate identity rather
// than raw (possibly large) message content.
export function identityHash(occKey) {
  return crypto.createHash('sha256').update(occKey).digest('hex').slice(0, 24);
}

export function createOrdinalStore({ loadOrdinalHighWater, saveOrdinalHighWater, log }) {
  const states = new Map();
  // Ordinal assigned to a given session-message OBJECT at first sight, reused
  // on later hydrates while the live array survives. Resume/reopen JSON-parses
  // a new object graph even when this memory runtime remains warm, so object
  // identity is only the fast/strong signal; the ordered snapshot fallback
  // (createPriorSnapshotMatcher) handles cloned transcript replays.
  const messageOrdinal = new WeakMap();

  // Touch (LRU) + create-on-miss. Re-inserting on a hit moves the entry to the
  // Map tail; when the cap is exceeded the oldest (head) session is evicted.
  // Eviction is safe because the state is reconstructible (see above).
  function touch(sessionId) {
    const existing = states.get(sessionId);
    if (existing) {
      states.delete(sessionId);
      states.set(sessionId, existing);
      return existing;
    }
    const st = { occNext: new Map(), seeded: false, snapshot: [] };
    states.set(sessionId, st);
    while (states.size > ORDINAL_STATE_MAX_SESSIONS) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
    return st;
  }

  // Assign/reuse the occurrence ordinal for message `m` under identity `occKey`.
  // A re-presented object reuses its recorded ordinal AND advances the session
  // high-water past it (rebuilding occNext from survivors after an eviction);
  // a first-seen object consumes the next free ordinal and records it. `floor`
  // (>0 only for a WARM first-seen untimestamped turn) lifts a genuine
  // post-restart/eviction append above the durable persisted high-water even
  // when the cold replay only counted the survivors currently in the array.
  function assignOccurrence(occNext, occKey, m, floor = 0) {
    if (messageOrdinal.has(m)) {
      const ord = messageOrdinal.get(m);
      if (ord + 1 > (occNext.get(occKey) ?? 0)) occNext.set(occKey, ord + 1);
      return ord;
    }
    let ord = occNext.get(occKey) ?? 0;
    if (floor > ord) ord = floor;
    occNext.set(occKey, ord + 1);
    messageOrdinal.set(m, ord);
    return ord;
  }

  // Reuse an occurrence recovered from the previous ingest's content/order
  // snapshot. Session resume/reopen JSON-parses the transcript, so every row is
  // a fresh object even while the long-lived memory runtime (and its WeakMaps)
  // stays warm. Object identity alone therefore misclassified a cloned replay
  // as newly appended history and minted a new source_ref for every old turn.
  function reuseOccurrence(occNext, occKey, m, occurrence) {
    const ord = Math.max(0, Math.floor(Number(occurrence) || 0));
    if (ord + 1 > (occNext.get(occKey) ?? 0)) occNext.set(occKey, ord + 1);
    messageOrdinal.set(m, ord);
    return ord;
  }

  /** Load the durable high-water once per (re)established state; on LRU
   *  eviction the state is dropped and reloaded here, so the high-water
   *  survives eviction too. Best-effort. */
  async function ensureDurableLoaded(state, sessionId) {
    if (state.durableLoaded) return;
    state.durable = new Map();
    try {
      const raw = await loadOrdinalHighWater(sessionId);
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) state.durable.set(k, Math.floor(n));
        }
      }
    } catch {
      /* absent/corrupt state file → in-memory only (invariant 2 safe) */
    }
    state.durableLoaded = true;
  }

  /** Write-behind persist of the durable untimestamped high-water. Not awaited:
   *  ingest latency is unchanged and a persist failure only degrades a rare
   *  post-restart append (never correctness of THIS call). Serialized per
   *  session by the ingest chain, so writes cannot interleave for one session. */
  function persistDurable(state, sessionId) {
    if (!state.dirty) return;
    state.dirty = false;
    const snapshot = Object.fromEntries(state.durable);
    Promise.resolve()
      .then(() => saveOrdinalHighWater(sessionId, snapshot))
      .catch((err) => log(`[ingest] untimestamped high-water persist failed: ${err?.message || err}\n`));
  }

  return {
    touch,
    assignOccurrence,
    reuseOccurrence,
    hasOrdinal: (m) => messageOrdinal.has(m),
    ensureDurableLoaded,
    persistDurable,
  };
}

/** Content/order fallback for JSON-cloned transcript replays. The previous
 *  eligible sequence is indexed by a stable base source key; a greedy forward
 *  subsequence match recognizes unchanged prefixes, compacted survivors, and
 *  appended suffixes in O(n). Same-object rows keep the stronger WeakMap
 *  occurrence and advance the cursor to that exact prior occurrence. Unmatched
 *  rows alone consume the historical high-water, so a genuine append remains
 *  distinct while a reopen/reload stays idempotent. */
export function createPriorSnapshotMatcher(snapshot) {
  const priorSnapshot = Array.isArray(snapshot) ? snapshot : [];
  const priorByKey = new Map();
  for (let i = 0; i < priorSnapshot.length; i += 1) {
    const item = priorSnapshot[i];
    if (!item?.key) continue;
    if (!priorByKey.has(item.key)) priorByKey.set(item.key, []);
    priorByKey.get(item.key).push({ index: i, occurrence: item.occurrence });
  }
  const priorPointers = new Map();
  let priorCursor = 0;
  return (key, wantedOccurrence = null) => {
    const list = priorByKey.get(key);
    if (!list?.length) return null;
    let p = priorPointers.get(key) ?? 0;
    while (p < list.length && list[p].index < priorCursor) p += 1;
    if (wantedOccurrence != null) {
      while (p < list.length && list[p].index >= priorCursor && Number(list[p].occurrence) !== Number(wantedOccurrence))
        p += 1;
    }
    if (p >= list.length) {
      priorPointers.set(key, p);
      return null;
    }
    const match = list[p];
    priorPointers.set(key, p + 1);
    priorCursor = match.index + 1;
    return match;
  };
}
