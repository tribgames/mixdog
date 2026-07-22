// Core-memory candidate pipeline (nomination → review → promotion), extracted from core-memory-store.mjs.
import { getDatabase, embeddingToSql } from './memory.mjs'
import { cachedEmbedTextBatch } from './memory-embed.mjs'
import { callAgentDispatch } from './agent-ipc.mjs'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { checkedConnect } from './pg/adapter.mjs'
import { __mixdogMemoryLog, CORE_DEDUP_TOP_K, CORE_SUMMARY_MAX, _getDb, throwIfAborted, addCore } from './core-memory-store.mjs';

//
// nominateCoreCandidates flags strong active entries as core-memory
// candidates. NEVER auto-inserts into core_entries — a user approves each via
// listCoreCandidates → promoteCoreCandidate. Durable-signal driven:
//   - category grade: only durable knowledge types (rule/constraint/decision/
//     preference/goal/fact) — transient task/issue never nominated.
//   - score >= CANDIDATE_MIN_SCORE: survived age-decay / repeated gate reviews.
//   - reviewed_at survival: entry has been through >= 1 gate review (reviewed_at
//     set) so freshly-promoted noise is excluded.
//   - core_overlap skip: entries whose embedding sits near an existing
//     core_entries row (sim >= CANDIDATE_OVERLAP_SIM) are already covered by a
//     user rule — skip to avoid duplicate promotion. Reuses the same cosine
//     recall shape as cycle2 phase_merge core_overlap.
// Terminal states ('promoted'/'dismissed') are never re-nominated. Caps at
// CANDIDATE_CAP total live candidates.

export const CANDIDATE_CAP = 10
// Durable categories worth surfacing for user-curated core memory. Mirrors the
// high end of CATEGORY_GRADE (memory-score.mjs) — task/issue excluded.
const CANDIDATE_CATEGORIES = new Set(['rule', 'constraint', 'decision', 'preference', 'goal', 'fact'])
// Score floor: preference grade is 1.4, fact 1.6 — require the entry to still
// be near its grade ceiling (i.e. survived decay), not a stale low-score root.
const CANDIDATE_MIN_SCORE = 1.3
// Embedding sim at/above which the active entry is considered already covered
// by an existing core row → skip nomination. Matches cycle2 TIER1_THRESHOLD.
const CANDIDATE_OVERLAP_SIM = 0.78
// A promote left mid-flight ('promoting') longer than this is treated as a
// crashed promotion and reverted to a live candidate by recoverStalePromotions.
// Worst-case addCore duration bounds this: it runs up to CORE_DEDUP_TOP_K (5)
// sequential LLM merge-judge calls at 30s timeout each (~150s) plus embedding
// generation — call it ~3min worst case. 15min gives >5x margin so a slow-but-
// live promote is never mistaken for a crash, while still recovering a genuine
// crash within one hourly cycle2 pass. The finalize path ALSO tolerates a
// racing recovery (rowCount=0 → re-claim, see promoteCoreCandidate) so an
// over-tight cutoff can't corrupt state — this margin is defense-in-depth.
const PROMOTING_STALE_MS = 15 * 60_000

function _candidateReason(row) {
  return `${row.category} grade, score ${Number(row.score).toFixed(2)}, survived gate review`
}

