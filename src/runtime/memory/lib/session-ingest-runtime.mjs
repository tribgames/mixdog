// Session ingest runtime extracted from index.mjs.
//
// The stateful ingest cluster: per-session serialization chains, the WeakMap
// identity-fields cache, the post-ingest raw-embedding flush chain, and the
// ingest_session entrypoint. Pure helpers (role normalization, source-ref
// hashing, turn allocation, text cleaning) and flushRawEmbeddings are imported
// directly; the live DB handle, log sink, and parseTsToMs (owned by the
// transcript-ingest instance) are injected so this module holds only the
// ingest-local chains/caches and the facade keeps ownership of `db`.

import {
  normalizeIngestRole,
  stableSessionSourceRef,
  createIngestTurnAllocator,
  sessionMessageContentForIngest,
  shouldExcludeIngestMessage,
} from './session-ingest.mjs'
import { cleanMemoryText } from './memory.mjs'
import { flushRawEmbeddings } from './memory-cycle.mjs'
import { resolveProjectScope } from './project-id-resolver.mjs'
import crypto from 'node:crypto'

// Ingest now WAITS for its embedding flush (bounded) so freshly ingested rows
// are dense-searchable the moment ingest_session returns. On a cold ONNX
// model the flush can stall on warmup; the race below caps the wait and lets
// the flush finish in the background (tick fallback still sweeps stragglers).
const INGEST_EMBED_WAIT_MS = 15_000

// Short, content-derived key for the durable untimestamped high-water map so the
// persisted blob stores a fixed-width hash per duplicate identity rather than raw
// (possibly large) message content.
function _identityHash(occKey) {
  return crypto.createHash('sha256').update(occKey).digest('hex').slice(0, 24)
}

