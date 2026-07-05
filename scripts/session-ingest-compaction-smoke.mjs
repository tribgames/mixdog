#!/usr/bin/env node
// Compaction-append collision smoke for the session-ingest RUNTIME (not just
// the pure helpers). Reproduces the silent-drop bug: after compaction removes an
// earlier identical untimestamped message from the in-memory array, a newly
// APPENDED identical message used to reproduce an already-persisted ordinal →
// same source_ref → INSERT ... ON CONFLICT DO NOTHING silently dropped it.
//
// Proves, against an in-memory fake DB that enforces the source_ref uniqueness
// the real ON CONFLICT relies on:
//   (1) post-compaction appended untimestamped identical msg → NEW row;
//   (2) full identical re-ingest in a FRESH runtime (rows already in DB) → 0 dups;
//   (3) subset re-ingest reproduces the same source_refs as a full re-ingest.
import { createSessionIngestRuntime } from '../src/runtime/memory/lib/session-ingest-runtime.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// Minimal fake DB. Only the two statements the ingest loop issues are modelled:
//   • SELECT COALESCE(MAX(source_turn) ...)  → per-session max
//   • INSERT INTO entries(...) ON CONFLICT DO NOTHING → dedupe on source_ref
// Any other query (the post-ingest raw-embedding flush's schema calls) returns
// an empty result; flushRawEmbeddings then hits `db._pool` (undefined) and its
// error is swallowed by the runtime, so the smoke never blocks on embeddings.
function createFakeDb() {
  const rows = [] // { ts, role, content, source_ref, session_id, source_turn, project_id }
  const bySourceRef = new Set()
  let nextId = 1
  return {
    rows,
    async query(sql, params = []) {
      if (/MAX\(source_turn\)/.test(sql)) {
        const sessionId = params[0]
        let max = 0
        for (const r of rows) if (r.session_id === sessionId && r.source_turn > max) max = r.source_turn
        return { rows: [{ max_turn: max }] }
      }
      if (/INSERT INTO entries/.test(sql)) {
        const [ts, role, content, source_ref, session_id, source_turn, project_id] = params
        if (bySourceRef.has(source_ref)) return { rowCount: 0 } // ON CONFLICT DO NOTHING
        bySourceRef.add(source_ref)
        rows.push({ id: nextId++, ts, role, content, source_ref, session_id, source_turn, project_id })
        return { rowCount: 1 }
      }
      return { rows: [] }
    },
  }
}

// Durable high-water store fake (mirrors the DB `meta` kv the facade wires). A
// SHARED store passed to two runtime instances simulates the state file
// surviving a process restart; an absent store simulates a deleted state file.
function makeRuntime(db, durable = new Map()) {
  return createSessionIngestRuntime({
    getDb: () => db,
    log: () => {},
    parseTsToMs: (v) => (typeof v === 'number' ? v : Number(v) || 0),
    loadOrdinalHighWater: async (sessionId) => durable.get(sessionId) ?? null,
    saveOrdinalHighWater: (sessionId, obj) => { durable.set(sessionId, obj); },
  })
}

const SESSION = 'compaction-smoke-sess'
// Untimestamped identical turns (no ts/timestamp → ordinal is what disambiguates).
const mk = (role, content) => ({ role, content })

// ── Scenario: live process ingests, compaction drops an earlier copy, append ──
const db = createFakeDb()
const rt = makeRuntime(db)

// Distinct object identities so compaction survival is by-reference (mirrors the
// runtime's immutable-transcript assumption).
const other1 = mk('assistant', 'sure, working on it')
const dupA = mk('user', 'run it again') // 1st identical untimestamped turn
const other2 = mk('assistant', 'done')
const dupB = mk('user', 'run it again') // 2nd identical untimestamped turn (distinct object)

// Call 1 (COLD): full array with two identical untimestamped user turns.
const arr1 = [other1, dupA, other2, dupB]
let r1 = await rt.ingestSessionMessages({ sessionId: SESSION, messages: arr1, limit: 5000 })
const userRows1 = db.rows.filter(r => r.role === 'user' && r.content === 'run it again')
assert(userRows1.length === 2, `cold ingest must persist BOTH identical untimestamped turns (got ${userRows1.length})`)
const refDupA = userRows1[0].source_ref
const refDupB = userRows1[1].source_ref
assert(refDupA !== refDupB, 'the two identical untimestamped turns must persist under distinct source_refs')

// Compaction: drop the FIRST identical copy (dupA) and some other rows; KEEP the
// second identical copy object (dupB) — this is what makes the array position of
// the surviving/new identical turn shift down onto an already-persisted ordinal.
// Then APPEND a genuinely new identical turn (distinct object).
const dupC = mk('user', 'run it again') // NEW appended identical turn
const arr2 = [dupB, mk('assistant', 'ok next'), dupC]