// Post-gate nomination pass. Cheap: one scan over durable high-score active
// roots not already candidate/promoted/dismissed, one core-overlap cosine
// probe per row, capped at CANDIDATE_CAP net-new. Returns count nominated.
export async function nominateCoreCandidates(dataDir, options = {}) {
  const signal = options?.signal
  const db = _getDb(dataDir)
  throwIfAborted(signal)
  // Recover crashed promotions first: a root stuck in 'promoting' past
  // PROMOTING_STALE_MS (claim tx committed but the process died before finalize)
  // is reverted to a live candidate here, so it re-enters the pool below.
  try {
    await recoverStalePromotions(dataDir, { signal })
    throwIfAborted(signal)
  } catch (err) {
    if (signal?.aborted) throw signal.reason ?? err
    __mixdogMemoryLog(`[core-memory] stale-promotion recovery failed: ${err.message}\n`)
  }
  // Live candidate headroom: never exceed CANDIDATE_CAP total pending. Count
  // only ACTIVE candidate roots — a candidate archived by cycle2 core_overlap
  // between nomination and now must not eat headroom (it is also excluded from
  // listCoreCandidates by the same status='active' guard).
  const liveRes = await db.query(
    `SELECT COUNT(*)::int AS n FROM entries WHERE is_root = 1 AND status = 'active' AND core_candidate_status = 'candidate'`,
  )
  const live = Number(liveRes.rows[0]?.n ?? 0)
  const headroom = CANDIDATE_CAP - live
  if (headroom <= 0) return 0

  // Pull the strongest eligible roots that have never been nominated (status
  // NULL) and have been through a gate review (reviewed_at set). Terminal
  // 'promoted'/'dismissed' rows are excluded by the NULL predicate.
  const cats = [...CANDIDATE_CATEGORIES]
  const eligibleRes = await db.query(
    `SELECT id, element, summary, category, score, project_id,
            (embedding IS NOT NULL) AS has_embedding
     FROM entries
     WHERE is_root = 1 AND status = 'active'
       AND core_candidate_status IS NULL
       AND reviewed_at IS NOT NULL
       AND category = ANY($1::text[])
       AND score >= $2
     ORDER BY score DESC, last_seen_at DESC, id ASC
     LIMIT $3`,
    [cats, CANDIDATE_MIN_SCORE, headroom * 3],
  )
  throwIfAborted(signal)

  const now = Date.now()
  let nominated = 0
  for (const row of eligibleRes.rows) {
    throwIfAborted(signal)
    if (nominated >= headroom) break
    // core_overlap skip: is this entry already covered by an existing core row?
    // Compute similarity fully in SQL against the entry's own embedding
    // (referenced by id) so no halfvec value round-trips through JS — mirrors
    // the cycle2 phase_merge core_overlap probe shape. Same-pool + COMMON core
    // are eligible matches.
    if (row.has_embedding) {
      const ov = await db.query(
        `SELECT 1 - (e.embedding <=> c.embedding) AS sim
         FROM entries e
         CROSS JOIN LATERAL (
           SELECT inner_c.embedding
           FROM core_entries inner_c
           WHERE inner_c.embedding IS NOT NULL
            AND (inner_c.status IS NULL OR inner_c.status = 'active')
             AND (inner_c.project_id IS NULL OR inner_c.project_id IS NOT DISTINCT FROM e.project_id)
           ORDER BY inner_c.embedding <=> e.embedding
           LIMIT 1
         ) c
         WHERE e.id = $1 AND e.embedding IS NOT NULL`,
        [Number(row.id)],
      )
      throwIfAborted(signal)
      if (ov.rows.length > 0 && Number(ov.rows[0].sim) >= CANDIDATE_OVERLAP_SIM) continue
    }
    const r = await db.query(
      `UPDATE entries SET core_candidate_status = 'candidate', core_candidate_at = $1
       WHERE id = $2 AND is_root = 1 AND core_candidate_status IS NULL`,
      [now, Number(row.id)],
    )
    if (Number(r.rowCount ?? r.affectedRows ?? 0) > 0) nominated++
  }
  if (nominated > 0) {
    __mixdogMemoryLog(`[core-memory] nominated ${nominated} core candidate(s)\n`)
  }
  return nominated
}

// List live candidates for the UI. Shape matches the deliver spec:
// {id, element, summary, category, score, reason}.
// `scope`: null → COMMON pool only (project_id NULL); '*' → all pools;
// slug → that project's pool + COMMON. Mirrors the add/edit/delete + list
// project isolation so an unscoped call can't leak another project's
// candidates. status='active' guard: a candidate root archived by cycle2
// core_overlap between nomination and listing must NOT stay listed (it also
// no longer counts against CANDIDATE_CAP — see nominateCoreCandidates).
export async function listCoreCandidates(dataDir, scope = null) {
  const db = _getDb(dataDir)
  let scopeClause = ''
  const params = []
  if (scope === '*') {
    scopeClause = ''
  } else if (scope == null) {
    scopeClause = 'AND project_id IS NULL'
  } else {
    scopeClause = 'AND (project_id IS NULL OR project_id = $1)'
    params.push(scope)
  }
  const r = await db.query(
    `SELECT id, element, summary, category, score, project_id
     FROM entries
     WHERE is_root = 1 AND status = 'active' AND core_candidate_status = 'candidate'
       ${scopeClause}
     ORDER BY score DESC, core_candidate_at DESC, id ASC`,
    params,
  )
  return r.rows.map(row => ({
    id: Number(row.id),
    element: row.element,
    summary: row.summary,
    category: row.category,
    score: row.score == null ? null : Number(row.score),
    project_id: row.project_id ?? null,
    reason: _candidateReason(row),
  }))
}