export function createSessionIngestRuntime({
  getDb,
  log,
  parseTsToMs,
  // Durable per-session untimestamped high-water store (reviewer item 1). Injected
  // by the facade (DB `meta` kv). Defaults to no-op so the runtime still works
  // (in-memory only) when a caller does not wire durability.
  loadOrdinalHighWater = async () => null,
  saveOrdinalHighWater = async () => {},
}) {
  // Post-ingest raw-embedding flush chain (facade-local). The checkCycles tick
  // keeps its OWN independent guard inside the scheduler; this chain serializes
  // flushes kicked from ingestSessionMessages so ingest bursts never stack
  // embedding work, while still guaranteeing every ingest's rows get their own
  // flush pass (the old boolean guard silently SKIPPED bursts, leaving rows
  // embedding-less until the ~60s tick — a recall (no results) window).
  let _rawEmbedFlushChain = Promise.resolve()
  // Per-session ingest serialization. Concurrent ingest_session calls for the
  // SAME session raced on MAX(source_turn) → duplicate turn allocation. Chain
  // same-session ingests so the MAX read + insert loop for one session never
  // overlaps another for the same session. Different sessions stay parallel.
  const _ingestSessionChains = new Map()
  // ── Untimestamped-repeat ordinal state (per session) ──────────────────────
  // `occNext[identity]` = next FREE occurrence ordinal assigned for a
  // (role,content) identity in this session. It disambiguates textually
  // identical UNTIMESTAMPED turns (a timestamped turn carries a durable ts and
  // never needs it). Monotonic and compaction-independent so a genuine appended
  // repeat lands ABOVE every already-persisted copy rather than colliding with
  // one under ON CONFLICT DO NOTHING.
  //
  // In-memory only, LRU-bounded (_touchOrdinalState) so it cannot grow without
  // bound across session ids. Correctness does NOT depend on it surviving
  // eviction or a process restart: on a miss the high-water is rebuilt from the
  // WeakMap of already-assigned ordinals for the messages STILL in the array
  // (survivors advance occNext, so a following genuine append still lands above
  // them — this is what makes LRU eviction safe mid-session), and any truly-cold
  // walk falls back to POSITIONAL ordinals, which reproduce a fresh full/subset
  // re-ingest exactly and therefore never mint a duplicate row. See the
  // DURABILITY note at the assignment site for why a persisted high-water cannot
  // recover more than this for indistinguishable untimestamped identicals.
  const _sessionIngestOrdinalState = new Map()
  const _ORDINAL_STATE_MAX_SESSIONS = 2048
  // Touch (LRU) + create-on-miss. Re-inserting on a hit moves the entry to the
  // Map tail; when the cap is exceeded the oldest (head) session is evicted.
  // Eviction is safe because the state is reconstructible (see above).
  function _touchOrdinalState(sessionId) {
    const existing = _sessionIngestOrdinalState.get(sessionId)
    if (existing) {
      _sessionIngestOrdinalState.delete(sessionId)
      _sessionIngestOrdinalState.set(sessionId, existing)
      return existing
    }
    const st = { occNext: new Map(), seeded: false, snapshot: [] }
    _sessionIngestOrdinalState.set(sessionId, st)
    while (_sessionIngestOrdinalState.size > _ORDINAL_STATE_MAX_SESSIONS) {
      const oldest = _sessionIngestOrdinalState.keys().next().value
      if (oldest === undefined) break
      _sessionIngestOrdinalState.delete(oldest)
    }
    return st
  }
  // Ordinal assigned to a given session-message OBJECT at first sight, reused on
  // later hydrates while the live array survives. Resume/reopen JSON-parses a new
  // object graph even when this memory runtime remains warm, so object identity
  // is only the fast/strong signal; the ordered snapshot fallback below handles
  // cloned transcript replays.
  const _ingestedMessageOrdinal = new WeakMap()
  // Assign/reuse the occurrence ordinal for message `m` under identity `occKey`.
  // A re-presented object reuses its recorded ordinal AND advances the session
  // high-water past it (rebuilding occNext from survivors after an eviction);
  // a first-seen object consumes the next free ordinal and records it. `floor`
  // (>0 only for a WARM first-seen untimestamped turn) lifts a genuine
  // post-restart/eviction append above the durable persisted high-water even when
  // the cold replay only counted the survivors currently in the array.
  function _assignOccurrence(occNext, occKey, m, floor = 0) {
    if (_ingestedMessageOrdinal.has(m)) {
      const ord = _ingestedMessageOrdinal.get(m)
      if (ord + 1 > (occNext.get(occKey) ?? 0)) occNext.set(occKey, ord + 1)
      return ord
    }
    let ord = occNext.get(occKey) ?? 0
    if (floor > ord) ord = floor
    occNext.set(occKey, ord + 1)
    _ingestedMessageOrdinal.set(m, ord)
    return ord
  }
  // Reuse an occurrence recovered from the previous ingest's content/order
  // snapshot. Session resume/reopen JSON-parses the transcript, so every row is
  // a fresh object even while the long-lived memory runtime (and its WeakMaps)
  // stays warm. Object identity alone therefore misclassified a cloned replay
  // as newly appended history and minted a new source_ref for every old turn.
  function _reuseOccurrence(occNext, occKey, m, occurrence) {
    const ord = Math.max(0, Math.floor(Number(occurrence) || 0))
    if (ord + 1 > (occNext.get(occKey) ?? 0)) occNext.set(occKey, ord + 1)
    _ingestedMessageOrdinal.set(m, ord)
    return ord
  }
  // Cache of (role, cleaned content) per session message OBJECT, keyed by
  // identity (WeakMap — entries vanish once the message is GC'd, e.g. after
  // compaction or JSON reload replaces the array). Live-array steady-state calls
  // reuse the cache; cloned replays recompute once and then reconcile against the
  // ordered snapshot.
  const _ingestIdentityFieldsCache = new WeakMap()
  // Return { role, content } for a session message's dedup identity, or null if
  // the message would be skipped by ingest (no role / excluded / empty content
  // after cleaning). Cached per message object so repeated calls over the same
  // (unchanged) transcript prefix never re-run the expensive clean/normalize
  // regex pipeline.
  function _ingestIdentityFields(m) {
    if (_ingestIdentityFieldsCache.has(m)) return _ingestIdentityFieldsCache.get(m)
    let fields = null
    const role = normalizeIngestRole(m.role)
    if (role && !shouldExcludeIngestMessage(m)) {
      const content = cleanMemoryText(sessionMessageContentForIngest(m))
      if (content && content.trim()) fields = { role, content }
    }
    _ingestIdentityFieldsCache.set(m, fields)
    return fields
  }

  async function ingestSessionMessages(args = {}) {
    const sessionId = String(args.sessionId || args.session_id || `session-${Date.now()}`).trim()
    // Serialize per-session so the MAX(source_turn) read + insert loop for one
    // session never overlaps a concurrent ingest for the SAME session (they
    // otherwise race the turn allocator and double-allocate). Distinct sessions
    // run in parallel.
    const prev = _ingestSessionChains.get(sessionId) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(() => _ingestSessionMessagesImpl(sessionId, args))
    _ingestSessionChains.set(sessionId, run.catch(() => {}))
    const tail = _ingestSessionChains.get(sessionId)
    try {
      return await run
    } finally {
      // Best-effort GC: drop the map entry only if no later call chained after us.
      if (_ingestSessionChains.get(sessionId) === tail) _ingestSessionChains.delete(sessionId)
    }
  }

  async function _ingestSessionMessagesImpl(sessionId, args = {}) {
    const db = getDb()
    const messages = Array.isArray(args.messages) ? args.messages : []
    // Recall fast-track hydrates the current session before compaction; allow
    // callers to ingest the full in-memory transcript instead of silently
    // clipping long sessions at 500 turns. Default remains conservative.
    const limit = Math.max(1, Math.min(5000, Number(args.limit) || 200))
    const start = Math.max(0, messages.length - limit)
    const projectId = resolveProjectScope(typeof args.cwd === 'string' && args.cwd ? args.cwd : null)
    let considered = 0
    let inserted = 0
    // Ids of rows THIS call actually inserted (ON CONFLICT skips return no id).
    // The post-ingest flush is scoped to exactly these so ingest_session never
    // synchronously inherits other calls'/sessions' raw-embedding backlog.
    const insertedIds = []
    // Monotonic ingest order, independent of the current (post-compaction)
    // array index. source_turn used to be `i+1`, but after compaction shrinks /
    // reindexes session.messages a NEWLY appended turn gets a LOW i and thus a
    // LOW source_turn — and since dump_session_roots / recall order by
    // source_turn first, it would sort BEFORE older pre-compaction rows. Seed a
    // running counter from the current max source_turn for this session so every
    // new row is assigned a turn strictly greater than all previously-ingested
    // ones (true continuation order). Re-ingested (ON CONFLICT) rows keep their
    // original turn and do not consume a new one.
    let prevMaxTurn = 0
    try {
      const maxRow = await db.query(
        `SELECT COALESCE(MAX(source_turn), 0) AS max_turn FROM entries WHERE session_id = $1`,
        [sessionId],
      )
      prevMaxTurn = Number(maxRow.rows?.[0]?.max_turn) || 0
    } catch { prevMaxTurn = 0 }
    const turnAllocator = createIngestTurnAllocator(prevMaxTurn)
    // ── Untimestamped-repeat ordinal: re-ingest vs genuine-append distinction ─
    // The ordinal folded into stableSessionSourceRef must satisfy BOTH: a
    // full/subset re-ingest of the SAME messages reproduces the exact ordinal →
    // same source_ref → ON CONFLICT dedupes; and a genuinely NEW untimestamped
    // turn appended after compaction dropped an earlier identical copy lands on a
    // FREE ordinal above every persisted copy (else it reproduces a persisted
    // ordinal and is silently dropped).
    //
    // Rule (see module-level notes on _assignOccurrence): a re-presented message
    // (same object) reuses its recorded ordinal AND advances the session
    // high-water; a first-seen turn takes the next free high-water ordinal, so an
    // appended identical turn lands above every persisted copy (invariant 1). On
    // a fresh/evicted/restarted state the prefix [0,start) is replayed ONCE to
    // rebuild occNext (positional + any surviving recorded ordinals) so a SUBSET
    // re-ingest reproduces the refs a full re-ingest would (invariants 2 & 3); a
    // warm state skips the replay, keeping steady-state ingest O(new messages)
    // (invariant 4).
    //
    // DURABILITY (reviewer item 1): a genuine untimestamped append arriving in a
    // LATER (warm) call after a restart/eviction IS distinguishable from the
    // cold-replay survivors — the cold replay seeded occNext = survivor-count T,
    // but the DB holds K>T persisted copies, so a warm first-seen turn drawing T
    // would silently collide. `ordinalState.durable` (hash → next-ordinal,
    // persisted per session for untimestamped identities that reached
    // occurrence>0) restores that K: a WARM first-seen untimestamped turn draws
    // max(occNext, durableK) so it lands ABOVE every persisted copy. The COLD
    // positional replay path is NOT consulted for durable (floor=0 there), so a
    // fresh full/subset re-ingest stays pure-positional and dedupes even with a
    // stale or deleted state file (invariants 2 & 3 hold). The only residual
    // (unavoidable) collapse is an identical append that is ALREADY inside the
    // cold-replay array on a compacted restart — indistinguishable from a
    // survivor (identical content, no per-message id); it never DUPLICATES.
    const ordinalState = _touchOrdinalState(sessionId)
    const occNext = ordinalState.occNext
    // A first-seen turn is a genuine new append (eligible for the durable floor)
    // only in a WARM call — one whose ordinal state was already established by an
    // earlier ingest. In the establishing (cold) call every array message is
    // positional-replayed, so the floor must NOT apply.
    const warmCall = ordinalState.seeded
    if (!ordinalState.durableLoaded) {
      // Load once per (re)established state; on LRU eviction the state is dropped
      // and reloaded here, so the high-water survives eviction too. Best-effort.
      ordinalState.durable = new Map()
      try {
        const raw = await loadOrdinalHighWater(sessionId)
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw)) {
            const n = Number(v)
            if (Number.isFinite(n) && n > 0) ordinalState.durable.set(k, Math.floor(n))
          }
        }
      } catch { /* absent/corrupt state file → in-memory only (invariant 2 safe) */ }
      ordinalState.durableLoaded = true
    }
    // Content/order fallback for JSON-cloned transcript replays. The previous
    // eligible sequence is indexed by a stable base source key; a greedy
    // forward subsequence match recognizes unchanged prefixes, compacted
    // survivors, and appended suffixes in O(n). Same-object rows keep the
    // stronger WeakMap occurrence and advance the cursor to that exact prior
    // occurrence. Unmatched rows alone consume the historical high-water, so a
    // genuine append remains distinct while a reopen/reload stays idempotent.
    const priorSnapshot = Array.isArray(ordinalState.snapshot) ? ordinalState.snapshot : []
    const priorByKey = new Map()
    for (let i = 0; i < priorSnapshot.length; i += 1) {
      const item = priorSnapshot[i]
      if (!item?.key) continue
      if (!priorByKey.has(item.key)) priorByKey.set(item.key, [])
      priorByKey.get(item.key).push({ index: i, occurrence: item.occurrence })
    }
    const priorPointers = new Map()
    let priorCursor = 0
    const takePrior = (key, wantedOccurrence = null) => {
      const list = priorByKey.get(key)
      if (!list?.length) return null
      let p = priorPointers.get(key) ?? 0
      while (p < list.length && list[p].index < priorCursor) p += 1
      if (wantedOccurrence != null) {
        while (p < list.length
          && list[p].index >= priorCursor
          && Number(list[p].occurrence) !== Number(wantedOccurrence)) p += 1
      }
      if (p >= list.length) {
        priorPointers.set(key, p)
        return null
      }
      const match = list[p]
      priorPointers.set(key, p + 1)
      priorCursor = match.index + 1
      return match
    }
    const currentSnapshot = []
    const prepared = []
    for (let i = 0; i < messages.length; i += 1) {
      const m = messages[i]
      if (!m || typeof m !== 'object') continue
      const fields = _ingestIdentityFields(m)
      if (!fields) continue
      const { role, content } = fields
      const occKey = `${role}\u0000${content}`
      const rawTs = m.ts ?? m.timestamp
      const untimestamped = !((typeof rawTs === 'number' && Number.isFinite(rawTs))
        || (typeof rawTs === 'string' && rawTs.trim()))
      const idHash = untimestamped ? _identityHash(occKey) : null
      // occurrence=0 makes a stable match key: timestamp/tool ids remain part
      // of the key, while repeated untimestamped text shares a key and is
      // disambiguated by ordered snapshot occurrences.
      const snapshotKey = stableSessionSourceRef(sessionId, m, role, content, 0)
      let occurrence
      if (_ingestedMessageOrdinal.has(m)) {
        occurrence = _assignOccurrence(occNext, occKey, m)
        takePrior(snapshotKey, occurrence)
      } else {
        const prior = takePrior(snapshotKey)
        if (prior) {
          occurrence = _reuseOccurrence(occNext, occKey, m, prior.occurrence)
        } else {
          const floor = (warmCall && untimestamped) ? (ordinalState.durable.get(idHash) ?? 0) : 0
          occurrence = _assignOccurrence(occNext, occKey, m, floor)
        }
      }
      if (untimestamped && occurrence >= 1) {
        // Duplicate untimestamped identity (occurrence>0): record/raise its durable
        // next-ordinal (write-behind persisted below). Monotonic — never regresses
        // a loaded K, so a cold replay counting only survivors can't shrink it.
        const cur = ordinalState.durable.get(idHash) ?? 0
        if (occurrence + 1 > cur) { ordinalState.durable.set(idHash, occurrence + 1); ordinalState.dirty = true }
      }
      currentSnapshot.push({ key: snapshotKey, occurrence })
      if (i >= start) {
        considered += 1
        prepared.push({ m, role, content, occurrence, index: i })
      }
    }
    ordinalState.snapshot = currentSnapshot
    ordinalState.seeded = true
    for (const { m, role, content, occurrence, index } of prepared) {
      const tsMs = parseTsToMs(m.ts ?? m.timestamp ?? (Date.now() - (messages.length - index)))
      // Assign the next monotonic turn BEFORE building the source_ref so identical
      // untimestamped repeats get distinct identities (peekNext is stable until a
      // row is actually inserted → next()).
      const assignedTurn = turnAllocator.peekNext()
      // Stable per-message identity. The previous `session:${id}#${i+1}` key was
      // positional, so after compaction shrinks/reindexes session.messages a
      // later turn could reuse an old index and be silently skipped by
      // ON CONFLICT DO NOTHING. stableSessionSourceRef hashes only durable
      // fields (role, original ts if present, tool ids, content) — never the
      // synthesized tsMs fallback or the loop index. For untimestamped turns the
      // monotonic ordinal is folded in so genuine repeats persist (not collapsed).
      const sourceRef = stableSessionSourceRef(sessionId, m, role, content, occurrence)
      const result = await db.query(`
        INSERT INTO entries(ts, role, content, source_ref, session_id, source_turn, project_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [tsMs, role, content, sourceRef, sessionId, assignedTurn, projectId])
      const rowInserted = Number(result.rowCount ?? result.affectedRows ?? 0) || 0
      if (rowInserted > 0) {
        inserted += rowInserted
        const newId = result.rows?.[0]?.id
        if (newId != null && Number.isFinite(Number(newId))) insertedIds.push(Number(newId))
        turnAllocator.next()
      }
    }
    // Write-behind persist of the durable untimestamped high-water. Not awaited:
    // ingest latency is unchanged and a persist failure only degrades a rare
    // post-restart append (never correctness of THIS call). Serialized per
    // session by the chain, so writes cannot interleave for one session.
    if (ordinalState.dirty) {
      ordinalState.dirty = false
      const snapshot = Object.fromEntries(ordinalState.durable)
      Promise.resolve()
        .then(() => saveOrdinalHighWater(sessionId, snapshot))
        .catch((err) => log(`[ingest] untimestamped high-water persist failed: ${err?.message || err}\n`))
    }
    // Always-on post-ingest raw embedding: freshly ingested rows become
    // dense-searchable immediately (autoclear/recall-fasttrack hydration,
    // recall empty-fallback), without waiting for cycle1 chunking or the
    // ~60s background tick. Local ONNX only — no LLM cost, so it runs
    // regardless of the recap toggle.
    //
    // Two-tier flush so ingest never synchronously inherits OTHER calls'/
    // sessions' raw-embedding backlog:
    //  1) AWAITED (bounded) — scoped to exactly THIS call's insertedIds, so
    //     ingest_session resolves once its own rows are embedded and an
    //     immediately following recall sees them in the dense leg. A 15s cap
    //     keeps a cold ONNX warmup from wedging ingest. Id-scoped, so
    //     concurrent ingests embed disjoint row sets (SKIP LOCKED) without
    //     stacking redundant work — no chain serialization needed here.
    //  2) BACKGROUND (not awaited) — an unscoped sweep of any PRE-EXISTING
    //     backlog (rows left by earlier calls / other sessions / the flush
    //     cap). Serialized on _rawEmbedFlushChain so bursts don't stack full
    //     backlog scans; the ~60s tick still sweeps whatever this misses.
    if (insertedIds.length > 0) {
      const runOwnFlush = () => flushRawEmbeddings(db, { limit: 200, ids: insertedIds })
        .then((r) => {
          if (r.attempted > 0) log(`[embed] post-ingest raw flush (own) attempted=${r.attempted} embedded=${r.embedded}\n`)
          return r
        })
        .catch((err) => log(`[embed] post-ingest raw flush failed: ${err?.message || err}\n`))
      // Clear/manual-compact path opts out (embedWait:false): those rows are
      // about to be summarized away, so dense-search immediacy is pointless and
      // the bounded wait would only delay compaction. Enqueue the flush onto
      // _rawEmbedFlushChain (append, don't await) so clear-path ingest bursts
      // stay serialized like the backlog sweep — never running concurrent raw
      // flushes. All other callers keep the awaited (bounded) wait so a
      // following recall sees the rows.
      if (args.embedWait === false) {
        _rawEmbedFlushChain = _rawEmbedFlushChain
          .catch(() => {})
          .then(runOwnFlush)
          .catch(() => {})
      } else {
        let timer
        await Promise.race([
          runOwnFlush(),
          new Promise((resolve) => { timer = setTimeout(resolve, INGEST_EMBED_WAIT_MS) }),
        ]).finally(() => clearTimeout(timer))
      }
    }
    // Background backlog sweep — kicked, never awaited. Runs even when THIS
    // call inserted 0 rows, so pre-existing backlog is not left waiting for
    // the next scheduler tick.
    _rawEmbedFlushChain = _rawEmbedFlushChain
      .catch(() => {}) // never let a previous flush failure poison the chain
      .then(() => flushRawEmbeddings(db, { limit: 200 }))
      .then((r) => {
        if (r.attempted > 0) log(`[embed] post-ingest raw flush (backlog) attempted=${r.attempted} embedded=${r.embedded}\n`)
        return r
      })
      .catch((err) => log(`[embed] post-ingest raw backlog flush failed: ${err?.message || err}\n`))
    return { text: `ingest_session: considered=${considered} inserted=${inserted} session=${sessionId}` }
  }

  return { ingestSessionMessages }
}
