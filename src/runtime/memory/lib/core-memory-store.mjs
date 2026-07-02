const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}

// User-curated core memory store — native PG-backed via core_entries table.
// Per-project entries distinguished by project_id column (NULL = COMMON).
// addCore / editCore generate an embedding for each row and run a cosine-sim
// lookup against existing rows in the same project pool: candidates at or
// above SIM_RECALL go through an LLM "merge or distinct" judge — only the
// LLM's verdict, not the embedding score, decides whether the prior row is
// superseded in place. Below the threshold the row is INSERTed fresh.
// cycle2 reads core_entries via the {{USER_CORE}} prompt slot to avoid
// re-promoting entries that already overlap a user-curated row.

import { getDatabase, embeddingToSql } from './memory.mjs'
import { cachedEmbedTextBatch } from './memory-embed.mjs'
import { deleteRootEmbedding } from './memory-embed.mjs'
import { callAgentDispatch } from './agent-ipc.mjs'
import { resolveMaintenancePreset } from '../../shared/llm/index.mjs'
import { checkedConnect } from './pg/adapter.mjs'

const VALID_CAT = new Set([
  'rule', 'constraint', 'decision', 'fact', 'goal', 'preference', 'task', 'issue',
])

// Embedding sim threshold for surfacing a candidate to the LLM judge. Wider
// than cycle2's tier-1 (0.78) on purpose: LLM verdict is authoritative so
// the recall side can afford broader recall.
const SIM_RECALL = 0.65
const CORE_DEDUP_TOP_K = 5

export const CORE_SUMMARY_MAX = 120