// Promote a candidate via a two-phase claim → insert → finalize with a
// recoverable intermediate state ('promoting'), so a process crash at ANY point
// is recoverable by the cycle2 recovery sweep (recoverStalePromotions).
//
// Phase 1 (claim tx): status='archived', core_candidate_status='promoting'.
//   The embedding is NOT nulled here — deferred to finalize — so recovery can
//   restore the row to active WITHOUT needing to re-embed. Archived-with-
//   embedding for the brief promoting window is harmless: the recall scope
//   filter excludes BOTH 'promoted' AND 'promoting' rows (and their members).
// Phase 2: addCore (its own tx — advisory locks can't join an outer tx).
// Phase 3 (finalize tx): core_candidate_status='promoted', embedding=NULL.
//
// Crash matrix:
//   - crash after phase 1, before addCore commits → row is archived+'promoting'
//     with NO core row → recovery sweep (stale > PROMOTING_STALE_MS) reverts it
//     to active+'candidate' (embedding intact) → clean retry.
//   - addCore threw → synchronous compensation reverts immediately (same shape).
//   - crash after addCore commits, before finalize → core row exists + row is
//     'promoting' → recovery reverts the ROOT to candidate, but the core row now
//     exists, so the retry's addCore merge-judge/unique-index folds back into the
//     same core row (element unchanged) → converges (no duplicate).  This is the
//     one window where a retry relies on addCore dedup, but it is bounded and
//     self-healing rather than a permanent orphan+stuck-root.
//   - finalize committed → terminal 'promoted', embedding NULL → done.
//
// `scope` (from the index handler) enforces project isolation: the candidate
// must belong to the resolved scope or COMMON — never another project's pool.
export async function promoteCoreCandidate(dataDir, id, options = {}) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  // Require BOTH active status and a live candidate flag (finding #2): a stale
  // archived/merged root must not be promotable by direct id.
  const cur = (await db.query(
    `SELECT id, element, summary, category, project_id, core_candidate_status
     FROM entries WHERE id = $1 AND is_root = 1 AND status = 'active'`,
    [numId],
  )).rows[0]
  if (!cur) throw new Error(`no active root entry with id=${numId} (already archived, merged, or deleted)`)
  if (cur.core_candidate_status !== 'candidate') {
    throw new Error(`entry id=${numId} is not a live core candidate (status=${cur.core_candidate_status ?? 'none'})`)
  }
  // Project-scope guard: reject cross-project promotion. scope null == COMMON;
  // a scoped candidate is only promotable within its own pool (or if it is a
  // COMMON candidate). Mirrors add/edit/delete project isolation.
  const scope = options?.scope ?? null
  const rowPid = cur.project_id ?? null
  if (rowPid != null && rowPid !== scope) {
    throw new Error(`candidate id=${numId} belongs to project "${rowPid}", not the resolved scope "${scope ?? 'common'}"`)
  }
  // Core summary cap: candidate summaries may exceed CORE_SUMMARY_MAX. Prefer
  // the explicit override, else compress by truncation so addCore accepts it.
  const summary = options?.summary ?? cur.summary
  const cappedSummary = summary && String(summary).length > CORE_SUMMARY_MAX
    ? String(summary).slice(0, CORE_SUMMARY_MAX)
    : summary
  const now = Date.now()
  // Phase 1 — claim (active+candidate guarded so a concurrent archive/promote
  // loses the race → 0 rows → nothing to promote). Embedding NOT nulled here
  // (deferred to finalize) so recovery needs no re-embed.
  const claim = await db.transaction(async (tx) => {
    const r = await tx.query(
      `UPDATE entries SET core_candidate_status = 'promoting', core_candidate_at = $1, status = 'archived'
       WHERE id = $2 AND is_root = 1 AND status = 'active' AND core_candidate_status = 'candidate'`,
      [now, numId],
    )
    return Number(r.rowCount ?? r.affectedRows ?? 0)
  })
  if (claim === 0) {
    throw new Error(`candidate id=${numId} was concurrently promoted/archived — nothing to do`)
  }
  // Phase 2 — insert into core_entries. addCore's own tx commits independently.
  let entry
  try {
    entry = await addCore(
      dataDir,
      { element: cur.element, summary: cappedSummary, category: cur.category },
      rowPid,
    )
  } catch (err) {
    // Synchronous compensation: revert the 'promoting' claim to the live-
    // candidate state so a retry is clean and no core row was created. Embedding
    // is intact (never nulled), so no re-embed needed.
    try {
      await db.transaction(async (tx) => {
        await tx.query(
          `UPDATE entries SET core_candidate_status = 'candidate', core_candidate_at = $1, status = 'active'
           WHERE id = $2 AND is_root = 1 AND core_candidate_status = 'promoting' AND status = 'archived'`,
          [Date.now(), numId],
        )
      })
    } catch (compErr) {
      __mixdogMemoryLog(`[core-memory] promote compensation failed id=${numId}: ${compErr.message} (root left 'promoting' — recovery sweep will revert)\n`)
    }
    throw err
  }
  // Phase 3 — finalize: terminal 'promoted' + null the embedding (now safe: the
  // core row is committed, so nulling can't strand a recoverable row without its
  // fact). Guarded on 'promoting'. If a racing recoverStalePromotions (slow
  // addCore that overran PROMOTING_STALE_MS) already reverted the row to
  // 'candidate'+active, this affects 0 rows — but the core row IS committed, so
  // we must NOT return success while the root is still a live candidate (user
  // would see success + the candidate re-listed). Re-claim from the recovered
  // 'candidate' state (finding #2). If THAT also affects 0 rows, another actor
  // changed the row (genuine re-promote, dismiss, archive) — don't clobber;
  // log and still return the entry (the core row exists either way).
  const finalize = await db.transaction(async (tx) => {
    const r1 = await tx.query(
      `UPDATE entries SET core_candidate_status = 'promoted', core_candidate_at = $1, embedding = NULL
       WHERE id = $2 AND is_root = 1 AND core_candidate_status = 'promoting'`,
      [Date.now(), numId],
    )
    if (Number(r1.rowCount ?? r1.affectedRows ?? 0) > 0) return 'finalized'
    // Row was recovered back to candidate mid-flight — re-claim it (core row
    // already committed). Guard on the exact recovery state (active+candidate).
    const r2 = await tx.query(
      `UPDATE entries SET core_candidate_status = 'promoted', core_candidate_at = $1, status = 'archived', embedding = NULL
       WHERE id = $2 AND is_root = 1 AND status = 'active' AND core_candidate_status = 'candidate'`,
      [Date.now(), numId],
    )
    return Number(r2.rowCount ?? r2.affectedRows ?? 0) > 0 ? 'reclaimed' : 'unchanged'
  })
  if (finalize === 'reclaimed') {
    __mixdogMemoryLog(`[core-memory] promote id=${numId} finalized after a racing recovery revert (re-claimed)\n`)
  } else if (finalize === 'unchanged') {
    __mixdogMemoryLog(`[core-memory] promote id=${numId}: root changed by another actor before finalize; core row committed, root state left as-is\n`)
  }
  return entry
}

