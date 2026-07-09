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

export const CORE_SUMMARY_MAX = 100
export const CORE_ELEMENT_MAX = 40

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
  // Only refill live cores — archiveCore intentionally nulls the embedding to
  // drop archived rows from recall; refilling them would resurrect them.
  const r = await db.query(`SELECT id, element, summary FROM core_entries WHERE embedding IS NULL AND (status IS NULL OR status = 'active')`)
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
      AND (status IS NULL OR status = 'active')
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
  // Only live cores enter recall/review — archived (superseded) rows are
  // retired but retained for audit. Legacy NULL status = active.
  const live = `(status IS NULL OR status = 'active')`
  if (projectId === '*') {
    const r = await db.query(`SELECT ${cols} FROM core_entries WHERE ${live} ORDER BY project_id NULLS FIRST, id ASC`)
    return r.rows
  }
  if (projectId === null) {
    const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id IS NULL AND ${live} ORDER BY id ASC`)
    return r.rows
  }
  const r = await db.query(`SELECT ${cols} FROM core_entries WHERE project_id = $1 AND ${live} ORDER BY id ASC`, [projectId])
  return r.rows
}

export async function addCore(dataDir, { element, summary, category }, projectId) {
  if (projectId === undefined) throw new Error('addCore: projectId required — pass null for COMMON pool, or slug string for scoped pool')
  const el = trimOrNull(element)
  const sm = trimOrNull(summary) ?? el
  if (!el || !sm) throw new Error('add requires element and summary')
  if (el.length > CORE_ELEMENT_MAX) {
    throw new Error(`core element too long (${el.length}/${CORE_ELEMENT_MAX} chars, remove ${el.length - CORE_ELEMENT_MAX}) — element is a short key/title, not content.`)
  }
  if (sm.length > CORE_SUMMARY_MAX) {
    throw new Error(`core summary too long (${sm.length}/${CORE_SUMMARY_MAX} chars, remove ${sm.length - CORE_SUMMARY_MAX}) — 1 fact in 1-2 sentences; move procedures/multi-step/code to recap or docs.`)
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
      // Savepoint so a unique-collision doesn't abort the whole tx — we recover
      // by reviving an archived row on the same connection below.
      await client.query('SAVEPOINT ins')
      r = await client.query(
        `INSERT INTO core_entries(element, summary, category, project_id, embedding, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5::halfvec, $6, $7)
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [el, sm, cat, projectId, embedding ? embeddingToSql(embedding) : null, now, now],
      )
      await client.query('RELEASE SAVEPOINT ins')
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK TO SAVEPOINT ins')
        // Unique (project_id, element) collision. If the colliding row is an
        // archived (superseded) row, the fact is being re-asserted → revive it
        // in place: flip back to active, clear archived_at, overwrite content.
        // Avoids a partial-index migration. An active collision is a genuine
        // duplicate → surface the error.
        const revived = await client.query(
          `UPDATE core_entries
           SET summary = $1, category = $2, embedding = $3::halfvec,
               status = 'active', archived_at = NULL, updated_at = $4
           WHERE project_id IS NOT DISTINCT FROM $5 AND element = $6
             AND status = 'archived'
           RETURNING id, element, summary, category, project_id, created_at, updated_at`,
          [sm, cat, embedding ? embeddingToSql(embedding) : null, now, projectId, el],
        )
        if (revived.rows.length > 0) {
          await client.query('COMMIT')
          return { ...revived.rows[0], revived_from_archived: true }
        }
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
    throw new Error(`core summary too long (${newSummary.length}/${CORE_SUMMARY_MAX} chars, remove ${newSummary.length - CORE_SUMMARY_MAX}) — 1 fact in 1-2 sentences; move procedures/multi-step/code to recap or docs.`)
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

// Archive (retire without physical removal) a core entry whose fact was
// superseded by a newer active fact. Non-destructive: flips status to
// 'archived' + stamps archived_at so the row can be recovered/audited, and
// drops it from the recall/review pool. Safe-by-default: unlike deleteCore this
// is reversible and runs in conservative mode. Relies on the nullable status/
// archived_at columns added in ensureCurrentSchemaExtensions (no migration
// beyond those additive columns).
//
// Takes the same core:${project} advisory lock as addCore/editCore and
// re-checks the row inside it, so a concurrent addCore merge/overwrite that
// changed the fact after cycle3 read it is NOT clobbered. `expect` carries the
// element/summary cycle3 reviewed; if the live row drifted from it the archive
// is skipped (returns { skipped:true, reason:'content drift' }).
export async function archiveCore(dataDir, id, expect = null) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const db = _getDb(dataDir)
  const now = Date.now()
  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    // Lock ORDER must match addCore/editCore: advisory (pool) FIRST, then the
    // row FOR UPDATE — otherwise same-row concurrency deadlocks. The advisory
    // key needs project_id, so read it first WITHOUT a row lock (plain SELECT,
    // no FOR UPDATE → acquires no row lock, can't invert ordering), take the
    // pool advisory lock, THEN FOR UPDATE the row and re-validate under it.
    const pre = (await client.query(
      `SELECT project_id FROM core_entries WHERE id = $1`,
      [numId],
    )).rows[0]
    if (!pre) throw new Error(`no entry with id=${numId}`)
    const poolKey = `core:${pre.project_id == null ? 'COMMON' : pre.project_id}`
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [poolKey])
    // Now take the row lock under the pool lock and re-read — a concurrent
    // addCore holding the same advisory lock may have merged/overwritten or
    // moved the row's project_id between our pre-read and the lock.
    const locked = (await client.query(
      `SELECT id, element, summary, project_id, status FROM core_entries WHERE id = $1 FOR UPDATE`,
      [numId],
    )).rows[0]
    if (!locked || !(locked.status == null || locked.status === 'active')) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'concurrently archived/removed' }
    }
    // If project_id moved pools between pre-read and lock, our advisory lock is
    // on the wrong pool → bail rather than archive under a mismatched lock.
    if ((locked.project_id ?? null) !== (pre.project_id ?? null)) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'pool changed under lock' }
    }
    if (expect && (String(expect.element ?? '') !== String(locked.element ?? '') ||
                   String(expect.summary ?? '') !== String(locked.summary ?? ''))) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'content drift' }
    }
    const r = await client.query(
      `UPDATE core_entries
       SET status = 'archived', archived_at = $1, updated_at = $2, embedding = NULL
       WHERE id = $3 AND (status IS NULL OR status = 'active')
       RETURNING *`,
      [now, now, numId],
    )
    await client.query('COMMIT')
    if (r.rows.length === 0) return { id: numId, skipped: true, reason: 'concurrently archived/removed' }
    return r.rows[0]
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
}