function trimOrNull(v) {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function _getDb(dataDir) {
  if (!dataDir) throw new Error('core-memory: dataDir required')
  const db = getDatabase(dataDir)
  if (!db) throw new Error('core-memory: database not open — call openDatabase first')
  return db
}

async function _embedFor(db, element, summary) {
  const text = `${element}\n${summary || ''}`.trim()
  if (!text) return null
  const [vec] = await cachedEmbedTextBatch(db, [text])
  return Array.isArray(vec) ? vec : null
}

// Lazy repair of NULL embeddings on existing rows. Runs once per boot or
// whenever a NULL slips back in via direct SQL. SELECT WHERE embedding IS NULL
// returns 0 rows on a fully-populated table, so this is a fast no-op.
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

async function _backfillNullEmbeddings(db, options = {}) {
  const signal = options?.signal
  throwIfAborted(signal)
  const r = await db.query(`SELECT id, element, summary FROM core_entries WHERE embedding IS NULL`)
  if (r.rows.length === 0) return 0
  let filled = 0
  for (const row of r.rows) {
    throwIfAborted(signal)
    const vec = await _embedFor(db, row.element, row.summary)
    throwIfAborted(signal)
    if (!vec) continue
    await db.query(
      `UPDATE core_entries SET embedding = $1::halfvec WHERE id = $2 AND embedding IS NULL`,
      [embeddingToSql(vec), row.id],
    )
    filled++
  }
  if (filled > 0) {
    __mixdogMemoryLog(`[core-memory] backfilled ${filled} NULL embedding(s) on core_entries\n`)
  }
  return filled
}

export async function backfillCoreEmbeddings(dataDir, options = {}) {
  const db = _getDb(dataDir)
  return await _backfillNullEmbeddings(db, options)
}

// Boot-time invariant restoration: core_entries.id must always be the
// contiguous sequence 1..N. SERIAL only ever increments, so deleting a row
// leaves a permanent gap (e.g. 1,2,4,5 after deleting 3). This closes those
// gaps by resequencing every row globally (across all project_id pools) to
// 1..N in id order, then realigns the serial so the next INSERT continues from
// N+1. Deterministic invariant restore — no heuristic, no fallback branch.
export async function compactCoreIds(dataDir) {
  const db = _getDb(dataDir)
  // Fast no-op guard: a contiguous 1..N table has COUNT == MAX(id). This also
  // covers the empty table (n=0, mx=0) — return before any write.
  const g = await db.query(`SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS mx FROM core_entries`)
  const n = Number(g.rows[0].n)
  const mx = Number(g.rows[0].mx)
  if (n === mx) return 0

  // BEGIN transaction on ONE checked-out client — the pool wrapper db.query
  // releases the client per call, so BEGIN/COMMIT must run on one client
  // (same pattern as addCore).
  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    // (a) Vacate the low range so shifted ids can't collide with the 1..N
    // target. Offset by current MAX(id): every id becomes id+mx, which is
    // strictly greater than N (N <= mx), so the resequence below is safe.
    await client.query(`UPDATE core_entries SET id = id + $1`, [mx])
    // (b) Resequence ALL rows globally to 1..N preserving id order.
    await client.query(`
      WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM core_entries
      )
      UPDATE core_entries c SET id = o.rn FROM ordered o WHERE c.id = o.id`)
    // (c) Realign the serial so the next INSERT continues from N+1. Guarded by
    // the n===mx return above, so MAX(id) is always > 0 here — setval(...,0,true)
    // is invalid and is never reached.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('core_entries','id'),
         (SELECT COALESCE(MAX(id),0) FROM core_entries), true)`)
    await client.query('COMMIT')
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
  __mixdogMemoryLog(`[core-memory] compacted ${n} core id(s)\n`)
  return n
}

async function _findTopKCore(db, projectId, embedding, excludeId, { forUpdate = false } = {}) {
  if (!embedding) return []
  const exclusion = excludeId == null ? '' : 'AND id != $3'
  const sql = `
    SELECT id, element, summary, category, 1 - (embedding <=> $1::halfvec) AS sim
    FROM core_entries
    WHERE embedding IS NOT NULL
      AND project_id IS NOT DISTINCT FROM $2
      ${exclusion}
    ORDER BY embedding <=> $1::halfvec
    LIMIT ${CORE_DEDUP_TOP_K}${forUpdate ? ' FOR UPDATE' : ''}`
  const params = excludeId == null
    ? [embeddingToSql(embedding), projectId]
    : [embeddingToSql(embedding), projectId, excludeId]
  const r = await db.query(sql, params)
  return r.rows.filter(row => Number(row.sim) >= SIM_RECALL)
}

async function _resolveMergeTarget(candidates, incoming) {
  for (const c of candidates) {
    if (await _llmJudgeMerge(c, incoming)) return c
  }
  return null
}

// LLM judge for "is this incoming entry a restatement of the existing one?"
// One-word reply: merge | distinct. Errors fall back to distinct so a flaky
// LLM never silently absorbs a fresh registration into an unrelated row.
async function _llmJudgeMerge(existing, incoming) {
  const prompt =
    `Two user-curated core memory entries below. Are they restating the same rule, fact, or preference (just different wording)? Reply ONE WORD: merge or distinct.\n\n` +
    `EXISTING: ${existing.element} — ${String(existing.summary || '')}\n` +
    `INCOMING: ${incoming.element} — ${String(incoming.summary || '')}`
  try {
    const raw = await callAgentDispatch({
      agent: 'cycle2-agent',
      taskType: 'maintenance',
      mode: 'core-merge-judge',
      preset: resolveMaintenancePreset('memory'),
      timeout: 30_000,
      cwd: null,
    }, prompt)
    return String(raw ?? '').trim().toLowerCase().startsWith('merge')
  } catch (err) {
    __mixdogMemoryLog(`[core-memory] LLM merge judge failed: ${err.message}\n`)
    return false
  }
}

export async function listCore(dataDir, projectId = null) {
  const db = _getDb(dataDir)
  const cols = `id, element, summary, category, project_id, created_at, updated_at`
  if (projectId === '*') {
    const r = await db.query(`SELECT ${cols} FROM core_entries ORDER BY project_id NULLS FIRST, id ASC`)
    return r.rows
  }
  if (projectId === null) {
    const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id IS NULL ORDER BY id ASC`)
    return r.rows
  }
  const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id = $1 ORDER BY id ASC`, [projectId])
  return r.rows
}

export async function addCore(dataDir, { element, summary, category }, projectId) {
  if (projectId === undefined) throw new Error('addCore: projectId required — pass null for COMMON pool, or slug string for scoped pool')
  const el = trimOrNull(element)
  const sm = trimOrNull(summary) ?? el
  if (!el || !sm) throw new Error('add requires element and summary')
  if (sm.length > CORE_SUMMARY_MAX) {
    throw new Error(`core summary too long (${sm.length} chars, max ${CORE_SUMMARY_MAX}) — core memory must be 1 fact in 1-2 sentences; procedures, multi-step, or code belong in recap or docs. Compress and retry.`)
  }
  const cat = (trimOrNull(category) ?? 'fact').toLowerCase()
  if (!VALID_CAT.has(cat)) {
    throw new Error(`invalid category "${cat}". Valid: ${[...VALID_CAT].join(', ')}`)
  }
  const db = _getDb(dataDir)
  const now = Date.now()
  await _backfillNullEmbeddings(db)
  const embedding = await _embedFor(db, el, sm)

  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    const poolKey = `core:${projectId == null ? 'COMMON' : projectId}`
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [poolKey])
    const candidates = await _findTopKCore(client, projectId, embedding, null, { forUpdate: true })
    const mergeTarget = await _resolveMergeTarget(candidates, { element: el, summary: sm })
    if (mergeTarget) {
      const r = await client.query(
        `UPDATE core_entries
         SET element = $1, summary = $2, category = $3, embedding = $4::halfvec, updated_at = $5
         WHERE id = $6
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [el, sm, cat, embedding ? embeddingToSql(embedding) : null, now, mergeTarget.id],
      )
      await client.query('COMMIT')
      const row = r.rows[0]
      return { ...row, merged_with: mergeTarget.id, sim: Number(mergeTarget.sim).toFixed(3) }
    }
    let r
    try {
      r = await client.query(
        `INSERT INTO core_entries(element, summary, category, project_id, embedding, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::halfvec, $6, $7)
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [el, sm, cat, projectId, embedding ? embeddingToSql(embedding) : null, now, now],
      )
    } catch (err) {
      if (err.code === '23505') {
        throw new Error(`core entry already exists: project=${projectId ?? 'COMMON'} element=${JSON.stringify(el.slice(0, 200))}`)
      }
      throw err
    }
    await client.query('COMMIT')
    return r.rows[0]
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

export async function editCore(dataDir, id, patch) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const cur = (await db.query(`SELECT * FROM core_entries WHERE id = $1`, [numId])).rows[0]
  if (!cur) throw new Error(`no entry with id=${numId}`)
  const newElement = trimOrNull(patch.element) ?? cur.element
  const newSummary = trimOrNull(patch.summary) ?? cur.summary
  const newCategoryRaw = trimOrNull(patch.category)
  const newCategory = newCategoryRaw ? newCategoryRaw.toLowerCase() : cur.category
  if (!VALID_CAT.has(newCategory)) {
    throw new Error(`invalid category "${newCategory}". Valid: ${[...VALID_CAT].join(', ')}`)
  }
  if (newElement === cur.element && newSummary === cur.summary && newCategory === cur.category) {
    throw new Error('no change')
  }
  if (newSummary && newSummary.length > CORE_SUMMARY_MAX) {
    throw new Error(`core summary too long (${newSummary.length} chars, max ${CORE_SUMMARY_MAX}) — core memory must be 1 fact in 1-2 sentences; procedures, multi-step, or code belong in recap or docs. Compress and retry.`)
  }
  const now = Date.now()
  const textChanged = newElement !== cur.element || newSummary !== cur.summary
  if (!textChanged) {
    await db.query(
      `UPDATE core_entries SET category = $1, updated_at = $2 WHERE id = $3`,
      [newCategory, now, numId],
    )
    return { ...cur, element: newElement, summary: newSummary, category: newCategory, updated_at: now }
  }

  await _backfillNullEmbeddings(db)
  const embedding = await _embedFor(db, newElement, newSummary)
  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    const poolKey = `core:${cur.project_id == null ? 'COMMON' : cur.project_id}`
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [poolKey])
    const candidates = await _findTopKCore(client, cur.project_id, embedding, numId, { forUpdate: true })
    const mergeTarget = await _resolveMergeTarget(candidates, { element: newElement, summary: newSummary })
    if (mergeTarget) {
      const r = await client.query(
        `UPDATE core_entries
         SET element = $1, summary = $2, category = $3, embedding = $4::halfvec, updated_at = $5
         WHERE id = $6
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [newElement, newSummary, newCategory, embedding ? embeddingToSql(embedding) : null, now, mergeTarget.id],
      )
      await client.query(`DELETE FROM core_entries WHERE id = $1`, [numId])
      await client.query('COMMIT')
      const row = r.rows[0]
      return { ...row, merged_from: numId, merged_with: mergeTarget.id, sim: Number(mergeTarget.sim).toFixed(3) }
    }
    await client.query(
      `UPDATE core_entries SET element = $1, summary = $2, category = $3, embedding = $4::halfvec, updated_at = $5 WHERE id = $6`,
      [newElement, newSummary, newCategory, embedding ? embeddingToSql(embedding) : null, now, numId],
    )
    await client.query('COMMIT')
    return { ...cur, element: newElement, summary: newSummary, category: newCategory, updated_at: now }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