// Recovery sweep for crashed promotions: a root left in 'promoting' (claim tx
// committed but the process died before finalize) is reverted to the live
// candidate state (status='active', core_candidate_status='candidate') once it
// is older than PROMOTING_STALE_MS. Embedding was never nulled in the claim, so
// no re-embed is required. Runs from nominateCoreCandidates (hourly cycle2).
// Idempotent: 0 stale rows → fast no-op. Returns count recovered.
export async function recoverStalePromotions(dataDir, options = {}) {
  const signal = options?.signal
  const db = _getDb(dataDir)
  throwIfAborted(signal)
  const cutoff = Date.now() - PROMOTING_STALE_MS
  const r = await db.query(
    `UPDATE entries SET core_candidate_status = 'candidate', core_candidate_at = $1, status = 'active'
     WHERE is_root = 1 AND core_candidate_status = 'promoting'
       AND core_candidate_at IS NOT NULL AND core_candidate_at < $2`,
    [Date.now(), cutoff],
  )
  const n = Number(r.rowCount ?? r.affectedRows ?? 0)
  if (n > 0) __mixdogMemoryLog(`[core-memory] recovered ${n} stale 'promoting' root(s) → candidate\n`)
  return n
}

// Dismiss a candidate: mark terminal so the nomination pass never re-nominates
// the same root. Leaves status/score untouched — the entry stays active in
// generated memory, it just won't be re-surfaced as a core candidate.
// `scope` enforces project isolation (mirrors promote): a scoped caller can
// only dismiss candidates in its own pool or COMMON.
export async function dismissCoreCandidate(dataDir, id, options = {}) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const scope = options?.scope ?? null
  const cur = (await db.query(
    `SELECT project_id, core_candidate_status FROM entries WHERE id = $1 AND is_root = 1`,
    [numId],
  )).rows[0]
  if (!cur) throw new Error(`no root entry with id=${numId}`)
  const rowPid = cur.project_id ?? null
  if (rowPid != null && rowPid !== scope) {
    throw new Error(`candidate id=${numId} belongs to project "${rowPid}", not the resolved scope "${scope ?? 'common'}"`)
  }
  const r = await db.query(
    `UPDATE entries SET core_candidate_status = 'dismissed', core_candidate_at = $1
     WHERE id = $2 AND is_root = 1 AND core_candidate_status = 'candidate'
     RETURNING id, element, category`,
    [Date.now(), numId],
  )
  if (r.rows.length === 0) throw new Error(`no live core candidate with id=${numId}`)
  return r.rows[0]
}