// Non-destructive project reclassification: move a mis-scoped core entry to the
// correct pool (a project slug, or COMMON when newProjectId is null). Only the
// project_id + updated_at change — no delete, and no re-embed (the embedding is
// derived from element/summary text, which is pool-independent). Takes BOTH the
// source and target pool advisory locks in a deterministic (sorted) order so a
// move can't deadlock with a concurrent add/edit/archive on either pool, then
// FOR UPDATEs the row and re-validates under the lock. `expect` carries the
// element/summary cycle3 reviewed; if the live row drifted, the move is skipped
// ({ skipped, reason }). A live (project_id, element) collision in the target
// pool means the fact already exists there → skipped, so the caller holds it for
// manual resolution instead of clobbering the existing row.
export async function reclassifyCore(dataDir, id, newProjectId, expect = null) {
  const numId = Number(id)
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('integer id > 0 required')
  const targetPid = newProjectId == null ? null : (String(newProjectId).trim() || null)
  const db = _getDb(dataDir)
  const now = Date.now()
  const client = await checkedConnect(db._pool, 'memory')
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '5s'`)
    // Read the current pool WITHOUT a row lock first (no FOR UPDATE → acquires
    // no row lock, can't invert ordering) so the advisory locks are taken first.
    const pre = (await client.query(`SELECT project_id FROM core_entries WHERE id = $1`, [numId])).rows[0]
    if (!pre) throw new Error(`no entry with id=${numId}`)
    const curPid = pre.project_id ?? null
    if ((curPid ?? null) === (targetPid ?? null)) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'already in target pool' }
    }
    // Lock BOTH pools, sorted, so a move in the opposite direction can't deadlock.
    const keys = [...new Set([
      `core:${curPid == null ? 'COMMON' : curPid}`,
      `core:${targetPid == null ? 'COMMON' : targetPid}`,
    ])].sort()
    for (const k of keys) await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [k])
    const locked = (await client.query(
      `SELECT id, element, summary, project_id, status FROM core_entries WHERE id = $1 FOR UPDATE`,
      [numId],
    )).rows[0]
    if (!locked || !(locked.status == null || locked.status === 'active')) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'concurrently archived/removed' }
    }
    if ((locked.project_id ?? null) !== curPid) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'pool changed under lock' }
    }
    // Reviewed-source guard: cycle3 decided this move against the pool the row
    // was in AT REVIEW time. If the row was reclassified into a THIRD pool
    // between review and now, the in-tx pre-read above sees that new pool (so
    // the pool-changed-under-lock check passes) but the move is stale → skip.
    // `expect.sourceProjectId` (null = COMMON) carries the reviewed pool.
    if (expect && 'sourceProjectId' in expect) {
      const reviewedPid = expect.sourceProjectId == null ? null : (String(expect.sourceProjectId).trim() || null)
      if ((locked.project_id ?? null) !== reviewedPid) {
        await client.query('ROLLBACK')
        return { id: numId, skipped: true, reason: 'source pool drift' }
      }
    }
    if (expect && (String(expect.element ?? '') !== String(locked.element ?? '') ||
                   String(expect.summary ?? '') !== String(locked.summary ?? ''))) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: 'content drift' }
    }
    // Unique (project_id, element) guard: a live row with this element already in
    // the target pool means the fact is present there → don't clobber it.
    const dup = (await client.query(
      `SELECT id FROM core_entries
       WHERE project_id IS NOT DISTINCT FROM $1 AND element = $2
         AND (status IS NULL OR status = 'active') AND id != $3
       LIMIT 1`,
      [targetPid, locked.element, numId],
    )).rows[0]
    if (dup) {
      await client.query('ROLLBACK')
      return { id: numId, skipped: true, reason: `target pool already has element (id=${dup.id})` }
    }
    let r
    try {
      await client.query('SAVEPOINT mv')
      r = await client.query(
        `UPDATE core_entries SET project_id = $1, updated_at = $2 WHERE id = $3
         RETURNING id, element, summary, category, project_id, created_at, updated_at`,
        [targetPid, now, numId],
      )
      await client.query('RELEASE SAVEPOINT mv')
    } catch (err) {
      if (err.code === '23505') {
        await client.query('ROLLBACK')
        return { id: numId, skipped: true, reason: 'unique collision in target pool' }
      }
      throw err
    }
    await client.query('COMMIT')
    return { ...r.rows[0], from_project_id: curPid, to_project_id: targetPid }
  } catch (err) {
    try { await client.query('ROLLBACK') } catch {}
    throw err
  } finally {
    client.release()
  }
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