export async function deleteCore(dataDir, id) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const r = await db.query(`DELETE FROM core_entries WHERE id = $1 RETURNING *`, [numId])
  if (r.rows.length === 0) throw new Error(`no entry with id=${numId}`)
  return r.rows[0]
}

// ─── Core-candidate promotion pipeline (proposal mode) ───────────────────────
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

const CANDIDATE_CAP = 10
// Durable categories worth surfacing for user-curated core memory. Mirrors the
// high end of CATEGORY_GRADE (memory-score.mjs) — task/issue excluded.
const CANDIDATE_CATEGORIES = new Set(['rule', 'constraint', 'decision', 'preference', 'goal', 'fact'])
// Score floor: preference grade is 1.4, fact 1.6 — require the entry to still
// be near its grade ceiling (i.e. survived decay), not a stale low-score root.
const CANDIDATE_MIN_SCORE = 1.3
// Embedding sim at/above which the active entry is considered already covered
// by an existing core row → skip nomination. Matches cycle2 TIER1_THRESHOLD.
const CANDIDATE_OVERLAP_SIM = 0.78

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
  // Live candidate headroom: never exceed CANDIDATE_CAP total pending.
  const liveRes = await db.query(
    `SELECT COUNT(*)::int AS n FROM entries WHERE is_root = 1 AND core_candidate_status = 'candidate'`,
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
export async function listCoreCandidates(dataDir) {
  const db = _getDb(dataDir)
  const r = await db.query(
    `SELECT id, element, summary, category, score
     FROM entries
     WHERE is_root = 1 AND core_candidate_status = 'candidate'
     ORDER BY score DESC, core_candidate_at DESC, id ASC`,
  )
  return r.rows.map(row => ({
    id: Number(row.id),
    element: row.element,
    summary: row.summary,
    category: row.category,
    score: row.score == null ? null : Number(row.score),
    reason: _candidateReason(row),
  }))
}

// Promote a candidate: run addCore (reuses its LLM merge-judge + embedding
// dedup), then mark the source root 'promoted' AND archive it so cycle2/cycle3
// don't fight the new core row (see demotion consistency below). Terminal —
// never re-nominated. Returns the added/merged core entry.
export async function promoteCoreCandidate(dataDir, id, options = {}) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const cur = (await db.query(
    `SELECT id, element, summary, category, project_id, core_candidate_status
     FROM entries WHERE id = $1 AND is_root = 1`,
    [numId],
  )).rows[0]
  if (!cur) throw new Error(`no root entry with id=${numId}`)
  if (cur.core_candidate_status !== 'candidate') {
    throw new Error(`entry id=${numId} is not a live core candidate (status=${cur.core_candidate_status ?? 'none'})`)
  }
  // Core summary cap: candidate summaries may exceed CORE_SUMMARY_MAX. Prefer
  // the explicit override, else compress by truncation so addCore accepts it.
  const summary = options?.summary ?? cur.summary
  const cappedSummary = summary && String(summary).length > CORE_SUMMARY_MAX
    ? String(summary).slice(0, CORE_SUMMARY_MAX)
    : summary
  const entry = await addCore(
    dataDir,
    { element: cur.element, summary: cappedSummary, category: cur.category },
    cur.project_id ?? null,
  )
  const now = Date.now()
  // Mark consumed AND archive the source root: the fact now lives in
  // core_entries, so the generated root must leave the active set to avoid
  // re-nomination and to keep cycle2 core_overlap from re-processing it.
  const arch = await db.query(
    `UPDATE entries SET core_candidate_status = 'promoted', core_candidate_at = $1, status = 'archived'
     WHERE id = $2 AND is_root = 1 AND status = 'active'`,
    [now, numId],
  )
  // Drop the archived root's embedding — same as cycle2 phase_merge
  // core_overlap — so the archived root can never resurface in any dense
  // recall / dedup / nomination probe.
  if (Number(arch.rowCount ?? arch.affectedRows ?? 0) > 0) {
    try { await deleteRootEmbedding(db, numId) } catch {}
  } else {
    // Root was not active (already archived/merged elsewhere): still mark the
    // candidate flag terminal so it leaves the candidate list.
    await db.query(
      `UPDATE entries SET core_candidate_status = 'promoted', core_candidate_at = $1 WHERE id = $2 AND is_root = 1`,
      [now, numId],
    )
  }
  return entry
}

// Dismiss a candidate: mark terminal so the nomination pass never re-nominates
// the same root. Leaves status/score untouched — the entry stays active in
// generated memory, it just won't be re-surfaced as a core candidate.
export async function dismissCoreCandidate(dataDir, id) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const r = await db.query(
    `UPDATE entries SET core_candidate_status = 'dismissed', core_candidate_at = $1
     WHERE id = $2 AND is_root = 1 AND core_candidate_status = 'candidate'
     RETURNING id, element, category`,
    [Date.now(), numId],
  )
  if (r.rows.length === 0) throw new Error(`no live core candidate with id=${numId}`)
  return r.rows[0]
}
