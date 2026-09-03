// phase-merge-verdicts.mjs — negative-verdict memo for the cycle2 LLM judge.
//
// Every hourly pass re-derived the same top-similarity pairs (the pairing is
// deterministic over an unchanged active set) and asked the judge again, so
// the whole per-pass LLM budget went to pairs already known to be distinct
// and the core_overlap sweep starved. A `distinct` verdict is durable as long
// as neither side's text changes, so it is keyed on both summaries' hashes.

import { createHash } from 'node:crypto'

let _ensured = new WeakSet()

export function summaryHash(text) {
  return createHash('sha1').update(String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex')
}

export async function ensurePhaseMergeVerdictTable(db) {
  if (_ensured.has(db)) return
  await db.exec(`
    CREATE TABLE IF NOT EXISTS phase_merge_verdicts (
      kind      text   NOT NULL,
      a_id      bigint NOT NULL,
      b_id      bigint NOT NULL,
      a_hash    text   NOT NULL,
      b_hash    text   NOT NULL,
      verdict   text   NOT NULL,
      judged_at bigint NOT NULL,
      PRIMARY KEY (kind, a_id, b_id)
    )
  `)
  _ensured.add(db)
}

// Returns the cached verdict ('distinct' | 'merge') when both texts are the
// ones that were judged, else null.
export async function readPhaseMergeVerdict(db, kind, a, b) {
  const r = await db.query(
    `SELECT verdict FROM phase_merge_verdicts
     WHERE kind = $1 AND a_id = $2 AND b_id = $3 AND a_hash = $4 AND b_hash = $5`,
    [kind, Number(a.id), Number(b.id), summaryHash(a.summary), summaryHash(b.summary)],
  )
  return r.rows[0]?.verdict ?? null
}

export async function writePhaseMergeVerdict(db, kind, a, b, verdict, now = Date.now()) {
  await db.query(
    `INSERT INTO phase_merge_verdicts (kind, a_id, b_id, a_hash, b_hash, verdict, judged_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (kind, a_id, b_id) DO UPDATE
       SET a_hash = EXCLUDED.a_hash, b_hash = EXCLUDED.b_hash,
           verdict = EXCLUDED.verdict, judged_at = EXCLUDED.judged_at`,
    [kind, Number(a.id), Number(b.id), summaryHash(a.summary), summaryHash(b.summary), verdict, now],
  )
}

// Rows whose either side no longer exists are dead weight; prune on demand.
export async function prunePhaseMergeVerdicts(db, maxAgeMs = 30 * 24 * 3600 * 1000, now = Date.now()) {
  const r = await db.query(`DELETE FROM phase_merge_verdicts WHERE judged_at < $1`, [now - maxAgeMs])
  return Number(r.rowCount ?? 0)
}

export function _resetPhaseMergeVerdictCacheForTests() {
  _ensured = new WeakSet()
}