// Call 2 (WARM, same runtime/process): the appended dupC must persist as a NEW row.
let r2 = await rt.ingestSessionMessages({ sessionId: SESSION, messages: arr2, limit: 5000 })
const userRows2 = db.rows.filter(r => r.role === 'user' && r.content === 'run it again')
assert(
  userRows2.length === 3,
  `INVARIANT 1: post-compaction appended identical turn must persist as a NEW row (expected 3 total, got ${userRows2.length}) — this is the silent-drop bug`,
)
const refDupC = userRows2.find(r => r.source_ref !== refDupA && r.source_ref !== refDupB)?.source_ref
assert(refDupC, 'appended identical turn must have a fresh source_ref above the persisted high-water')
// dupB survived: it must have deduped (reused its recorded ordinal), NOT minted a new row.
assert(db.rows.filter(r => r.source_ref === refDupB).length === 1, 'survived identical turn must dedupe, not duplicate')

// ── INVARIANT 2: fresh runtime (new process), full identical re-ingest ────────
// Rows already in DB; re-ingesting the CURRENT array from start=0 must create
// ZERO new rows.
const rowCountBefore = db.rows.length
const rtFresh = makeRuntime(db) // cold state for this "process"
await rtFresh.ingestSessionMessages({ sessionId: SESSION, messages: arr2, limit: 5000 })
assert(
  db.rows.length === rowCountBefore,
  `INVARIANT 2: full identical re-ingest in a fresh process must create 0 duplicates (before=${rowCountBefore} after=${db.rows.length})`,
)

// ── INVARIANT 3: subset re-ingest reproduces the same source_refs as full ─────
// Fresh DB + fresh runtime; ingest the full array, capture refs; then a NEW
// fresh DB/runtime ingesting the same array via a small window (subset, seeded
// from the prefix) must reproduce the identical source_refs.
function refsFor(messages, opts) {
  const d = createFakeDb()
  const r = makeRuntime(d)
  return { d, r }
}
{
  const fullMsgs = [mk('user', 'x'), mk('assistant', 'y'), mk('user', 'x'), mk('user', 'x'), mk('assistant', 'y')]
  const { d: dFull, r: rFull } = refsFor()
  await rFull.ingestSessionMessages({ sessionId: 'subset-sess', messages: fullMsgs, limit: 5000 })
  const fullRefs = dFull.rows.filter(r => r.session_id === 'subset-sess').map(r => r.source_ref).sort()

  // Subset: fresh process, window = last 2 messages, prefix seeded internally.
  const { d: dSub, r: rSub } = refsFor()
  await rSub.ingestSessionMessages({ sessionId: 'subset-sess', messages: fullMsgs, limit: 2 })
  const subRefs = dSub.rows.filter(r => r.session_id === 'subset-sess').map(r => r.source_ref)
  for (const ref of subRefs) {
    assert(fullRefs.includes(ref), `INVARIANT 3: subset re-ingest source_ref ${ref} must match a full re-ingest ref`)
  }
  // The subset window's last two messages are `x`(3rd occurrence) and `y`(2nd);
  // their refs must equal the full re-ingest's 3rd `x` and 2nd `y` refs.
  assert(subRefs.length === 2, `subset window should ingest exactly its 2 messages (got ${subRefs.length})`)
}

// ── INVARIANT 1 across RESTART: fresh runtime (new process), same DB ──────────
// A restart = a NEW runtime instance (empty in-memory ordinal state AND empty
// WeakMap) ingesting a reloaded transcript against the SAME DB that already
// holds prior rows. When the reloaded (compacted) array still RETAINS the
// identical copies, positional ordinals reproduce each survivor's OWN live row,
// and a freshly appended identical turn takes a free ordinal and persists NEW.
{
  const rdb = createFakeDb()
  const S = 'restart-sess'
  const rtA = makeRuntime(rdb)
  await rtA.ingestSessionMessages({ sessionId: S, messages: [mk('user', 'ping'), mk('assistant', 'pong'), mk('user', 'ping')], limit: 5000 })
  const pingBefore = rdb.rows.filter(r => r.content === 'ping')
  assert(pingBefore.length === 2, `pre-restart should persist 2 identical pings (got ${pingBefore.length})`)
  const beforeIds = new Set(pingBefore.map(r => r.id))

  // Restart: brand-new runtime (fresh WeakMap + ordinal state), same DB. The
  // reloaded compacted array RETAINS both ping copies (compaction dropped only
  // the non-identical `pong`); append a genuinely new identical ping. The
  // reloaded objects are DISTINCT references from the pre-restart ones.
  const rtB = makeRuntime(rdb)
  await rtB.ingestSessionMessages({ sessionId: S, messages: [mk('user', 'ping'), mk('user', 'ping'), mk('user', 'ping')], limit: 5000 })
  const pingAfter = rdb.rows.filter(r => r.content === 'ping')
  assert(pingAfter.length === 3, `RESTART: appended identical turn must persist as a NEW row (expected 3, got ${pingAfter.length})`)
  // Row-identity (not ref-membership) check: the survivor re-ingest must DEDUPE
  // onto the 2 pre-existing live rows (same ids, no re-insert) and add EXACTLY
  // one NEW row (the append) — proving survivors mapped to live rows, not dropped.
  const survivorRows = pingAfter.filter(r => beforeIds.has(r.id))
  const newRows = pingAfter.filter(r => !beforeIds.has(r.id))
  assert(survivorRows.length === 2, `RESTART: survivors must reuse the 2 live rows (got ${survivorRows.length})`)
  assert(newRows.length === 1, `RESTART: exactly one NEW appended row expected (got ${newRows.length})`)
}

// ── INVARIANT 1 across RESTART, LATER-WARM append (durable high-water) ────────
// The path the reviewer disproved: after restart the cold replay of a COMPACTED
// array seeds occNext = survivor-count T, but the DB holds K>T copies. A NEW
// untimestamped identical turn arriving in a LATER (warm) call is distinguishable
// (it is genuinely new, not one of the cold-replay survivors) and MUST persist —
// only the durable per-identity high-water K makes that possible.
{
  const durable = new Map()   // survives the "restart" (shared across runtimes)
  const rdb = createFakeDb()  // DB rows survive the restart too
  const S = 'restart-warm-sess'

  // Pre-restart process: build K=3 persisted copies of an identical untimestamped
  // turn (cold [X,other,X] → 2 copies; then in-process compaction+append → 3rd).
  const rtA = makeRuntime(rdb, durable)
  const xa1 = mk('user', 'again'); const xa2 = mk('user', 'again')
  await rtA.ingestSessionMessages({ sessionId: S, messages: [xa1, mk('assistant', 'ok'), xa2], limit: 5000 })
  const xa3 = mk('user', 'again') // in-process appended (compaction kept xa2)
  await rtA.ingestSessionMessages({ sessionId: S, messages: [xa2, mk('assistant', 'ok2'), xa3], limit: 5000 })
  assert(rdb.rows.filter(r => r.content === 'again').length === 3, 'pre-restart should hold K=3 identical copies')
  assert(durable.has(S), 'durable high-water must have been persisted for the duplicate identity')

  // Restart: fresh runtime (empty WeakMap + ordinal state), SAME db + durable.
  // Reloaded COMPACTED array retains only ONE copy (T=1).
  const rtB = makeRuntime(rdb, durable)
  const rx = mk('user', 'again') // reloaded survivor (distinct object)
  await rtB.ingestSessionMessages({ sessionId: S, messages: [rx], limit: 5000 }) // COLD replay (T=1)
  assert(rdb.rows.filter(r => r.content === 'again').length === 3, 'cold replay of survivor must not add rows (dedupe)')

  // LATER warm call on rtB appends a genuinely new identical turn.
  const rxNew = mk('user', 'again')
  const rowsBeforeAppend = rdb.rows.length
  await rtB.ingestSessionMessages({ sessionId: S, messages: [rx, rxNew], limit: 5000 })
  const againAfter = rdb.rows.filter(r => r.content === 'again')
  assert(
    againAfter.length === 4,
    `LATER-WARM RESTART: appended identical turn must persist as a NEW row via durable K (expected 4, got ${againAfter.length})`,
  )
  assert(rdb.rows.length === rowsBeforeAppend + 1, 'exactly one new row from the later-warm append')
}

// ── Zero-dup guarantee when a compacted reload DROPPED an identical copy ──────
// If the reloaded array is missing an earlier identical untimestamped copy AND
// the WeakMap survivor signal is gone (restart), the appended identical turn is
// information-theoretically indistinguishable from the survivors (see the
// DURABILITY note in session-ingest-runtime.mjs). Contract in that corner: NEVER
// mint a duplicate survivor row (ON CONFLICT dedupes). The append may collapse;
// it must not duplicate.
{
  const rdb = createFakeDb()
  const S = 'restart-drop-sess'
  const rtA = makeRuntime(rdb)
  await rtA.ingestSessionMessages({ sessionId: S, messages: [mk('user', 'echo'), mk('user', 'echo')], limit: 5000 })
  const before = rdb.rows.filter(r => r.content === 'echo').length
  assert(before === 2, `pre-restart should persist 2 identical echoes (got ${before})`)
  const rowsBefore = rdb.rows.length

  // Restart with a compacted reload that DROPPED one echo, then appended one
  // (net 2 copies again). Must not mint a duplicate; the append collapses.
  const rtB = makeRuntime(rdb)
  await rtB.ingestSessionMessages({ sessionId: S, messages: [mk('user', 'echo'), mk('user', 'echo')], limit: 5000 })
  const after = rdb.rows.filter(r => r.content === 'echo').length
  assert(after === before, `RESTART+drop: must not mint a duplicate survivor row (before=${before} after=${after})`)
  assert(rdb.rows.length === rowsBefore, 'RESTART+drop: no duplicate rows created')
}

process.stdout.write('session ingest compaction-append smoke passed \u2713\n')
